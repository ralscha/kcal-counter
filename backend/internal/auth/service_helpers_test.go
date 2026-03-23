package auth

import (
	"testing"

	"kcal-counter/internal/store/sqlc"

	wa "github.com/go-webauthn/webauthn/webauthn"
)

func TestPasskeyUserWebAuthnMethods(t *testing.T) {
	credential := wa.Credential{ID: []byte("cred-1")}
	user := &passkeyUser{
		user:        sqlc.User{ID: 42, WebauthnUserID: []byte("stored-handle")},
		credentials: []wa.Credential{credential},
	}

	if got := user.WebAuthnName(); got != "42" {
		t.Fatalf("WebAuthnName() = %q, want 42", got)
	}
	if got := user.WebAuthnDisplayName(); got != "42" {
		t.Fatalf("WebAuthnDisplayName() = %q, want 42", got)
	}
	if got := user.WebAuthnCredentials(); len(got) != 1 || string(got[0].ID) != "cred-1" {
		t.Fatalf("WebAuthnCredentials() = %v, want credential list", got)
	}

	encodedID := user.WebAuthnID()
	if got := string(encodedID); got != "stored-handle" {
		t.Fatalf("WebAuthnID() = %q, want stored-handle", got)
	}
}
