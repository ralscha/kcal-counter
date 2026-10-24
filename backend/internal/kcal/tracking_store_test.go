package kcal

import (
	"context"
	"database/sql"
	"github.com/google/uuid"
	"kcal-counter/internal/store/sqlc"
	"time"
)

type trackingKey struct {
	userID int64
	id     uuid.UUID
}

func (f *fakeStore) GetKcalTargetForUpdate(_ context.Context, arg sqlc.GetKcalTargetForUpdateParams) (sqlc.KcalTarget, error) {
	item, ok := f.targets[trackingKey{arg.UserID, arg.ID}]
	if !ok {
		return sqlc.KcalTarget{}, sql.ErrNoRows
	}
	return item, nil
}

func (f *fakeStore) UpsertKcalTarget(_ context.Context, arg sqlc.UpsertKcalTargetParams) (sqlc.KcalTarget, error) {
	item := sqlc.KcalTarget{
		ID: arg.ID, UserID: arg.UserID, EffectiveFrom: arg.EffectiveFrom, KcalLimit: arg.KcalLimit,
		ClientUpdatedAt: arg.ClientUpdatedAt, ServerUpdatedAt: arg.ServerUpdatedAt, DeletedAt: arg.DeletedAt, GlobalVersion: f.nextVersion(),
	}
	f.targets[trackingKey{arg.UserID, arg.ID}] = item
	return item, nil
}

func (f *fakeStore) DeleteExpiredTargetTombstones(_ context.Context, arg sqlc.DeleteExpiredTargetTombstonesParams) ([]int64, error) {
	versions := []int64{}
	for key, item := range f.targets {
		if item.UserID == arg.UserID && item.DeletedAt.Valid && item.ServerUpdatedAt.Before(arg.ServerUpdatedAt) {
			versions = append(versions, item.GlobalVersion)
			delete(f.targets, key)
		}
	}
	return versions, nil
}

func (f *fakeStore) GetKcalPeriodForUpdate(_ context.Context, arg sqlc.GetKcalPeriodForUpdateParams) (sqlc.KcalPeriod, error) {
	item, ok := f.periods[trackingKey{arg.UserID, arg.ID}]
	if !ok {
		return sqlc.KcalPeriod{}, sql.ErrNoRows
	}
	return item, nil
}

func (f *fakeStore) UpsertKcalPeriod(_ context.Context, arg sqlc.UpsertKcalPeriodParams) (sqlc.KcalPeriod, error) {
	item := sqlc.KcalPeriod{
		ID: arg.ID, UserID: arg.UserID, StartDate: arg.StartDate, EndDate: arg.EndDate,
		ClientUpdatedAt: arg.ClientUpdatedAt, ServerUpdatedAt: arg.ServerUpdatedAt, DeletedAt: arg.DeletedAt, GlobalVersion: f.nextVersion(),
	}
	f.periods[trackingKey{arg.UserID, arg.ID}] = item
	return item, nil
}

func (f *fakeStore) DeleteExpiredPeriodTombstones(_ context.Context, arg sqlc.DeleteExpiredPeriodTombstonesParams) ([]int64, error) {
	versions := []int64{}
	for key, item := range f.periods {
		if item.UserID == arg.UserID && item.DeletedAt.Valid && item.ServerUpdatedAt.Before(arg.ServerUpdatedAt) {
			versions = append(versions, item.GlobalVersion)
			delete(f.periods, key)
		}
	}
	return versions, nil
}

func (f *fakeStore) GetKcalMealForUpdate(_ context.Context, arg sqlc.GetKcalMealForUpdateParams) (sqlc.KcalMeal, error) {
	item, ok := f.meals[trackingKey{arg.UserID, arg.ID}]
	if !ok {
		return sqlc.KcalMeal{}, sql.ErrNoRows
	}
	return item, nil
}

func (f *fakeStore) UpsertKcalMeal(_ context.Context, arg sqlc.UpsertKcalMealParams) (sqlc.KcalMeal, error) {
	item := sqlc.KcalMeal{
		ID: arg.ID, UserID: arg.UserID, Name: arg.Name, Items: arg.Items,
		ClientUpdatedAt: arg.ClientUpdatedAt, ServerUpdatedAt: arg.ServerUpdatedAt, DeletedAt: arg.DeletedAt, GlobalVersion: f.nextVersion(),
	}
	f.meals[trackingKey{arg.UserID, arg.ID}] = item
	return item, nil
}

func (f *fakeStore) DeleteExpiredMealTombstones(_ context.Context, arg sqlc.DeleteExpiredMealTombstonesParams) ([]int64, error) {
	versions := []int64{}
	for key, item := range f.meals {
		if item.UserID == arg.UserID && item.DeletedAt.Valid && item.ServerUpdatedAt.Before(arg.ServerUpdatedAt) {
			versions = append(versions, item.GlobalVersion)
			delete(f.meals, key)
		}
	}
	return versions, nil
}

func (f *fakeStore) trackingRows(userID, cursor int64) []sqlc.ListSyncRecordsSinceRow {
	rows := []sqlc.ListSyncRecordsSinceRow{}
	for _, item := range f.targets {
		if item.UserID != userID || item.GlobalVersion <= cursor {
			continue
		}
		rows = append(rows, sqlc.ListSyncRecordsSinceRow{EntityTable: EntityTableTargets, ID: item.ID,
			EffectiveFrom: sql.NullString{String: item.EffectiveFrom.Format(time.DateOnly), Valid: true}, KcalLimit: item.KcalLimit,
			ClientUpdatedAt: item.ClientUpdatedAt, ServerUpdatedAt: item.ServerUpdatedAt, GlobalVersion: item.GlobalVersion, Deleted: item.DeletedAt.Valid,
		})
	}
	for _, item := range f.periods {
		if item.UserID != userID || item.GlobalVersion <= cursor {
			continue
		}
		rows = append(rows, sqlc.ListSyncRecordsSinceRow{EntityTable: EntityTablePeriods, ID: item.ID,
			StartDate: sql.NullString{String: item.StartDate.Format(time.DateOnly), Valid: true}, EndDate: sql.NullString{String: item.EndDate.Format(time.DateOnly), Valid: true},
			ClientUpdatedAt: item.ClientUpdatedAt, ServerUpdatedAt: item.ServerUpdatedAt, GlobalVersion: item.GlobalVersion, Deleted: item.DeletedAt.Valid,
		})
	}
	for _, item := range f.meals {
		if item.UserID != userID || item.GlobalVersion <= cursor {
			continue
		}
		rows = append(rows, sqlc.ListSyncRecordsSinceRow{EntityTable: EntityTableMeals, ID: item.ID,
			Name: item.Name, Items: item.Items,
			ClientUpdatedAt: item.ClientUpdatedAt, ServerUpdatedAt: item.ServerUpdatedAt, GlobalVersion: item.GlobalVersion, Deleted: item.DeletedAt.Valid,
		})
	}
	return rows
}
