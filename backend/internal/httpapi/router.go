package httpapi

import (
	"database/sql"
	"log/slog"
	"net/http"

	"kcal-counter/internal/auth"
	"kcal-counter/internal/cache"
	"kcal-counter/internal/config"
	"kcal-counter/internal/httpapi/handlers"
	appmw "kcal-counter/internal/httpapi/middleware"
	"kcal-counter/internal/kcal"

	"github.com/alexedwards/scs/v2"
	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	ratelimit "github.com/ralscha/ratelimiter-pg"
)

func NewRouter(db *sql.DB, sessions *scs.SessionManager, authService *auth.Service, kcalService *kcal.Service, loginLimiter *ratelimit.RateLimiter, roleCache *cache.Cache[int64, []string], logger *slog.Logger, cfg config.Config) http.Handler {
	r := chi.NewRouter()
	r.Use(chimw.RealIP)
	if cfg.App.Env != "production" {
		r.Use(chimw.Logger)
	}
	r.Use(chimw.Recoverer)
	if cfg.HTTP.WriteTimeout > 0 {
		r.Use(chimw.Timeout(cfg.HTTP.WriteTimeout))
	}
	r.Use(chimw.NoCache)

	health := handlers.HealthHandler{DB: db}
	authHandler := handlers.AuthHandler{Service: authService, Sessions: sessions, Logger: logger}
	adminHandler := handlers.AdminHandler{Service: authService, Sessions: sessions}
	kcalHandler := handlers.KcalHandler{Service: kcalService, Sessions: sessions}

	r.Get("/health", health.Live)
	r.Get("/readiness", health.Ready)

	r.Route("/api/v1", func(api chi.Router) {
		api.Route("/auth", func(public chi.Router) {
			public.Group(func(sessioned chi.Router) {
				sessioned.Use(sessions.LoadAndSave)
				sessioned.Post("/passkeys/register", authHandler.RegisterPasskey)
				sessioned.Post("/passkeys/register/finish", authHandler.FinishPasskeyRegistration)
				sessioned.Group(func(login chi.Router) {
					login.Use(appmw.RateLimitByIP(loginLimiter, "passkey_login", logger))
					login.Post("/passkeys/login/start", authHandler.BeginPasskeyLogin)
					login.Post("/passkeys/login/finish", authHandler.FinishPasskeyLogin)
				})
			})

			public.Group(func(protected chi.Router) {
				protected.Use(sessions.LoadAndSave)
				protected.Use(appmw.RequireAuthenticated(sessions))
				protected.Post("/logout", authHandler.Logout)
				protected.Get("/me", authHandler.Me)
				protected.Post("/passkeys/register/start", authHandler.BeginPasskeyRegistration)
			})
		})

		api.Route("/admin", func(admin chi.Router) {
			admin.Use(sessions.LoadAndSave)
			admin.Use(appmw.RequireAuthenticated(sessions))
			admin.Use(appmw.RequireRoles(sessions, authService.UserRoleNames, roleCache, "admin"))
			admin.Get("/access", adminHandler.Access)
		})

		api.Route("/kcal", func(kcalRouter chi.Router) {
			kcalRouter.Use(sessions.LoadAndSave)
			kcalRouter.Use(appmw.RequireAuthenticated(sessions))
			kcalRouter.Post("/templates", kcalHandler.CreateTemplate)
			kcalRouter.Get("/templates/{kind}", kcalHandler.ListTemplates)
			kcalRouter.Put("/templates/{id}", kcalHandler.UpdateTemplate)
			kcalRouter.Delete("/templates/{id}", kcalHandler.DeleteTemplate)
			kcalRouter.Post("/entries", kcalHandler.CreateEntry)
			kcalRouter.Get("/entries", kcalHandler.ListEntries)
			kcalRouter.Put("/entries/{id}", kcalHandler.UpdateEntry)
			kcalRouter.Delete("/entries/{id}", kcalHandler.DeleteEntry)
			kcalRouter.Get("/total", kcalHandler.Total)
			kcalRouter.Post("/sync", kcalHandler.Sync)
		})
	})

	return r
}
