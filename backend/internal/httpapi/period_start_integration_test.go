package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"testing"

	"github.com/google/uuid"

	"kcal-counter/internal/kcal"
)

func TestPeriodStartSyncPersistsAcrossDevicesAndAccounts(t *testing.T) {
	ctx := context.Background()
	env := newIntegrationEnv(t, ctx)
	firstClient := newCookieClient(t)
	user := loginKcalTestUser(t, ctx, env, firstClient)
	secondClient := newCookieClient(t)
	authenticateTestClient(t, ctx, env, secondClient, user.ID)
	otherClient := newCookieClient(t)
	otherUser, err := env.queries.CreateUser(ctx, []byte("other-period-account"))
	if err != nil {
		t.Fatal(err)
	}
	authenticateTestClient(t, ctx, env, otherClient, otherUser.ID)

	sync := func(client *http.Client, userID, cursor int64, changes ...map[string]any) kcal.SyncResult {
		t.Helper()
		response := mustDoRequest(t, client, newJSONRequest(t, ctx, http.MethodPost, env.server.URL+"/api/v1/kcal/sync", map[string]any{
			"user_id": strconv.FormatInt(userID, 10), "device_id": uuid.NewString(),
			"last_sync_seq": cursor, "changes": changes,
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
	periodChange := func(date any, timestamp string) map[string]any {
		return map[string]any{
			"entity_table": kcal.EntityTablePeriodStarts, "id": kcal.PeriodStartID,
			"cycle_start_date": date, "client_updated_at": timestamp, "deleted": false,
		}
	}
	assertPeriod := func(records []kcal.SyncRecord, date *string) {
		t.Helper()
		for _, record := range records {
			if record.EntityTable != kcal.EntityTablePeriodStarts {
				continue
			}
			if record.ID.String() != kcal.PeriodStartID || record.Deleted {
				t.Fatalf("invalid period record: %+v", record)
			}
			if date == nil && record.CycleStartDate == nil {
				return
			}
			if date != nil && record.CycleStartDate != nil && *date == *record.CycleStartDate {
				return
			}
			t.Fatalf("period date = %v, want %v", record.CycleStartDate, date)
		}
		t.Fatalf("period missing from records: %+v", records)
	}

	date := "2024-02-29"
	created := sync(firstClient, user.ID, 0,
		map[string]any{
			"entity_table": kcal.EntityTableEntries, "id": uuid.NewString(),
			"kcal_delta": 250, "happened_at": "2026-10-22T10:00:00Z",
			"client_updated_at": "2026-10-22T10:00:00Z", "deleted": false,
		},
		periodChange(date, "2026-10-22T12:00:00Z"),
	)
	if len(created.PushResults) != 2 || !created.PushResults[0].Applied || !created.PushResults[1].Applied {
		t.Fatalf("mixed entry/period push = %+v", created.PushResults)
	}
	assertPeriod(created.PullChanges, &date)
	if created.LastSyncVersion != created.PushResults[1].Record.GlobalVersion {
		t.Fatal("period change did not advance the sync cursor")
	}
	var storedDate, storedType string
	if err := env.db.QueryRowContext(ctx, "SELECT cycle_start_date::text, pg_typeof(cycle_start_date)::text FROM kcal_period_starts WHERE user_id = $1", user.ID).Scan(&storedDate, &storedType); err != nil {
		t.Fatal(err)
	}
	if storedDate != date || storedType != "date" {
		t.Fatalf("stored period = %q (%s), want %q (date)", storedDate, storedType, date)
	}
	assertPeriod(sync(secondClient, user.ID, 0).PullChanges, &date)

	if other := sync(otherClient, otherUser.ID, 0); len(other.PullChanges) != 0 || other.LastSyncVersion != 0 {
		t.Fatalf("other account received user data: %+v", other)
	}
	otherDate := "2026-01-01"
	assertPeriod(sync(otherClient, otherUser.ID, 0, periodChange(otherDate, "2026-10-22T12:00:00Z")).PullChanges, &otherDate)
	assertPeriod(sync(firstClient, user.ID, 0).PullChanges, &date)

	cleared := sync(firstClient, user.ID, created.LastSyncVersion, periodChange(nil, "2026-10-22T13:00:00Z"))
	assertPeriod(cleared.PullChanges, nil)
	assertPeriod(sync(secondClient, user.ID, created.LastSyncVersion).PullChanges, nil)
	assertPeriod(sync(secondClient, user.ID, 0).PullChanges, nil)
	stale := sync(secondClient, user.ID, cleared.LastSyncVersion, periodChange(date, "2026-10-22T12:00:00Z"))
	if len(stale.PushResults) != 1 || stale.PushResults[0].Applied || stale.PushResults[0].Record.CycleStartDate != nil || stale.LastSyncVersion != cleared.LastSyncVersion {
		t.Fatalf("stale period overwrote newer clear: %+v", stale)
	}
	reset := sync(secondClient, user.ID, cleared.LastSyncVersion+100)
	if !reset.ResetRequired {
		t.Fatal("future cursor did not reset")
	}
	assertPeriod(reset.PullChanges, nil)

	newDate := "2026-10-22"
	started := sync(firstClient, user.ID, reset.LastSyncVersion, periodChange(newDate, "2026-10-22T14:00:00Z"))
	assertPeriod(started.PullChanges, &newDate)
	assertPeriod(sync(secondClient, user.ID, cleared.LastSyncVersion).PullChanges, &newDate)
	assertPeriod(sync(otherClient, otherUser.ID, 0).PullChanges, &otherDate)
}
