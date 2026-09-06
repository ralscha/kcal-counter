package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alexedwards/scs/v2"
)

func TestTemplateAmountsMustBePositiveAndFinite(t *testing.T) {
	for _, amount := range []string{"NaN", "Inf", "+Inf", "-Inf", "0", "-1", "1e999", "bad"} {
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
	for _, amount := range []string{"0.5", "1", "100.25"} {
		if !isPositiveFiniteAmount(amount) {
			t.Fatalf("rejected valid amount %q", amount)
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
