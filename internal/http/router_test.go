package http

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/daling/2fa/internal/config"
)

func newTestRouter(t *testing.T) http.Handler {
	t.Helper()
	logger := newDiscardLogger()
	return NewRouter(RouterDeps{
		Logger: logger,
		Config: config.Config{
			Addr:                "127.0.0.1:0",
			Env:                 "development",
			DBPath:              ":memory:",
			SessionTTL:          1,
			RateLimitAuthPerMin: 1,
			RateLimitSyncPerMin: 1,
		},
	})
}

func TestHealth(t *testing.T) {
	r := newTestRouter(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/meta/health", nil)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", rec.Code)
	}
}

func TestVersion(t *testing.T) {
	r := newTestRouter(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/meta/version", nil)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", rec.Code)
	}
}

func TestBusinessRoutesScaffolded(t *testing.T) {
	r := newTestRouter(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/login", nil)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status: got %d want 501", rec.Code)
	}
}

func TestAdminAssetsServedAtRoot(t *testing.T) {
	dir := t.TempDir()
	index := []byte("<html><body>admin</body></html>")
	if err := os.WriteFile(filepath.Join(dir, "index.html"), index, 0o644); err != nil {
		t.Fatal(err)
	}

	r := NewRouter(RouterDeps{
		Logger: newDiscardLogger(),
		Config: config.Config{
			Addr:                "127.0.0.1:0",
			Env:                 "development",
			DBPath:              ":memory:",
			AdminAssetsDir:      dir,
			SessionTTL:          1,
			RateLimitAuthPerMin: 1,
			RateLimitSyncPerMin: 1,
		},
	})

	for _, path := range []string{"/", "/users"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status: got %d want 200", path, rec.Code)
		}
		if rec.Body.String() != string(index) {
			t.Fatalf("%s body: got %q", path, rec.Body.String())
		}
	}
}
