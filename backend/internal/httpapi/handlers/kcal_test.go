package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alexedwards/scs/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"kcal-counter/internal/kcal"
)

type fakeKcalService struct {
	templates []kcal.TemplateItem
	entries   []kcal.Entry
	total     int64
	sync      kcal.SyncResult
	template  kcal.TemplateItem
	entry     kcal.Entry
	err       error
	lastSync  kcal.SyncInput
}

func (f *fakeKcalService) CreateEntry(context.Context, int64, kcal.EntryInput) (kcal.Entry, error) {
	return f.entry, f.err
}

func (f *fakeKcalService) CreateTemplateItem(context.Context, int64, kcal.TemplateItemInput) (kcal.TemplateItem, error) {
	return f.template, f.err
}

func (f *fakeKcalService) DeleteEntry(context.Context, int64, uuid.UUID) error {
	return f.err
}

func (f *fakeKcalService) DeleteTemplateItem(context.Context, int64, uuid.UUID) error {
	return f.err
}

func (f *fakeKcalService) GetTotalInRange(context.Context, int64, time.Time, time.Time) (int64, error) {
	return f.total, f.err
}

func (f *fakeKcalService) ListEntriesInRange(context.Context, int64, time.Time, time.Time) ([]kcal.Entry, error) {
	return f.entries, f.err
}

func (f *fakeKcalService) ListTemplateItems(context.Context, int64, string) ([]kcal.TemplateItem, error) {
	return f.templates, f.err
}

func (f *fakeKcalService) Sync(_ context.Context, _ int64, input kcal.SyncInput) (kcal.SyncResult, error) {
	f.lastSync = input
	return f.sync, f.err
}

func (f *fakeKcalService) UpdateEntry(context.Context, int64, uuid.UUID, kcal.EntryInput) (kcal.Entry, error) {
	return f.entry, f.err
}

func (f *fakeKcalService) UpdateTemplateItem(context.Context, int64, uuid.UUID, kcal.TemplateItemInput) (kcal.TemplateItem, error) {
	return f.template, f.err
}

func TestKcalHandlerListTemplates(t *testing.T) {
	sessions := scs.New()
	service := &fakeKcalService{templates: []kcal.TemplateItem{{ID: uuid.MustParse("11111111-1111-1111-1111-111111111111"), Kind: "food", Name: "rice", Amount: "100", Unit: "grams", KcalAmount: 130}}}
	handler := KcalHandler{Service: service, Sessions: sessions}
	protected := sessions.LoadAndSave(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessions.Put(r.Context(), "user_id", int64(42))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("kind", "food")
		handler.ListTemplates(w, r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx)))
	}))

	recorder := httptest.NewRecorder()
	protected.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/kcal/templates/food", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}

	var response struct {
		Data struct {
			Templates []kcal.TemplateItem `json:"templates"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(response.Data.Templates) != 1 || response.Data.Templates[0].Name != "rice" {
		t.Fatalf("templates = %+v, want one rice template", response.Data.Templates)
	}
}

func TestKcalHandlerSync(t *testing.T) {
	sessions := scs.New()
	now := time.Date(2026, 3, 23, 11, 58, 0, 0, time.UTC)
	service := &fakeKcalService{sync: kcal.SyncResult{LastSyncVersion: 7, PushResults: []kcal.SyncPushResult{{Applied: true}}}}
	handler := KcalHandler{Service: service, Sessions: sessions}
	protected := sessions.LoadAndSave(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessions.Put(r.Context(), "user_id", int64(42))
		handler.Sync(w, r)
	}))

	body := `{"device_id":"11111111-1111-1111-1111-111111111111","last_sync_seq":3,"changes":[{"entity_table":"kcal_template_items","id":"22222222-2222-2222-2222-222222222222","kind":"food","name":"rice","amount":"100","unit":"grams","kcal_amount":130,"deleted":false,"client_updated_at":"2026-03-23T12:00:00Z"},{"entity_table":"kcal_entries","id":"33333333-3333-3333-3333-333333333333","kcal_delta":260,"happened_at":"2026-03-23T11:58:00Z","deleted":false,"client_updated_at":"2026-03-23T12:01:00Z"}]}`
	recorder := httptest.NewRecorder()
	protected.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/kcal/sync", strings.NewReader(body)))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if service.lastSync.DeviceID.String() != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("deviceID = %s, want request device id", service.lastSync.DeviceID)
	}
	if service.lastSync.LastSyncVersion != 3 {
		t.Fatalf("last sync version = %d, want 3", service.lastSync.LastSyncVersion)
	}
	if len(service.lastSync.Changes) != 2 {
		t.Fatalf("changes = %d, want 2", len(service.lastSync.Changes))
	}
	if service.lastSync.Changes[1].HappenedAt == nil || !service.lastSync.Changes[1].HappenedAt.Equal(now) {
		t.Fatalf("entry happened_at = %v, want %v", service.lastSync.Changes[1].HappenedAt, now)
	}

	var response struct {
		Data kcal.SyncResult `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if response.Data.LastSyncVersion != 7 {
		t.Fatalf("response = %+v, want last sync seq 7", response.Data)
	}
}

func TestKcalHandlerSyncRejectsInvalidDeviceID(t *testing.T) {
	sessions := scs.New()
	handler := KcalHandler{Service: &fakeKcalService{}, Sessions: sessions}
	protected := sessions.LoadAndSave(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessions.Put(r.Context(), "user_id", int64(42))
		handler.Sync(w, r)
	}))

	recorder := httptest.NewRecorder()
	protected.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/kcal/sync", strings.NewReader(`{"device_id":"bad","changes":[]}`)))

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}
