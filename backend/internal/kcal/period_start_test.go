package kcal

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSyncPeriodStartSharesClearsAndResetsWithoutCrossingAccounts(t *testing.T) {
	store := newFakeStore()
	service := NewService(store)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	date := "2026-10-20"
	change := SyncRecord{
		EntityTable: EntityTablePeriodStarts, ID: periodStartUUID,
		CycleStartDate: &date, ClientUpdatedAt: now,
	}
	sync := func(userID, cursor int64, changes ...SyncRecord) SyncResult {
		t.Helper()
		result, err := service.Sync(context.Background(), userID, SyncInput{
			DeviceID: uuid.New(), LastSyncVersion: cursor, Changes: changes,
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}

	created := sync(7, 0, change)
	if len(created.PushResults) != 1 || !created.PushResults[0].Applied || created.LastSyncVersion == 0 {
		t.Fatalf("create = %+v, want applied period and cursor", created)
	}
	secondDevice := sync(7, 0)
	if len(secondDevice.PullChanges) != 1 || secondDevice.PullChanges[0].CycleStartDate == nil || *secondDevice.PullChanges[0].CycleStartDate != date {
		t.Fatalf("second device = %+v, want stored date", secondDevice)
	}
	otherAccount := sync(8, 0)
	if len(otherAccount.PullChanges) != 0 || otherAccount.LastSyncVersion != 0 {
		t.Fatalf("other account received period data: %+v", otherAccount)
	}

	clear := change
	clear.CycleStartDate = nil
	clear.ClientUpdatedAt = now.Add(time.Hour)
	cleared := sync(7, created.LastSyncVersion, clear)
	if len(cleared.PullChanges) != 1 || cleared.PullChanges[0].CycleStartDate != nil || cleared.PullChanges[0].Deleted || cleared.LastSyncVersion <= created.LastSyncVersion {
		t.Fatalf("clear = %+v, want versioned null date", cleared)
	}
	data, err := json.Marshal(cleared.PullChanges[0])
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	if value, present := wire["cycle_start_date"]; !present || value != nil {
		t.Fatalf("clear did not encode an explicit null: %s", data)
	}
	stale := sync(7, cleared.LastSyncVersion, change)
	if len(stale.PushResults) != 1 || stale.PushResults[0].Applied || stale.PushResults[0].Record.CycleStartDate != nil || stale.LastSyncVersion != cleared.LastSyncVersion {
		t.Fatalf("stale write = %+v, want authoritative cleared date", stale)
	}
	reset := sync(7, cleared.LastSyncVersion+10)
	if !reset.ResetRequired || len(reset.PullChanges) != 1 || reset.PullChanges[0].CycleStartDate != nil || reset.PullChanges[0].Deleted {
		t.Fatalf("reset lost cleared period: %+v", reset)
	}

	store.minValidVersion = cleared.LastSyncVersion
	newCycle := change
	newCycle.ClientUpdatedAt = now.Add(2 * time.Hour)
	reset = sync(7, created.LastSyncVersion, newCycle)
	if !reset.ResetRequired || len(reset.PushResults) != 0 || store.periodStarts[7].CycleStartDate.Valid {
		t.Fatalf("expired cursor changed the period before reset: %+v", reset)
	}
	retried := sync(7, reset.LastSyncVersion, newCycle)
	if len(retried.PushResults) != 1 || !retried.PushResults[0].Applied || retried.PushResults[0].Record.CycleStartDate == nil {
		t.Fatalf("new cycle was not applied after reset: %+v", retried)
	}
}

func TestParseCycleStartDateUsesStrictCalendarDates(t *testing.T) {
	for _, value := range []string{"", "2026-2-03", "2026-02-30", "2025-02-29", "2026-10-22T00:00:00Z", "0000-01-01", "10000-01-01", " 2026-10-22 "} {
		if _, err := ParseCycleStartDate(&value); err == nil {
			t.Errorf("accepted invalid date %q", value)
		}
	}
	for _, value := range []string{"0001-01-01", "2024-02-29", "2026-10-22", "9999-12-31"} {
		date, err := ParseCycleStartDate(&value)
		if err != nil || !date.Valid || date.Time.Format(time.DateOnly) != value {
			t.Errorf("ParseCycleStartDate(%q) = %+v, %v", value, date, err)
		}
	}
	if date, err := ParseCycleStartDate(nil); err != nil || date.Valid {
		t.Fatalf("ParseCycleStartDate(nil) = %+v, %v", date, err)
	}
}
