package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/env"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

type Config struct {
	App       AppConfig       `koanf:"app"`
	HTTP      HTTPConfig      `koanf:"http"`
	Database  DatabaseConfig  `koanf:"database"`
	Session   SessionConfig   `koanf:"session"`
	Security  SecurityConfig  `koanf:"security"`
	WebAuthn  WebAuthnConfig  `koanf:"webauthn"`
	Scheduler SchedulerConfig `koanf:"scheduler"`
}

type AppConfig struct {
	Env      string `koanf:"env"`
	LogLevel string `koanf:"log_level"`
}

type HTTPConfig struct {
	Address           string        `koanf:"address"`
	ReadTimeout       time.Duration `koanf:"read_timeout"`
	ReadHeaderTimeout time.Duration `koanf:"read_header_timeout"`
	WriteTimeout      time.Duration `koanf:"write_timeout"`
	IdleTimeout       time.Duration `koanf:"idle_timeout"`
	ShutdownTimeout   time.Duration `koanf:"shutdown_timeout"`
}

type DatabaseConfig struct {
	URL             string        `koanf:"url"`
	MaxOpenConns    int           `koanf:"max_open_conns"`
	MaxIdleConns    int           `koanf:"max_idle_conns"`
	ConnMaxLifetime time.Duration `koanf:"conn_max_lifetime"`
	ConnMaxIdleTime time.Duration `koanf:"conn_max_idle_time"`
}

type SessionConfig struct {
	CookieName  string        `koanf:"cookie_name"`
	Lifetime    time.Duration `koanf:"lifetime"`
	IdleTimeout time.Duration `koanf:"idle_timeout"`
	SameSite    string        `koanf:"same_site"`
	Secure      bool          `koanf:"secure"`
	HTTPOnly    bool          `koanf:"http_only"`
	Persist     bool          `koanf:"persist"`
}

type SecurityConfig struct {
	AuthorizationCacheTTL  time.Duration `koanf:"authorization_cache_ttl"`
	FailedLoginThreshold   int           `koanf:"failed_login_threshold"`
	FailedLoginWindow      time.Duration `koanf:"failed_login_window"`
	InactivityDisableAfter time.Duration `koanf:"inactivity_disable_after"`
}

type WebAuthnConfig struct {
	RPID          string   `koanf:"rp_id"`
	RPDisplayName string   `koanf:"rp_display_name"`
	RPOrigins     []string `koanf:"rp_origins"`
}

type SchedulerConfig struct {
	Enabled              bool          `koanf:"enabled"`
	CleanupEvery         time.Duration `koanf:"cleanup_every"`
	InactivityCheckEvery time.Duration `koanf:"inactivity_check_every"`
}

const defaultConfigPath = "config/config.yaml"

func Load(configPath string) (Config, error) {
	if strings.TrimSpace(configPath) == "" {
		configPath = defaultConfigPath
	}

	k := koanf.New(".")
	if err := k.Load(file.Provider(configPath), yaml.Parser()); err != nil {
		return Config{}, fmt.Errorf("load config file: %w", err)
	}

	if err := k.Load(env.Provider("KCAL_COUNTER_", ".", func(raw string) string {
		trimmed := strings.TrimPrefix(raw, "KCAL_COUNTER_")
		return strings.ToLower(strings.ReplaceAll(trimmed, "__", "."))
	}), nil); err != nil {
		return Config{}, fmt.Errorf("load environment: %w", err)
	}

	var cfg Config
	if err := k.Unmarshal("", &cfg); err != nil {
		return Config{}, fmt.Errorf("unmarshal config: %w", err)
	}

	if cfg.Security.AuthorizationCacheTTL <= 0 {
		cfg.Security.AuthorizationCacheTTL = 5 * time.Second
	}

	return cfg, nil
}
