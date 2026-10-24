package kcal

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"kcal-counter/internal/store/sqlc"
)

// TargetIDForDate gives each account one target per calendar date, even when
// multiple devices create it while offline. The date must be valid first.
func TargetIDForDate(date string) (uuid.UUID, error) {
	if _, err := ParseCalendarDate(date); err != nil {
		return uuid.Nil, err
	}
	return uuid.Parse("00000000-0000-0000-0002-0000" + strings.ReplaceAll(date, "-", ""))
}

func ParseCalendarDate(value string) (time.Time, error) {
	date, err := ParseCycleStartDate(&value)
	if err != nil {
		return time.Time{}, errors.New("date must be a valid YYYY-MM-DD calendar date")
	}
	return date.Time, nil
}

// ValidateTrackingChange is shared by the HTTP boundary and sync service so
// malformed offline changes are rejected before a transaction starts.
func ValidateTrackingChange(change SyncRecord) error {
	switch change.EntityTable {
	case EntityTableTargets:
		id, err := TargetIDForDate(change.EffectiveFrom)
		if err != nil {
			return fmt.Errorf("effective_from: %w", err)
		}
		if change.ID != id {
			return fmt.Errorf("target id must be %s for effective_from %s", id, change.EffectiveFrom)
		}
		if change.KcalLimit != nil && *change.KcalLimit <= 0 {
			return errors.New("kcal_limit must be positive or null")
		}
	case EntityTablePeriods:
		start, err := ParseCalendarDate(change.StartDate)
		if err != nil {
			return fmt.Errorf("start_date: %w", err)
		}
		end, err := ParseCalendarDate(change.EndDate)
		if err != nil {
			return fmt.Errorf("end_date: %w", err)
		}
		if end.Before(start) {
			return errors.New("end_date must be on or after start_date")
		}
	case EntityTableMeals:
		if !validMealName(change.Name) {
			return errors.New("meal name must contain 1 to 200 characters")
		}
		if len(change.Items) < 1 || len(change.Items) > 100 {
			return errors.New("meal must contain 1 to 100 items")
		}
		for i, item := range change.Items {
			if item.TemplateID == uuid.Nil || !validMealName(item.Name) || item.KcalDelta <= 0 {
				return fmt.Errorf("meal item %d requires a template_id, a name of 1 to 200 characters and positive kcal_delta", i)
			}
		}
	default:
		return fmt.Errorf("unsupported tracking entity %q", change.EntityTable)
	}
	return nil
}

func validMealName(name string) bool {
	name = strings.TrimSpace(name)
	return name != "" && utf8.RuneCountInString(name) <= 200
}

func applyTargetChange(ctx context.Context, store Store, userID int64, change SyncRecord) (SyncPushResult, error) {
	if err := ValidateTrackingChange(change); err != nil {
		return SyncPushResult{}, err
	}
	current, err := store.GetKcalTargetForUpdate(ctx, sqlc.GetKcalTargetForUpdateParams{ID: change.ID, UserID: userID})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return SyncPushResult{}, err
	}
	if err == nil && change.ClientUpdatedAt.Before(current.ClientUpdatedAt) {
		return SyncPushResult{Record: syncRecordFromTarget(current)}, nil
	}
	date, _ := ParseCalendarDate(change.EffectiveFrom)
	limit := sql.NullInt32{}
	if change.KcalLimit != nil {
		limit = sql.NullInt32{Int32: *change.KcalLimit, Valid: true}
	}
	now := time.Now().UTC()
	stored, err := store.UpsertKcalTarget(ctx, sqlc.UpsertKcalTargetParams{
		ID: change.ID, UserID: userID, EffectiveFrom: date, KcalLimit: limit,
		ClientUpdatedAt: change.ClientUpdatedAt, ServerUpdatedAt: now,
		DeletedAt: deletedAtForChange(change.Deleted, now),
	})
	if err != nil {
		return SyncPushResult{}, err
	}
	return SyncPushResult{Applied: true, Record: syncRecordFromTarget(stored)}, nil
}

