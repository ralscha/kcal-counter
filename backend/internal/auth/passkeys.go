package auth

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"kcal-counter/internal/store/sqlc"

	"github.com/go-webauthn/webauthn/protocol"
	wa "github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
)

const webauthnUserIDLength = 32

func (s *Service) BeginPasskeyRegistration(ctx context.Context, userID int64) (*protocol.CredentialCreation, []byte, error) {
	user, err := s.loadPasskeyUser(ctx, userID)
	if err != nil {
		return nil, nil, err
	}

	options, session, err := s.webAuthn.BeginRegistration(
		user,
		wa.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		wa.WithExclusions(wa.Credentials(user.WebAuthnCredentials()).CredentialDescriptors()),
		wa.WithExtensions(map[string]any{"credProps": true}),
	)
	if err != nil {
		return nil, nil, err
	}

	sessionJSON, err := json.Marshal(session)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal passkey registration session: %w", err)
	}

	return options, sessionJSON, nil
}

func (s *Service) BeginPasskeyRegistrationForNewUser(ctx context.Context) (*protocol.CredentialCreation, []byte, error) {
	handle := make([]byte, webauthnUserIDLength)
	if _, err := crand.Read(handle); err != nil {
		return nil, nil, fmt.Errorf("generate user handle: %w", err)
	}

	user := &newUserPasskeyUser{handle: handle}
	options, session, err := s.webAuthn.BeginRegistration(
		user,
		wa.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		wa.WithExtensions(map[string]any{"credProps": true}),
	)
	if err != nil {
		return nil, nil, err
	}

	sessionJSON, err := json.Marshal(session)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal passkey registration session: %w", err)
	}

	return options, sessionJSON, nil
}

func (s *Service) FinishPasskeyRegistrationForNewUser(ctx context.Context, sessionJSON, credentialJSON []byte) (SessionPrincipal, error) {
	session, err := decodePasskeySession(sessionJSON)
	if err != nil {
		return SessionPrincipal{}, err
	}

	user := &newUserPasskeyUser{handle: session.UserID}
	credential, err := s.webAuthn.FinishRegistration(user, *session, jsonRequest(credentialJSON))
	if err != nil {
		return SessionPrincipal{}, err
	}

	var principal SessionPrincipal
	if err := s.withTx(ctx, func(q *sqlc.Queries) error {
		newUser, err := q.CreateUser(ctx, session.UserID)
		if err != nil {
			if isUniqueViolation(err) {
				return ErrRequestFailed
			}
			return err
		}

		role, err := q.GetRoleByName(ctx, "user")
		if err != nil {
			return err
		}
		if err := q.AddUserRole(ctx, sqlc.AddUserRoleParams{UserID: newUser.ID, RoleID: role.ID}); err != nil {
			return err
		}
		if err := q.UpdateUserLastLogin(ctx, newUser.ID); err != nil {
			return err
		}
		if err := persistPasskeyCredential(ctx, q, newUser.ID, credential); err != nil {
			return err
		}

		roles, err := q.ListUserRoleNames(ctx, newUser.ID)
		if err != nil {
			return err
		}
		principal = principalFromUser(newUser, roles)
		return nil
	}); err != nil {
		return SessionPrincipal{}, err
	}

	return principal, nil
}

func (s *Service) FinishPasskeyRegistration(ctx context.Context, userID int64, sessionJSON, credentialJSON []byte) error {
	session, err := decodePasskeySession(sessionJSON)
	if err != nil {
		return err
	}

	user, err := s.loadPasskeyUser(ctx, userID)
	if err != nil {
		return err
	}

	credential, err := s.webAuthn.FinishRegistration(user, *session, jsonRequest(credentialJSON))
	if err != nil {
		return err
	}

	return persistPasskeyCredential(ctx, s.queries, userID, credential)
}

func (s *Service) BeginPasskeyLogin() (*protocol.CredentialAssertion, []byte, error) {
	options, session, err := s.webAuthn.BeginDiscoverableLogin(wa.WithUserVerification(protocol.VerificationPreferred))
	if err != nil {
		return nil, nil, err
	}

	sessionJSON, err := json.Marshal(session)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal passkey login session: %w", err)
	}

	return options, sessionJSON, nil
}

