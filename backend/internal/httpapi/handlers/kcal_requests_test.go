package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alexedwards/scs/v2"
	"github.com/google/uuid"

	"kcal-counter/internal/kcal"
	"kcal-counter/internal/validation"
)

func TestSyncRejectsInvalidPeriodStartBeforePersistence(t *testing.T) {
	testCases := []struct {
		name  string
		field string
		value any
	}{
		{"invalid calendar date", "cycle_start_date", "2026-02-30"},
		{"timestamp instead of date", "cycle_start_date", "2026-10-22T00:00:00Z"},
		{"year zero", "cycle_start_date", "0000-01-01"},
		{"non-canonical id", "id", uuid.NewString()},
		{"deleted singleton", "deleted", true},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			change := map[string]any{
				"entity_table": kcal.EntityTablePeriodStarts, "id": kcal.PeriodStartID,
				"cycle_start_date": "2026-10-22", "deleted": false,
				"client_updated_at": "2026-10-22T12:00:00Z",
			}
			change[testCase.field] = testCase.value
			body, err := json.Marshal(map[string]any{
				"user_id": "42", "device_id": uuid.NewString(), "changes": []any{change},
			})
			if err != nil {
				t.Fatal(err)
			}
			recorder := httptest.NewRecorder()
			KcalHandler{}.Sync(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/kcal/sync", strings.NewReader(string(body))))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestTemplateAmountsMustFitDatabaseRange(t *testing.T) {
	for _, amount := range []string{
		"NaN", "Inf", "+Inf", "-Inf", "0", "-1", "1e999", "bad",
		"0.0001", "1e-10", "1000000000", "999999999.9999", "0x1p2", "1_000",
	} {
		t.Run(amount, func(t *testing.T) {
			template := templateItemRequest{Kind: "food", Name: "Rice", Amount: amount, Unit: "g", KcalAmount: 100}
			if template.Validate() == nil {
				t.Fatal("template accepted invalid amount")
			}
			sync := syncRequest{
				DeviceID: "11111111-1111-1111-1111-111111111111",
				Changes: []syncChangeRequest{{
					EntityTable: "kcal_template_items", ID: "22222222-2222-2222-2222-222222222222",
					Kind: "food", Name: "Rice", Amount: amount, Unit: "g", KcalAmount: 100,
					ClientUpdatedAt: time.Now(),
				}},
			}
			if sync.Validate() == nil {
				t.Fatal("sync accepted invalid amount")
			}
		})
	}
	for _, amount := range []string{"0.001", "0.5", "1", "100.25", "999999999.999", "+1", ".5", "1.", "1e2"} {
		err := validation.New()
		validateTemplateAmount(err, "amount", amount)
		if err.ErrOrNil() != nil {
			t.Fatalf("rejected valid amount %q", amount)
		}
	}
}

func TestSyncRejectsNilUUIDs(t *testing.T) {
	request := syncRequest{DeviceID: uuid.Nil.String()}
	if request.Validate() == nil {
		t.Fatal("sync accepted an empty device UUID")
	}
	request.DeviceID = uuid.NewString()
	happenedAt := time.Now()
	request.Changes = []syncChangeRequest{{
		EntityTable: "kcal_entries", ID: uuid.Nil.String(), KcalDelta: 100,
		HappenedAt: &happenedAt, ClientUpdatedAt: happenedAt,
	}}
	if request.Validate() == nil {
		t.Fatal("sync accepted an empty change UUID")
	}
}

func TestTemplateRejectsOutOfRangeAmountBeforePersistence(t *testing.T) {
	// A nil service ensures invalid amounts cannot reach the database.
	handler := KcalHandler{}
	for _, amount := range []string{"0.0001", "1000000000", "0x1p2"} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/kcal/templates", strings.NewReader(
			`{"kind":"food","name":"Rice","amount":"`+amount+`","unit":"g","kcal_amount":100}`,
		))
		handler.CreateTemplate(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("amount %q status = %d, want 400", amount, recorder.Code)
		}
	}
}

func TestSyncRejectsAnotherAccountsQueue(t *testing.T) {
	sessions := scs.New()
	// A nil service also ensures a rejected request never reaches persistence.
	handler := KcalHandler{Sessions: sessions}
	protected := sessions.LoadAndSave(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessions.Put(r.Context(), "user_id", int64(42))
		handler.Sync(w, r)
	}))
	recorder := httptest.NewRecorder()
	protected.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/kcal/sync", strings.NewReader(
		`{"user_id":"99","device_id":"11111111-1111-1111-1111-111111111111","changes":[]}`,
	)))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	protected.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/kcal/sync", strings.NewReader(
		`{"device_id":"11111111-1111-1111-1111-111111111111","changes":[]}`,
	)))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("missing account status = %d, want 403", recorder.Code)
	}
}
