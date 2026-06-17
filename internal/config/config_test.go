package config

import (
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("SERVER_ADDR", "")
	t.Setenv("SERVER_ENV", "")
	t.Setenv("SERVER_DB_PATH", "")
	t.Setenv("SERVER_PUBLIC_ORIGIN", "")
	t.Setenv("SERVER_SESSION_SECRET", "")
	t.Setenv("SERVER_SESSION_TTL", "")
	t.Setenv("SERVER_ALLOWED_ORIGINS", "http://a, http://b")
	t.Setenv("SERVER_RATE_LIMIT_AUTH_PER_MIN", "")
	t.Setenv("SERVER_RATE_LIMIT_SYNC_PER_MIN", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Addr != "127.0.0.1:8080" {
		t.Errorf("Addr default: got %q", cfg.Addr)
	}
	if cfg.SessionTTL != 720*time.Hour {
		t.Errorf("SessionTTL default: got %v", cfg.SessionTTL)
	}
	if got, want := len(cfg.AllowedOrigins), 2; got != want {
		t.Errorf("AllowedOrigins: got %d entries, want %d", got, want)
	}
	if cfg.IsProduction() {
		t.Errorf("development env reported as production")
	}
}

func TestLoadProductionRequiresSecret(t *testing.T) {
	t.Setenv("SERVER_ENV", "production")
	t.Setenv("SERVER_SESSION_SECRET", "")
	if _, err := Load(); err == nil {
		t.Fatalf("expected error when production lacks session secret")
	}
}
