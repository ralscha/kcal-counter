package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"kcal-counter/internal/store/sqlc"
)

func TestKcalRoutesRequireAuthentication(t *testing.T) {
	ctx := context.Background()
	env := newIntegrationEnv(t, ctx)

	resp := mustDoRequest(t, http.DefaultClient, newRequest(t, ctx, http.MethodGet, env.server.URL+"/api/v1/kcal/templates/food", nil))
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusUnauthorized {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want %d, body = %s", resp.StatusCode, http.StatusUnauthorized, strings.TrimSpace(string(body)))
	}
}

func TestKcalSyncListTotalAndPullFlow(t *testing.T) {
	ctx := context.Background()
	env := newIntegrationEnv(t, ctx)
	client := newCookieClient(t)
	user := loginKcalTestUser(t, ctx, env, client)

	templateID := "11111111-1111-1111-1111-111111111111"
	entryID := "22222222-2222-2222-2222-222222222222"
	deviceID := "33333333-3333-3333-3333-333333333333"

	syncBody := map[string]any{
		"device_id":     deviceID,
		"last_sync_seq": 0,
		"changes": []map[string]any{
			{
				"entity_table":      "kcal_template_items",
				"id":                templateID,
				"kind":              "food",
				"name":              "rice",
				"amount":            "100",
				"unit":              "grams",
				"kcal_amount":       130,
				"deleted":           false,
				"client_updated_at": "2026-03-23T12:00:00Z",
			},
			{
				"entity_table":      "kcal_entries",
				"id":                entryID,
				"kcal_delta":        260,
				"happened_at":       "2026-03-23T11:58:00Z",
				"deleted":           false,
				"client_updated_at": "2026-03-23T12:01:00Z",
			},
		},
	}

	syncResp := mustDoRequest(t, client, newJSONRequest(t, ctx, http.MethodPost, env.server.URL+"/api/v1/kcal/sync", syncBody))
	defer func() { _ = syncResp.Body.Close() }()
	if syncResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(syncResp.Body)
		t.Fatalf("sync status = %d, want %d, body = %s", syncResp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
	}

	var syncPayload struct {
		Data struct {
			PushResults []struct {
				Applied bool `json:"applied"`
			} `json:"push_results"`
			PullChanges []struct {
				EntityTable     string `json:"entity_table"`
				Name            string `json:"name"`
				KcalDelta       int32  `json:"kcal_delta"`
				ClientUpdatedAt string `json:"client_updated_at"`
			} `json:"pull_changes"`
			LastSyncVersion int64 `json:"last_sync_seq"`
		} `json:"data"`
	}
	if err := json.NewDecoder(syncResp.Body).Decode(&syncPayload); err != nil {
		t.Fatalf("decode sync response: %v", err)
	}
	if len(syncPayload.Data.PushResults) != 2 || !syncPayload.Data.PushResults[0].Applied || !syncPayload.Data.PushResults[1].Applied {
		t.Fatalf("push results = %+v, want two applied results", syncPayload.Data.PushResults)
	}
	if len(syncPayload.Data.PullChanges) != 2 {
		t.Fatalf("pull changes = %d, want 2", len(syncPayload.Data.PullChanges))
	}
	if syncPayload.Data.LastSyncVersion == 0 {
		t.Fatal("last_sync_seq = 0, want non-zero sync cursor")
	}

	listTemplatesResp := mustDoRequest(t, client, newRequest(t, ctx, http.MethodGet, env.server.URL+"/api/v1/kcal/templates/food", nil))
	defer func() { _ = listTemplatesResp.Body.Close() }()
	if listTemplatesResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(listTemplatesResp.Body)
		t.Fatalf("list templates status = %d, want %d, body = %s", listTemplatesResp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
	}
	var templatesPayload struct {
		Data struct {
			Templates []struct {
				Name       string `json:"name"`
				Amount     string `json:"amount"`
				Unit       string `json:"unit"`
				KcalAmount int32  `json:"kcal_amount"`
			} `json:"templates"`
		} `json:"data"`
	}
	if err := json.NewDecoder(listTemplatesResp.Body).Decode(&templatesPayload); err != nil {
		t.Fatalf("decode templates response: %v", err)
	}
	if len(templatesPayload.Data.Templates) != 1 || templatesPayload.Data.Templates[0].Name != "rice" {
		t.Fatalf("templates payload = %+v, want one rice template", templatesPayload.Data.Templates)
	}

	entriesResp := mustDoRequest(t, client, newRequest(t, ctx, http.MethodGet, env.server.URL+"/api/v1/kcal/entries?from=2026-03-23T00:00:00Z&to=2026-03-24T00:00:00Z", nil))
	defer func() { _ = entriesResp.Body.Close() }()
	if entriesResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(entriesResp.Body)
		t.Fatalf("list entries status = %d, want %d, body = %s", entriesResp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
	}
	var entriesPayload struct {
		Data struct {
			Entries []struct {
				KcalDelta int32 `json:"kcal_delta"`
			} `json:"entries"`
		} `json:"data"`
	}
	if err := json.NewDecoder(entriesResp.Body).Decode(&entriesPayload); err != nil {
		t.Fatalf("decode entries response: %v", err)
	}
	if len(entriesPayload.Data.Entries) != 1 || entriesPayload.Data.Entries[0].KcalDelta != 260 {
		t.Fatalf("entries payload = %+v, want one 260 kcal entry", entriesPayload.Data.Entries)
	}

	totalResp := mustDoRequest(t, client, newRequest(t, ctx, http.MethodGet, env.server.URL+"/api/v1/kcal/total?from=2026-03-23T00:00:00Z&to=2026-03-24T00:00:00Z", nil))
	defer func() { _ = totalResp.Body.Close() }()
	if totalResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(totalResp.Body)
		t.Fatalf("total status = %d, want %d, body = %s", totalResp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
	}
	var totalPayload struct {
		Data struct {
			TotalKcal int64 `json:"total_kcal"`
		} `json:"data"`
	}
	if err := json.NewDecoder(totalResp.Body).Decode(&totalPayload); err != nil {
		t.Fatalf("decode total response: %v", err)
	}
	if totalPayload.Data.TotalKcal != 260 {
		t.Fatalf("total_kcal = %d, want 260", totalPayload.Data.TotalKcal)
	}

	secondSyncResp := mustDoRequest(t, client, newJSONRequest(t, ctx, http.MethodPost, env.server.URL+"/api/v1/kcal/sync", map[string]any{
		"device_id":     deviceID,
		"last_sync_seq": syncPayload.Data.LastSyncVersion,
		"changes":       []map[string]any{},
	}))
	defer func() { _ = secondSyncResp.Body.Close() }()
	if secondSyncResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(secondSyncResp.Body)
		t.Fatalf("second sync status = %d, want %d, body = %s", secondSyncResp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
	}
	var secondSyncPayload struct {
		Data struct {
			PullChanges []struct{} `json:"pull_changes"`
			LastSyncSeq int64      `json:"last_sync_seq"`
		} `json:"data"`
	}
	if err := json.NewDecoder(secondSyncResp.Body).Decode(&secondSyncPayload); err != nil {
		t.Fatalf("decode second sync response: %v", err)
	}
	if len(secondSyncPayload.Data.PullChanges) != 0 {
		t.Fatalf("pull changes = %d, want 0", len(secondSyncPayload.Data.PullChanges))
	}
	if secondSyncPayload.Data.LastSyncSeq != syncPayload.Data.LastSyncVersion {
		t.Fatalf("last_sync_seq = %d, want %d", secondSyncPayload.Data.LastSyncSeq, syncPayload.Data.LastSyncVersion)
	}

	storedEntry, err := env.queries.GetKcalEntryByID(ctx, sqlc.GetKcalEntryByIDParams{ID: mustUUID(t, entryID), UserID: user.ID})
	if err != nil {
		t.Fatalf("GetKcalEntryByID() error = %v", err)
	}
	if storedEntry.KcalDelta != 260 {
		t.Fatalf("stored kcal delta = %d, want 260", storedEntry.KcalDelta)
	}
}

