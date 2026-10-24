package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"kcal-counter/internal/kcal"
)

func TestSyncRejectsInvalidTrackingChangesBeforePersistence(t *testing.T) {
	for _, test := range []struct {
		name   string
		change map[string]any
	}{
		{"target ID does not match date", map[string]any{"entity_table": kcal.EntityTableTargets, "effective_from": "2026-10-22", "kcal_limit": 2000}},
		{"target invalid date", map[string]any{"entity_table": kcal.EntityTableTargets, "effective_from": "2026-02-30", "kcal_limit": nil}},
		{"target invalid limit", map[string]any{"entity_table": kcal.EntityTableTargets, "id": "00000000-0000-0000-0002-000020261022", "effective_from": "2026-10-22", "kcal_limit": 0}},
		{"target overflowing limit", map[string]any{"entity_table": kcal.EntityTableTargets, "id": "00000000-0000-0000-0002-000020261022", "effective_from": "2026-10-22", "kcal_limit": 2147483648}},
		{"period reversed dates", map[string]any{"entity_table": kcal.EntityTablePeriods, "start_date": "2026-10-22", "end_date": "2026-10-21"}},
		{"period missing dates", map[string]any{"entity_table": kcal.EntityTablePeriods}},
		{"meal missing items", map[string]any{"entity_table": kcal.EntityTableMeals, "name": "Breakfast", "items": []any{}}},
		{"meal malformed UUID", map[string]any{"entity_table": kcal.EntityTableMeals, "name": "Breakfast", "items": []any{map[string]any{"template_id": "bad", "name": "Oats", "kcal_delta": 200}}}},
		{"meal negative delta", map[string]any{"entity_table": kcal.EntityTableMeals, "name": "Breakfast", "items": []any{map[string]any{"template_id": uuid.NewString(), "name": "Oats", "kcal_delta": -200}}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, ok := test.change["id"]; !ok {
				test.change["id"] = uuid.NewString()
			}
			test.change["client_updated_at"] = "2026-10-22T12:00:00Z"
			body, err := json.Marshal(map[string]any{"user_id": "42", "device_id": uuid.NewString(), "changes": []any{test.change}})
			if err != nil {
				t.Fatal(err)
			}
			recorder := httptest.NewRecorder()
			// A nil service ensures malformed queues cannot reach persistence.
			KcalHandler{}.Sync(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/kcal/sync", strings.NewReader(string(body))))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}
