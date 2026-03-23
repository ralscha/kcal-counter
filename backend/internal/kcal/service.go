package kcal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"kcal-counter/internal/store/sqlc"
)

const (
	EntityTableTemplateItems = "kcal_template_items"
	EntityTableEntries       = "kcal_entries"
	tombstoneRetention       = 30 * 24 * time.Hour
)

var ErrInvalidTemplateKind = errors.New("invalid template kind")

type Store interface {
	BumpMinValidVersion(context.Context, sqlc.BumpMinValidVersionParams) error
	CreateKcalEntry(context.Context, sqlc.CreateKcalEntryParams) (sqlc.KcalEntry, error)
	CreateKcalTemplateItem(context.Context, sqlc.CreateKcalTemplateItemParams) (sqlc.KcalTemplateItem, error)
	DeleteExpiredEntryTombstones(context.Context, sqlc.DeleteExpiredEntryTombstonesParams) ([]int64, error)
	DeleteExpiredTemplateTombstones(context.Context, sqlc.DeleteExpiredTemplateTombstonesParams) ([]int64, error)
	DeleteKcalEntry(context.Context, sqlc.DeleteKcalEntryParams) (sqlc.KcalEntry, error)
	DeleteKcalTemplateItem(context.Context, sqlc.DeleteKcalTemplateItemParams) (sqlc.KcalTemplateItem, error)
	EnsureSyncMetadataRow(context.Context, int64) error
	GetKcalEntryByID(context.Context, sqlc.GetKcalEntryByIDParams) (sqlc.KcalEntry, error)
	GetKcalEntryForUpdate(context.Context, sqlc.GetKcalEntryForUpdateParams) (sqlc.KcalEntry, error)
	GetKcalTemplateItemByID(context.Context, sqlc.GetKcalTemplateItemByIDParams) (sqlc.KcalTemplateItem, error)
	GetKcalTemplateItemForUpdate(context.Context, sqlc.GetKcalTemplateItemForUpdateParams) (sqlc.KcalTemplateItem, error)
	GetKcalTotalInRange(context.Context, sqlc.GetKcalTotalInRangeParams) (int64, error)
	ListKcalEntriesInRange(context.Context, sqlc.ListKcalEntriesInRangeParams) ([]sqlc.KcalEntry, error)
	ListKcalTemplateItemsByKind(context.Context, sqlc.ListKcalTemplateItemsByKindParams) ([]sqlc.KcalTemplateItem, error)
	ListSyncRecordsSince(context.Context, sqlc.ListSyncRecordsSinceParams) ([]sqlc.ListSyncRecordsSinceRow, error)
	ListSyncSnapshot(context.Context, int64) ([]sqlc.ListSyncSnapshotRow, error)
	ReadSyncMetadata(context.Context, int64) (sqlc.ReadSyncMetadataRow, error)
	UpdateKcalEntry(context.Context, sqlc.UpdateKcalEntryParams) (sqlc.KcalEntry, error)
	UpdateKcalTemplateItem(context.Context, sqlc.UpdateKcalTemplateItemParams) (sqlc.KcalTemplateItem, error)
	UpsertDeviceSyncState(context.Context, sqlc.UpsertDeviceSyncStateParams) error
	WithTx(context.Context, func(Store) error) error
}

type Service struct {
	store Store
}

type TemplateItem struct {
	ID         uuid.UUID `json:"id"`
	Kind       string    `json:"kind"`
	Name       string    `json:"name"`
	Amount     string    `json:"amount"`
	Unit       string    `json:"unit"`
	KcalAmount int32     `json:"kcal_amount"`
}

type Entry struct {
	ID         uuid.UUID `json:"id"`
	KcalDelta  int32     `json:"kcal_delta"`
	HappenedAt time.Time `json:"happened_at"`
}

type TemplateItemInput struct {
	ID         *uuid.UUID
	Kind       string
	Name       string
	Amount     string
	Unit       string
	KcalAmount int32
}

type EntryInput struct {
	ID         *uuid.UUID
	KcalDelta  int32
	HappenedAt time.Time
}

