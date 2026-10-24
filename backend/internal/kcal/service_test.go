package kcal

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"

	"kcal-counter/internal/store/sqlc"
)

type fakeStore struct {
	targets           map[trackingKey]sqlc.KcalTarget
	periods           map[trackingKey]sqlc.KcalPeriod
	meals             map[trackingKey]sqlc.KcalMeal
	templates         map[trackingKey]sqlc.KcalTemplateItem
	entries           map[trackingKey]sqlc.KcalEntry
	periodStarts      map[int64]sqlc.KcalPeriodStart
	upsertCursorCalls []sqlc.UpsertDeviceSyncStateParams
	syncLockCalls     int
	minValidVersion   int64
	globalVersion     int64
	listTemplateItems []sqlc.KcalTemplateItem
	listEntries       []sqlc.KcalEntry
	total             int64
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		targets:      map[trackingKey]sqlc.KcalTarget{},
		periods:      map[trackingKey]sqlc.KcalPeriod{},
		meals:        map[trackingKey]sqlc.KcalMeal{},
		templates:    map[trackingKey]sqlc.KcalTemplateItem{},
		entries:      map[trackingKey]sqlc.KcalEntry{},
		periodStarts: map[int64]sqlc.KcalPeriodStart{},
	}
}

func (f *fakeStore) WithTx(_ context.Context, fn func(Store) error) error {
	return fn(f)
}

func (f *fakeStore) AcquireSyncLock(context.Context, int64) error {
	f.syncLockCalls++
	return nil
}

func (f *fakeStore) BumpMinValidVersion(_ context.Context, arg sqlc.BumpMinValidVersionParams) error {
	if arg.MinValidVersion > f.minValidVersion {
		f.minValidVersion = arg.MinValidVersion
	}
	return nil
}

func (f *fakeStore) CreateKcalEntry(_ context.Context, arg sqlc.CreateKcalEntryParams) (sqlc.KcalEntry, error) {
	entry := sqlc.KcalEntry{
		ID:              arg.ID,
		UserID:          arg.UserID,
		KcalDelta:       arg.KcalDelta,
		HappenedAt:      arg.HappenedAt,
		ClientUpdatedAt: arg.ClientUpdatedAt,
		ServerUpdatedAt: arg.ServerUpdatedAt,
		GlobalVersion:   f.nextVersion(),
		DeletedAt:       arg.DeletedAt,
	}
	f.entries[trackingKey{arg.UserID, arg.ID}] = entry
	return entry, nil
}

func (f *fakeStore) CreateKcalTemplateItem(_ context.Context, arg sqlc.CreateKcalTemplateItemParams) (sqlc.KcalTemplateItem, error) {
	item := sqlc.KcalTemplateItem{
		ID:              arg.ID,
		UserID:          arg.UserID,
		Kind:            arg.Kind,
		Name:            arg.Name,
		Amount:          arg.Amount,
		Unit:            arg.Unit,
		KcalAmount:      arg.KcalAmount,
		ClientUpdatedAt: arg.ClientUpdatedAt,
		ServerUpdatedAt: arg.ServerUpdatedAt,
		GlobalVersion:   f.nextVersion(),
		DeletedAt:       arg.DeletedAt,
	}
	f.templates[trackingKey{arg.UserID, arg.ID}] = item
	return item, nil
}

func (f *fakeStore) DeleteExpiredEntryTombstones(_ context.Context, arg sqlc.DeleteExpiredEntryTombstonesParams) ([]int64, error) {
	versions := make([]int64, 0)
	for id, entry := range f.entries {
		if entry.UserID != arg.UserID || !entry.DeletedAt.Valid || !entry.ServerUpdatedAt.Before(arg.ServerUpdatedAt) {
			continue
		}
		versions = append(versions, entry.GlobalVersion)
		delete(f.entries, id)
	}
	return versions, nil
}

func (f *fakeStore) DeleteExpiredTemplateTombstones(_ context.Context, arg sqlc.DeleteExpiredTemplateTombstonesParams) ([]int64, error) {
	versions := make([]int64, 0)
	for id, item := range f.templates {
		if item.UserID != arg.UserID || !item.DeletedAt.Valid || !item.ServerUpdatedAt.Before(arg.ServerUpdatedAt) {
			continue
		}
		versions = append(versions, item.GlobalVersion)
		delete(f.templates, id)
	}
	return versions, nil
}

