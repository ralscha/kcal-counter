package kcal

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func trackingChanges() []SyncRecord {
	date := "2026-10-22"
	id, _ := TargetIDForDate(date)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	return []SyncRecord{
		{EntityTable: EntityTableTargets, ID: id, EffectiveFrom: date, KcalLimit: new(int32(2000)), ClientUpdatedAt: now},
		{EntityTable: EntityTablePeriods, ID: uuid.New(), StartDate: "2026-10-01", EndDate: "2026-10-21", ClientUpdatedAt: now},
		{EntityTable: EntityTableMeals, ID: uuid.New(), Name: "Breakfast", Items: []MealItem{{TemplateID: uuid.New(), Name: "Oats", KcalDelta: 350}}, ClientUpdatedAt: now},
	}
}

func TestTrackingSyncKeepsAccountsIsolatedAndReturnsAuthoritativeChanges(t *testing.T) {
	store := newFakeStore()
	service := NewService(store)
	sync := func(userID, cursor int64, changes ...SyncRecord) SyncResult {
		t.Helper()
		result, err := service.Sync(context.Background(), userID, SyncInput{DeviceID: uuid.New(), LastSyncVersion: cursor, Changes: changes})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	changes := trackingChanges()
	created := sync(7, 0, changes...)
	if len(created.PushResults) != 3 || len(created.PullChanges) != 3 {
		t.Fatalf("create result = %+v", created)
	}
	for _, result := range created.PushResults {
		if !result.Applied {
			t.Fatalf("create was not applied: %+v", result)
		}
	}
	if other := sync(8, 0); len(other.PullChanges) != 0 || other.LastSyncVersion != 0 {
		t.Fatalf("another account saw data: %+v", other)
	}
	otherChanges := trackingChanges()
	for i := range otherChanges {
		otherChanges[i].ID = changes[i].ID
	}
	otherChanges[0].KcalLimit = new(int32(1800))
	otherChanges[2].Name = "Other breakfast"
	other := sync(8, 0, otherChanges...)
	if len(other.PushResults) != 3 || *sync(7, 0).PullChanges[0].KcalLimit != 2000 {
		t.Fatal("same IDs collided across accounts")
	}
	clear := changes[0]
	clear.KcalLimit = nil
	clear.ClientUpdatedAt = clear.ClientUpdatedAt.Add(time.Hour)
	cleared := sync(7, created.LastSyncVersion, clear)
	if len(cleared.PullChanges) != 1 || cleared.PullChanges[0].KcalLimit != nil || cleared.PullChanges[0].Deleted {
		t.Fatalf("target disable = %+v", cleared)
	}
	encoded, err := json.Marshal(cleared.PullChanges[0])
	if err != nil || !strings.Contains(string(encoded), `"kcal_limit":null`) {
		t.Fatalf("disabled target does not serialize an explicit null: %s (%v)", encoded, err)
	}
	stale := sync(7, cleared.LastSyncVersion, changes[0])
	if len(stale.PushResults) != 1 || stale.PushResults[0].Applied || stale.PushResults[0].Record.KcalLimit != nil || stale.LastSyncVersion != cleared.LastSyncVersion {
		t.Fatalf("stale target restored a disabled limit: %+v", stale)
	}
	reset := sync(7, cleared.LastSyncVersion+100)
	if !reset.ResetRequired || len(reset.PullChanges) != 3 {
		t.Fatalf("reset lost tracking entities: %+v", reset)
	}
	for _, change := range changes {
		change.Deleted = true
		change.ClientUpdatedAt = change.ClientUpdatedAt.Add(2 * time.Hour)
		deleted := sync(7, 0, change)
		if len(deleted.PushResults) != 1 || !deleted.PushResults[0].Record.Deleted {
			t.Fatalf("delete = %+v", deleted)
		}
		stale := change
		stale.Deleted = false
		stale.ClientUpdatedAt = stale.ClientUpdatedAt.Add(-time.Hour)
		ignored := sync(7, deleted.LastSyncVersion, stale)
		if ignored.PushResults[0].Applied || !ignored.PushResults[0].Record.Deleted {
			t.Fatalf("older change resurrected tombstone: %+v", ignored)
		}
	}
	if snapshot := sync(7, 9999); !snapshot.ResetRequired || len(snapshot.PullChanges) != 0 {
		t.Fatalf("reset included tombstones: %+v", snapshot)
	}
}

func TestTrackingTombstoneCompactionForcesReset(t *testing.T) {
	for _, change := range trackingChanges() {
		t.Run(change.EntityTable, func(t *testing.T) {
			store := newFakeStore()
			change.Deleted = true
			service := NewService(store)
			created, err := service.Sync(context.Background(), 7, SyncInput{DeviceID: uuid.New(), Changes: []SyncRecord{change}})
			if err != nil {
				t.Fatal(err)
			}
			old := time.Now().Add(-31 * 24 * time.Hour)
			for key, item := range store.targets {
				item.ServerUpdatedAt = old
				store.targets[key] = item
			}
			for key, item := range store.periods {
				item.ServerUpdatedAt = old
				store.periods[key] = item
			}
			for key, item := range store.meals {
				item.ServerUpdatedAt = old
				store.meals[key] = item
			}
			reset, err := service.Sync(context.Background(), 7, SyncInput{DeviceID: uuid.New()})
			if err != nil || !reset.ResetRequired || reset.MinValidVersion != created.LastSyncVersion || len(reset.PullChanges) != 0 {
				t.Fatalf("expired tombstone reset = %+v, %v", reset, err)
			}
		})
	}
}

func TestTrackingValidation(t *testing.T) {
	base := trackingChanges()
	cases := []struct {
		name   string
		index  int
		mutate func(*SyncRecord)
	}{
		{"target mismatched ID", 0, func(c *SyncRecord) { c.ID = uuid.New() }},
		{"target impossible date", 0, func(c *SyncRecord) { c.EffectiveFrom = "2026-02-30" }},
		{"target year zero", 0, func(c *SyncRecord) { c.EffectiveFrom = "0000-01-01" }},
		{"target zero limit", 0, func(c *SyncRecord) { c.KcalLimit = new(int32(0)) }},
		{"target negative limit", 0, func(c *SyncRecord) { c.KcalLimit = new(int32(-1)) }},
		{"period invalid start", 1, func(c *SyncRecord) { c.StartDate = "2026-2-01" }},
		{"period invalid end", 1, func(c *SyncRecord) { c.EndDate = "2026-02-30" }},
		{"period reversed dates", 1, func(c *SyncRecord) { c.EndDate = "2026-09-30" }},
		{"meal blank name", 2, func(c *SyncRecord) { c.Name = "  " }},
		{"meal long name", 2, func(c *SyncRecord) { c.Name = strings.Repeat("é", 201) }},
		{"meal missing items", 2, func(c *SyncRecord) { c.Items = nil }},
		{"meal too many items", 2, func(c *SyncRecord) { c.Items = make([]MealItem, 101) }},
		{"meal item nil ID", 2, func(c *SyncRecord) { c.Items[0].TemplateID = uuid.Nil }},
		{"meal item blank name", 2, func(c *SyncRecord) { c.Items[0].Name = " " }},
		{"meal item long name", 2, func(c *SyncRecord) { c.Items[0].Name = strings.Repeat("a", 201) }},
		{"meal item nonpositive delta", 2, func(c *SyncRecord) { c.Items[0].KcalDelta = 0 }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			change := base[test.index]
			change.Items = append([]MealItem(nil), change.Items...)
			test.mutate(&change)
			if err := ValidateTrackingChange(change); err == nil {
				t.Fatal("invalid tracking change accepted")
			}
		})
	}
	for _, date := range []string{"0001-01-01", "2024-02-29", "9999-12-31"} {
		id, err := TargetIDForDate(date)
		if err != nil || id.String() != "00000000-0000-0000-0002-0000"+strings.ReplaceAll(date, "-", "") {
			t.Fatalf("canonical ID for %q = %s, %v", date, id, err)
		}
	}
	for _, change := range base {
		if err := ValidateTrackingChange(change); err != nil {
			t.Errorf("valid change rejected: %v", err)
		}
	}
}
