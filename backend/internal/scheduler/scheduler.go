package scheduler

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"database/sql"
	"kcal-counter/internal/auth"
	"kcal-counter/internal/config"
	"kcal-counter/internal/store/sqlc"
)

type Scheduler struct {
	logger   *slog.Logger
	q        *sqlc.Queries
	auth     *auth.Service
	cfg      config.Config
	mu       sync.RWMutex
	sweepers []func(time.Time)

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func Start(parent context.Context, logger *slog.Logger, db *sql.DB, authService *auth.Service, cfg config.Config) *Scheduler {
	if !cfg.Scheduler.Enabled {
		return nil
	}

	ctx, cancel := context.WithCancel(parent)
	s := &Scheduler{
		logger: logger,
		q:      sqlc.New(db),
		auth:   authService,
		cfg:    cfg,
		cancel: cancel,
	}

	s.loop(ctx, cfg.Scheduler.CleanupEvery, s.cleanup)
	s.loop(ctx, cfg.Scheduler.InactivityCheckEvery, s.disableInactiveUsers)

	return s
}

func (s *Scheduler) Stop() {
	if s == nil {
		return
	}
	s.cancel()
	s.wg.Wait()
}

// RegisterSweeper registers a function that is called during each cleanup run
// to evict expired entries from an in-process cache.
func (s *Scheduler) RegisterSweeper(fn func(time.Time)) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.sweepers = append(s.sweepers, fn)
	s.mu.Unlock()
}

func (s *Scheduler) loop(ctx context.Context, interval time.Duration, job func(context.Context)) {
	if interval <= 0 {
		return
	}

	s.wg.Go(func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		job(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				job(ctx)
			}
		}
	})
}
func (s *Scheduler) cleanup(ctx context.Context) {
	if s.auth != nil && s.auth.RateLimiter() != nil {
		removed, err := s.auth.RateLimiter().DeleteStaleBuckets(ctx, 24*time.Hour)
		if err != nil {
			s.logger.Error("delete stale rate limit buckets", slog.Any("err", err))
		} else if removed > 0 {
			s.logger.Info("deleted stale rate limit buckets", slog.Int64("count", removed))
		}
	}

	now := time.Now().UTC()
	s.mu.RLock()
	sweepers := append([]func(time.Time){}, s.sweepers...)
	s.mu.RUnlock()
	for _, sweep := range sweepers {
		sweep(now)
	}
}

func (s *Scheduler) disableInactiveUsers(ctx context.Context) {
	deadline := sql.NullTime{Time: time.Now().UTC().Add(-s.cfg.Security.InactivityDisableAfter), Valid: true}
	users, err := s.q.DisableInactiveUsers(ctx, deadline)
	if err != nil {
		s.logger.Error("disable inactive users", slog.Any("err", err))
		return
	}
	if len(users) > 0 {
		s.logger.Info("disabled inactive users", slog.Int("count", len(users)))
	}
}