func (f *fakeStore) DeleteKcalEntry(_ context.Context, arg sqlc.DeleteKcalEntryParams) (sqlc.KcalEntry, error) {
	entry, ok := f.entries[trackingKey{arg.UserID, arg.ID}]
	if !ok || entry.UserID != arg.UserID || entry.DeletedAt.Valid {
		return sqlc.KcalEntry{}, sql.ErrNoRows
	}
	entry.ClientUpdatedAt = arg.ClientUpdatedAt
	entry.ServerUpdatedAt = arg.ServerUpdatedAt
	entry.GlobalVersion = f.nextVersion()
	entry.DeletedAt = sql.NullTime{Time: arg.ServerUpdatedAt, Valid: true}
	f.entries[trackingKey{arg.UserID, arg.ID}] = entry
	return entry, nil
}

func (f *fakeStore) DeleteKcalTemplateItem(_ context.Context, arg sqlc.DeleteKcalTemplateItemParams) (sqlc.KcalTemplateItem, error) {
	item, ok := f.templates[trackingKey{arg.UserID, arg.ID}]
	if !ok || item.UserID != arg.UserID || item.DeletedAt.Valid {
		return sqlc.KcalTemplateItem{}, sql.ErrNoRows
	}
	item.ClientUpdatedAt = arg.ClientUpdatedAt
	item.ServerUpdatedAt = arg.ServerUpdatedAt
	item.GlobalVersion = f.nextVersion()
	item.DeletedAt = sql.NullTime{Time: arg.ServerUpdatedAt, Valid: true}
	f.templates[trackingKey{arg.UserID, arg.ID}] = item
	return item, nil
}

func (f *fakeStore) EnsureSyncMetadataRow(context.Context, int64) error {
	return nil
}

func (f *fakeStore) GetKcalEntryByID(_ context.Context, arg sqlc.GetKcalEntryByIDParams) (sqlc.KcalEntry, error) {
	entry, ok := f.entries[trackingKey{arg.UserID, arg.ID}]
	if !ok || entry.UserID != arg.UserID {
		return sqlc.KcalEntry{}, sql.ErrNoRows
	}
	return entry, nil
}

func (f *fakeStore) GetKcalEntryForUpdate(ctx context.Context, arg sqlc.GetKcalEntryForUpdateParams) (sqlc.KcalEntry, error) {
	return f.GetKcalEntryByID(ctx, sqlc.GetKcalEntryByIDParams(arg))
}

func (f *fakeStore) GetKcalPeriodStartForUpdate(_ context.Context, userID int64) (sqlc.KcalPeriodStart, error) {
	period, ok := f.periodStarts[userID]
	if !ok {
		return sqlc.KcalPeriodStart{}, sql.ErrNoRows
	}
	return period, nil
}

func (f *fakeStore) UpsertKcalPeriodStart(_ context.Context, arg sqlc.UpsertKcalPeriodStartParams) (sqlc.KcalPeriodStart, error) {
	period := sqlc.KcalPeriodStart{
		UserID: arg.UserID, CycleStartDate: arg.CycleStartDate,
		ClientUpdatedAt: arg.ClientUpdatedAt, ServerUpdatedAt: arg.ServerUpdatedAt,
		GlobalVersion: f.nextVersion(),
	}
	f.periodStarts[arg.UserID] = period
	return period, nil
}

func (f *fakeStore) GetKcalTemplateItemByID(_ context.Context, arg sqlc.GetKcalTemplateItemByIDParams) (sqlc.KcalTemplateItem, error) {
	item, ok := f.templates[trackingKey{arg.UserID, arg.ID}]
	if !ok || item.UserID != arg.UserID {
		return sqlc.KcalTemplateItem{}, sql.ErrNoRows
	}
	return item, nil
}

func (f *fakeStore) GetKcalTemplateItemForUpdate(ctx context.Context, arg sqlc.GetKcalTemplateItemForUpdateParams) (sqlc.KcalTemplateItem, error) {
	return f.GetKcalTemplateItemByID(ctx, sqlc.GetKcalTemplateItemByIDParams(arg))
}

