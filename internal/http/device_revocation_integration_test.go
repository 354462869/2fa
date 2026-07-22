package http

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/daling/2fa/internal/storage"
)

type boundDeviceFixture struct {
	router     http.Handler
	userID     string
	deviceID   string
	boundToken string
	adminToken string
}

func TestUserDeviceRevokePreservesReasonForNextBoundRequest(t *testing.T) {
	fixture := setupBoundDeviceFixture(t, false)

	rec := doJSON(t, fixture.router, http.MethodDelete, "/v1/devices/"+fixture.deviceID, nil, fixture.boundToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke device: status %d body=%s", rec.Code, rec.Body.String())
	}

	assertBoundSessionRevokedThenInvalid(t, fixture)
}

func TestAdminDeviceRevokePreservesReasonForNextBoundRequest(t *testing.T) {
	fixture := setupBoundDeviceFixture(t, true)

	rec := doJSON(t, fixture.router, http.MethodDelete,
		"/v1/admin/users/"+fixture.userID+"/devices/"+fixture.deviceID, nil, fixture.adminToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("admin revoke device: status %d body=%s", rec.Code, rec.Body.String())
	}

	assertBoundSessionRevokedThenInvalid(t, fixture)
}

func TestIndependentDeviceSessionsRemainOnlineWhenOneIsRevoked(t *testing.T) {
	router := setupIntegrationRouter(t)
	rec := doJSON(t, router, http.MethodPost, "/v1/auth/register",
		map[string]string{"username": "multi-device-user", "password": "securepass12345"}, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("register user: status %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, router, http.MethodPost, "/v1/auth/login",
		map[string]string{"username": "multi-device-user", "password": "securepass12345"}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("login device A: status %d body=%s", rec.Code, rec.Body.String())
	}
	var loginA SessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &loginA); err != nil {
		t.Fatalf("decode device A login: %v", err)
	}

	rec = doJSON(t, router, http.MethodPost, "/v1/auth/login",
		map[string]string{"username": "multi-device-user", "password": "securepass12345"}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("login device B: status %d body=%s", rec.Code, rec.Body.String())
	}
	var loginB SessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &loginB); err != nil {
		t.Fatalf("decode device B login: %v", err)
	}

	deviceA := "independent-device-a"
	rec = doJSON(t, router, http.MethodPost, "/v1/devices",
		map[string]string{"id": deviceA, "label": "Device A"}, loginA.Token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register device A: status %d body=%s", rec.Code, rec.Body.String())
	}
	deviceB := "independent-device-b"
	rec = doJSON(t, router, http.MethodPost, "/v1/devices",
		map[string]string{"id": deviceB, "label": "Device B"}, loginB.Token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register device B: status %d body=%s", rec.Code, rec.Body.String())
	}

	for name, token := range map[string]string{"device A": loginA.Token, "device B": loginB.Token} {
		rec = doJSON(t, router, http.MethodGet, "/v1/auth/me", nil, token)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s before revoke: status %d body=%s", name, rec.Code, rec.Body.String())
		}
	}

	rec = doJSON(t, router, http.MethodDelete, "/v1/devices/"+deviceA, nil, loginA.Token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke device A: status %d body=%s", rec.Code, rec.Body.String())
	}
	assertBoundSessionRevokedThenInvalid(t, boundDeviceFixture{
		router: router, deviceID: deviceA, boundToken: loginA.Token,
	})

	rec = doJSON(t, router, http.MethodGet, "/v1/auth/me", nil, loginB.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("device B after device A revoke: status %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestBoundSessionCannotRegisterSecondDevice(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	router, store := setupSessionErrorRouter(t, now)
	rec := doJSON(t, router, http.MethodPost, "/v1/auth/register",
		map[string]string{"username": "rebind-user", "password": "securepass12345"}, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("register user: status %d body=%s", rec.Code, rec.Body.String())
	}
	var registration SessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &registration); err != nil {
		t.Fatalf("decode registration: %v", err)
	}

	deviceA := "bound-device-a"
	rec = doJSON(t, router, http.MethodPost, "/v1/devices",
		map[string]string{"id": deviceA, "label": "Device A"}, registration.Token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register device A: status %d body=%s", rec.Code, rec.Body.String())
	}

	deviceB := "blocked-device-b"
	rec = doJSON(t, router, http.MethodPost, "/v1/devices",
		map[string]string{"id": deviceB, "label": "Device B"}, registration.Token)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("register device B: status %d body=%s", rec.Code, rec.Body.String())
	}
	if code := decodeErrorCode(t, rec.Body.Bytes()); code != "auth.unauthorized" {
		t.Fatalf("register device B code: got %q want auth.unauthorized", code)
	}
	if _, err := store.GetDevice(context.Background(), deviceB); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("device B persisted after rejected rebind: %v", err)
	}

	rec = doJSON(t, router, http.MethodDelete, "/v1/devices/"+deviceA, nil, registration.Token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke device A: status %d body=%s", rec.Code, rec.Body.String())
	}
	assertBoundSessionRevokedThenInvalid(t, boundDeviceFixture{
		router: router, deviceID: deviceA, boundToken: registration.Token,
	})
}

