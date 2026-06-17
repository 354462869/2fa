package http

import (
	"bytes"
	"context"
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

func setupIntegrationRouter(t *testing.T) http.Handler {
	t.Helper()
	store, err := storage.NewSQLiteStore(t.TempDir() + "/test.sqlite")
	if err != nil {
		t.Fatalf("store setup: %v", err)
	}
	t.Cleanup(func() { store.Close() })

	authSvc := auth.NewService(store, 24*time.Hour)
	syncSvc := sync.NewService(store)
	logger := newDiscardLogger()

	return NewRouter(RouterDeps{
		Logger: logger,
		Config: config.Config{
			Addr:                "127.0.0.1:0",
			Env:                 "development",
			DBPath:              ":memory:",
			SessionTTL:          24 * time.Hour,
			RateLimitAuthPerMin: 100,
			RateLimitSyncPerMin: 1000,
		},
		Store: store,
		Auth:  authSvc,
		Sync:  syncSvc,
	})
}

func doJSON(t *testing.T, r http.Handler, method, path string, body interface{}, token string) *httptest.ResponseRecorder {
	t.Helper()
	var reqBody []byte
	if body != nil {
		reqBody, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestRegisterAndLogin(t *testing.T) {
	router := setupIntegrationRouter(t)

	rec := doJSON(t, router, "POST", "/v1/auth/register",
		map[string]string{"username": "testuser", "password": "securepass12345"}, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("register: status %d body=%s", rec.Code, rec.Body.String())
	}

	var regResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &regResp)
	if regResp.Token == "" {
		t.Fatal("register: empty token")
	}
	if regResp.User.Username != "testuser" {
		t.Fatalf("register: username=%q", regResp.User.Username)
	}

	rec = doJSON(t, router, "POST", "/v1/auth/login",
		map[string]string{"username": "testuser", "password": "securepass12345"}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("login: status %d body=%s", rec.Code, rec.Body.String())
	}

	var loginResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &loginResp)
	if loginResp.Token == "" {
		t.Fatal("login: empty token")
	}

	rec = doJSON(t, router, "POST", "/v1/auth/login",
		map[string]string{"username": "testuser", "password": "wrongpassword1"}, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad login: expected 401, got %d", rec.Code)
	}
}

func TestAuthMe(t *testing.T) {
	router := setupIntegrationRouter(t)

	rec := doJSON(t, router, "POST", "/v1/auth/register",
		map[string]string{"username": "meuser", "password": "securepass12345"}, "")
	var regResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &regResp)

	rec = doJSON(t, router, "GET", "/v1/auth/me", nil, regResp.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("me: status %d", rec.Code)
	}
}

func TestDeviceCRUD(t *testing.T) {
	router := setupIntegrationRouter(t)

	rec := doJSON(t, router, "POST", "/v1/auth/register",
		map[string]string{"username": "devuser", "password": "securepass12345"}, "")
	var regResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &regResp)
	token := regResp.Token

	rec = doJSON(t, router, "POST", "/v1/devices",
		map[string]string{"id": "device-test-001", "label": "My Chrome"}, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register device: status %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, router, "GET", "/v1/devices", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list devices: status %d", rec.Code)
	}

	rec = doJSON(t, router, "DELETE", "/v1/devices/device-test-001", nil, token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke device: status %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSyncPushAndPull(t *testing.T) {
	router := setupIntegrationRouter(t)

	rec := doJSON(t, router, "POST", "/v1/auth/register",
		map[string]string{"username": "syncuser", "password": "securepass12345"}, "")
	var regResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &regResp)
	token := regResp.Token

	rec = doJSON(t, router, "GET", "/v1/sync/vault", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get vault: status %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, router, "PUT", "/v1/sync/vault/envelope", map[string]interface{}{
		"envelope": map[string]interface{}{
			"alg":             "A256GCM",
			"kdf":             "argon2id",
			"kdf_salt_b64":    "dGVzdHNhbHQ=",
			"wrapped_dek_b64": "d3JhcHBlZA==",
			"wrap_iv_b64":     "aXY=",
		},
		"expected_rev": 0,
	}, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("put envelope: status %d body=%s", rec.Code, rec.Body.String())
	}

	pushBody := map[string]interface{}{
		"items": []map[string]interface{}{
			{
				"id":           "item-001",
				"deleted":      false,
				"expected_rev": nil,
				"ciphertext":   map[string]string{"alg": "A256GCM", "iv_b64": "dGVzdA==", "ct_b64": "ZW5j"},
			},
		},
		"groups": []map[string]interface{}{
			{
				"id":           "grp-001",
				"deleted":      false,
				"sort_index":   100,
				"expected_rev": nil,
				"ciphertext":   map[string]string{"alg": "A256GCM", "iv_b64": "Z3Jw", "ct_b64": "Z2Nj"},
			},
		},
	}

	rec = doJSON(t, router, "POST", "/v1/sync/push", pushBody, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("push: status %d body=%s", rec.Code, rec.Body.String())
	}

	var pushResp PushResponse
	json.Unmarshal(rec.Body.Bytes(), &pushResp)
	if len(pushResp.Applied) != 2 {
		t.Fatalf("push: expected 2 applied, got %d", len(pushResp.Applied))
	}
	if len(pushResp.Conflicts) != 0 {
		t.Fatalf("push: expected 0 conflicts, got %d", len(pushResp.Conflicts))
	}

	rec = doJSON(t, router, "POST", "/v1/sync/pull",
		map[string]interface{}{"since_seq": 0}, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("pull: status %d body=%s", rec.Code, rec.Body.String())
	}

	var pullResp PullResponse
	json.Unmarshal(rec.Body.Bytes(), &pullResp)
	if len(pullResp.Items) != 1 {
		t.Fatalf("pull: expected 1 item, got %d", len(pullResp.Items))
	}
	if len(pullResp.Groups) != 1 {
		t.Fatalf("pull: expected 1 group, got %d", len(pullResp.Groups))
	}

	rec = doJSON(t, router, "GET", "/v1/sync/items/item-001", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get item: status %d", rec.Code)
	}

	rec = doJSON(t, router, "GET", "/v1/sync/groups/grp-001", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get group: status %d", rec.Code)
	}
}