func (f *fakeStore) GetKcalTotalInRange(context.Context, sqlc.GetKcalTotalInRangeParams) (int64, error) {
	return f.total, nil
}

func (f *fakeStore) ListKcalEntriesInRange(context.Context, sqlc.ListKcalEntriesInRangeParams) ([]sqlc.KcalEntry, error) {
	return append([]sqlc.KcalEntry(nil), f.listEntries...), nil
}

func (f *fakeStore) ListKcalTemplateItemsByKind(context.Context, sqlc.ListKcalTemplateItemsByKindParams) ([]sqlc.KcalTemplateItem, error) {
	return append([]sqlc.KcalTemplateItem(nil), f.listTemplateItems...), nil
}

func (f *fakeStore) ListSyncRecordsSince(_ context.Context, arg sqlc.ListSyncRecordsSinceParams) ([]sqlc.ListSyncRecordsSinceRow, error) {
	rows := make([]sqlc.ListSyncRecordsSinceRow, 0)
	for _, item := range f.templates {
		if item.UserID != arg.UserID || item.GlobalVersion <= arg.GlobalVersion {
			continue
		}
		rows = append(rows, sqlc.ListSyncRecordsSinceRow{
			EntityTable:     EntityTableTemplateItems,
			ID:              item.ID,
			Kind:            string(item.Kind),
			Name:            item.Name,
			Amount:          item.Amount,
			Unit:            item.Unit,
			KcalAmount:      item.KcalAmount,
			ClientUpdatedAt: item.ClientUpdatedAt,
			ServerUpdatedAt: item.ServerUpdatedAt,
			GlobalVersion:   item.GlobalVersion,
			Deleted:         item.DeletedAt.Valid,
		})
	}
	for _, entry := range f.entries {
		if entry.UserID != arg.UserID || entry.GlobalVersion <= arg.GlobalVersion {
			continue
		}
		rows = append(rows, sqlc.ListSyncRecordsSinceRow{
			EntityTable:     EntityTableEntries,
			ID:              entry.ID,
			KcalDelta:       sql.NullInt32{Int32: entry.KcalDelta, Valid: true},
			HappenedAt:      sql.NullTime{Time: entry.HappenedAt, Valid: true},
			ClientUpdatedAt: entry.ClientUpdatedAt,
			ServerUpdatedAt: entry.ServerUpdatedAt,
			GlobalVersion:   entry.GlobalVersion,
			Deleted:         entry.DeletedAt.Valid,
		})
	}
	if period, ok := f.periodStarts[arg.UserID]; ok && period.GlobalVersion > arg.GlobalVersion {
		date := sql.NullString{}
		if period.CycleStartDate.Valid {
			date = sql.NullString{String: period.CycleStartDate.Time.Format(time.DateOnly), Valid: true}
		}
		rows = append(rows, sqlc.ListSyncRecordsSinceRow{
			EntityTable: EntityTablePeriodStarts, ID: periodStartUUID, CycleStartDate: date,
			ClientUpdatedAt: period.ClientUpdatedAt, ServerUpdatedAt: period.ServerUpdatedAt,
			GlobalVersion: period.GlobalVersion,
		})
	}
	rows = append(rows, f.trackingRows(arg.UserID, arg.GlobalVersion)...)
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].GlobalVersion != rows[j].GlobalVersion {
			return rows[i].GlobalVersion < rows[j].GlobalVersion
		}
		if rows[i].EntityTable != rows[j].EntityTable {
			return rows[i].EntityTable < rows[j].EntityTable
		}
		return rows[i].ID.String() < rows[j].ID.String()
	})
	return rows, nil
}

func (f *fakeStore) ListSyncSnapshot(ctx context.Context, userID int64) ([]sqlc.ListSyncSnapshotRow, error) {
	all, err := f.ListSyncRecordsSince(ctx, sqlc.ListSyncRecordsSinceParams{UserID: userID, GlobalVersion: -1})
	if err != nil {
		return nil, err
	}
	rows := make([]sqlc.ListSyncSnapshotRow, 0, len(all))
	for _, row := range all {
		if !row.Deleted {
			rows = append(rows, sqlc.ListSyncSnapshotRow(row))
		}
	}
	return rows, nil
}

