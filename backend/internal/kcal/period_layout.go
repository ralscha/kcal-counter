package kcal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"

	"kcal-counter/internal/store/sqlc"
)

const maxArchivedPeriods = 1000

func validateSyncIdentity(change SyncRecord) error {
	if change.ID == uuid.Nil {
		return errors.New("sync change id is required")
	}
	if change.ClientUpdatedAt.IsZero() {
		return fmt.Errorf("sync change %s is missing client_updated_at", change.ID)
	}
	return nil
}

func validatePeriodStartChange(change SyncRecord) error {
	if change.ID != periodStartUUID {
		return errors.New("period start id must be the canonical singleton id")
	}
	if change.Deleted {
		return errors.New("clear a period start using a null cycle_start_date")
	}
	_, err := ParseCycleStartDate(change.CycleStartDate)
	return err
}

// projectPeriodChanges runs under the sync transaction lock. The entire period
// group either preserves a valid layout or receives authoritative conflicts;
// independent changes in the request can still be applied normally.
func projectPeriodChanges(ctx context.Context, store Store, userID int64, changes []SyncRecord) (map[int]SyncRecord, error) {
	periodChanges := make(map[int]SyncRecord)
	for index, change := range changes {
		change = normalizeSyncRecord(change)
		if change.EntityTable != EntityTablePeriods && change.EntityTable != EntityTablePeriodStarts {
			continue
		}
		if err := validateSyncIdentity(change); err != nil {
			return nil, err
		}
		if change.EntityTable == EntityTablePeriods {
			if err := ValidateTrackingChange(change); err != nil {
				return nil, err
			}
		} else if err := validatePeriodStartChange(change); err != nil {
			return nil, err
		}
		periodChanges[index] = change
	}
	if len(periodChanges) == 0 {
		return nil, nil
	}

	rows, err := store.ListSyncSnapshot(ctx, userID)
	if err != nil {
		return nil, err
	}
	originalArchives := make(map[uuid.UUID]SyncRecord)
	projectedArchives := make(map[uuid.UUID]SyncRecord)
	loadedArchives := make(map[uuid.UUID]bool)
	var originalActive, projectedActive *SyncRecord
	for _, row := range rows {
		if row.EntityTable != EntityTablePeriods && row.EntityTable != EntityTablePeriodStarts {
			continue
		}
		record, err := syncRecordFromListRow(sqlc.ListSyncRecordsSinceRow(row))
		if err != nil {
			return nil, err
		}
		if record.EntityTable == EntityTablePeriodStarts {
			originalActive, projectedActive = &record, &record
		} else {
			originalArchives[record.ID], projectedArchives[record.ID] = record, record
			loadedArchives[record.ID] = true
		}
	}
	// Iterate in request order: repeated IDs must follow the same LWW rules as
	// the subsequent writes, including equal-timestamp updates.
	for index := range changes {
		change, included := periodChanges[index]
		if !included {
			continue
		}
		if change.EntityTable == EntityTablePeriodStarts {
			if projectedActive == nil || !change.ClientUpdatedAt.Before(projectedActive.ClientUpdatedAt) {
				projectedActive = &change
			}
			continue
		}
		if !loadedArchives[change.ID] {
			current, err := store.GetKcalPeriodForUpdate(ctx, sqlc.GetKcalPeriodForUpdateParams{ID: change.ID, UserID: userID})
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if err == nil {
				record := syncRecordFromPeriod(current)
				originalArchives[record.ID], projectedArchives[record.ID] = record, record
			}
			loadedArchives[change.ID] = true
		}
		current, exists := projectedArchives[change.ID]
		if !exists || !change.ClientUpdatedAt.Before(current.ClientUpdatedAt) {
			projectedArchives[change.ID] = change
		}
	}
	if validPeriodLayout(projectedArchives, projectedActive) {
		return nil, nil
	}

	conflicts := make(map[int]SyncRecord, len(periodChanges))
	now := time.Now().UTC()
	for index, change := range periodChanges {
		if change.EntityTable == EntityTablePeriodStarts {
			if originalActive != nil {
				conflicts[index] = *originalActive
			} else {
				conflicts[index] = SyncRecord{
					EntityTable: EntityTablePeriodStarts, ID: periodStartUUID,
					ClientUpdatedAt: change.ClientUpdatedAt, ServerUpdatedAt: &now,
				}
			}
		} else if original, exists := originalArchives[change.ID]; exists {
			conflicts[index] = original
		} else {
			// The client may already display this tentative offline archive. A
			// synthetic tombstone removes it without persisting invalid history.
			conflicts[index] = SyncRecord{
				EntityTable: EntityTablePeriods, ID: change.ID, Deleted: true,
				StartDate: change.StartDate, EndDate: change.EndDate,
				ClientUpdatedAt: change.ClientUpdatedAt, ServerUpdatedAt: &now,
			}
		}
	}
	return conflicts, nil
}

func validPeriodLayout(archives map[uuid.UUID]SyncRecord, active *SyncRecord) bool {
	periods := make([]SyncRecord, 0, len(archives))
	for _, record := range archives {
		if !record.Deleted {
			periods = append(periods, record)
		}
	}
	if len(periods) > maxArchivedPeriods {
		return false
	}
	sort.Slice(periods, func(i, j int) bool { return periods[i].StartDate < periods[j].StartDate })
	for index, period := range periods {
		if index > 0 && period.StartDate <= periods[index-1].EndDate {
			return false
		}
		if active != nil && active.CycleStartDate != nil && period.EndDate >= *active.CycleStartDate {
			return false
		}
	}
	return true
}
