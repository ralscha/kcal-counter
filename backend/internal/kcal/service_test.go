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
	templates         map[uuid.UUID]sqlc.KcalTemplateItem
	entries           map[uuid.UUID]sqlc.KcalEntry
	upsertCursorCalls []sqlc.UpsertDeviceSyncStateParams
	minValidVersion   int64
	globalVersion     int64
	listTemplateItems []sqlc.KcalTemplateItem
	listEntries       []sqlc.KcalEntry
	total             int64
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		templates: map[uuid.UUID]sqlc.KcalTemplateItem{},
		entries:   map[uuid.UUID]sqlc.KcalEntry{},
	}
}

func (f *fakeStore) WithTx(_ context.Context, fn func(Store) error) error {
	return fn(f)
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
	f.entries[arg.ID] = entry
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
	f.templates[arg.ID] = item
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
	entry, ok := f.entries[arg.ID]
	if !ok || entry.UserID != arg.UserID || entry.DeletedAt.Valid {
		return sqlc.KcalEntry{}, sql.ErrNoRows
	}
	entry.ClientUpdatedAt = arg.ClientUpdatedAt
	entry.ServerUpdatedAt = arg.ServerUpdatedAt
	entry.GlobalVersion = f.nextVersion()
	entry.DeletedAt = sql.NullTime{Time: arg.ServerUpdatedAt, Valid: true}
	f.entries[arg.ID] = entry
	return entry, nil
}

func (f *fakeStore) DeleteKcalTemplateItem(_ context.Context, arg sqlc.DeleteKcalTemplateItemParams) (sqlc.KcalTemplateItem, error) {
	item, ok := f.templates[arg.ID]
	if !ok || item.UserID != arg.UserID || item.DeletedAt.Valid {
		return sqlc.KcalTemplateItem{}, sql.ErrNoRows
	}
	item.ClientUpdatedAt = arg.ClientUpdatedAt
	item.ServerUpdatedAt = arg.ServerUpdatedAt
	item.GlobalVersion = f.nextVersion()
	item.DeletedAt = sql.NullTime{Time: arg.ServerUpdatedAt, Valid: true}
	f.templates[arg.ID] = item
	return item, nil
}

func (f *fakeStore) EnsureSyncMetadataRow(context.Context, int64) error {
	return nil
}

func (f *fakeStore) GetKcalEntryByID(_ context.Context, arg sqlc.GetKcalEntryByIDParams) (sqlc.KcalEntry, error) {
	entry, ok := f.entries[arg.ID]
	if !ok || entry.UserID != arg.UserID {
		return sqlc.KcalEntry{}, sql.ErrNoRows
	}
	return entry, nil
}

func (f *fakeStore) GetKcalEntryForUpdate(ctx context.Context, arg sqlc.GetKcalEntryForUpdateParams) (sqlc.KcalEntry, error) {
	return f.GetKcalEntryByID(ctx, sqlc.GetKcalEntryByIDParams(arg))
}

func (f *fakeStore) GetKcalTemplateItemByID(_ context.Context, arg sqlc.GetKcalTemplateItemByIDParams) (sqlc.KcalTemplateItem, error) {
	item, ok := f.templates[arg.ID]
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

func (f *fakeStore) ListSyncSnapshot(_ context.Context, userID int64) ([]sqlc.ListSyncSnapshotRow, error) {
	rows := make([]sqlc.ListSyncSnapshotRow, 0)
	for _, item := range f.templates {
		if item.UserID != userID || item.DeletedAt.Valid {
			continue
		}
		rows = append(rows, sqlc.ListSyncSnapshotRow{
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
		})
	}
	for _, entry := range f.entries {
		if entry.UserID != userID || entry.DeletedAt.Valid {
			continue
		}
		rows = append(rows, sqlc.ListSyncSnapshotRow{
			EntityTable:     EntityTableEntries,
			ID:              entry.ID,
			KcalDelta:       sql.NullInt32{Int32: entry.KcalDelta, Valid: true},
			HappenedAt:      sql.NullTime{Time: entry.HappenedAt, Valid: true},
			ClientUpdatedAt: entry.ClientUpdatedAt,
			ServerUpdatedAt: entry.ServerUpdatedAt,
			GlobalVersion:   entry.GlobalVersion,
		})
	}
	return rows, nil
}

func (f *fakeStore) ReadSyncMetadata(_ context.Context, _ int64) (sqlc.ReadSyncMetadataRow, error) {
	currentVersion := f.minValidVersion
	for _, item := range f.templates {
		if item.GlobalVersion > currentVersion {
			currentVersion = item.GlobalVersion
		}
	}
	for _, entry := range f.entries {
		if entry.GlobalVersion > currentVersion {
			currentVersion = entry.GlobalVersion
		}
	}
	return sqlc.ReadSyncMetadataRow{CurrentVersion: currentVersion, MinValidVersion: f.minValidVersion}, nil
}

func (f *fakeStore) UpdateKcalEntry(_ context.Context, arg sqlc.UpdateKcalEntryParams) (sqlc.KcalEntry, error) {
	entry, ok := f.entries[arg.ID]
	if !ok || entry.UserID != arg.UserID {
		return sqlc.KcalEntry{}, sql.ErrNoRows
	}
	entry.KcalDelta = arg.KcalDelta
	entry.HappenedAt = arg.HappenedAt
	entry.ClientUpdatedAt = arg.ClientUpdatedAt
	entry.ServerUpdatedAt = arg.ServerUpdatedAt
	entry.DeletedAt = arg.DeletedAt
	entry.GlobalVersion = f.nextVersion()
	f.entries[arg.ID] = entry
	return entry, nil
}

func (f *fakeStore) UpdateKcalTemplateItem(_ context.Context, arg sqlc.UpdateKcalTemplateItemParams) (sqlc.KcalTemplateItem, error) {
	item, ok := f.templates[arg.ID]
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
	f.templates[arg.ID] = item
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
	store.entries[entryID] = sqlc.KcalEntry{
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
	store.templates[templateID] = sqlc.KcalTemplateItem{
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
