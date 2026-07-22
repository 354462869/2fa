package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/daling/2fa/internal/storage"
)

type deleteFailingStore struct {
	storage.Store
	err error
}

func (s deleteFailingStore) DeleteSession(context.Context, string) error { return s.err }

func TestValidateSessionPreservesDenialWhenCleanupFails(t *testing.T) {
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	cleanupErr := errors.New("cleanup failed")
	tests := []struct {
		name       string
		token      string
		session    storage.Session
		wantDenied error
	}{
		{
			name: "expired session", token: "expired-cleanup-token", wantDenied: ErrSessionExpired,
			session: storage.Session{
				UserID: "user-1", ExpiresAt: now, AbsoluteExpiresAt: now.Add(time.Hour), CreatedAt: now.Add(-time.Hour),
			},
		},
		{
			name: "revoked session", token: "revoked-cleanup-token", wantDenied: ErrSessionRevoked,
			session: storage.Session{
				UserID: "user-1", DeviceID: "missing-device", ExpiresAt: now.Add(time.Hour),
				AbsoluteExpiresAt: now.Add(24 * time.Hour), CreatedAt: now,
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, store := setupSessionService(t, now, time.Hour, 24*time.Hour)
			createStoredSession(t, store, tt.token, tt.session)
			svc := NewServiceWithClock(deleteFailingStore{Store: store, err: cleanupErr}, time.Hour, 24*time.Hour, fixedClock{now: now})

			_, _, err := svc.ValidateSession(context.Background(), tt.token)
			if !errors.Is(err, tt.wantDenied) {
				t.Fatalf("denial error: got %v want %v", err, tt.wantDenied)
			}
			if !errors.Is(err, cleanupErr) {
				t.Fatalf("cleanup error was not preserved: %v", err)
			}
		})
	}
}