func TestKcalSyncAllowsRepeatedZeroCursor(t *testing.T) {
	ctx := context.Background()
	env := newIntegrationEnv(t, ctx)
	client := newCookieClient(t)

	loginKcalTestUser(t, ctx, env, client)

	deviceID := "33333333-3333-3333-3333-333333333334"

	for range 2 {
		syncResp := mustDoRequest(t, client, newJSONRequest(t, ctx, http.MethodPost, env.server.URL+"/api/v1/kcal/sync", map[string]any{
			"device_id":     deviceID,
			"last_sync_seq": 0,
			"changes":       []map[string]any{},
		}))
		defer func() { _ = syncResp.Body.Close() }()
		if syncResp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(syncResp.Body)
			t.Fatalf("sync status = %d, want %d, body = %s", syncResp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
		}

		var syncPayload struct {
			Data struct {
				PushResults []struct{} `json:"push_results"`
				PullChanges []struct{} `json:"pull_changes"`
				LastSyncSeq int64      `json:"last_sync_seq"`
			} `json:"data"`
		}
		if err := json.NewDecoder(syncResp.Body).Decode(&syncPayload); err != nil {
			t.Fatalf("decode sync response: %v", err)
		}
		if len(syncPayload.Data.PushResults) != 0 || len(syncPayload.Data.PullChanges) != 0 {
			t.Fatalf("sync payload = %+v, want no changes", syncPayload.Data)
		}
		if syncPayload.Data.LastSyncSeq != 0 {
			t.Fatalf("last_sync_seq = %d, want 0", syncPayload.Data.LastSyncSeq)
		}
	}
}

