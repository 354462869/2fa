package http

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/daling/2fa/internal/auth"
	"github.com/daling/2fa/internal/config"
	"github.com/daling/2fa/internal/storage"
	"github.com/daling/2fa/internal/sync"
)

type httpFixedClock struct {
	now time.Time
}

func (c httpFixedClock) Now() time.Time { return c.now }

type httpSessionFixture struct {
	now               time.Time
	token             string
	role              string
	disabled          bool
	deviceID          string
	expiresAt         time.Time
	absoluteExpiresAt time.Time
}

func setupSessionErrorRouter(t *testing.T, now time.Time) (http.Handler, *storage.SQLiteStore) {
	t.Helper()
	store, err := storage.NewSQLiteStore(t.TempDir() + "/http-session.sqlite")
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	authSvc := auth.NewServiceWithClock(store, time.Hour, 24*time.Hour, httpFixedClock{now: now})
	return NewRouter(RouterDeps{
		Logger: newDiscardLogger(),
		Config: config.Config{
			Addr: "127.0.0.1:0", Env: "development", DBPath: ":memory:",
			SessionTTL: time.Hour, SessionMaxLifetime: 24 * time.Hour,
			RateLimitAuthPerMin: 100, RateLimitSyncPerMin: 100,
		},
		Store: store, Auth: authSvc, Sync: sync.NewService(store),
	}), store
}

func decodeErrorCode(t *testing.T, recBody []byte) string {
	t.Helper()
	var apiErr APIError
	if err := json.Unmarshal(recBody, &apiErr); err != nil {
		t.Fatalf("decode API error: %v", err)
	}
	return apiErr.Code
}

func TestProtectedHandlersMapStructuredSessionErrors(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name       string
		path       string
		token      string
		wantStatus int
		wantCode   string
		prepare    func(*testing.T, *storage.SQLiteStore)
	}{
		{name: "missing credentials", path: "/v1/auth/me", wantStatus: http.StatusUnauthorized, wantCode: "auth.unauthorized"},
		{name: "malformed credentials", path: "/v1/sync/vault", token: "malformed", wantStatus: http.StatusUnauthorized, wantCode: "auth.unauthorized"},
		{name: "invalid session", path: "/v1/auth/me", token: "invalid-token", wantStatus: http.StatusUnauthorized, wantCode: "auth.session_invalid"},
		{name: "expired sync session", path: "/v1/sync/vault", token: "expired-token", wantStatus: http.StatusUnauthorized, wantCode: "auth.session_expired", prepare: func(t *testing.T, store *storage.SQLiteStore) {
			createHTTPUserAndSession(t, store, httpSessionFixture{
				now: now, token: "expired-token", role: "user", expiresAt: now, absoluteExpiresAt: now.Add(time.Hour),
			})
		}},
		{name: "revoked admin session", path: "/v1/admin/users", token: "revoked-token", wantStatus: http.StatusUnauthorized, wantCode: "auth.session_revoked", prepare: func(t *testing.T, store *storage.SQLiteStore) {
			createHTTPUserAndSession(t, store, httpSessionFixture{
				now: now, token: "revoked-token", role: "admin", deviceID: "missing-device",
				expiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(24 * time.Hour),
			})
		}},
		{name: "disabled logout session", path: "/v1/auth/logout", token: "disabled-token", wantStatus: http.StatusUnauthorized, wantCode: "auth.user_disabled", prepare: func(t *testing.T, store *storage.SQLiteStore) {
			createHTTPUserAndSession(t, store, httpSessionFixture{
				now: now, token: "disabled-token", role: "user", disabled: true,
				expiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(24 * time.Hour),
			})
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			router, store := setupSessionErrorRouter(t, now)
			if tt.prepare != nil {
				tt.prepare(t, store)
			}
			req := httptestRequest(tt.path, tt.token, tt.name == "malformed credentials")
			rec := doRequest(router, req)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status: got %d want %d body=%s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if code := decodeErrorCode(t, rec.Body.Bytes()); code != tt.wantCode {
				t.Fatalf("code: got %q want %q", code, tt.wantCode)
			}
		})
	}
}

func TestLoginReturnsUnauthorizedForDisabledUser(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	router, store := setupSessionErrorRouter(t, now)
	authSvc := auth.NewService(store, time.Hour, 24*time.Hour)
	passwordHash, err := authSvc.HashPassword("securepass12345")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if err := store.CreateUser(context.Background(), &storage.User{
		ID: "disabled-login-user", Username: "disabled-login", PasswordHash: passwordHash,
		Role: "user", Disabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	rec := doJSON(t, router, http.MethodPost, "/v1/auth/login", map[string]string{
		"username": "disabled-login", "password": "securepass12345",
	}, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status: got %d want %d body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
	if code := decodeErrorCode(t, rec.Body.Bytes()); code != "auth.user_disabled" {
		t.Fatalf("code: got %q want %q", code, "auth.user_disabled")
	}
}

func TestProtectedHandlerReturnsInternalErrorForSessionStoreFailure(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	router, store := setupSessionErrorRouter(t, now)
	if err := store.Close(); err != nil {
		t.Fatalf("Close store: %v", err)
	}

	rec := doRequest(router, httptestRequest("/v1/auth/me", "valid-shaped-token", false))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status: got %d want %d body=%s", rec.Code, http.StatusInternalServerError, rec.Body.String())
	}
	if code := decodeErrorCode(t, rec.Body.Bytes()); code != "internal_error" {
		t.Fatalf("code: got %q want %q", code, "internal_error")
	}
}

func createHTTPUserAndSession(t *testing.T, store *storage.SQLiteStore, fixture httpSessionFixture) {
	t.Helper()
	userID := fixture.token + "-user"
	if err := store.CreateUser(context.Background(), &storage.User{
		ID: userID, Username: userID, PasswordHash: "hash", Role: fixture.role,
		Disabled: fixture.disabled, CreatedAt: fixture.now, UpdatedAt: fixture.now,
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := store.CreateSession(context.Background(), &storage.Session{
		TokenHash: hashHTTPTestToken(fixture.token), UserID: userID, DeviceID: fixture.deviceID,
		ExpiresAt: fixture.expiresAt, AbsoluteExpiresAt: fixture.absoluteExpiresAt, CreatedAt: fixture.now,
	}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
}

func hashHTTPTestToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func httptestRequest(path, token string, malformed bool) *http.Request {
	req, _ := http.NewRequest(http.MethodGet, path, nil)
	if path == "/v1/auth/logout" {
		req.Method = http.MethodPost
	}
	if malformed {
		req.Header.Set("Authorization", token)
	} else if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req
}

func doRequest(handler http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}
