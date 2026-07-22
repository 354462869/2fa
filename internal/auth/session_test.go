package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/daling/2fa/internal/storage"
)

type fixedClock struct {
	now time.Time
}

func (c fixedClock) Now() time.Time { return c.now }

func setupSessionService(t *testing.T, now time.Time, idleTTL, maxLifetime time.Duration) (*Service, *storage.SQLiteStore) {
	t.Helper()
	store, err := storage.NewSQLiteStore(t.TempDir() + "/auth.sqlite")
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	if err := store.CreateUser(context.Background(), &storage.User{
		ID: "user-1", Username: "user-1", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return NewServiceWithClock(store, idleTTL, maxLifetime, fixedClock{now: now}), store
}

func createStoredSession(t *testing.T, store storage.Store, token string, session storage.Session) {
	t.Helper()
	session.TokenHash = hashToken(token)
	if err := store.CreateSession(context.Background(), &session); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
}

func TestCreateSessionSetsIdleAndAbsoluteExpiries(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	svc, store := setupSessionService(t, now, time.Hour, 24*time.Hour)

	token, expiresAt, err := svc.CreateSession(context.Background(), "user-1", "")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	session, err := store.GetSession(context.Background(), hashToken(token))
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if !expiresAt.Equal(now.Add(time.Hour)) || !session.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("idle expiry: response=%v stored=%v", expiresAt, session.ExpiresAt)
	}
	if !session.AbsoluteExpiresAt.Equal(now.Add(24 * time.Hour)) {
		t.Fatalf("absolute expiry: got %v", session.AbsoluteExpiresAt)
	}
}

func TestValidateSessionRenewsAtHalfIdleLifetime(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	svc, store := setupSessionService(t, now, time.Hour, 24*time.Hour)
	createStoredSession(t, store, "renew-token", storage.Session{
		UserID: "user-1", ExpiresAt: now.Add(30 * time.Minute),
		AbsoluteExpiresAt: now.Add(8 * time.Hour), CreatedAt: now.Add(-time.Hour),
	})

	if _, _, err := svc.ValidateSession(context.Background(), "renew-token"); err != nil {
		t.Fatalf("ValidateSession: %v", err)
	}
	session, err := store.GetSession(context.Background(), hashToken("renew-token"))
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if !session.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("renewed expiry: got %v", session.ExpiresAt)
	}
}

func TestValidateSessionDoesNotRenewAboveHalfIdleLifetime(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	svc, store := setupSessionService(t, now, time.Hour, 24*time.Hour)
	original := now.Add(30*time.Minute + time.Second)
	createStoredSession(t, store, "fresh-token", storage.Session{
		UserID: "user-1", ExpiresAt: original,
		AbsoluteExpiresAt: now.Add(8 * time.Hour), CreatedAt: now.Add(-time.Hour),
	})

	if _, _, err := svc.ValidateSession(context.Background(), "fresh-token"); err != nil {
		t.Fatalf("ValidateSession: %v", err)
	}
	session, err := store.GetSession(context.Background(), hashToken("fresh-token"))
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if !session.ExpiresAt.Equal(original) {
		t.Fatalf("expiry unexpectedly renewed: got %v want %v", session.ExpiresAt, original)
	}
}

func TestValidateSessionCapsRenewalAtAbsoluteExpiry(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	svc, store := setupSessionService(t, now, time.Hour, 24*time.Hour)
	absoluteExpiry := now.Add(20 * time.Minute)
	createStoredSession(t, store, "capped-token", storage.Session{
		UserID: "user-1", ExpiresAt: now.Add(10 * time.Minute),
		AbsoluteExpiresAt: absoluteExpiry, CreatedAt: now.Add(-24 * time.Hour),
	})

	if _, _, err := svc.ValidateSession(context.Background(), "capped-token"); err != nil {
		t.Fatalf("ValidateSession: %v", err)
	}
	session, err := store.GetSession(context.Background(), hashToken("capped-token"))
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if !session.ExpiresAt.Equal(absoluteExpiry) {
		t.Fatalf("expiry was not capped: got %v want %v", session.ExpiresAt, absoluteExpiry)
	}
}

func TestValidateSessionRejectsExpiredSessionsWithoutRenewal(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name       string
		expiresAt  time.Time
		absoluteAt time.Time
	}{
		{name: "idle expiry", expiresAt: now, absoluteAt: now.Add(time.Hour)},
		{name: "absolute expiry", expiresAt: now.Add(time.Hour), absoluteAt: now},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, store := setupSessionService(t, now, time.Hour, 24*time.Hour)
			token := tt.name + "-token"
			createStoredSession(t, store, token, storage.Session{
				UserID: "user-1", ExpiresAt: tt.expiresAt,
				AbsoluteExpiresAt: tt.absoluteAt, CreatedAt: now.Add(-time.Hour),
			})

			_, _, err := svc.ValidateSession(context.Background(), token)
			if !errors.Is(err, ErrSessionExpired) {
				t.Fatalf("ValidateSession error: got %v want ErrSessionExpired", err)
			}
			if _, err := store.GetSession(context.Background(), hashToken(token)); !errors.Is(err, storage.ErrNotFound) {
				t.Fatalf("expired session remained stored: %v", err)
			}
		})
	}
}

func TestValidateSessionReturnsStructuredValidityErrors(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	t.Run("invalid token", func(t *testing.T) {
		svc, _ := setupSessionService(t, now, time.Hour, 24*time.Hour)
		_, _, err := svc.ValidateSession(context.Background(), "missing-token")
		if !errors.Is(err, ErrSessionInvalid) {
			t.Fatalf("got %v want ErrSessionInvalid", err)
		}
	})
	t.Run("disabled user", func(t *testing.T) {
		svc, store := setupSessionService(t, now, time.Hour, 24*time.Hour)
		if err := store.SetUserDisabled(context.Background(), "user-1", true); err != nil {
			t.Fatalf("SetUserDisabled: %v", err)
		}
		createStoredSession(t, store, "disabled-token", storage.Session{
			UserID: "user-1", ExpiresAt: now.Add(time.Hour), AbsoluteExpiresAt: now.Add(24 * time.Hour), CreatedAt: now,
		})
		_, _, err := svc.ValidateSession(context.Background(), "disabled-token")
		if !errors.Is(err, ErrUserDisabled) {
			t.Fatalf("got %v want ErrUserDisabled", err)
		}
	})
	for _, name := range []string{"missing device", "revoked device"} {
		t.Run(name, func(t *testing.T) {
			svc, store := setupSessionService(t, now, time.Hour, 24*time.Hour)
			if name == "revoked device" {
				if err := store.CreateDevice(context.Background(), &storage.Device{
					ID: "device-1", UserID: "user-1", Revoked: true, LastSeenAt: now, CreatedAt: now,
				}); err != nil {
					t.Fatalf("CreateDevice: %v", err)
				}
			}
			createStoredSession(t, store, name+"-token", storage.Session{
				UserID: "user-1", DeviceID: "device-1", ExpiresAt: now.Add(time.Hour),
				AbsoluteExpiresAt: now.Add(24 * time.Hour), CreatedAt: now,
			})
			_, _, err := svc.ValidateSession(context.Background(), name+"-token")
			if !errors.Is(err, ErrSessionRevoked) {
				t.Fatalf("got %v want ErrSessionRevoked", err)
			}
		})
	}
}