func loginKcalTestUser(t *testing.T, ctx context.Context, env *integrationEnv, client *http.Client) sqlc.User {
	t.Helper()

	user, err := env.queries.CreateUser(ctx, []byte("httpapi-kcal-test-user"))
	if err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}

	authenticateTestClient(t, ctx, env, client, user.ID)

	return user
}

func newJSONRequest(t *testing.T, ctx context.Context, method string, endpoint string, payload any) *http.Request {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return newRequest(t, ctx, method, endpoint, bytes.NewReader(body), withJSONContentType())
}

func mustUUID(t *testing.T, raw string) uuid.UUID {
	t.Helper()
	parsed, err := uuid.Parse(raw)
	if err != nil {
		t.Fatalf("uuid.Parse() error = %v", err)
	}
	return parsed
}

func TestKcalCrudTemplateAndEntryFlow(t *testing.T) {
	ctx := context.Background()
	env := newIntegrationEnv(t, ctx)
	client := newCookieClient(t)
	_ = loginKcalTestUser(t, ctx, env, client)

	createTemplateResp := mustDoRequest(t, client, newJSONRequest(t, ctx, http.MethodPost, env.server.URL+"/api/v1/kcal/templates", map[string]any{
		"kind":        "food",
		"name":        "banana",
		"amount":      "1",
		"unit":        "piece",
		"kcal_amount": 90,
	}))
	defer func() { _ = createTemplateResp.Body.Close() }()
	if createTemplateResp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createTemplateResp.Body)
		t.Fatalf("create template status = %d, want %d, body = %s", createTemplateResp.StatusCode, http.StatusCreated, strings.TrimSpace(string(body)))
	}
	var createdTemplate struct {
		Data struct {
			Template struct {
				ID         string `json:"id"`
				Name       string `json:"name"`
				KcalAmount int32  `json:"kcal_amount"`
			} `json:"template"`
		} `json:"data"`
	}
	if err := json.NewDecoder(createTemplateResp.Body).Decode(&createdTemplate); err != nil {
		t.Fatalf("decode create template response: %v", err)
	}
	if createdTemplate.Data.Template.Name != "banana" {
		t.Fatalf("created template = %+v, want banana", createdTemplate.Data.Template)
	}

	updateTemplateResp := mustDoRequest(t, client, newJSONRequest(t, ctx, http.MethodPut, env.server.URL+"/api/v1/kcal/templates/"+createdTemplate.Data.Template.ID, map[string]any{
		"kind":        "food",
		"name":        "banana large",
		"amount":      "1",
		"unit":        "piece",
		"kcal_amount": 120,
	}))
	defer func() { _ = updateTemplateResp.Body.Close() }()
	if updateTemplateResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(updateTemplateResp.Body)
		t.Fatalf("update template status = %d, want %d, body = %s", updateTemplateResp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
	}

	createEntryResp := mustDoRequest(t, client, newJSONRequest(t, ctx, http.MethodPost, env.server.URL+"/api/v1/kcal/entries", map[string]any{
		"kcal_delta":  300,
		"happened_at": "2026-03-23T13:00:00Z",
	}))
	defer func() { _ = createEntryResp.Body.Close() }()
	if createEntryResp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createEntryResp.Body)
		t.Fatalf("create entry status = %d, want %d, body = %s", createEntryResp.StatusCode, http.StatusCreated, strings.TrimSpace(string(body)))
	}
	var createdEntry struct {
		Data struct {
			Entry struct {
				ID        string `json:"id"`
				KcalDelta int32  `json:"kcal_delta"`
			} `json:"entry"`
		} `json:"data"`
	}
	if err := json.NewDecoder(createEntryResp.Body).Decode(&createdEntry); err != nil {
		t.Fatalf("decode create entry response: %v", err)
	}
	if createdEntry.Data.Entry.KcalDelta != 300 {
		t.Fatalf("created entry = %+v, want 300 kcal", createdEntry.Data.Entry)
	}

	updateEntryResp := mustDoRequest(t, client, newJSONRequest(t, ctx, http.MethodPut, env.server.URL+"/api/v1/kcal/entries/"+createdEntry.Data.Entry.ID, map[string]any{
		"kcal_delta":  250,
		"happened_at": "2026-03-23T13:15:00Z",
	}))
	defer func() { _ = updateEntryResp.Body.Close() }()
	if updateEntryResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(updateEntryResp.Body)
		t.Fatalf("update entry status = %d, want %d, body = %s", updateEntryResp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
	}

	totalResp := mustDoRequest(t, client, newRequest(t, ctx, http.MethodGet, env.server.URL+"/api/v1/kcal/total?from=2026-03-23T00:00:00Z&to=2026-03-24T00:00:00Z", nil))
	defer func() { _ = totalResp.Body.Close() }()
	var totalPayload struct {
		Data struct {
			TotalKcal int64 `json:"total_kcal"`
		} `json:"data"`
	}
	if err := json.NewDecoder(totalResp.Body).Decode(&totalPayload); err != nil {
		t.Fatalf("decode total response: %v", err)
	}
	if totalPayload.Data.TotalKcal != 250 {
		t.Fatalf("total_kcal = %d, want 250", totalPayload.Data.TotalKcal)
	}

	deleteEntryResp := mustDoRequest(t, client, newRequest(t, ctx, http.MethodDelete, env.server.URL+"/api/v1/kcal/entries/"+createdEntry.Data.Entry.ID, nil))
	defer func() { _ = deleteEntryResp.Body.Close() }()
	if deleteEntryResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(deleteEntryResp.Body)
		t.Fatalf("delete entry status = %d, want %d, body = %s", deleteEntryResp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
	}

	deleteTemplateResp := mustDoRequest(t, client, newRequest(t, ctx, http.MethodDelete, env.server.URL+"/api/v1/kcal/templates/"+createdTemplate.Data.Template.ID, nil))
	defer func() { _ = deleteTemplateResp.Body.Close() }()
	if deleteTemplateResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(deleteTemplateResp.Body)
		t.Fatalf("delete template status = %d, want %d, body = %s", deleteTemplateResp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
	}

	listTemplatesResp := mustDoRequest(t, client, newRequest(t, ctx, http.MethodGet, env.server.URL+"/api/v1/kcal/templates/food", nil))
	defer func() { _ = listTemplatesResp.Body.Close() }()
	var templatesPayload struct {
		Data struct {
			Templates []map[string]any `json:"templates"`
		} `json:"data"`
	}
	if err := json.NewDecoder(listTemplatesResp.Body).Decode(&templatesPayload); err != nil {
		t.Fatalf("decode templates response: %v", err)
	}
	if len(templatesPayload.Data.Templates) != 0 {
		t.Fatalf("templates = %+v, want empty after delete", templatesPayload.Data.Templates)
	}
}
