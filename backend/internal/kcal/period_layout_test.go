package kcal

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"kcal-counter/internal/store/sqlc"
)

func TestSyncRejectsConflictingPeriodGroupAndKeepsIndependentChanges(t *testing.T) {
	store := newFakeStore()
	service := NewService(store)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	sync := func(cursor int64, changes ...SyncRecord) SyncResult {
		t.Helper()
		result, err := service.Sync(context.Background(), 7, SyncInput{DeviceID: uuid.New(), LastSyncVersion: cursor, Changes: changes})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := SyncRecord{EntityTable: EntityTablePeriods, ID: uuid.New(), StartDate: "2026-10-01", EndDate: "2026-10-09", ClientUpdatedAt: now}
	second := SyncRecord{EntityTable: EntityTablePeriods, ID: uuid.New(), StartDate: "2026-10-10", EndDate: "2026-10-14", ClientUpdatedAt: now.Add(time.Hour)}
	active := SyncRecord{EntityTable: EntityTablePeriodStarts, ID: periodStartUUID, CycleStartDate: new("2026-10-15"), ClientUpdatedAt: second.ClientUpdatedAt}
	created := sync(0, first, second, active)
	staleFirst, staleActive := first, active
	staleFirst.EndDate, staleFirst.ClientUpdatedAt = "2026-10-19", now.Add(2*time.Hour)
	staleActive.CycleStartDate, staleActive.ClientUpdatedAt = new("2026-10-20"), staleFirst.ClientUpdatedAt
	entry := SyncRecord{EntityTable: EntityTableEntries, ID: uuid.New(), KcalDelta: 123, HappenedAt: &now, ClientUpdatedAt: now}
	conflict := sync(created.LastSyncVersion, staleFirst, staleActive, entry)
	if len(conflict.PushResults) != 3 || conflict.PushResults[0].Applied || conflict.PushResults[1].Applied || !conflict.PushResults[2].Applied {
		t.Fatalf("period conflict blocked independent entry or accepted invalid group: %+v", conflict)
	}
	if conflict.PushResults[0].Record.EndDate != first.EndDate || *conflict.PushResults[1].Record.CycleStartDate != *active.CycleStartDate {
		t.Fatalf("conflict did not return original authoritative layout: %+v", conflict.PushResults)
	}
	if len(conflict.PullChanges) != 1 || conflict.PullChanges[0].ID != entry.ID || conflict.LastSyncVersion != created.LastSyncVersion+1 {
		t.Fatalf("rejected period mutations changed server history: %+v", conflict)
	}
	// A new archive must also be rejected when its matching active-start change
	// loses LWW; otherwise it would overlap the still-current active period.
	newArchive := SyncRecord{EntityTable: EntityTablePeriods, ID: uuid.New(), StartDate: "2026-10-15", EndDate: "2026-10-19", ClientUpdatedAt: now}
	staleActive.ClientUpdatedAt = now
	rejected := sync(conflict.LastSyncVersion, newArchive, staleActive)
	if rejected.PushResults[0].Applied || !rejected.PushResults[0].Record.Deleted || rejected.PushResults[0].Record.ID != newArchive.ID || rejected.PushResults[0].Record.GlobalVersion != 0 || rejected.PushResults[1].Applied || *rejected.PushResults[1].Record.CycleStartDate != "2026-10-15" {
		t.Fatalf("new archive conflict did not undo the tentative local layout: %+v", rejected)
	}
	if _, exists := store.periods[trackingKey{7, newArchive.ID}]; exists || rejected.LastSyncVersion != conflict.LastSyncVersion {
		t.Fatal("rejected new archive was persisted")
	}
	// Retrying intentionally with the current active period and newer timestamps
	// forms a valid archive group and proceeds normally.
	newArchive.ClientUpdatedAt, staleActive.ClientUpdatedAt = now.Add(3*time.Hour), now.Add(3*time.Hour)
	accepted := sync(rejected.LastSyncVersion, newArchive, staleActive)
	if !accepted.PushResults[0].Applied || !accepted.PushResults[1].Applied || len(accepted.PullChanges) != 2 {
		t.Fatalf("valid retry was rejected: %+v", accepted)
	}
}

func TestSyncProjectsArchiveLimitAndReturnsAbsentActiveAsNull(t *testing.T) {
	store := newFakeStore()
	service := NewService(store)
	start := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	now := time.Now().UTC()
	var first SyncRecord
	for day := range maxArchivedPeriods {
		date := start.AddDate(0, 0, day)
		item := sqlc.KcalPeriod{ID: uuid.New(), UserID: 7, StartDate: date, EndDate: date, ClientUpdatedAt: now, ServerUpdatedAt: now, GlobalVersion: store.nextVersion()}
		store.periods[trackingKey{7, item.ID}] = item
		if day == 0 {
			first = syncRecordFromPeriod(item)
		}
	}
	date := start.AddDate(0, 0, maxArchivedPeriods).Format(time.DateOnly)
	archive := SyncRecord{EntityTable: EntityTablePeriods, ID: uuid.New(), StartDate: date, EndDate: date, ClientUpdatedAt: now.Add(time.Hour)}
	active := SyncRecord{EntityTable: EntityTablePeriodStarts, ID: periodStartUUID, CycleStartDate: new(start.AddDate(0, 0, maxArchivedPeriods+1).Format(time.DateOnly)), ClientUpdatedAt: archive.ClientUpdatedAt}
	result, err := service.Sync(context.Background(), 7, SyncInput{DeviceID: uuid.New(), LastSyncVersion: store.globalVersion, Changes: []SyncRecord{archive, active}})
	if err != nil {
		t.Fatal(err)
	}
	if result.PushResults[0].Applied || !result.PushResults[0].Record.Deleted || result.PushResults[1].Applied || result.PushResults[1].Record.CycleStartDate != nil || result.PushResults[1].Record.Deleted || len(store.periodStarts) != 0 || len(store.periods) != maxArchivedPeriods {
		t.Fatalf("archive limit changed the original empty-active layout: %+v", result)
	}
	first.Deleted, first.ClientUpdatedAt = true, archive.ClientUpdatedAt
	accepted, err := service.Sync(context.Background(), 7, SyncInput{DeviceID: uuid.New(), LastSyncVersion: result.LastSyncVersion, Changes: []SyncRecord{first, archive, active}})
	if err != nil || !accepted.PushResults[0].Applied || !accepted.PushResults[1].Applied || !accepted.PushResults[2].Applied {
		t.Fatalf("replacement within the archive limit failed: %+v, %v", accepted, err)
	}
}

func TestPeriodProjectionHonorsTombstoneAndRequestOrder(t *testing.T) {
	store := newFakeStore()
	service := NewService(store)
	now := time.Now().UTC()
	archive := SyncRecord{EntityTable: EntityTablePeriods, ID: uuid.New(), StartDate: "2026-10-01", EndDate: "2026-10-19", Deleted: true, ClientUpdatedAt: now}
	active := SyncRecord{EntityTable: EntityTablePeriodStarts, ID: periodStartUUID, CycleStartDate: new("2026-10-15"), ClientUpdatedAt: now}
	created, err := service.Sync(context.Background(), 7, SyncInput{DeviceID: uuid.New(), Changes: []SyncRecord{archive, active}})
	if err != nil {
		t.Fatal(err)
	}
	stale := archive
	stale.Deleted, stale.ClientUpdatedAt = false, now.Add(-time.Hour)
	ignored, err := service.Sync(context.Background(), 7, SyncInput{DeviceID: uuid.New(), LastSyncVersion: created.LastSyncVersion, Changes: []SyncRecord{stale}})
	if err != nil || ignored.PushResults[0].Applied || !ignored.PushResults[0].Record.Deleted {
		t.Fatalf("projection resurrected a stale tombstone: %+v, %v", ignored, err)
	}
	bad, good := archive, archive
	bad.Deleted, good.Deleted = false, false
	bad.ClientUpdatedAt, good.ClientUpdatedAt = now.Add(time.Hour), now.Add(time.Hour)
	good.EndDate = "2026-10-14"
	ordered, err := service.Sync(context.Background(), 7, SyncInput{DeviceID: uuid.New(), LastSyncVersion: ignored.LastSyncVersion, Changes: []SyncRecord{bad, good}})
	if err != nil || !ordered.PushResults[0].Applied || !ordered.PushResults[1].Applied || ordered.PushResults[1].Record.EndDate != good.EndDate {
		t.Fatalf("projection did not preserve equal-timestamp request order: %+v, %v", ordered, err)
	}
}
