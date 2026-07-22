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

	authSvc := auth.NewService(store, 24*time.Hour, 30*24*time.Hour)
	syncSvc := sync.NewService(store)
	logger := newDiscardLogger()

	return NewRouter(RouterDeps{
		Logger: logger,
		Config: config.Config{
			Addr:                "127.0.0.1:0",
			Env:                 "development",
			DBPath:              ":memory:",
			SessionTTL:          24 * time.Hour,
			SessionMaxLifetime:  30 * 24 * time.Hour,
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
		"accounts": []map[string]interface{}{
			{
				"id":                    "acct-001",
				"deleted":               false,
				"kind":                  "login",
				"platform":              "example",
				"display_name":          "Example Account",
				"login_identifier":      "a***@example.com",
				"login_identifier_hash": "sha256:login",
				"status":                "active",
				"tags_json":             []string{"prod"},
				"metadata_json":         map[string]string{"owner": "team"},
				"expected_rev":          nil,
				"secret_ciphertext":     map[string]string{"alg": "A256GCM", "iv_b64": "YWNjdA==", "ct_b64": "c2Vj"},
			},
		},
		"relations": []map[string]interface{}{
			{
				"id":                "rel-001",
				"deleted":           false,
				"kind":              "uses_totp",
				"from_kind":         "account",
				"from_id":           "acct-001",
				"to_kind":           "item",
				"to_id":             "item-001",
				"metadata_json":     map[string]string{"label": "primary"},
				"expected_rev":      nil,
				"secret_ciphertext": map[string]string{"alg": "A256GCM", "iv_b64": "cmVs", "ct_b64": "c2Vj"},
			},
		},
	}

	rec = doJSON(t, router, "POST", "/v1/sync/push", pushBody, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("push: status %d body=%s", rec.Code, rec.Body.String())
	}

	var pushResp PushResponse
	json.Unmarshal(rec.Body.Bytes(), &pushResp)
	if len(pushResp.Applied) != 4 {
		t.Fatalf("push: expected 4 applied, got %d", len(pushResp.Applied))
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
	if len(pullResp.Accounts) != 1 || pullResp.Accounts[0].SecretCiphertext == nil {
		t.Fatalf("pull: unexpected accounts: %+v", pullResp.Accounts)
	}
	if len(pullResp.Relations) != 1 || pullResp.Relations[0].SecretCiphertext == nil {
		t.Fatalf("pull: unexpected relations: %+v", pullResp.Relations)
	}

	rec = doJSON(t, router, "GET", "/v1/sync/items/item-001", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get item: status %d", rec.Code)
	}

	rec = doJSON(t, router, "GET", "/v1/sync/groups/grp-001", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get group: status %d", rec.Code)
	}

	rec = doJSON(t, router, "GET", "/v1/sync/accounts/acct-001", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get account: status %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, router, "GET", "/v1/sync/relations/rel-001", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get relation: status %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAccountRelationConflictTombstoneAndAdminMetadata(t *testing.T) {
	router := setupIntegrationRouter(t)

	rec := doJSON(t, router, "POST", "/v1/admin/setup", map[string]string{"username": "admin2", "password": "AdminPassword123!"}, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("admin setup: status %d body=%s", rec.Code, rec.Body.String())
	}
	var adminResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &adminResp)
	adminToken := adminResp.Token

	rec = doJSON(t, router, "POST", "/v1/auth/register", map[string]string{"username": "acctrel", "password": "securepass12345"}, "")
	var userResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &userResp)
	userToken := userResp.Token

	doJSON(t, router, "POST", "/v1/sync/push", map[string]interface{}{
		"accounts": []map[string]interface{}{{
			"id": "acct-c1", "deleted": false, "kind": "login", "platform": "example", "display_name": "Example",
			"login_identifier": "u***@example.com", "status": "active", "expected_rev": nil,
			"secret_ciphertext": map[string]string{"alg": "A256GCM", "iv_b64": "YQ==", "ct_b64": "Yg=="},
		}},
		"relations": []map[string]interface{}{{
			"id": "rel-c1", "deleted": false, "kind": "uses_totp", "from_kind": "account", "from_id": "acct-c1", "to_kind": "item", "to_id": "item-c1", "expected_rev": nil,
			"secret_ciphertext": map[string]string{"alg": "A256GCM", "iv_b64": "Yw==", "ct_b64": "ZA=="},
		}},
	}, userToken)

	staleRev := int64(99)
	rec = doJSON(t, router, "POST", "/v1/sync/push", map[string]interface{}{
		"accounts": []map[string]interface{}{{
			"id": "acct-c1", "deleted": false, "kind": "login", "platform": "example", "display_name": "Changed",
			"status": "active", "expected_rev": staleRev,
			"secret_ciphertext": map[string]string{"alg": "A256GCM", "iv_b64": "ZQ==", "ct_b64": "Zg=="},
		}},
	}, userToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("account conflict push: status %d body=%s", rec.Code, rec.Body.String())
	}
	var conflictResp PushResponse
	json.Unmarshal(rec.Body.Bytes(), &conflictResp)
	if len(conflictResp.Conflicts) != 1 || conflictResp.Conflicts[0].Kind != "account" || conflictResp.Conflicts[0].CurrentAccount == nil {
		t.Fatalf("unexpected conflict response: %+v", conflictResp.Conflicts)
	}

	goodRev := int64(1)
	rec = doJSON(t, router, "POST", "/v1/sync/push", map[string]interface{}{
		"relations": []map[string]interface{}{{
			"id": "rel-c1", "deleted": true, "kind": "uses_totp", "from_kind": "account", "from_id": "acct-c1", "to_kind": "item", "to_id": "item-c1", "expected_rev": goodRev,
		}},
	}, userToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("relation tombstone push: status %d body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, router, "GET", "/v1/sync/relations/rel-c1", nil, userToken)
	var relation RelationResponse
	json.Unmarshal(rec.Body.Bytes(), &relation)
	if !relation.Deleted || relation.SecretCiphertext != nil {
		t.Fatalf("expected tombstone without secret, got %+v", relation)
	}

	rec = doJSON(t, router, "GET", "/v1/admin/users/"+userResp.User.ID+"/accounts", nil, userToken)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("non-admin accounts list: expected 401, got %d", rec.Code)
	}

	rec = doJSON(t, router, "GET", "/v1/admin/users/"+userResp.User.ID+"/accounts", nil, adminToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin accounts list: status %d body=%s", rec.Code, rec.Body.String())
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("secret_ciphertext")) || bytes.Contains(rec.Body.Bytes(), []byte("ct_b64")) {
		t.Fatalf("admin accounts response exposed ciphertext: %s", rec.Body.String())
	}
	var accountPage AdminAccountPage
	json.Unmarshal(rec.Body.Bytes(), &accountPage)
	if len(accountPage.Accounts) != 1 || accountPage.Accounts[0].LoginIdentifier == nil {
		t.Fatalf("unexpected admin account page: %+v", accountPage)
	}

	rec = doJSON(t, router, "GET", "/v1/admin/users/"+userResp.User.ID+"/relations", nil, adminToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin relations list: status %d body=%s", rec.Code, rec.Body.String())
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("secret_ciphertext")) || bytes.Contains(rec.Body.Bytes(), []byte("ct_b64")) {
		t.Fatalf("admin relations response exposed ciphertext: %s", rec.Body.String())
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

	authSvc := auth.NewService(store, 24*time.Hour, 30*24*time.Hour)
	syncSvc := sync.NewService(store)
	logger := newDiscardLogger()

	router := NewRouter(RouterDeps{
		Logger: logger,
		Config: config.Config{
			Addr:                "127.0.0.1:0",
			Env:                 "development",
			DBPath:              ":memory:",
			SessionTTL:          24 * time.Hour,
			SessionMaxLifetime:  30 * 24 * time.Hour,
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

	authSvc := auth.NewService(store, 24*time.Hour, 30*24*time.Hour)
	syncSvc := sync.NewService(store)
	logger := newDiscardLogger()

	router := NewRouter(RouterDeps{
		Logger: logger,
		Config: config.Config{
			Addr:                "127.0.0.1:0",
			Env:                 "development",
			DBPath:              ":memory:",
			SessionTTL:          24 * time.Hour,
			SessionMaxLifetime:  30 * 24 * time.Hour,
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

func TestAccountRelationCreatedAtAndAliases(t *testing.T) {
	router := setupIntegrationRouter(t)

	rec := doJSON(t, router, "POST", "/v1/auth/register",
		map[string]string{"username": "aliasuser", "password": "securepass12345"}, "")
	var regResp SessionResponse
	json.Unmarshal(rec.Body.Bytes(), &regResp)
	token := regResp.Token

	rec = doJSON(t, router, "POST", "/v1/sync/push", map[string]interface{}{
		"accounts": []map[string]interface{}{{
			"id": "acct-A", "deleted": false, "kind": "login", "platform": "example",
			"display_name": "Account A", "status": "active", "expected_rev": nil,
			"secret_ciphertext": map[string]string{"alg": "A256GCM", "iv_b64": "YQ==", "ct_b64": "Yg=="},
		}, {
			"id": "acct-B", "deleted": false, "kind": "login", "platform": "example",
			"display_name": "Account B", "status": "active", "expected_rev": nil,
			"secret_ciphertext": map[string]string{"alg": "A256GCM", "iv_b64": "Yw==", "ct_b64": "ZA=="},
		}},
		"relations": []map[string]interface{}{{
			"id": "rel-legacy", "deleted": false, "kind": "uses_totp",
			"from_kind": "account", "from_id": "acct-A", "to_kind": "item", "to_id": "item-X",
			"expected_rev":      nil,
			"secret_ciphertext": map[string]string{"alg": "A256GCM", "iv_b64": "ZQ==", "ct_b64": "Zg=="},
		}, {
			"id": "rel-design", "deleted": false,
			"relation_type":     "login_email",
			"from_account_id":   "acct-A",
			"to_account_id":     "acct-B",
			"expected_rev":      nil,
			"secret_ciphertext": map[string]string{"alg": "A256GCM", "iv_b64": "Zw==", "ct_b64": "aA=="},
		}},
	}, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("push: status %d body=%s", rec.Code, rec.Body.String())
	}
	var pushResp PushResponse
	json.Unmarshal(rec.Body.Bytes(), &pushResp)
	if len(pushResp.Applied) != 4 || len(pushResp.Conflicts) != 0 {
		t.Fatalf("expected 4 applied no conflicts, got %+v", pushResp)
	}

	rec = doJSON(t, router, "GET", "/v1/sync/accounts/acct-A", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get account: %d body=%s", rec.Code, rec.Body.String())
	}
	var account AccountResponse
	json.Unmarshal(rec.Body.Bytes(), &account)
	if account.CreatedAt.IsZero() {
		t.Fatalf("account.created_at is zero: %+v", account)
	}
	if !account.CreatedAt.Equal(account.UpdatedAt) {
		t.Fatalf("expected CreatedAt == UpdatedAt on first push, got %v vs %v", account.CreatedAt, account.UpdatedAt)
	}

	rec = doJSON(t, router, "GET", "/v1/sync/relations/rel-legacy", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get rel-legacy: %d body=%s", rec.Code, rec.Body.String())
	}
	var legacyRel RelationResponse
	json.Unmarshal(rec.Body.Bytes(), &legacyRel)
	if legacyRel.RelationType != "uses_totp" {
		t.Fatalf("relation_type alias missing on legacy push: %+v", legacyRel)
	}
	if legacyRel.FromAccountID == nil || *legacyRel.FromAccountID != "acct-A" {
		t.Fatalf("from_account_id alias not populated when from_kind=account: %+v", legacyRel)
	}
	if legacyRel.ToAccountID != nil {
		t.Fatalf("to_account_id alias unexpectedly populated when to_kind != account: %+v", legacyRel)
	}
	if legacyRel.CreatedAt.IsZero() {
		t.Fatalf("relation.created_at is zero: %+v", legacyRel)
	}

	rec = doJSON(t, router, "GET", "/v1/sync/relations/rel-design", nil, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get rel-design: %d body=%s", rec.Code, rec.Body.String())
	}
	var designRel RelationResponse
	json.Unmarshal(rec.Body.Bytes(), &designRel)
	if designRel.Kind != "login_email" || designRel.RelationType != "login_email" {
		t.Fatalf("design-aligned push did not translate relation_type into kind: %+v", designRel)
	}
	if designRel.FromKind != "account" || designRel.FromID != "acct-A" || designRel.ToKind != "account" || designRel.ToID != "acct-B" {
		t.Fatalf("design-aligned push did not populate generic from/to fields: %+v", designRel)
	}
	if designRel.FromAccountID == nil || *designRel.FromAccountID != "acct-A" {
		t.Fatalf("from_account_id not populated for account endpoint: %+v", designRel)
	}
	if designRel.ToAccountID == nil || *designRel.ToAccountID != "acct-B" {
		t.Fatalf("to_account_id not populated for account endpoint: %+v", designRel)
	}
}
