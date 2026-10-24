package httpapi_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"kcal-counter/internal/kcal"
)

func TestPeriodGroupConflictsPreserveServerLayout(t *testing.T) {
	ctx := context.Background()
	env := newIntegrationEnv(t, ctx)
	user, err := env.queries.CreateUser(ctx, []byte("period-layout-account"))
	if err != nil {
		t.Fatal(err)
	}
	service := kcal.NewService(kcal.NewStore(env.db))
	sync := func(userID, cursor int64, changes ...kcal.SyncRecord) kcal.SyncResult {
		t.Helper()
		result, err := service.Sync(ctx, userID, kcal.SyncInput{DeviceID: uuid.New(), LastSyncVersion: cursor, Changes: changes})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	now := time.Now().UTC()
	first := kcal.SyncRecord{EntityTable: kcal.EntityTablePeriods, ID: uuid.MustParse("00000000-0000-0000-0003-000020261001"), StartDate: "2026-10-01", EndDate: "2026-10-09", ClientUpdatedAt: now}
	second := kcal.SyncRecord{EntityTable: kcal.EntityTablePeriods, ID: uuid.MustParse("00000000-0000-0000-0003-000020261010"), StartDate: "2026-10-10", EndDate: "2026-10-14", ClientUpdatedAt: now.Add(time.Hour)}
	active := kcal.SyncRecord{EntityTable: kcal.EntityTablePeriodStarts, ID: uuid.MustParse(kcal.PeriodStartID), CycleStartDate: new("2026-10-15"), ClientUpdatedAt: second.ClientUpdatedAt}
	created := sync(user.ID, 0, first, second, active)
	staleFirst, staleActive := first, active
	staleFirst.EndDate, staleFirst.ClientUpdatedAt = "2026-10-19", now.Add(2*time.Hour)
	staleActive.CycleStartDate, staleActive.ClientUpdatedAt = new("2026-10-20"), staleFirst.ClientUpdatedAt
	entry := kcal.SyncRecord{EntityTable: kcal.EntityTableEntries, ID: uuid.New(), KcalDelta: 123, HappenedAt: &now, ClientUpdatedAt: now}
	conflict := sync(user.ID, created.LastSyncVersion, staleFirst, staleActive, entry)
	if len(conflict.PushResults) != 3 || conflict.PushResults[0].Applied || conflict.PushResults[1].Applied || !conflict.PushResults[2].Applied || conflict.PushResults[0].Record.EndDate != "2026-10-09" || *conflict.PushResults[1].Record.CycleStartDate != "2026-10-15" {
		t.Fatalf("stale device poisoned layout or blocked independent entry: %+v", conflict)
	}
	if len(conflict.PullChanges) != 1 || conflict.PullChanges[0].ID != entry.ID {
		t.Fatalf("rejected period group wrote sync history: %+v", conflict)
	}
	newArchive := kcal.SyncRecord{EntityTable: kcal.EntityTablePeriods, ID: uuid.New(), StartDate: "2026-10-15", EndDate: "2026-10-19", ClientUpdatedAt: now}
	staleActive.ClientUpdatedAt = now // This active-start update loses LWW.
	rejected := sync(user.ID, conflict.LastSyncVersion, newArchive, staleActive)
	if rejected.PushResults[0].Applied || !rejected.PushResults[0].Record.Deleted || rejected.PushResults[0].Record.ID != newArchive.ID || rejected.PushResults[0].Record.GlobalVersion != 0 || rejected.PushResults[1].Applied || *rejected.PushResults[1].Record.CycleStartDate != "2026-10-15" || rejected.LastSyncVersion != conflict.LastSyncVersion {
		t.Fatalf("new archive/stale active group was not rejected authoritatively: %+v", rejected)
	}
	var archiveCount int
	if err := env.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM kcal_periods WHERE user_id = $1 AND id = $2", user.ID, newArchive.ID).Scan(&archiveCount); err != nil || archiveCount != 0 {
		t.Fatalf("synthetic tombstone was persisted: count=%d, error=%v", archiveCount, err)
	}
	newArchive.ClientUpdatedAt, staleActive.ClientUpdatedAt = now.Add(3*time.Hour), now.Add(3*time.Hour)
	accepted := sync(user.ID, rejected.LastSyncVersion, newArchive, staleActive)
	if !accepted.PushResults[0].Applied || !accepted.PushResults[1].Applied || len(accepted.PullChanges) != 2 {
		t.Fatalf("intentional valid retry failed: %+v", accepted)
	}

	// Archive capacity is checked against the final live layout, so a batch can
	// replace an archive at capacity without transiently exceeding the limit.
	other, err := env.queries.CreateUser(ctx, []byte("period-capacity-account"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.ExecContext(ctx, `
		INSERT INTO kcal_periods (id, user_id, start_date, end_date)
		SELECT gen_random_uuid(), $1, DATE '2020-01-01' + day, DATE '2020-01-01' + day
		FROM generate_series(0, 999) AS day`, other.ID); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	date := start.AddDate(0, 0, 1000).Format(time.DateOnly)
	extra := kcal.SyncRecord{EntityTable: kcal.EntityTablePeriods, ID: uuid.New(), StartDate: date, EndDate: date, ClientUpdatedAt: now.Add(4 * time.Hour)}
	otherActive := active
	otherActive.CycleStartDate, otherActive.ClientUpdatedAt = new(start.AddDate(0, 0, 1001).Format(time.DateOnly)), extra.ClientUpdatedAt
	capacityConflict := sync(other.ID, 0, extra, otherActive)
	if capacityConflict.PushResults[0].Applied || !capacityConflict.PushResults[0].Record.Deleted || capacityConflict.PushResults[1].Applied || capacityConflict.PushResults[1].Record.CycleStartDate != nil || capacityConflict.PushResults[1].Record.Deleted {
		t.Fatalf("archive capacity did not restore the absent active date: %+v", capacityConflict.PushResults)
	}
	var firstID uuid.UUID
	if err := env.db.QueryRowContext(ctx, "SELECT id FROM kcal_periods WHERE user_id = $1 AND start_date = DATE '2020-01-01'", other.ID).Scan(&firstID); err != nil {
		t.Fatal(err)
	}
	remove := kcal.SyncRecord{EntityTable: kcal.EntityTablePeriods, ID: firstID, StartDate: "2020-01-01", EndDate: "2020-01-01", Deleted: true, ClientUpdatedAt: extra.ClientUpdatedAt}
	replacement := sync(other.ID, capacityConflict.LastSyncVersion, remove, extra, otherActive)
	for _, result := range replacement.PushResults {
		if !result.Applied {
			t.Fatalf("valid replacement at capacity failed: %+v", replacement)
		}
	}
	if err := env.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM kcal_periods WHERE user_id = $1 AND deleted_at IS NULL", other.ID).Scan(&archiveCount); err != nil || archiveCount != 1000 {
		t.Fatalf("live archives after replacement = %d, error=%v", archiveCount, err)
	}
	if original := sync(user.ID, accepted.LastSyncVersion); len(original.PullChanges) != 0 || original.LastSyncVersion != accepted.LastSyncVersion {
		t.Fatalf("other account's capacity changed original layout: %+v", original)
	}
}