func setupBoundDeviceFixture(t *testing.T, withAdmin bool) boundDeviceFixture {
	t.Helper()
	router := setupIntegrationRouter(t)
	adminToken := ""
	if withAdmin {
		rec := doJSON(t, router, http.MethodPost, "/v1/admin/setup",
			map[string]string{"username": "admin", "password": "AdminPassword123!"}, "")
		if rec.Code != http.StatusCreated {
			t.Fatalf("admin setup: status %d body=%s", rec.Code, rec.Body.String())
		}
		var response SessionResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode admin setup: %v", err)
		}
		adminToken = response.Token
	}

	rec := doJSON(t, router, http.MethodPost, "/v1/auth/register",
		map[string]string{"username": "device-user", "password": "securepass12345"}, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("register user: status %d body=%s", rec.Code, rec.Body.String())
	}
	var registration SessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &registration); err != nil {
		t.Fatalf("decode registration: %v", err)
	}

	rec = doJSON(t, router, http.MethodPost, "/v1/auth/login", map[string]string{
		"username": "device-user", "password": "securepass12345",
	}, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("bootstrap login: status %d body=%s", rec.Code, rec.Body.String())
	}
	var login SessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &login); err != nil {
		t.Fatalf("decode bootstrap login: %v", err)
	}

	deviceID := "device-bound-001"
	rec = doJSON(t, router, http.MethodPost, "/v1/devices",
		map[string]string{"id": deviceID, "label": "Bound Browser"}, login.Token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register device: status %d body=%s", rec.Code, rec.Body.String())
	}

	return boundDeviceFixture{
		router: router, userID: registration.User.ID, deviceID: deviceID,
		boundToken: login.Token, adminToken: adminToken,
	}
}

func assertBoundSessionRevokedThenInvalid(t *testing.T, fixture boundDeviceFixture) {
	t.Helper()
	rec := doJSON(t, fixture.router, http.MethodGet, "/v1/auth/me", nil, fixture.boundToken)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("first bound request: status %d body=%s", rec.Code, rec.Body.String())
	}
	if code := decodeErrorCode(t, rec.Body.Bytes()); code != "auth.session_revoked" {
		t.Fatalf("first bound request code: got %q want auth.session_revoked", code)
	}

	rec = doJSON(t, fixture.router, http.MethodGet, "/v1/auth/me", nil, fixture.boundToken)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("second bound request: status %d body=%s", rec.Code, rec.Body.String())
	}
	if code := decodeErrorCode(t, rec.Body.Bytes()); code != "auth.session_invalid" {
		t.Fatalf("second bound request code: got %q want auth.session_invalid", code)
	}
}