func TestEnvelopeNilExpectedRevConflict(t *testing.T) {
	router := setupIntegrationRouter(t)

	rec := doJSON(t, router, "POST", "/v1/auth/register",
		map[string]string{"username": "envconflict", "password": "securepass12345"}, "")
	var regResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &regResp)

	body := map[string]interface{}{
		"envelope": map[string]interface{}{
			"alg": "A256GCM", "kdf": "argon2id",
			"kdf_salt_b64": "dGVzdA==", "wrapped_dek_b64": "ZGVr", "wrap_iv_b64": "aXY=",
		},
		"expected_rev": nil,
	}
	rec = doJSON(t, router, "PUT", "/v1/sync/vault/envelope", body, regResp.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("first envelope: status %d body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, router, "PUT", "/v1/sync/vault/envelope", body, regResp.Token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second envelope: expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRejectsSyncPasswordHeaderName(t *testing.T) {
	router := setupIntegrationRouter(t)
	req := httptest.NewRequest("GET", "/v1/meta/health", nil)
	req.Header.Set("X-Sync-Password", "must-not-be-sent")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestConflictDetection(t *testing.T) {
	router := setupIntegrationRouter(t)

	rec := doJSON(t, router, "POST", "/v1/auth/register",
		map[string]string{"username": "conflict", "password": "securepass12345"}, "")
	var regResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &regResp)
	token := regResp.Token

	doJSON(t, router, "POST", "/v1/sync/push", map[string]interface{}{
		"items": []map[string]interface{}{
			{
				"id": "item-c1", "deleted": false, "expected_rev": nil,
				"ciphertext": map[string]string{"alg": "A256GCM", "iv_b64": "YQ==", "ct_b64": "Yg=="},
			},
		},
	}, token)

	staleRev := int64(99)
	rec = doJSON(t, router, "POST", "/v1/sync/push", map[string]interface{}{
		"items": []map[string]interface{}{
			{
				"id": "item-c1", "deleted": false, "expected_rev": staleRev,
				"ciphertext": map[string]string{"alg": "A256GCM", "iv_b64": "Yw==", "ct_b64": "ZA=="},
			},
		},
	}, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("conflict push: status %d", rec.Code)
	}

	var pushResp PushResponse
	json.Unmarshal(rec.Body.Bytes(), &pushResp)
	if len(pushResp.Conflicts) != 1 {
		t.Fatalf("expected 1 conflict, got %d", len(pushResp.Conflicts))
	}
	if pushResp.Conflicts[0].CurrentRev != 1 {
		t.Fatalf("expected currentRev=1, got %d", pushResp.Conflicts[0].CurrentRev)
	}
}

func TestDisabledUserCannotSync(t *testing.T) {
	store, err := storage.NewSQLiteStore(t.TempDir() + "/test.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })

	authSvc := auth.NewService(store, 24*time.Hour)
	syncSvc := sync.NewService(store)
	logger := newDiscardLogger()

	router := NewRouter(RouterDeps{
		Logger: logger,
		Config: config.Config{
			Addr:                "127.0.0.1:0",
			Env:                 "development",
			DBPath:              ":memory:",
			SessionTTL:          24 * time.Hour,
			RateLimitAuthPerMin: 100,
			RateLimitSyncPerMin: 1000,
		},
		Store: store,
		Auth:  authSvc,
		Sync:  syncSvc,
	})

	rec := doJSON(t, router, "POST", "/v1/auth/register",
		map[string]string{"username": "disabled1", "password": "securepass12345"}, "")
	var regResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &regResp)
	token := regResp.Token

	store.SetUserDisabled(context.Background(), regResp.User.ID, true)

	rec = doJSON(t, router, "GET", "/v1/sync/vault", nil, token)
	if rec.Code != http.StatusForbidden && rec.Code != http.StatusUnauthorized {
		t.Fatalf("disabled user sync: expected 403/401, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminFlow(t *testing.T) {
	store, err := storage.NewSQLiteStore(t.TempDir() + "/test.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })

	authSvc := auth.NewService(store, 24*time.Hour)
	syncSvc := sync.NewService(store)
	logger := newDiscardLogger()

	router := NewRouter(RouterDeps{
		Logger: logger,
		Config: config.Config{
			Addr:                "127.0.0.1:0",
			Env:                 "development",
			DBPath:              ":memory:",
			SessionTTL:          24 * time.Hour,
			RateLimitAuthPerMin: 100,
			RateLimitSyncPerMin: 1000,
		},
		Store: store,
		Auth:  authSvc,
		Sync:  syncSvc,
	})

	hash, _ := authSvc.HashPassword("adminpass12345")
	now := time.Now().UTC()
	store.CreateUser(context.Background(), &storage.User{
		ID: "admin-1", Username: "admin", PasswordHash: hash,
		Role: "admin", CreatedAt: now, UpdatedAt: now,
	})

	rec := doJSON(t, router, "POST", "/v1/auth/register",
		map[string]string{"username": "regular", "password": "securepass12345"}, "")
	var regResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &regResp)
	deviceID := "admin-flow-device"
	device := &storage.Device{
		ID: deviceID, UserID: regResp.User.ID, Label: "Test Browser",
		LastSeenAt: now, CreatedAt: now,
	}
	if err := store.CreateDevice(context.Background(), device); err != nil {
		t.Fatalf("create device: %v", err)
	}

	rec = doJSON(t, router, "POST", "/v1/admin/auth/login",
		map[string]string{"username": "admin", "password": "adminpass12345"}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("admin login: status %d body=%s", rec.Code, rec.Body.String())
	}
	var adminResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &adminResp)
	adminToken := adminResp.Token

	rec = doJSON(t, router, "GET", "/v1/admin/users", nil, adminToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin list users: status %d", rec.Code)
	}

	rec = doJSON(t, router, "GET", "/v1/admin/users/"+regResp.User.ID+"/devices", nil, adminToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin list user devices: status %d body=%s", rec.Code, rec.Body.String())
	}
	var devicePage struct {
		Devices []DeviceResponse `json:"devices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &devicePage); err != nil {
		t.Fatalf("decode device page: %v", err)
	}
	if len(devicePage.Devices) != 1 || devicePage.Devices[0].ID != deviceID {
		t.Fatalf("unexpected devices: %+v", devicePage.Devices)
	}

	rec = doJSON(t, router, "POST", "/v1/admin/users/"+regResp.User.ID+"/disable", nil, adminToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("admin disable: status %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, router, "POST", "/v1/admin/users/"+regResp.User.ID+"/enable", nil, adminToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("admin enable: status %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, router, "GET", "/v1/admin/audit", nil, adminToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin audit: status %d", rec.Code)
	}
}

func TestAdminSetupFirstRun(t *testing.T) {
	router := setupIntegrationRouter(t)

	rec := doJSON(t, router, "GET", "/v1/admin/setup/status", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("setup status: status %d body=%s", rec.Code, rec.Body.String())
	}
	var status AdminSetupStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode setup status: %v", err)
	}
	if !status.NeedsSetup {
		t.Fatal("expected setup to be required")
	}

	rec = doJSON(t, router, "POST", "/v1/admin/setup",
		map[string]string{"username": "admin", "password": "AdminPassword123!"}, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("admin setup: status %d body=%s", rec.Code, rec.Body.String())
	}
	var setupResp SessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &setupResp); err != nil {
		t.Fatalf("decode setup response: %v", err)
	}
	if setupResp.Token == "" || setupResp.User.Role != "admin" {
		t.Fatalf("unexpected setup response: %+v", setupResp)
	}

	rec = doJSON(t, router, "GET", "/v1/admin/setup/status", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("setup status after init: status %d", rec.Code)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode setup status after init: %v", err)
	}
	if status.NeedsSetup {
		t.Fatal("expected setup to be complete")
	}

	rec = doJSON(t, router, "POST", "/v1/admin/setup",
		map[string]string{"username": "other", "password": "AdminPassword123!"}, "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("second admin setup: expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, router, "POST", "/v1/admin/auth/login",
		map[string]string{"username": "admin", "password": "AdminPassword123!"}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("admin login after setup: status %d body=%s", rec.Code, rec.Body.String())
	}
}
