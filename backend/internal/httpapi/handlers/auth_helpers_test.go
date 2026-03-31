package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"kcal-counter/internal/auth"
	"kcal-counter/internal/validation"
)

func TestValidationHelpers(t *testing.T) {
	testCases := []struct {
		name     string
		validate func() error
		wantErr  string
		wantMap  validation.FieldErrors
	}{
		{name: "passkey missing credential", validate: func() error { return passkeyRegistrationRequest{}.Validate() }, wantErr: "credential is required", wantMap: validation.FieldErrors{"credential": map[string]any{"required": true}}},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			err := testCase.validate()
			if err == nil {
				t.Fatal("validation error = nil, want non-nil")
			}
			var validationErr *validation.Errors
			if !errors.As(err, &validationErr) {
				t.Fatalf("validation error type = %T, want *validation.Errors", err)
			}
			if validationErr.Error() != testCase.wantErr {
				t.Fatalf("validation error = %q, want %q", validationErr.Error(), testCase.wantErr)
			}
			if !reflect.DeepEqual(validationErr.FieldMap(), testCase.wantMap) {
				t.Fatalf("validation fields = %+v, want %+v", validationErr.FieldMap(), testCase.wantMap)
			}
		})
	}
}

func TestHandleAuthErrorMappings(t *testing.T) {
	testCases := []struct {
		name    string
		err     error
		status  int
		code    string
		message string
	}{
		{name: "unauthorized", err: auth.ErrUnauthorized, status: http.StatusUnauthorized, code: "unauthorized", message: auth.ErrUnauthorized.Error()},
		{name: "locked", err: auth.ErrAccountLocked, status: http.StatusLocked, code: "account_locked", message: auth.ErrAccountLocked.Error()},
		{name: "disabled", err: auth.ErrAccountDisabled, status: http.StatusForbidden, code: "account_disabled", message: auth.ErrAccountDisabled.Error()},
		{name: "passkey", err: auth.ErrPasskeyCeremony, status: http.StatusBadRequest, code: "passkey_ceremony_missing", message: auth.ErrPasskeyCeremony.Error()},
		{name: "request failed", err: auth.ErrRequestFailed, status: http.StatusConflict, code: "request_failed", message: auth.ErrRequestFailed.Error()},
		{name: "default", err: errors.New("boom"), status: http.StatusInternalServerError, code: "internal_error", message: "an unexpected error occurred"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/passkeys/login/finish", nil)
			AuthHandler{}.handleAuthError(recorder, request, testCase.err)

			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, want %d", recorder.Code, testCase.status)
			}

			var response testEnvelope
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("json.Unmarshal() error = %v", err)
			}
			if response.Error == nil {
				t.Fatal("response.Error = nil, want error payload")
			}
			if response.Error.Code != testCase.code || response.Error.Message != testCase.message {
				t.Fatalf("response.Error = %+v, want code=%q message=%q", response.Error, testCase.code, testCase.message)
			}
		})
	}
}

func TestHandleAuthErrorLogsUnexpectedFailures(t *testing.T) {
	var logOutput bytes.Buffer
	handler := AuthHandler{
		Logger: slog.New(slog.NewTextHandler(&logOutput, nil)),
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/passkeys/login/finish", nil)
	request.RemoteAddr = "127.0.0.1:54321"

	handler.handleAuthError(recorder, request, errors.New("boom"))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
	logged := logOutput.String()
	if !strings.Contains(logged, "auth request failed") {
		t.Fatalf("log output = %q, want auth request failed message", logged)
	}
	if !strings.Contains(logged, "boom") {
		t.Fatalf("log output = %q, want underlying error", logged)
	}
	if !strings.Contains(logged, "/api/v1/auth/passkeys/login/finish") {
		t.Fatalf("log output = %q, want request path", logged)
	}
}

func TestClientIP(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "192.168.1.9:8080"
	if got := clientIP(request); got != "192.168.1.9" {
		t.Fatalf("clientIP(host:port) = %q, want 192.168.1.9", got)
	}

	request.RemoteAddr = " 10.0.0.8 "
	if got := clientIP(request); got != "10.0.0.8" {
		t.Fatalf("clientIP(raw) = %q, want 10.0.0.8", got)
	}
}

func TestHandlerMethodsRejectInvalidPayloads(t *testing.T) {
	testCases := []struct {
		name        string
		handler     func(AuthHandler, http.ResponseWriter, *http.Request)
		body        string
		wantMessage string
		wantFields  validation.FieldErrors
	}{
		{name: "finish passkey registration missing credential", handler: AuthHandler.FinishPasskeyRegistration, body: `{}`, wantMessage: "credential is required", wantFields: validation.FieldErrors{"credential": map[string]any{"required": true}}},
		{name: "finish passkey login missing credential", handler: AuthHandler.FinishPasskeyLogin, body: `{}`, wantMessage: "credential is required", wantFields: validation.FieldErrors{"credential": map[string]any{"required": true}}},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(testCase.body))

			testCase.handler(AuthHandler{}, recorder, request)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
			}

			var response testEnvelope
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("json.Unmarshal() error = %v", err)
			}
			if response.Error == nil {
				t.Fatal("response.Error = nil, want error payload")
			}
			if response.Error.Code != "validation_failed" || response.Error.Message != testCase.wantMessage {
				t.Fatalf("response.Error = %+v, want code=%q message=%q", response.Error, "validation_failed", testCase.wantMessage)
			}
			if !reflect.DeepEqual(response.Error.Fields, testCase.wantFields) {
				t.Fatalf("response.Error.Fields = %+v, want %+v", response.Error.Fields, testCase.wantFields)
			}
		})
	}
}
