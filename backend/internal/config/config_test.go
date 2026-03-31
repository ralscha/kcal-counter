package config

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

var loadConfigMu sync.Mutex

func TestLoadAppliesDefaultsAndEnvironmentOverrides(t *testing.T) {
	loadConfigMu.Lock()
	defer loadConfigMu.Unlock()

	writeConfigFixture(t, `
app:
  env: test

http:
  address: ":8080"
`)
	t.Setenv("KCAL_COUNTER_HTTP__ADDRESS", ":9999")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.HTTP.Address != ":9999" {
		t.Fatalf("HTTP.Address = %q, want :9999", cfg.HTTP.Address)
	}
	if cfg.Security.AuthorizationCacheTTL != 5*time.Second {
		t.Fatalf("Security.AuthorizationCacheTTL = %v, want 5s", cfg.Security.AuthorizationCacheTTL)
	}
}

func TestLoadUsesExplicitConfigPath(t *testing.T) {
	loadConfigMu.Lock()
	defer loadConfigMu.Unlock()

	dir := t.TempDir()
	configPath := filepath.Join(dir, "custom.yaml")
	if err := os.WriteFile(configPath, []byte("app:\n  env: test\n\nhttp:\n  address: \":8081\"\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.HTTP.Address != ":8081" {
		t.Fatalf("HTTP.Address = %q, want :8081", cfg.HTTP.Address)
	}
}

func writeConfigFixture(t *testing.T, contents string) {
	t.Helper()

	dir := t.TempDir()
	configDir := filepath.Join(dir, "config")
	if err := os.MkdirAll(configDir, 0o750); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "config.yaml"), []byte(contents), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	originalWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd() error = %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("Chdir() error = %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(originalWD)
	})
}
