package handlers

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kcal-counter/internal/auth"
	"kcal-counter/internal/httpapi/jsonio"

	"github.com/alexedwards/scs/v2"
)

const (
	passkeyRegistrationSessionKey = "passkey_registration_session"
	passkeyLoginSessionKey        = "passkey_login_session" //nolint:gosec // session key name, not a credential
)

type AuthHandler struct {
	Service  *auth.Service
	Sessions *scs.SessionManager
	Logger   *slog.Logger
}

func (h AuthHandler) RegisterPasskey(w http.ResponseWriter, r *http.Request) {
	options, sessionJSON, err := h.Service.RegisterPasskey(r.Context(), auth.PasskeyRegisterInput{IPAddress: clientIP(r)})
	if err != nil {
		h.handleAuthError(w, r, err)
		return
	}

	h.Sessions.Put(r.Context(), passkeyRegistrationSessionKey, string(sessionJSON))
	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"options": options})
}

func (h AuthHandler) BeginPasskeyRegistration(w http.ResponseWriter, r *http.Request) {
	options, sessionJSON, err := h.Service.BeginPasskeyRegistration(r.Context(), h.Sessions.GetInt64(r.Context(), "user_id"))
	if err != nil {
		h.handleAuthError(w, r, err)
		return
	}

	h.Sessions.Put(r.Context(), passkeyRegistrationSessionKey, string(sessionJSON))
	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"options": options})
}

func (h AuthHandler) FinishPasskeyRegistration(w http.ResponseWriter, r *http.Request) {
	var req passkeyRegistrationRequest
	if err := jsonio.DecodeAndValidate(w, r, &req); err != nil {
		return
	}

	sessionJSON := []byte(h.Sessions.GetString(r.Context(), passkeyRegistrationSessionKey))

	userID := h.Sessions.GetInt64(r.Context(), "user_id")
	if userID == 0 {
		// New user registration: create the user and credential atomically.
		principal, err := h.Service.FinishPasskeyRegistrationForNewUser(r.Context(), sessionJSON, req.Credential)
		if err != nil {
			h.handleAuthError(w, r, err)
			return
		}
		if err := h.completeLogin(r.Context(), principal); err != nil {
			jsonio.WriteError(w, http.StatusInternalServerError, "session_error", err.Error())
			return
		}
		h.Sessions.Remove(r.Context(), passkeyRegistrationSessionKey)
		jsonio.WriteJSON(w, http.StatusCreated, map[string]any{"user": principal})
		return
	}

	// Existing authenticated user adding a new passkey.
	if err := h.Service.FinishPasskeyRegistration(r.Context(), userID, sessionJSON, req.Credential); err != nil {
		h.handleAuthError(w, r, err)
		return
	}
	h.Sessions.Remove(r.Context(), passkeyRegistrationSessionKey)
	jsonio.WriteJSON(w, http.StatusCreated, map[string]any{"registered": true})
}

func (h AuthHandler) BeginPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	options, sessionJSON, err := h.Service.BeginPasskeyLogin()
	if err != nil {
		h.handleAuthError(w, r, err)
		return
	}

	h.Sessions.Put(r.Context(), passkeyLoginSessionKey, string(sessionJSON))
	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"options": options})
}

func (h AuthHandler) FinishPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	var req passkeyLoginRequest
	if err := jsonio.DecodeAndValidate(w, r, &req); err != nil {
		return
	}

	sessionJSON := []byte(h.Sessions.GetString(r.Context(), passkeyLoginSessionKey))
	principal, err := h.Service.FinishPasskeyLogin(r.Context(), sessionJSON, req.Credential)
	if err != nil {
		h.handleAuthError(w, r, err)
		return
	}

	if err := h.completeLogin(r.Context(), principal); err != nil {
		jsonio.WriteError(w, http.StatusInternalServerError, "session_error", err.Error())
		return
	}

	h.Sessions.Remove(r.Context(), passkeyLoginSessionKey)
	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"user": principal})
}

func (h AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	if err := h.Sessions.Destroy(r.Context()); err != nil {
		jsonio.WriteError(w, http.StatusInternalServerError, "logout_failed", "could not destroy session")
		return
	}
	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"logged_out": true})
}

func (h AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	principal, err := h.Service.CurrentUser(r.Context(), h.Sessions.GetInt64(r.Context(), "user_id"))
	if err != nil {
		h.handleAuthError(w, r, err)
		return
	}
	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"user": principal})
}

func (h AuthHandler) handleAuthError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case writeRateLimitError(w, err):
		return
	case errors.Is(err, auth.ErrUnauthorized):
		jsonio.WriteError(w, http.StatusUnauthorized, "unauthorized", err.Error())
	case errors.Is(err, auth.ErrAccountLocked):
		jsonio.WriteError(w, http.StatusLocked, "account_locked", err.Error())
	case errors.Is(err, auth.ErrAccountDisabled):
		jsonio.WriteError(w, http.StatusForbidden, "account_disabled", err.Error())
	case errors.Is(err, auth.ErrPasskeyCeremony):
		jsonio.WriteError(w, http.StatusBadRequest, "passkey_ceremony_missing", err.Error())
	case errors.Is(err, auth.ErrRequestFailed):
		jsonio.WriteError(w, http.StatusConflict, "request_failed", err.Error())
	default:
		if h.Logger != nil {
			h.Logger.Error("auth request failed",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.String("remote_addr", r.RemoteAddr),
				slog.Any("err", err),
			)
		}
		jsonio.WriteError(w, http.StatusInternalServerError, "internal_error", "an unexpected error occurred")
	}
}

func handleAuthError(w http.ResponseWriter, err error) {
	AuthHandler{}.handleAuthError(w, &http.Request{}, err)
}

func writeRateLimitError(w http.ResponseWriter, err error) bool {
	var rateLimitErr *auth.RateLimitError
	if !errors.As(err, &rateLimitErr) {
		return false
	}

	if rateLimitErr.RetryAfter > 0 {
		w.Header().Set("Retry-After", formatRetryAfter(rateLimitErr.RetryAfter))
	}
	jsonio.WriteError(w, http.StatusTooManyRequests, "too_many_requests", "too many requests; try again later")
	return true
}

func (h AuthHandler) completeLogin(ctx context.Context, principal auth.SessionPrincipal) error {
	if err := h.Sessions.RenewToken(ctx); err != nil {
		return errors.New("could not renew session")
	}
	h.Sessions.Put(ctx, "user_id", principal.UserID)
	return nil
}

func clientIP(r *http.Request) string {
	forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	if forwarded != "" {
		return forwarded
	}

	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func formatRetryAfter(duration time.Duration) string {
	seconds := max(int(duration.Seconds()), 1)
	return strconv.Itoa(seconds)
}
