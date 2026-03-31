package middleware

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"kcal-counter/internal/httpapi/jsonio"

	ratelimit "github.com/ralscha/ratelimiter-pg"
)

type limiter interface {
	Allow(context.Context, string) (ratelimit.Decision, error)
}

func RateLimitByIP(limiter limiter, keyPrefix string, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if limiter == nil {
			return next
		}

		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)
			if ip == "" {
				next.ServeHTTP(w, r)
				return
			}

			decision, err := limiter.Allow(r.Context(), keyPrefix+":ip:"+ip)
			if err != nil {
				if logger != nil {
					logger.Error("rate limit check failed",
						slog.String("key_prefix", keyPrefix),
						slog.String("client_ip", ip),
						slog.String("method", r.Method),
						slog.String("path", r.URL.Path),
						slog.Any("err", err),
					)
				}
				jsonio.WriteError(w, http.StatusInternalServerError, "internal_error", "an unexpected error occurred")
				return
			}

			if !decision.Allowed {
				if decision.RetryAfter > 0 {
					w.Header().Set("Retry-After", formatRetryAfter(decision.RetryAfter))
				}
				jsonio.WriteError(w, http.StatusTooManyRequests, "too_many_requests", "too many requests; try again later")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func clientIP(r *http.Request) string {
	// In production the reverse proxy (Caddy) strips any client-provided
	// X-Real-IP header and replaces it with the actual TCP peer address,
	// making this header trustworthy. In development (no proxy) the header
	// is absent and we fall back to r.RemoteAddr, which is the raw TCP
	// connection address — never influenced by request headers.
	if xrip := strings.TrimSpace(r.Header.Get("X-Real-IP")); xrip != "" {
		return xrip
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
