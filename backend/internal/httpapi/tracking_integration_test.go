package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"

	"kcal-counter/internal/kcal"
)

func TestTrackingSyncPersistsPortableHistoryAndAtomicBatches(t *testing.T) {
	ctx := context.Background()
	env := newIntegrationEnv(t, ctx)
	client := newCookieClient(t)
	user := loginKcalTestUser(t, ctx, env, client)
	secondClient := newCookieClient(t)
	authenticateTestClient(t, ctx, env, secondClient, user.ID)
	otherClient := newCookieClient(t)
	otherUser, err := env.queries.CreateUser(ctx, []byte("other-tracking-account"))
	if err != nil {
		t.Fatal(err)
	}
	authenticateTestClient(t, ctx, env, otherClient, otherUser.ID)

	sync := func(client *http.Client, userID, cursor int64, changes ...kcal.SyncRecord) kcal.SyncResult {
		t.Helper()
		response := mustDoRequest(t, client, newJSONRequest(t, ctx, http.MethodPost, env.server.URL+"/api/v1/kcal/sync", map[string]any{
			"user_id": strconv.FormatInt(userID, 10), "device_id": uuid.NewString(), "last_sync_seq": cursor, "changes": changes,
		}))
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(response.Body)
			t.Fatalf("sync status = %d: %s", response.StatusCode, body)
		}
		var payload struct {
			Data kcal.SyncResult `json:"data"`
		}
		if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return payload.Data
	}
	find := func(records []kcal.SyncRecord, table string) kcal.SyncRecord {
		t.Helper()
		for _, record := range records {
			if record.EntityTable == table {
				return record
			}
		}
		t.Fatalf("missing %s in %+v", table, records)
		return kcal.SyncRecord{}
	}
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	targetID, err := kcal.TargetIDForDate("2026-10-22")
	if err != nil {
		t.Fatal(err)
	}
	templateID := uuid.New()
	changes := []kcal.SyncRecord{
		{EntityTable: kcal.EntityTableTemplateItems, ID: templateID, Kind: "food", Name: "Oats", Amount: "100", Unit: "g", KcalAmount: 350, ClientUpdatedAt: now},
		{EntityTable: kcal.EntityTableEntries, ID: uuid.New(), KcalDelta: 350, HappenedAt: &now, ClientUpdatedAt: now},
		{EntityTable: kcal.EntityTablePeriodStarts, ID: uuid.MustParse(kcal.PeriodStartID), CycleStartDate: new("2026-10-22"), ClientUpdatedAt: now},
		{EntityTable: kcal.EntityTableTargets, ID: targetID, EffectiveFrom: "2026-10-22", KcalLimit: new(int32(2000)), ClientUpdatedAt: now},
		{EntityTable: kcal.EntityTablePeriods, ID: uuid.New(), StartDate: "2024-02-01", EndDate: "2024-02-29", ClientUpdatedAt: now},
		{EntityTable: kcal.EntityTableMeals, ID: uuid.New(), Name: "Breakfast", Items: []kcal.MealItem{{TemplateID: templateID, Name: "Oats snapshot", KcalDelta: 350}}, ClientUpdatedAt: now},
	}
	created := sync(client, user.ID, 0, changes...)
	if len(created.PushResults) != len(changes) || len(created.PullChanges) != len(changes) {
		t.Fatalf("mixed initial batch = %+v", created)
	}
	for _, result := range created.PushResults {
		if !result.Applied {
			t.Fatalf("initial change not applied: %+v", result)
		}
	}
	fresh := sync(secondClient, user.ID, 0)
	if len(fresh.PullChanges) != 6 || find(fresh.PullChanges, kcal.EntityTablePeriods).EndDate != "2024-02-29" || find(fresh.PullChanges, kcal.EntityTableMeals).Items[0].Name != "Oats snapshot" {
		t.Fatalf("second device lost tracking data: %+v", fresh)
	}
	if other := sync(otherClient, otherUser.ID, 0); len(other.PullChanges) != 0 || other.LastSyncVersion != 0 {
		t.Fatalf("other account saw private data: %+v", other)
	}
	// A portable backup keeps record IDs. Every entity must remain account scoped.
	otherChanges := append([]kcal.SyncRecord(nil), changes...)
	otherChanges[0].Name = "Other oats"
	otherChanges[1].KcalDelta = 100
	otherChanges[3].KcalLimit = new(int32(1800))
	otherChanges[5].Name = "Other breakfast"
	imported := sync(otherClient, otherUser.ID, 0, otherChanges...)
	if len(imported.PushResults) != 6 {
		t.Fatalf("portable backup failed: %+v", imported)
	}
	unchanged := sync(client, user.ID, 0)
	if find(unchanged.PullChanges, kcal.EntityTableTemplateItems).Name != "Oats" || find(unchanged.PullChanges, kcal.EntityTableEntries).KcalDelta != 350 || *find(unchanged.PullChanges, kcal.EntityTableTargets).KcalLimit != 2000 || find(unchanged.PullChanges, kcal.EntityTableMeals).Name != "Breakfast" {
		t.Fatalf("import changed the original account: %+v", unchanged)
	}

	clear := changes[3]
	clear.KcalLimit = nil
	clear.ClientUpdatedAt = now.Add(time.Hour)
	cleared := sync(client, user.ID, created.LastSyncVersion, clear)
	if len(cleared.PullChanges) != 1 || cleared.PullChanges[0].KcalLimit != nil || cleared.PullChanges[0].Deleted || cleared.LastSyncVersion <= created.LastSyncVersion {
		t.Fatalf("disable target = %+v", cleared)
	}
	if fresh := sync(secondClient, user.ID, 0); find(fresh.PullChanges, kcal.EntityTableTargets).KcalLimit != nil {
		t.Fatal("fresh device did not receive disabled target")
	}
	stale := sync(secondClient, user.ID, cleared.LastSyncVersion, changes[3])
	if stale.PushResults[0].Applied || stale.PushResults[0].Record.KcalLimit != nil || stale.LastSyncVersion != cleared.LastSyncVersion {
		t.Fatalf("stale target replaced disabled target: %+v", stale)
	}
	reset := sync(secondClient, user.ID, cleared.LastSyncVersion+100)
	if !reset.ResetRequired || len(reset.PullChanges) != 6 || find(reset.PullChanges, kcal.EntityTableTargets).KcalLimit != nil {
		t.Fatalf("reset lost tracking history: %+v", reset)
	}

	// Start a new cycle and archive its predecessor in the same transaction.
	archive := changes[4]
	archive.StartDate, archive.EndDate = "2026-10-22", "2026-10-23"
	archive.ClientUpdatedAt = now.Add(2 * time.Hour)
	active := changes[2]
	active.CycleStartDate, active.ClientUpdatedAt = new("2026-10-24"), archive.ClientUpdatedAt
	archived := sync(client, user.ID, cleared.LastSyncVersion, archive, active)
	if len(archived.PullChanges) != 2 || find(archived.PullChanges, kcal.EntityTablePeriods).EndDate != "2026-10-23" || *find(archived.PullChanges, kcal.EntityTablePeriodStarts).CycleStartDate != "2026-10-24" {
		t.Fatalf("cycle archive batch = %+v", archived)
	}
	// An error after the first SQL write rolls back the complete batch.
	badArchive := archive
	badArchive.ID, badArchive.EndDate = uuid.New(), "2026-10-01"
	newActive := active
	newActive.CycleStartDate, newActive.ClientUpdatedAt = new("2026-11-01"), now.Add(3*time.Hour)
	_, err = kcal.NewService(kcal.NewStore(env.db)).Sync(ctx, user.ID, kcal.SyncInput{
		DeviceID: uuid.New(), LastSyncVersion: archived.LastSyncVersion, Changes: []kcal.SyncRecord{newActive, badArchive},
	})
	if err == nil {
		t.Fatal("invalid archive unexpectedly committed")
	}
	afterFailure := sync(client, user.ID, 0)
	if afterFailure.LastSyncVersion != archived.LastSyncVersion || *find(afterFailure.PullChanges, kcal.EntityTablePeriodStarts).CycleStartDate != "2026-10-24" {
		t.Fatalf("failed batch was not atomic: %+v", afterFailure)
	}

	// Template removal cannot erase or alter the saved meal snapshot.
	deletedTemplate := changes[0]
	deletedTemplate.Deleted, deletedTemplate.ClientUpdatedAt = true, now.Add(3*time.Hour)
	sync(client, user.ID, archived.LastSyncVersion, deletedTemplate)
	if meal := find(sync(secondClient, user.ID, 0).PullChanges, kcal.EntityTableMeals); len(meal.Items) != 1 || meal.Items[0].Name != "Oats snapshot" || meal.Items[0].KcalDelta != 350 {
		t.Fatalf("template removal changed meal snapshot: %+v", meal)
	}
	deletions := append([]kcal.SyncRecord(nil), changes[3:]...)
	for i := range deletions {
		deletions[i].Deleted, deletions[i].ClientUpdatedAt = true, now.Add(4*time.Hour)
	}
	deleted := sync(client, user.ID, 0, deletions...)
	for _, result := range deleted.PushResults {
		if !result.Applied || !result.Record.Deleted {
			t.Fatalf("tombstone not applied: %+v", result)
		}
	}
	stale = sync(secondClient, user.ID, deleted.LastSyncVersion, changes[3:]...)
	for _, result := range stale.PushResults {
		if result.Applied || !result.Record.Deleted {
			t.Fatalf("stale write resurrected a tombstone: %+v", result)
		}
	}
	reset = sync(secondClient, user.ID, deleted.LastSyncVersion+100)
	if !reset.ResetRequired || len(reset.PullChanges) != 2 {
		t.Fatalf("reset included deleted entities: %+v", reset)
	}
	for _, table := range []string{"kcal_targets", "kcal_periods", "kcal_meals"} {
		if _, err := env.db.ExecContext(ctx, "UPDATE "+table+" SET server_updated_at = NOW() - INTERVAL '31 days' WHERE user_id = $1", user.ID); err != nil {
			t.Fatal(err)
		}
	}
	compacted := sync(secondClient, user.ID, 0)
	if !compacted.ResetRequired || compacted.MinValidVersion != deleted.LastSyncVersion || len(compacted.PullChanges) != 2 {
		t.Fatalf("compaction failed to protect stale clients: %+v", compacted)
	}
	other := sync(otherClient, otherUser.ID, 0)
	if other.ResetRequired || len(other.PullChanges) != 6 || *find(other.PullChanges, kcal.EntityTableTargets).KcalLimit != 1800 {
		t.Fatalf("compaction crossed account boundary: %+v", other)
	}
}