type SyncRecord struct {
	EntityTable     string     `json:"entity_table"`
	ID              uuid.UUID  `json:"id"`
	Kind            string     `json:"kind,omitempty"`
	Name            string     `json:"name,omitempty"`
	Amount          string     `json:"amount,omitempty"`
	Unit            string     `json:"unit,omitempty"`
	KcalAmount      int32      `json:"kcal_amount,omitempty"`
	KcalDelta       int32      `json:"kcal_delta,omitempty"`
	HappenedAt      *time.Time `json:"happened_at,omitempty"`
	Deleted         bool       `json:"deleted"`
	ClientUpdatedAt time.Time  `json:"client_updated_at"`
	GlobalVersion   int64      `json:"global_version,omitempty"`
	ServerUpdatedAt *time.Time `json:"server_updated_at,omitempty"`
}

type SyncInput struct {
	DeviceID        uuid.UUID
	LastSyncVersion int64
	Changes         []SyncRecord
}

type SyncPushResult struct {
	Applied bool       `json:"applied"`
	Record  SyncRecord `json:"record"`
}

type SyncResult struct {
	ResetRequired   bool             `json:"reset_required"`
	ResetReason     string           `json:"reset_reason,omitempty"`
	LastSyncVersion int64            `json:"last_sync_seq"`
	MinValidVersion int64            `json:"min_valid_seq"`
	PushResults     []SyncPushResult `json:"push_results"`
	PullChanges     []SyncRecord     `json:"pull_changes"`
}

func NewService(store Store) *Service {
	return &Service{store: store}
}

type storeWrapper struct {
	*sqlc.Queries
	db sqlc.DBTX
}

func (w *storeWrapper) WithTx(ctx context.Context, fn func(Store) error) error {
	dtx, ok := w.db.(*sql.DB)
	if !ok {
		return fn(w)
	}
	tx, err := dtx.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	qtx := &storeWrapper{
		Queries: w.Queries.WithTx(tx),
		db:      tx,
	}
	if err := fn(qtx); err != nil {
		return err
	}
	return tx.Commit()
}

func NewStore(db sqlc.DBTX) Store {
	return &storeWrapper{
		Queries: sqlc.New(db),
		db:      db,
	}
}

func (s *Service) ListTemplateItems(ctx context.Context, userID int64, kind string) ([]TemplateItem, error) {
	parsedKind, err := parseTemplateKind(kind)
	if err != nil {
		return nil, err
	}

	items, err := s.store.ListKcalTemplateItemsByKind(ctx, sqlc.ListKcalTemplateItemsByKindParams{UserID: userID, Kind: parsedKind})
	if err != nil {
		return nil, err
	}

	result := make([]TemplateItem, 0, len(items))
	for _, item := range items {
		result = append(result, mapTemplateItem(item))
	}
	return result, nil
}

func (s *Service) ListEntriesInRange(ctx context.Context, userID int64, from, to time.Time) ([]Entry, error) {
	entries, err := s.store.ListKcalEntriesInRange(ctx, sqlc.ListKcalEntriesInRangeParams{UserID: userID, HappenedAt: from.UTC(), HappenedAt_2: to.UTC()})
	if err != nil {
		return nil, err
	}

	result := make([]Entry, 0, len(entries))
	for _, entry := range entries {
		result = append(result, mapEntry(entry))
	}
	return result, nil
}

func (s *Service) GetTotalInRange(ctx context.Context, userID int64, from, to time.Time) (int64, error) {
	return s.store.GetKcalTotalInRange(ctx, sqlc.GetKcalTotalInRangeParams{UserID: userID, HappenedAt: from.UTC(), HappenedAt_2: to.UTC()})
}

func (s *Service) CreateTemplateItem(ctx context.Context, userID int64, input TemplateItemInput) (TemplateItem, error) {
	itemID := uuid.New()
	if input.ID != nil {
		itemID = *input.ID
	}
	now := time.Now().UTC()
	item, err := s.createTemplateItem(ctx, userID, itemID, input, now, now, sql.NullTime{})
	if err != nil {
		return TemplateItem{}, err
	}
	return mapTemplateItem(item), nil
}

func (s *Service) UpdateTemplateItem(ctx context.Context, userID int64, itemID uuid.UUID, input TemplateItemInput) (TemplateItem, error) {
	current, err := s.store.GetKcalTemplateItemByID(ctx, sqlc.GetKcalTemplateItemByIDParams{ID: itemID, UserID: userID})
	if err != nil {
		return TemplateItem{}, err
	}
	if current.DeletedAt.Valid {
		return TemplateItem{}, sql.ErrNoRows
	}

	now := time.Now().UTC()
	item, err := s.updateTemplateItem(ctx, userID, itemID, input, now, now, sql.NullTime{})
	if err != nil {
		return TemplateItem{}, err
	}
	return mapTemplateItem(item), nil
}

