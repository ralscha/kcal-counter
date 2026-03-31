package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPasskeyLoginRoutesAreRateLimited(t *testing.T) {
	ctx := context.Background()
	env := newIntegrationEnv(t, ctx)
	client := newCookieClient(t)

	endpoint := env.server.URL + "/api/v1/auth/passkeys/login/start"

	for attempt := 1; attempt <= 5; attempt++ {
		resp := mustDoRequest(t, client, newRequest(t, ctx, http.MethodPost, endpoint, nil))
		defer func() { _ = resp.Body.Close() }()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("attempt %d status = %d, want %d, body = %s", attempt, resp.StatusCode, http.StatusOK, strings.TrimSpace(string(body)))
		}
	}

	resp := mustDoRequest(t, client, newRequest(t, ctx, http.MethodPost, endpoint, nil))
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusTooManyRequests {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("rate-limited status = %d, want %d, body = %s", resp.StatusCode, http.StatusTooManyRequests, strings.TrimSpace(string(body)))
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("Retry-After header = empty, want retry hint")
	}

	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if payload.Error.Code != "too_many_requests" {
		t.Fatalf("error code = %q, want too_many_requests", payload.Error.Code)
	}
	if payload.Error.Message != "too many requests; try again later" {
		t.Fatalf("error message = %q, want rate-limit message", payload.Error.Message)
	}
}