func (f *fakeStore) ReadSyncMetadata(_ context.Context, userID int64) (sqlc.ReadSyncMetadataRow, error) {
	currentVersion := f.minValidVersion
	for _, item := range f.templates {
		if item.UserID == userID && item.GlobalVersion > currentVersion {
			currentVersion = item.GlobalVersion
		}
	}
	for _, entry := range f.entries {
		if entry.UserID == userID && entry.GlobalVersion > currentVersion {
			currentVersion = entry.GlobalVersion
		}
	}
	if period, ok := f.periodStarts[userID]; ok && period.GlobalVersion > currentVersion {
		currentVersion = period.GlobalVersion
	}
	for _, row := range f.trackingRows(userID, -1) {
		currentVersion = max(currentVersion, row.GlobalVersion)
	}
	return sqlc.ReadSyncMetadataRow{CurrentVersion: currentVersion, MinValidVersion: f.minValidVersion}, nil
}

func (f *fakeStore) UpdateKcalEntry(_ context.Context, arg sqlc.UpdateKcalEntryParams) (sqlc.KcalEntry, error) {
	entry, ok := f.entries[trackingKey{arg.UserID, arg.ID}]
	if !ok || entry.UserID != arg.UserID {
		return sqlc.KcalEntry{}, sql.ErrNoRows
	}
	entry.KcalDelta = arg.KcalDelta
	entry.HappenedAt = arg.HappenedAt
	entry.ClientUpdatedAt = arg.ClientUpdatedAt
	entry.ServerUpdatedAt = arg.ServerUpdatedAt
	entry.DeletedAt = arg.DeletedAt
	entry.GlobalVersion = f.nextVersion()
	f.entries[trackingKey{arg.UserID, arg.ID}] = entry
	return entry, nil
}

func (f *fakeStore) UpdateKcalTemplateItem(_ context.Context, arg sqlc.UpdateKcalTemplateItemParams) (sqlc.KcalTemplateItem, error) {
	item, ok := f.templates[trackingKey{arg.UserID, arg.ID}]
	if !ok || item.UserID != arg.UserID {
		return sqlc.KcalTemplateItem{}, sql.ErrNoRows
	}
	item.Kind = arg.Kind
	item.Name = arg.Name
	item.Amount = arg.Amount
	item.Unit = arg.Unit
	item.KcalAmount = arg.KcalAmount
	item.ClientUpdatedAt = arg.ClientUpdatedAt
	item.ServerUpdatedAt = arg.ServerUpdatedAt
	item.DeletedAt = arg.DeletedAt
	item.GlobalVersion = f.nextVersion()
	f.templates[trackingKey{arg.UserID, arg.ID}] = item
	return item, nil
}

func (f *fakeStore) UpsertDeviceSyncState(_ context.Context, arg sqlc.UpsertDeviceSyncStateParams) error {
	f.upsertCursorCalls = append(f.upsertCursorCalls, arg)
	return nil
}

func (f *fakeStore) nextVersion() int64 {
	f.globalVersion++
	return f.globalVersion
}

func TestSyncIgnoresOlderEntryChange(t *testing.T) {
	store := newFakeStore()
	service := NewService(store)
	entryID := uuid.New()
	now := time.Now().UTC()
	store.globalVersion = 5
	store.entries[trackingKey{7, entryID}] = sqlc.KcalEntry{
		ID:              entryID,
		UserID:          7,
		KcalDelta:       450,
		HappenedAt:      now,
		ClientUpdatedAt: now,
		ServerUpdatedAt: now,
		GlobalVersion:   5,
	}

	result, err := service.Sync(context.Background(), 7, SyncInput{
		DeviceID:        uuid.New(),
		LastSyncVersion: 0,
		Changes: []SyncRecord{{
			EntityTable:     EntityTableEntries,
			ID:              entryID,
			KcalDelta:       200,
			HappenedAt:      new(now),
			ClientUpdatedAt: now.Add(-time.Minute),
		}},
	})
	if err != nil {
		t.Fatalf("Sync() error = %v", err)
	}
	if len(result.PushResults) != 1 || result.PushResults[0].Applied {
		t.Fatalf("push results = %+v, want one ignored authoritative record", result.PushResults)
	}
	if result.PushResults[0].Record.KcalDelta != 450 {
		t.Fatalf("authoritative kcal delta = %d, want 450", result.PushResults[0].Record.KcalDelta)
	}
}

