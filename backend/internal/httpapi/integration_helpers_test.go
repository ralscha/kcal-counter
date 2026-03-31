package httpapi_test

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"kcal-counter/internal/auth"
	"kcal-counter/internal/cache"
	"kcal-counter/internal/config"
	"kcal-counter/internal/database"
	"kcal-counter/internal/httpapi"
	"kcal-counter/internal/kcal"
	"kcal-counter/internal/store/sqlc"
	"kcal-counter/internal/testutil"

	"github.com/alexedwards/scs/pgxstore"
	"github.com/alexedwards/scs/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	ratelimit "github.com/ralscha/ratelimiter-pg"
)

type integrationEnv struct {
	db          *sql.DB
	pool        *pgxpool.Pool
	server      *httptest.Server
	queries     *sqlc.Queries
	authService *auth.Service
	sessions    *scs.SessionManager
}

func newIntegrationEnv(t *testing.T, ctx context.Context) *integrationEnv {
	t.Helper()

	databaseURL := testutil.FreshPostgresDatabaseURL(t, ctx)
	dbCfg := config.DatabaseConfig{
		URL:             databaseURL,
		MaxOpenConns:    10,
		MaxIdleConns:    2,
		ConnMaxLifetime: time.Minute,
		ConnMaxIdleTime: time.Minute,
	}

	db, err := database.Open(ctx, dbCfg)
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := database.RunMigrations(ctx, db); err != nil {
		t.Fatalf("RunMigrations() error = %v", err)
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("pgxpool.New() error = %v", err)
	}
	t.Cleanup(pool.Close)

	appCfg := config.Config{
		Database: dbCfg,
		Session: config.SessionConfig{
			CookieName:  "kcal_counter_session",
			Lifetime:    24 * time.Hour,
			IdleTimeout: 12 * time.Hour,
			SameSite:    "lax",
			HTTPOnly:    true,
			Persist:     true,
		},
		Security: config.SecurityConfig{
			AuthorizationCacheTTL: 5 * time.Second,
			FailedLoginThreshold:  5,
			FailedLoginWindow:     15 * time.Minute,
		},
		WebAuthn: config.WebAuthnConfig{
			RPID:          "localhost",
			RPDisplayName: "Kcal Counter Test",
			RPOrigins:     []string{"http://localhost:3000", "http://localhost:8080"},
		},
	}

	authService, err := auth.NewService(ctx, db, pool, appCfg)
	if err != nil {
		t.Fatalf("auth.NewService() error = %v", err)
	}

	sessions := scs.New()
	sessions.Store = pgxstore.NewWithCleanupInterval(pool, 0)
	sessions.Cookie.Name = appCfg.Session.CookieName
	sessions.Cookie.HttpOnly = true
	sessions.Lifetime = appCfg.Session.Lifetime
	sessions.IdleTimeout = appCfg.Session.IdleTimeout

	loginLimiter := ratelimit.New(pool, "public", ratelimit.BucketConfig{
		Capacity:        5,
		RefillPerSecond: 1.0 / 60.0,
		CostPerRequest:  1,
		DenyRetryFloor:  time.Second,
	})
	if err := loginLimiter.Init(ctx); err != nil {
		t.Fatalf("loginLimiter.Init() error = %v", err)
	}

	roleCache := cache.New[int64](appCfg.Security.AuthorizationCacheTTL, func(v []string) []string {
		return append([]string(nil), v...)
	})
	handler := httpapi.NewRouter(db, sessions, authService, kcal.NewService(kcal.NewStore(db)), loginLimiter, roleCache, slog.New(slog.NewTextHandler(io.Discard, nil)), appCfg)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	return &integrationEnv{
		db:          db,
		pool:        pool,
		server:      server,
		queries:     sqlc.New(db),
		authService: authService,
		sessions:    sessions,
	}
}

func newCookieClient(t *testing.T) *http.Client {
	t.Helper()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar.New() error = %v", err)
	}
	return &http.Client{Jar: jar}
}

type requestOption func(*http.Request)

func withJSONContentType() requestOption {
	return func(req *http.Request) {
		req.Header.Set("Content-Type", "application/json")
	}
}

func newRequest(t *testing.T, ctx context.Context, method string, endpoint string, body io.Reader, options ...requestOption) *http.Request {
	t.Helper()

	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		t.Fatalf("http.NewRequestWithContext() error = %v", err)
	}
	for _, option := range options {
		option(req)
	}
	return req
}

func mustDoRequest(t *testing.T, client *http.Client, req *http.Request) *http.Response {
	t.Helper()

	resp, err := client.Do(req) //nolint:gosec // test helper only calls httptest/local integration endpoints
	if err != nil {
		t.Fatalf("client.Do() error = %v", err)
	}
	return resp
}

func authenticateTestClient(t *testing.T, ctx context.Context, env *integrationEnv, client *http.Client, userID int64) {
	t.Helper()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, env.server.URL+"/test-login", nil).WithContext(ctx)
	handler := env.sessions.LoadAndSave(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := env.sessions.RenewToken(r.Context()); err != nil {
			t.Fatalf("RenewToken() error = %v", err)
		}
		env.sessions.Put(r.Context(), "user_id", userID)
		w.WriteHeader(http.StatusNoContent)
	}))
	handler.ServeHTTP(recorder, request)

	targetURL, err := url.Parse(env.server.URL)
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}
	client.Jar.SetCookies(targetURL, recorder.Result().Cookies())
}
