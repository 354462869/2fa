// Package config loads runtime configuration from environment variables.
//
// All environment-variable parsing for the server lives in this package.
// Other packages receive a [Config] value or the parts they need.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr         string
	Env          string
	DBPath       string
	PublicOrigin string
	AdminAssetsDir string

	SessionSecret string
	SessionTTL    time.Duration

	BootstrapAdminUsername string
	BootstrapAdminPassword string

	AllowedOrigins []string

	RateLimitAuthPerMin int
	RateLimitSyncPerMin int
}

func Load() (Config, error) {
	cfg := Config{
		Addr:                getString("SERVER_ADDR", "127.0.0.1:8080"),
		Env:                 getString("SERVER_ENV", "development"),
		DBPath:              getString("SERVER_DB_PATH", "./data/2fa.sqlite"),
		PublicOrigin:        getString("SERVER_PUBLIC_ORIGIN", "http://127.0.0.1:8080"),
		AdminAssetsDir:      os.Getenv("SERVER_ADMIN_ASSETS_DIR"),
		SessionSecret:       os.Getenv("SERVER_SESSION_SECRET"),
		AllowedOrigins:      splitCSV(getString("SERVER_ALLOWED_ORIGINS", "")),
		RateLimitAuthPerMin: getInt("SERVER_RATE_LIMIT_AUTH_PER_MIN", 20),
		RateLimitSyncPerMin: getInt("SERVER_RATE_LIMIT_SYNC_PER_MIN", 600),

		BootstrapAdminUsername: os.Getenv("SERVER_BOOTSTRAP_ADMIN_USERNAME"),
		BootstrapAdminPassword: os.Getenv("SERVER_BOOTSTRAP_ADMIN_PASSWORD"),
	}

	ttl, err := time.ParseDuration(getString("SERVER_SESSION_TTL", "720h"))
	if err != nil {
		return Config{}, fmt.Errorf("SERVER_SESSION_TTL: %w", err)
	}
	cfg.SessionTTL = ttl

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.Addr == "" {
		return errors.New("SERVER_ADDR must not be empty")
	}
	if c.DBPath == "" {
		return errors.New("SERVER_DB_PATH must not be empty")
	}
	if c.SessionTTL <= 0 {
		return errors.New("SERVER_SESSION_TTL must be positive")
	}
	if c.RateLimitAuthPerMin <= 0 || c.RateLimitSyncPerMin <= 0 {
		return errors.New("rate limits must be positive")
	}
	if c.IsProduction() && c.SessionSecret == "" {
		return errors.New("SERVER_SESSION_SECRET is required outside development")
	}
	return nil
}

func (c Config) IsProduction() bool {
	return strings.EqualFold(c.Env, "production")
}

func getString(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func getInt(key string, fallback int) int {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func splitCSV(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
