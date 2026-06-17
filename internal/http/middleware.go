package http

import (
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/daling/2fa/internal/config"
)

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func withRequestLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		logger.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"dur_ms", time.Since(start).Milliseconds(),
		)
	})
}

func withCORS(cfg config.Config, next http.Handler) http.Handler {
	allowed := cfg.AllowedOrigins
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && slices.Contains(allowed, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withSecretNameGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for name := range r.URL.Query() {
			if suspiciousSecretName(name) {
				writeError(w, http.StatusBadRequest, "request.secret_field", "Request contains a forbidden secret field name")
				return
			}
		}
		for name := range r.Header {
			if suspiciousSecretName(name) {
				writeError(w, http.StatusBadRequest, "request.secret_field", "Request contains a forbidden secret field name")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func suspiciousSecretName(name string) bool {
	lower := strings.ToLower(name)
	for _, needle := range []string{
		"sync-password",
		"sync_password",
		"syncpassword",
		"sync-passphrase",
		"sync_passphrase",
		"totp-secret",
		"totp_secret",
		"dek-plaintext",
		"dek_plaintext",
	} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}