func (s *Service) DeleteTemplateItem(ctx context.Context, userID int64, itemID uuid.UUID) error {
	current, err := s.store.GetKcalTemplateItemByID(ctx, sqlc.GetKcalTemplateItemByIDParams{ID: itemID, UserID: userID})
	if err != nil {
		return err
	}
	if current.DeletedAt.Valid {
		return sql.ErrNoRows
	}

	now := time.Now().UTC()
	_, err = s.store.DeleteKcalTemplateItem(ctx, sqlc.DeleteKcalTemplateItemParams{
		ID:              itemID,
		UserID:          userID,
		ClientUpdatedAt: now,
		ServerUpdatedAt: now,
	})
	return err
}

func (s *Service) CreateEntry(ctx context.Context, userID int64, input EntryInput) (Entry, error) {
	entryID := uuid.New()
	if input.ID != nil {
		entryID = *input.ID
	}
	now := time.Now().UTC()
	entry, err := s.createEntry(ctx, userID, entryID, input, now, now, sql.NullTime{})
	if err != nil {
		return Entry{}, err
	}
	return mapEntry(entry), nil
}

func (s *Service) UpdateEntry(ctx context.Context, userID int64, entryID uuid.UUID, input EntryInput) (Entry, error) {
	current, err := s.store.GetKcalEntryByID(ctx, sqlc.GetKcalEntryByIDParams{ID: entryID, UserID: userID})
	if err != nil {
		return Entry{}, err
	}
	if current.DeletedAt.Valid {
		return Entry{}, sql.ErrNoRows
	}

	now := time.Now().UTC()
	entry, err := s.updateEntry(ctx, userID, entryID, input, now, now, sql.NullTime{})
	if err != nil {
		return Entry{}, err
	}
	return mapEntry(entry), nil
}

func (s *Service) DeleteEntry(ctx context.Context, userID int64, entryID uuid.UUID) error {
	current, err := s.store.GetKcalEntryByID(ctx, sqlc.GetKcalEntryByIDParams{ID: entryID, UserID: userID})
	if err != nil {
		return err
	}
	if current.DeletedAt.Valid {
		return sql.ErrNoRows
	}

	now := time.Now().UTC()
	_, err = s.store.DeleteKcalEntry(ctx, sqlc.DeleteKcalEntryParams{
		ID:              entryID,
		UserID:          userID,
		ClientUpdatedAt: now,
		ServerUpdatedAt: now,
	})
	return err
}

func (s *Service) Sync(ctx context.Context, userID int64, input SyncInput) (SyncResult, error) {
	if input.LastSyncVersion < 0 {
		input.LastSyncVersion = 0
	}

	var result SyncResult
	err := s.store.WithTx(ctx, func(txStore Store) error {
		if err := txStore.EnsureSyncMetadataRow(ctx, userID); err != nil {
			return err
		}

		if err := txStore.UpsertDeviceSyncState(ctx, sqlc.UpsertDeviceSyncStateParams{
			UserID:          userID,
			DeviceID:        input.DeviceID,
			LastSyncVersion: input.LastSyncVersion,
		}); err != nil {
			return err
		}

		if err := compactExpiredDeletes(ctx, txStore, userID, time.Now().UTC()); err != nil {
			return err
		}

		meta, err := txStore.ReadSyncMetadata(ctx, userID)
		if err != nil {
			return err
		}

		if input.LastSyncVersion < meta.MinValidVersion {
			snapshotRows, err := txStore.ListSyncSnapshot(ctx, userID)
			if err != nil {
				return err
			}

			result = SyncResult{
				ResetRequired:   true,
				ResetReason:     "client cursor is older than the retained tombstone history",
				LastSyncVersion: meta.CurrentVersion,
				MinValidVersion: meta.MinValidVersion,
				PushResults:     []SyncPushResult{},
				PullChanges:     syncSnapshotRowsToRecords(snapshotRows),
			}
			return nil
		}

		pushResults := make([]SyncPushResult, 0, len(input.Changes))
		for _, change := range input.Changes {
			pushResult, err := applyClientChange(ctx, txStore, userID, change)
			if err != nil {
				return err
			}
			pushResults = append(pushResults, pushResult)
		}

		meta, err = txStore.ReadSyncMetadata(ctx, userID)
		if err != nil {
			return err
		}

		pullRows, err := txStore.ListSyncRecordsSince(ctx, sqlc.ListSyncRecordsSinceParams{
			UserID:        userID,
			GlobalVersion: input.LastSyncVersion,
		})
		if err != nil {
			return err
		}

		if err := txStore.UpsertDeviceSyncState(ctx, sqlc.UpsertDeviceSyncStateParams{
			UserID:          userID,
			DeviceID:        input.DeviceID,
			LastSyncVersion: meta.CurrentVersion,
		}); err != nil {
			return err
		}

		result = SyncResult{
			ResetRequired:   false,
			LastSyncVersion: meta.CurrentVersion,
			MinValidVersion: meta.MinValidVersion,
			PushResults:     pushResults,
			PullChanges:     syncRowsToRecords(pullRows),
		}
		return nil
	})

	return result, err
}