func applyPeriodChange(ctx context.Context, store Store, userID int64, change SyncRecord) (SyncPushResult, error) {
	if err := ValidateTrackingChange(change); err != nil {
		return SyncPushResult{}, err
	}
	current, err := store.GetKcalPeriodForUpdate(ctx, sqlc.GetKcalPeriodForUpdateParams{ID: change.ID, UserID: userID})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return SyncPushResult{}, err
	}
	if err == nil && change.ClientUpdatedAt.Before(current.ClientUpdatedAt) {
		return SyncPushResult{Record: syncRecordFromPeriod(current)}, nil
	}
	start, _ := ParseCalendarDate(change.StartDate)
	end, _ := ParseCalendarDate(change.EndDate)
	now := time.Now().UTC()
	stored, err := store.UpsertKcalPeriod(ctx, sqlc.UpsertKcalPeriodParams{
		ID: change.ID, UserID: userID, StartDate: start, EndDate: end,
		ClientUpdatedAt: change.ClientUpdatedAt, ServerUpdatedAt: now,
		DeletedAt: deletedAtForChange(change.Deleted, now),
	})
	if err != nil {
		return SyncPushResult{}, err
	}
	return SyncPushResult{Applied: true, Record: syncRecordFromPeriod(stored)}, nil
}

func applyMealChange(ctx context.Context, store Store, userID int64, change SyncRecord) (SyncPushResult, error) {
	if err := ValidateTrackingChange(change); err != nil {
		return SyncPushResult{}, err
	}
	current, err := store.GetKcalMealForUpdate(ctx, sqlc.GetKcalMealForUpdateParams{ID: change.ID, UserID: userID})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return SyncPushResult{}, err
	}
	if err == nil && change.ClientUpdatedAt.Before(current.ClientUpdatedAt) {
		record, err := syncRecordFromMeal(current)
		return SyncPushResult{Record: record}, err
	}
	items := append([]MealItem(nil), change.Items...)
	for i := range items {
		items[i].Name = strings.TrimSpace(items[i].Name)
	}
	encodedItems, err := json.Marshal(items)
	if err != nil {
		return SyncPushResult{}, err
	}
	now := time.Now().UTC()
	stored, err := store.UpsertKcalMeal(ctx, sqlc.UpsertKcalMealParams{
		ID: change.ID, UserID: userID, Name: change.Name, Items: encodedItems,
		ClientUpdatedAt: change.ClientUpdatedAt, ServerUpdatedAt: now,
		DeletedAt: deletedAtForChange(change.Deleted, now),
	})
	if err != nil {
		return SyncPushResult{}, err
	}
	record, err := syncRecordFromMeal(stored)
	return SyncPushResult{Applied: true, Record: record}, err
}

func syncRecordFromTarget(item sqlc.KcalTarget) SyncRecord {
	serverUpdatedAt := item.ServerUpdatedAt.UTC()
	record := SyncRecord{
		EntityTable: EntityTableTargets, ID: item.ID, EffectiveFrom: item.EffectiveFrom.Format(time.DateOnly),
		ClientUpdatedAt: item.ClientUpdatedAt.UTC(), ServerUpdatedAt: &serverUpdatedAt,
		GlobalVersion: item.GlobalVersion, Deleted: item.DeletedAt.Valid,
	}
	if item.KcalLimit.Valid {
		record.KcalLimit = &item.KcalLimit.Int32
	}
	return record
}

func syncRecordFromPeriod(item sqlc.KcalPeriod) SyncRecord {
	serverUpdatedAt := item.ServerUpdatedAt.UTC()
	return SyncRecord{
		EntityTable: EntityTablePeriods, ID: item.ID,
		StartDate: item.StartDate.Format(time.DateOnly), EndDate: item.EndDate.Format(time.DateOnly),
		ClientUpdatedAt: item.ClientUpdatedAt.UTC(), ServerUpdatedAt: &serverUpdatedAt,
		GlobalVersion: item.GlobalVersion, Deleted: item.DeletedAt.Valid,
	}
}

func syncRecordFromMeal(item sqlc.KcalMeal) (SyncRecord, error) {
	serverUpdatedAt := item.ServerUpdatedAt.UTC()
	record := SyncRecord{
		EntityTable: EntityTableMeals, ID: item.ID, Name: item.Name,
		ClientUpdatedAt: item.ClientUpdatedAt.UTC(), ServerUpdatedAt: &serverUpdatedAt,
		GlobalVersion: item.GlobalVersion, Deleted: item.DeletedAt.Valid,
	}
	if err := json.Unmarshal(item.Items, &record.Items); err != nil {
		return SyncRecord{}, fmt.Errorf("decode stored meal %s: %w", item.ID, err)
	}
	return record, nil
}
