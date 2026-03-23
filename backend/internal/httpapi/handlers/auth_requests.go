package handlers

import (
	"bytes"
	"encoding/json"

	"kcal-counter/internal/validation"
)

type passkeyRegistrationRequest struct {
	Credential json.RawMessage `json:"credential"`
}

func (r *passkeyRegistrationRequest) Normalize() {}

func (r passkeyRegistrationRequest) Validate() error {
	err := validation.New()
	validateCredential(err, r.Credential)
	return err.ErrOrNil()
}

type passkeyLoginRequest struct {
	Credential json.RawMessage `json:"credential"`
}

func (r *passkeyLoginRequest) Normalize() {}

func (r passkeyLoginRequest) Validate() error {
	err := validation.New()
	validateCredential(err, r.Credential)
	return err.ErrOrNil()
}

func validateCredential(err *validation.Errors, value json.RawMessage) {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		err.Add("credential", "required")
	}
}