func applyClientChange(ctx context.Context, store Store, userID int64, change SyncRecord) (SyncPushResult, error) {
	normalized := normalizeSyncRecord(change)
	if normalized.ID == uuid.Nil {
		return SyncPushResult{}, errors.New("sync change id is required")
	}
	if normalized.ClientUpdatedAt.IsZero() {
		return SyncPushResult{}, fmt.Errorf("sync change %s is missing client_updated_at", normalized.ID)
	}

	switch normalized.EntityTable {
	case EntityTableTemplateItems:
		return applyTemplateChange(ctx, store, userID, normalized)
	case EntityTableEntries:
		return applyEntryChange(ctx, store, userID, normalized)
	default:
		return SyncPushResult{}, fmt.Errorf("unsupported entity_table %q", change.EntityTable)
	}
}

func applyTemplateChange(ctx context.Context, store Store, userID int64, change SyncRecord) (SyncPushResult, error) {
	parsedKind, err := parseTemplateKind(change.Kind)
	if err != nil {
		return SyncPushResult{}, err
	}
	if strings.TrimSpace(change.Name) == "" {
		return SyncPushResult{}, fmt.Errorf("template %s name is required", change.ID)
	}
	if strings.TrimSpace(change.Amount) == "" {
		return SyncPushResult{}, fmt.Errorf("template %s amount is required", change.ID)
	}
	if strings.TrimSpace(change.Unit) == "" {
		return SyncPushResult{}, fmt.Errorf("template %s unit is required", change.ID)
	}
	if change.KcalAmount <= 0 {
		return SyncPushResult{}, fmt.Errorf("template %s kcal_amount must be positive", change.ID)
	}

	current, found, err := getTemplateForUpdate(ctx, store, userID, change.ID)
	if err != nil {
		return SyncPushResult{}, err
	}
	if found && change.ClientUpdatedAt.Before(current.ClientUpdatedAt) {
		return SyncPushResult{Applied: false, Record: syncRecordFromTemplateItem(current)}, nil
	}

	now := time.Now().UTC()
	deletedAt := deletedAtForChange(change.Deleted, now)

	var stored sqlc.KcalTemplateItem
	if found {
		stored, err = store.UpdateKcalTemplateItem(ctx, sqlc.UpdateKcalTemplateItemParams{
			ID:              change.ID,
			UserID:          userID,
			Kind:            parsedKind,
			Name:            change.Name,
			Amount:          change.Amount,
			Unit:            change.Unit,
			KcalAmount:      change.KcalAmount,
			ClientUpdatedAt: change.ClientUpdatedAt.UTC(),
			ServerUpdatedAt: now,
			DeletedAt:       deletedAt,
		})
	} else {
		stored, err = store.CreateKcalTemplateItem(ctx, sqlc.CreateKcalTemplateItemParams{
			ID:              change.ID,
			UserID:          userID,
			Kind:            parsedKind,
			Name:            change.Name,
			Amount:          change.Amount,
			Unit:            change.Unit,
			KcalAmount:      change.KcalAmount,
			ClientUpdatedAt: change.ClientUpdatedAt.UTC(),
			ServerUpdatedAt: now,
			DeletedAt:       deletedAt,
		})
	}
	if err != nil {
		return SyncPushResult{}, err
	}

	return SyncPushResult{Applied: true, Record: syncRecordFromTemplateItem(stored)}, nil
}

