package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"kcal-counter/internal/config"
	"kcal-counter/internal/database"
	"kcal-counter/internal/store/sqlc"

	"github.com/go-webauthn/webauthn/protocol"
	wa "github.com/go-webauthn/webauthn/webauthn"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	ratelimit "github.com/ralscha/ratelimiter-pg"
)

var (
	ErrAccountLocked   = errors.New("account is locked")
	ErrAccountDisabled = errors.New("account is disabled")
	ErrRequestFailed   = errors.New("request failed")
	ErrPasskeyCeremony = errors.New("passkey ceremony not initialized")
	ErrUnauthorized    = errors.New("authentication required")
	ErrRateLimited     = errors.New("rate limited")
)

type Service struct {
	db       *sql.DB
	queries  *sqlc.Queries
	limiter  *ratelimit.RateLimiter
	webAuthn *wa.WebAuthn
	cfg      config.Config
}
type SessionPrincipal struct {
	UserID int64    `json:"-"`
	Roles  []string `json:"roles"`
}

type RateLimitError struct {
	RetryAfter time.Duration
}

func (e *RateLimitError) Error() string {
	if e == nil || e.RetryAfter <= 0 {
		return ErrRateLimited.Error()
	}
	return fmt.Sprintf("%s: retry after %s", ErrRateLimited.Error(), e.RetryAfter)
}

func (e *RateLimitError) Unwrap() error {
	return ErrRateLimited
}

type PasskeyRegisterInput struct {
	IPAddress string
}

func NewService(ctx context.Context, db *sql.DB, pgxPool *pgxpool.Pool, cfg config.Config) (*Service, error) {
	limitCfg := ratelimit.BucketConfig{
		Capacity:        float64(cfg.Security.FailedLoginThreshold),
		RefillPerSecond: float64(cfg.Security.FailedLoginThreshold) / cfg.Security.FailedLoginWindow.Seconds(),
		CostPerRequest:  1,
		DenyRetryFloor:  time.Second,
	}

	limiter := ratelimit.New(pgxPool, "public", limitCfg)
	if err := limiter.Init(ctx); err != nil {
		return nil, fmt.Errorf("init rate limiter: %w", err)
	}

	webAuthn, err := wa.New(&wa.Config{
		RPID:          cfg.WebAuthn.RPID,
		RPDisplayName: cfg.WebAuthn.RPDisplayName,
		RPOrigins:     cfg.WebAuthn.RPOrigins,
	})
	if err != nil {
		return nil, fmt.Errorf("init webauthn: %w", err)
	}

	return &Service{
		db:       db,
		queries:  sqlc.New(db),
		limiter:  limiter,
		webAuthn: webAuthn,
		cfg:      cfg,
	}, nil
}

func (s *Service) RateLimiter() *ratelimit.RateLimiter {
	return s.limiter
}

func (s *Service) RegisterPasskey(ctx context.Context, input PasskeyRegisterInput) (*protocol.CredentialCreation, []byte, error) {
	if err := s.enforceRateLimit(ctx, "passkey_register", input.IPAddress); err != nil {
		return nil, nil, err
	}

	return s.BeginPasskeyRegistrationForNewUser(ctx)
}

func (s *Service) CurrentUser(ctx context.Context, userID int64) (SessionPrincipal, error) {
	if userID == 0 {
		return SessionPrincipal{}, ErrUnauthorized
	}

	user, err := s.queries.GetUserByID(ctx, userID)
	if err != nil {
		return SessionPrincipal{}, err
	}
	roles, err := s.queries.ListUserRoleNames(ctx, userID)
	if err != nil {
		return SessionPrincipal{}, err
	}
	return principalFromUser(user, roles), nil
}

func (s *Service) UserRoleNames(ctx context.Context, userID int64) ([]string, error) {
	if userID == 0 {
		return nil, ErrUnauthorized
	}

	roles, err := s.queries.ListUserRoleNames(ctx, userID)
	if err != nil {
		return nil, err
	}

	return roles, nil
}

func (s *Service) enforceRateLimit(ctx context.Context, action, ip string) error {
	if ip == "" {
		return nil
	}

	ipDecision, err := s.limiter.AllowWithConfig(ctx, action+":ip:"+ip, ratelimit.BucketConfig{
		Capacity:        float64(s.cfg.Security.FailedLoginThreshold * 4),
		RefillPerSecond: float64(s.cfg.Security.FailedLoginThreshold*4) / s.cfg.Security.FailedLoginWindow.Seconds(),
		CostPerRequest:  1,
		DenyRetryFloor:  time.Second,
	})
	if err != nil {
		return err
	}
	if !ipDecision.Allowed {
		return &RateLimitError{RetryAfter: ipDecision.RetryAfter}
	}

	return nil
}

func (s *Service) completeUserAuthentication(ctx context.Context, queries *sqlc.Queries, userID int64, updateLastLogin bool) (SessionPrincipal, error) {
	if updateLastLogin {
		if err := queries.UpdateUserLastLogin(ctx, userID); err != nil {
			return SessionPrincipal{}, err
		}
	}

	roles, err := queries.ListUserRoleNames(ctx, userID)
	if err != nil {
		return SessionPrincipal{}, err
	}
	updatedUser, err := queries.GetUserByID(ctx, userID)
	if err != nil {
		return SessionPrincipal{}, err
	}

	return principalFromUser(updatedUser, roles), nil
}

func principalFromUser(user sqlc.User, roles []string) SessionPrincipal {
	return SessionPrincipal{
		UserID: user.ID,
		Roles:  roles,
	}
}

func (s *Service) withTx(ctx context.Context, fn func(*sqlc.Queries) error) error {
	return database.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		return fn(s.queries.WithTx(tx))
	})
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
