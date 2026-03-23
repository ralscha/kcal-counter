package scheduler

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"database/sql"
	"kcal-counter/internal/config"
	"kcal-counter/internal/database"
	"kcal-counter/internal/store/sqlc"
	"kcal-counter/internal/testutil"
)

func TestStartReturnsNilWhenDisabled(t *testing.T) {
	scheduler := Start(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), nil, nil, config.Config{
		Scheduler: config.SchedulerConfig{Enabled: false},
	})
	if scheduler != nil {
		t.Fatalf("Start() = %v, want nil when scheduler disabled", scheduler)
	}
}

func TestStopHandlesNilReceiver(t *testing.T) {
	var scheduler *Scheduler
	scheduler.Stop()
}

func TestLoopSkipsNonPositiveIntervals(t *testing.T) {
	scheduler := &Scheduler{}
	ctx := t.Context()

	var calls atomic.Int32
	scheduler.loop(ctx, 0, func(context.Context) {
		calls.Add(1)
	})

	if got := calls.Load(); got != 0 {
		t.Fatalf("job calls = %d, want 0", got)
	}
}

func TestLoopRunsJobAndStopsOnCancel(t *testing.T) {
	scheduler := &Scheduler{}
	ctx, cancel := context.WithCancel(context.Background())

	var calls atomic.Int32
	scheduler.loop(ctx, 5*time.Millisecond, func(context.Context) {
		calls.Add(1)
	})

	time.Sleep(20 * time.Millisecond)
	cancel()
	scheduler.wg.Wait()

	if got := calls.Load(); got == 0 {
		t.Fatal("job calls = 0, want at least one execution")
	}
}

func TestRegisterSweeperRunsDuringCleanup(t *testing.T) {
	scheduler := &Scheduler{logger: discardLogger()}

	called := make(chan time.Time, 1)
	scheduler.RegisterSweeper(func(now time.Time) {
		called <- now
	})

	scheduler.cleanup(context.Background())

	select {
	case runAt := <-called:
		if runAt.IsZero() {
			t.Fatal("cleanup time = zero, want timestamp")
		}
	default:
		t.Fatal("registered sweeper was not called during cleanup")
	}
}

func TestDisableInactiveUsersDisablesOnlyStaleAccounts(t *testing.T) {
	ctx := context.Background()
	db, queries := newSchedulerTestDB(t, ctx)

	staleUser, err := queries.CreateUser(ctx, []byte("scheduler-stale-user"))
	if err != nil {
		t.Fatalf("CreateUser(stale) error = %v", err)
	}
	recentUser, err := queries.CreateUser(ctx, []byte("scheduler-recent-user"))
	if err != nil {
		t.Fatalf("CreateUser(recent) error = %v", err)
	}

	if _, err := db.ExecContext(ctx, `UPDATE users SET created_at = NOW() - INTERVAL '48 hours' WHERE id = $1`, staleUser.ID); err != nil {
		t.Fatalf("age stale user: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE users SET last_login_at = NOW() - INTERVAL '72 hours' WHERE id = $1`, staleUser.ID); err != nil {
		t.Fatalf("set stale last_login_at: %v", err)
	}

	scheduler := &Scheduler{
		logger: discardLogger(),
		q:      queries,
		cfg: config.Config{
			Security: config.SecurityConfig{InactivityDisableAfter: 24 * time.Hour},
		},
	}
	scheduler.disableInactiveUsers(ctx)

	staleUserAfter, err := queries.GetUserByID(ctx, staleUser.ID)
	if err != nil {
		t.Fatalf("GetUserByID(stale) error = %v", err)
	}
	if staleUserAfter.IsActive {
		t.Fatal("expected stale user to be disabled")
	}
	if !staleUserAfter.DisabledReason.Valid || staleUserAfter.DisabledReason.String != "inactivity" {
		t.Fatalf("DisabledReason = %+v, want inactivity", staleUserAfter.DisabledReason)
	}
	if !staleUserAfter.DisabledAt.Valid {
		t.Fatal("expected stale user DisabledAt to be set")
	}

	recentUserAfter, err := queries.GetUserByID(ctx, recentUser.ID)
	if err != nil {
		t.Fatalf("GetUserByID(recent) error = %v", err)
	}
	if !recentUserAfter.IsActive {
		t.Fatal("expected recent user to remain active")
	}
}

func newSchedulerTestDB(t *testing.T, ctx context.Context) (*sql.DB, *sqlc.Queries) {
	t.Helper()

	databaseURL := testutil.FreshPostgresDatabaseURL(t, ctx)

	db, err := database.Open(ctx, config.DatabaseConfig{
		URL:             databaseURL,
		MaxOpenConns:    5,
		MaxIdleConns:    2,
		ConnMaxLifetime: time.Minute,
		ConnMaxIdleTime: time.Minute,
	})
	if err != nil {
		t.Fatalf("database.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := database.RunMigrations(ctx, db); err != nil {
		t.Fatalf("RunMigrations() error = %v", err)
	}

	return db, sqlc.New(db)
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