func applyEntryChange(ctx context.Context, store Store, userID int64, change SyncRecord) (SyncPushResult, error) {
	if change.HappenedAt == nil || change.HappenedAt.IsZero() {
		return SyncPushResult{}, fmt.Errorf("entry %s happened_at is required", change.ID)
	}
	if change.KcalDelta == 0 {
		return SyncPushResult{}, fmt.Errorf("entry %s kcal_delta must be non-zero", change.ID)
	}

	current, found, err := getEntryForUpdate(ctx, store, userID, change.ID)
	if err != nil {
		return SyncPushResult{}, err
	}
	if found && change.ClientUpdatedAt.Before(current.ClientUpdatedAt) {
		return SyncPushResult{Applied: false, Record: syncRecordFromEntry(current)}, nil
	}

	now := time.Now().UTC()
	deletedAt := deletedAtForChange(change.Deleted, now)

	var stored sqlc.KcalEntry
	if found {
		stored, err = store.UpdateKcalEntry(ctx, sqlc.UpdateKcalEntryParams{
			ID:              change.ID,
			UserID:          userID,
			KcalDelta:       change.KcalDelta,
			HappenedAt:      change.HappenedAt.UTC(),
			ClientUpdatedAt: change.ClientUpdatedAt.UTC(),
			ServerUpdatedAt: now,
			DeletedAt:       deletedAt,
		})
	} else {
		stored, err = store.CreateKcalEntry(ctx, sqlc.CreateKcalEntryParams{
			ID:              change.ID,
			UserID:          userID,
			KcalDelta:       change.KcalDelta,
			HappenedAt:      change.HappenedAt.UTC(),
			ClientUpdatedAt: change.ClientUpdatedAt.UTC(),
			ServerUpdatedAt: now,
			DeletedAt:       deletedAt,
		})
	}
	if err != nil {
		return SyncPushResult{}, err
	}

	return SyncPushResult{Applied: true, Record: syncRecordFromEntry(stored)}, nil
}

func compactExpiredDeletes(ctx context.Context, store Store, userID int64, now time.Time) error {
	cutoff := now.Add(-tombstoneRetention)
	templateVersions, err := store.DeleteExpiredTemplateTombstones(ctx, sqlc.DeleteExpiredTemplateTombstonesParams{
		UserID:          userID,
		ServerUpdatedAt: cutoff,
	})
	if err != nil {
		return err
	}
	entryVersions, err := store.DeleteExpiredEntryTombstones(ctx, sqlc.DeleteExpiredEntryTombstonesParams{
		UserID:          userID,
		ServerUpdatedAt: cutoff,
	})
	if err != nil {
		return err
	}

	maxPurgedVersion := int64(0)
	for _, version := range templateVersions {
		if version > maxPurgedVersion {
			maxPurgedVersion = version
		}
	}
	for _, version := range entryVersions {
		if version > maxPurgedVersion {
			maxPurgedVersion = version
		}
	}
	if maxPurgedVersion == 0 {
		return nil
	}

	return store.BumpMinValidVersion(ctx, sqlc.BumpMinValidVersionParams{
		UserID:          userID,
		MinValidVersion: maxPurgedVersion,
	})
}

func getTemplateForUpdate(ctx context.Context, store Store, userID int64, id uuid.UUID) (sqlc.KcalTemplateItem, bool, error) {
	row, err := store.GetKcalTemplateItemForUpdate(ctx, sqlc.GetKcalTemplateItemForUpdateParams{ID: id, UserID: userID})
	if errors.Is(err, sql.ErrNoRows) {
		return sqlc.KcalTemplateItem{}, false, nil
	}
	if err != nil {
		return sqlc.KcalTemplateItem{}, false, err
	}
	return row, true, nil
}

func getEntryForUpdate(ctx context.Context, store Store, userID int64, id uuid.UUID) (sqlc.KcalEntry, bool, error) {
	row, err := store.GetKcalEntryForUpdate(ctx, sqlc.GetKcalEntryForUpdateParams{ID: id, UserID: userID})
	if errors.Is(err, sql.ErrNoRows) {
		return sqlc.KcalEntry{}, false, nil
	}
	if err != nil {
		return sqlc.KcalEntry{}, false, err
	}
	return row, true, nil
}