func (s *Service) FinishPasskeyLogin(ctx context.Context, sessionJSON, credentialJSON []byte) (SessionPrincipal, error) {
	session, err := decodePasskeySession(sessionJSON)
	if err != nil {
		return SessionPrincipal{}, err
	}

	validatedUser, validatedCredential, err := s.webAuthn.FinishPasskeyLogin(func(rawID, userHandle []byte) (wa.User, error) {
		return s.loadPasskeyUserByHandle(ctx, rawID, userHandle)
	}, *session, jsonRequest(credentialJSON))
	if err != nil {
		return SessionPrincipal{}, err
	}

	user, ok := validatedUser.(*passkeyUser)
	if !ok {
		return SessionPrincipal{}, errors.New("unexpected passkey user type")
	}

	if err := s.updatePasskeyCredential(ctx, validatedCredential); err != nil {
		return SessionPrincipal{}, err
	}

	return s.completeUserAuthentication(ctx, s.queries, user.user.ID, true)
}

type passkeyUser struct {
	user        sqlc.User
	credentials []wa.Credential
}

func (u *passkeyUser) WebAuthnID() []byte {
	return append([]byte(nil), u.user.WebauthnUserID...)
}

func (u *passkeyUser) WebAuthnName() string {
	return strconv.FormatInt(u.user.ID, 10)
}

func (u *passkeyUser) WebAuthnDisplayName() string {
	return strconv.FormatInt(u.user.ID, 10)
}

func (u *passkeyUser) WebAuthnCredentials() []wa.Credential {
	return u.credentials
}

type newUserPasskeyUser struct {
	handle []byte
}

func (u *newUserPasskeyUser) WebAuthnID() []byte                   { return u.handle }
func (u *newUserPasskeyUser) WebAuthnName() string                 { return "new-user" }
func (u *newUserPasskeyUser) WebAuthnDisplayName() string          { return "New User" }
func (u *newUserPasskeyUser) WebAuthnCredentials() []wa.Credential { return nil }

func (s *Service) loadPasskeyUser(ctx context.Context, userID int64) (*passkeyUser, error) {
	user, err := s.queries.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !user.IsActive {
		return nil, ErrAccountDisabled
	}
	if user.LockedUntil.Valid && user.LockedUntil.Time.After(time.Now().UTC()) {
		return nil, ErrAccountLocked
	}

	credentialRows, err := s.queries.ListPasskeyCredentialsByUserID(ctx, userID)
	if err != nil {
		return nil, err
	}

	credentials := make([]wa.Credential, 0, len(credentialRows))
	for _, row := range credentialRows {
		credential := credentialFromRow(row)
		credentials = append(credentials, credential)
	}

	return &passkeyUser{user: user, credentials: credentials}, nil
}

func (s *Service) loadPasskeyUserByHandle(ctx context.Context, rawID, userHandle []byte) (*passkeyUser, error) {
	credential, err := s.queries.GetPasskeyCredentialByCredentialID(ctx, rawID)
	if err != nil {
		return nil, err
	}

	user, err := s.loadPasskeyUser(ctx, credential.UserID)
	if err != nil {
		return nil, err
	}
	if len(userHandle) > 0 && !bytes.Equal(user.WebAuthnID(), userHandle) {
		return nil, errors.New("passkey user handle mismatch")
	}
	return user, nil
}

func decodePasskeySession(sessionJSON []byte) (*wa.SessionData, error) {
	if len(bytes.TrimSpace(sessionJSON)) == 0 {
		return nil, ErrPasskeyCeremony
	}

	var session wa.SessionData
	if err := json.Unmarshal(sessionJSON, &session); err != nil {
		return nil, fmt.Errorf("decode passkey session: %w", err)
	}

	return &session, nil
}

func jsonRequest(body []byte) *http.Request {
	return &http.Request{
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   io.NopCloser(bytes.NewReader(body)),
	}
}