func TestSyncReturnsResetSnapshotWhenCursorIsTooOld(t *testing.T) {
	store := newFakeStore()
	service := NewService(store)
	store.minValidVersion = 10
	templateID := uuid.New()
	now := time.Now().UTC()
	store.globalVersion = 12
	store.templates[trackingKey{7, templateID}] = sqlc.KcalTemplateItem{
		ID:              templateID,
		UserID:          7,
		Kind:            sqlc.KcalTemplateKindFood,
		Name:            "rice",
		Amount:          "100",
		Unit:            "grams",
		KcalAmount:      130,
		ClientUpdatedAt: now,
		ServerUpdatedAt: now,
		GlobalVersion:   12,
	}

	result, err := service.Sync(context.Background(), 7, SyncInput{
		DeviceID:        uuid.New(),
		LastSyncVersion: 5,
	})
	if err != nil {
		t.Fatalf("Sync() error = %v", err)
	}
	if !result.ResetRequired {
		t.Fatal("ResetRequired = false, want true")
	}
	if len(result.PullChanges) != 1 || result.PullChanges[0].Name != "rice" {
		t.Fatalf("pull changes = %+v, want one rice template snapshot", result.PullChanges)
	}
	if result.LastSyncVersion != 12 {
		t.Fatalf("last sync version = %d, want 12", result.LastSyncVersion)
	}
}

func TestSyncResetsCursorAfterServerHistoryIsRestored(t *testing.T) {
	store := newFakeStore()
	store.globalVersion = 2
	entryID := uuid.New()
	store.entries[trackingKey{7, entryID}] = sqlc.KcalEntry{ID: entryID, UserID: 7, KcalDelta: 100, GlobalVersion: 2}
	result, err := NewService(store).Sync(context.Background(), 7, SyncInput{
		DeviceID: uuid.New(), LastSyncVersion: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.ResetRequired || result.LastSyncVersion != 2 {
		t.Fatalf("result = %+v, want reset to version 2", result)
	}
}

func TestSyncAppliesEntryAndAdvancesDeviceCursor(t *testing.T) {
	store := newFakeStore()
	service := NewService(store)
	entryID := uuid.New()
	now := time.Now().UTC()
	deviceID := uuid.New()

	result, err := service.Sync(context.Background(), 7, SyncInput{
		DeviceID:        deviceID,
		LastSyncVersion: 0,
		Changes: []SyncRecord{{
			EntityTable:     EntityTableEntries,
			ID:              entryID,
			KcalDelta:       260,
			HappenedAt:      new(now),
			ClientUpdatedAt: now,
		}},
	})
	if err != nil {
		t.Fatalf("Sync() error = %v", err)
	}
	if len(result.PushResults) != 1 || !result.PushResults[0].Applied {
		t.Fatalf("push results = %+v, want one applied result", result.PushResults)
	}
	if len(result.PullChanges) != 1 || result.PullChanges[0].KcalDelta != 260 {
		t.Fatalf("pull changes = %+v, want one 260 kcal entry", result.PullChanges)
	}
	if result.LastSyncVersion == 0 {
		t.Fatal("last sync version = 0, want non-zero")
	}
	if len(store.upsertCursorCalls) != 2 {
		t.Fatalf("cursor calls = %d, want 2", len(store.upsertCursorCalls))
	}
	if store.upsertCursorCalls[0].LastSyncVersion != 0 {
		t.Fatalf("initial cursor = %d, want 0", store.upsertCursorCalls[0].LastSyncVersion)
	}
	if store.upsertCursorCalls[1].LastSyncVersion != result.LastSyncVersion {
		t.Fatalf("final cursor = %d, want %d", store.upsertCursorCalls[1].LastSyncVersion, result.LastSyncVersion)
	}
}

func TestListTemplateItemsRejectsInvalidKind(t *testing.T) {
	service := NewService(newFakeStore())
	_, err := service.ListTemplateItems(context.Background(), 7, "drink")
	if !errors.Is(err, ErrInvalidTemplateKind) {
		t.Fatalf("error = %v, want ErrInvalidTemplateKind", err)
	}
}

var _ Store = (*fakeStore)(nil)