func parseTemplateKind(kind string) (sqlc.KcalTemplateKind, error) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case string(sqlc.KcalTemplateKindFood):
		return sqlc.KcalTemplateKindFood, nil
	case string(sqlc.KcalTemplateKindActivity):
		return sqlc.KcalTemplateKindActivity, nil
	default:
		return "", fmt.Errorf("%w: %q", ErrInvalidTemplateKind, kind)
	}
}

func normalizeSyncRecord(change SyncRecord) SyncRecord {
	change.EntityTable = strings.ToLower(strings.TrimSpace(change.EntityTable))
	change.Kind = strings.ToLower(strings.TrimSpace(change.Kind))
	change.Name = strings.TrimSpace(change.Name)
	change.Amount = strings.TrimSpace(change.Amount)
	change.Unit = strings.TrimSpace(change.Unit)
	change.ClientUpdatedAt = change.ClientUpdatedAt.UTC()
	if change.HappenedAt != nil {
		happenedAt := change.HappenedAt.UTC()
		change.HappenedAt = &happenedAt
	}
	return change
}

func deletedAtForChange(deleted bool, now time.Time) sql.NullTime {
	if !deleted {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: now.UTC(), Valid: true}
}

func syncRowsToRecords(rows []sqlc.ListSyncRecordsSinceRow) []SyncRecord {
	records := make([]SyncRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, syncRecordFromListRow(row))
	}
	return records
}

func syncSnapshotRowsToRecords(rows []sqlc.ListSyncSnapshotRow) []SyncRecord {
	records := make([]SyncRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, syncRecordFromSnapshotRow(row))
	}
	return records
}

func syncRecordFromTemplateItem(item sqlc.KcalTemplateItem) SyncRecord {
	serverUpdatedAt := item.ServerUpdatedAt.UTC()
	return SyncRecord{
		EntityTable:     EntityTableTemplateItems,
		ID:              item.ID,
		Kind:            string(item.Kind),
		Name:            item.Name,
		Amount:          item.Amount,
		Unit:            item.Unit,
		KcalAmount:      item.KcalAmount,
		Deleted:         item.DeletedAt.Valid,
		ClientUpdatedAt: item.ClientUpdatedAt.UTC(),
		GlobalVersion:   item.GlobalVersion,
		ServerUpdatedAt: &serverUpdatedAt,
	}
}

func syncRecordFromEntry(item sqlc.KcalEntry) SyncRecord {
	happenedAt := item.HappenedAt.UTC()
	serverUpdatedAt := item.ServerUpdatedAt.UTC()
	return SyncRecord{
		EntityTable:     EntityTableEntries,
		ID:              item.ID,
		KcalDelta:       item.KcalDelta,
		HappenedAt:      &happenedAt,
		Deleted:         item.DeletedAt.Valid,
		ClientUpdatedAt: item.ClientUpdatedAt.UTC(),
		GlobalVersion:   item.GlobalVersion,
		ServerUpdatedAt: &serverUpdatedAt,
	}
}

func syncRecordFromListRow(row sqlc.ListSyncRecordsSinceRow) SyncRecord {
	record := SyncRecord{
		EntityTable:     row.EntityTable,
		ID:              row.ID,
		Deleted:         row.Deleted,
		ClientUpdatedAt: row.ClientUpdatedAt.UTC(),
		GlobalVersion:   row.GlobalVersion,
	}
	serverUpdatedAt := row.ServerUpdatedAt.UTC()
	record.ServerUpdatedAt = &serverUpdatedAt

	if row.EntityTable == EntityTableTemplateItems {
		record.Kind = row.Kind
		record.Name = row.Name
		record.Amount = row.Amount
		record.Unit = row.Unit
		record.KcalAmount = row.KcalAmount
		return record
	}

	record.KcalDelta = row.KcalDelta.Int32
	if row.HappenedAt.Valid {
		happenedAt := row.HappenedAt.Time.UTC()
		record.HappenedAt = &happenedAt
	}
	return record
}

func syncRecordFromSnapshotRow(row sqlc.ListSyncSnapshotRow) SyncRecord {
	record := SyncRecord{
		EntityTable:     row.EntityTable,
		ID:              row.ID,
		Deleted:         row.Deleted,
		ClientUpdatedAt: row.ClientUpdatedAt.UTC(),
		GlobalVersion:   row.GlobalVersion,
	}
	serverUpdatedAt := row.ServerUpdatedAt.UTC()
	record.ServerUpdatedAt = &serverUpdatedAt

	if row.EntityTable == EntityTableTemplateItems {
		record.Kind = row.Kind
		record.Name = row.Name
		record.Amount = row.Amount
		record.Unit = row.Unit
		record.KcalAmount = row.KcalAmount
		return record
	}

	record.KcalDelta = row.KcalDelta.Int32
	if row.HappenedAt.Valid {
		happenedAt := row.HappenedAt.Time.UTC()
		record.HappenedAt = &happenedAt
	}
	return record
}