func persistPasskeyCredential(ctx context.Context, q *sqlc.Queries, userID int64, credential *wa.Credential) error {
	if len(credential.ID) == 0 {
		return errors.New("passkey credential id is required")
	}
	credentialData, err := json.Marshal(credential)
	if err != nil {
		return fmt.Errorf("marshal passkey credential: %w", err)
	}

	aaguid := uuid.NullUUID{}
	if len(credential.Authenticator.AAGUID) == 16 {
		parsed, err := uuid.FromBytes(credential.Authenticator.AAGUID)
		if err != nil {
			return fmt.Errorf("decode passkey aaguid: %w", err)
		}
		aaguid = uuid.NullUUID{UUID: parsed, Valid: true}
	}

	transports := make([]string, 0, len(credential.Transport))
	for _, transport := range credential.Transport {
		transports = append(transports, string(transport))
	}

	_, err = q.CreatePasskeyCredential(ctx, sqlc.CreatePasskeyCredentialParams{
		UserID:              userID,
		CredentialID:        credential.ID,
		CredentialPublicKey: credential.PublicKey,
		AttestationType:     credential.AttestationType,
		Aaguid:              aaguid,
		SignCount:           int64(credential.Authenticator.SignCount),
		CloneWarning:        credential.Authenticator.CloneWarning,
		Transports:          transports,
		CredentialData:      credentialData,
	})

	return err
}

func (s *Service) updatePasskeyCredential(ctx context.Context, credential *wa.Credential) error {
	current, err := s.queries.GetPasskeyCredentialByCredentialID(ctx, credential.ID)
	if err != nil {
		return err
	}

	updatedCredential := *credential
	cloneWarning := current.CloneWarning || credential.Authenticator.CloneWarning
	if int64(updatedCredential.Authenticator.SignCount) < current.SignCount {
		cloneWarning = true
		updatedCredential.Authenticator.SignCount = uint32(current.SignCount) //nolint:gosec // persisted sign count fits WebAuthn counter field
	}
	updatedCredential.Authenticator.CloneWarning = cloneWarning

	credentialData, err := json.Marshal(&updatedCredential)
	if err != nil {
		return fmt.Errorf("marshal updated passkey credential: %w", err)
	}

	aaguid := uuid.NullUUID{}
	if len(updatedCredential.Authenticator.AAGUID) == 16 {
		parsed, err := uuid.FromBytes(updatedCredential.Authenticator.AAGUID)
		if err != nil {
			return fmt.Errorf("decode passkey aaguid: %w", err)
		}
		aaguid = uuid.NullUUID{UUID: parsed, Valid: true}
	}

	transports := make([]string, 0, len(updatedCredential.Transport))
	for _, transport := range updatedCredential.Transport {
		transports = append(transports, string(transport))
	}

	return s.queries.UpdatePasskeyCredential(ctx, sqlc.UpdatePasskeyCredentialParams{
		CredentialID:        updatedCredential.ID,
		CredentialPublicKey: updatedCredential.PublicKey,
		AttestationType:     updatedCredential.AttestationType,
		Aaguid:              aaguid,
		SignCount:           int64(updatedCredential.Authenticator.SignCount),
		CloneWarning:        cloneWarning,
		Transports:          transports,
		CredentialData:      credentialData,
	})
}

func credentialFromRow(row sqlc.PasskeyCredential) wa.Credential {
	if len(row.CredentialData) > 0 && string(row.CredentialData) != "{}" {
		var credential wa.Credential
		if err := json.Unmarshal(row.CredentialData, &credential); err == nil {
			return credential
		}
	}

	credential := wa.Credential{
		ID:              row.CredentialID,
		PublicKey:       row.CredentialPublicKey,
		AttestationType: row.AttestationType,
		Transport:       make([]protocol.AuthenticatorTransport, 0, len(row.Transports)),
		Authenticator: wa.Authenticator{
			SignCount:    uint32(row.SignCount), //nolint:gosec // WebAuthn sign counter fits in uint32
			CloneWarning: row.CloneWarning,
		},
	}

	if row.Aaguid.Valid {
		credential.Authenticator.AAGUID = row.Aaguid.UUID[:]
	}
	for _, transport := range row.Transports {
		credential.Transport = append(credential.Transport, protocol.AuthenticatorTransport(transport))
	}

	return credential
}