func mapTemplateItem(item sqlc.KcalTemplateItem) TemplateItem {
	return TemplateItem{
		ID:         item.ID,
		Kind:       string(item.Kind),
		Name:       item.Name,
		Amount:     item.Amount,
		Unit:       item.Unit,
		KcalAmount: item.KcalAmount,
	}
}

func mapEntry(item sqlc.KcalEntry) Entry {
	return Entry{
		ID:         item.ID,
		KcalDelta:  item.KcalDelta,
		HappenedAt: item.HappenedAt.UTC(),
	}
}

func (s *Service) createTemplateItem(ctx context.Context, userID int64, itemID uuid.UUID, input TemplateItemInput, clientUpdatedAt, serverUpdatedAt time.Time, deletedAt sql.NullTime) (sqlc.KcalTemplateItem, error) {
	parsedKind, err := parseTemplateKind(input.Kind)
	if err != nil {
		return sqlc.KcalTemplateItem{}, err
	}

	return s.store.CreateKcalTemplateItem(ctx, sqlc.CreateKcalTemplateItemParams{
		ID:              itemID,
		UserID:          userID,
		Kind:            parsedKind,
		Name:            strings.TrimSpace(input.Name),
		Amount:          strings.TrimSpace(input.Amount),
		Unit:            strings.TrimSpace(input.Unit),
		KcalAmount:      input.KcalAmount,
		ClientUpdatedAt: clientUpdatedAt.UTC(),
		ServerUpdatedAt: serverUpdatedAt.UTC(),
		DeletedAt:       deletedAt,
	})
}

func (s *Service) updateTemplateItem(ctx context.Context, userID int64, itemID uuid.UUID, input TemplateItemInput, clientUpdatedAt, serverUpdatedAt time.Time, deletedAt sql.NullTime) (sqlc.KcalTemplateItem, error) {
	parsedKind, err := parseTemplateKind(input.Kind)
	if err != nil {
		return sqlc.KcalTemplateItem{}, err
	}

	return s.store.UpdateKcalTemplateItem(ctx, sqlc.UpdateKcalTemplateItemParams{
		ID:              itemID,
		UserID:          userID,
		Kind:            parsedKind,
		Name:            strings.TrimSpace(input.Name),
		Amount:          strings.TrimSpace(input.Amount),
		Unit:            strings.TrimSpace(input.Unit),
		KcalAmount:      input.KcalAmount,
		ClientUpdatedAt: clientUpdatedAt.UTC(),
		ServerUpdatedAt: serverUpdatedAt.UTC(),
		DeletedAt:       deletedAt,
	})
}

func (s *Service) createEntry(ctx context.Context, userID int64, entryID uuid.UUID, input EntryInput, clientUpdatedAt, serverUpdatedAt time.Time, deletedAt sql.NullTime) (sqlc.KcalEntry, error) {
	return s.store.CreateKcalEntry(ctx, sqlc.CreateKcalEntryParams{
		ID:              entryID,
		UserID:          userID,
		KcalDelta:       input.KcalDelta,
		HappenedAt:      input.HappenedAt.UTC(),
		ClientUpdatedAt: clientUpdatedAt.UTC(),
		ServerUpdatedAt: serverUpdatedAt.UTC(),
		DeletedAt:       deletedAt,
	})
}

func (s *Service) updateEntry(ctx context.Context, userID int64, entryID uuid.UUID, input EntryInput, clientUpdatedAt, serverUpdatedAt time.Time, deletedAt sql.NullTime) (sqlc.KcalEntry, error) {
	return s.store.UpdateKcalEntry(ctx, sqlc.UpdateKcalEntryParams{
		ID:              entryID,
		UserID:          userID,
		KcalDelta:       input.KcalDelta,
		HappenedAt:      input.HappenedAt.UTC(),
		ClientUpdatedAt: clientUpdatedAt.UTC(),
		ServerUpdatedAt: serverUpdatedAt.UTC(),
		DeletedAt:       deletedAt,
	})
}
