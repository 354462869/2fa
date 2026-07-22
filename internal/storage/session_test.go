package storage

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

func TestSessionCRUDPersistsAndUpdatesAbsoluteExpiry(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	if err := store.CreateUser(ctx, &User{
		ID: "session-user", Username: "session-user", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	session := &Session{
		TokenHash: "session-hash", UserID: "session-user",
		ExpiresAt: now.Add(time.Hour), AbsoluteExpiresAt: now.Add(24 * time.Hour), CreatedAt: now,
	}
	if err := store.CreateSession(ctx, session); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	got, err := store.GetSession(ctx, session.TokenHash)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if !got.AbsoluteExpiresAt.Equal(session.AbsoluteExpiresAt) {
		t.Fatalf("AbsoluteExpiresAt: got %v want %v", got.AbsoluteExpiresAt, session.AbsoluteExpiresAt)
	}

	renewed := now.Add(2 * time.Hour)
	if err := store.UpdateSessionExpiry(ctx, session.TokenHash, renewed); err != nil {
		t.Fatalf("UpdateSessionExpiry: %v", err)
	}
	got, err = store.GetSession(ctx, session.TokenHash)
	if err != nil {
		t.Fatalf("GetSession after update: %v", err)
	}
	if !got.ExpiresAt.Equal(renewed) {
		t.Fatalf("ExpiresAt: got %v want %v", got.ExpiresAt, renewed)
	}
}

func TestCreateSessionDefaultsZeroAbsoluteExpiryWithoutMutatingInput(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	if err := store.CreateUser(ctx, &User{
		ID: "legacy-caller", Username: "legacy-caller", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	session := &Session{
		TokenHash: "legacy-caller-hash", UserID: "legacy-caller",
		ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	}

	if err := store.CreateSession(ctx, session); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if !session.AbsoluteExpiresAt.IsZero() {
		t.Fatalf("caller input mutated: AbsoluteExpiresAt=%v", session.AbsoluteExpiresAt)
	}
	persisted, err := store.GetSession(ctx, session.TokenHash)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if !persisted.AbsoluteExpiresAt.Equal(session.ExpiresAt) {
		t.Fatalf("AbsoluteExpiresAt: got %v want %v", persisted.AbsoluteExpiresAt, session.ExpiresAt)
	}
}

func TestCreateDeviceAndBindSessionRollsBackDeviceWhenSessionMissing(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	if err := store.CreateUser(ctx, &User{
		ID: "rollback-user", Username: "rollback-user", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := store.CreateSession(ctx, &Session{
		TokenHash: "valid-session-hash", UserID: "rollback-user",
		ExpiresAt: now.Add(time.Hour), AbsoluteExpiresAt: now.Add(24 * time.Hour), CreatedAt: now,
	}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	device := &Device{
		ID: "rollback-device", UserID: "rollback-user", Label: "Rollback device",
		LastSeenAt: now, CreatedAt: now,
	}

	err := store.CreateDeviceAndBindSession(ctx, device, "missing-session-hash")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing session: got %v want ErrNotFound", err)
	}
	if err := store.CreateDeviceAndBindSession(ctx, device, "valid-session-hash"); err != nil {
		t.Fatalf("retry with same device ID: %v", err)
	}
}

func TestCreateDeviceAndBindSessionRejectsDeviceOwnedByAnotherUser(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	for _, userID := range []string{"session-owner", "device-owner"} {
		if err := store.CreateUser(ctx, &User{
			ID: userID, Username: userID, PasswordHash: "hash",
			Role: "user", CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatalf("CreateUser(%s): %v", userID, err)
		}
	}
	if err := store.CreateSession(ctx, &Session{
		TokenHash: "owner-session-hash", UserID: "session-owner",
		ExpiresAt: now.Add(time.Hour), AbsoluteExpiresAt: now.Add(24 * time.Hour), CreatedAt: now,
	}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	device := &Device{
		ID: "another-user-device", UserID: "device-owner", Label: "Other device",
		LastSeenAt: now, CreatedAt: now,
	}

	err := store.CreateDeviceAndBindSession(ctx, device, "owner-session-hash")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("CreateDeviceAndBindSession: got %v want ErrNotFound", err)
	}
}

func TestSessionMigrationBackfillsAbsoluteExpiryFromIdleExpiry(t *testing.T) {
	dbPath := t.TempDir() + "/legacy-session.sqlite"
	legacy, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	_, err = legacy.Exec(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE sessions (
			token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '',
			expires_at TEXT NOT NULL, created_at TEXT NOT NULL
		);
		INSERT INTO users VALUES ('legacy-user', 'legacy-user', 'hash', 'user', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
		INSERT INTO sessions VALUES ('legacy-hash', 'legacy-user', '', '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z');
	`)
	if err != nil {
		legacy.Close()
		t.Fatalf("create legacy session schema: %v", err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	store, err := NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("migrate legacy database: %v", err)
	}
	session, err := store.GetSession(context.Background(), "legacy-hash")
	if err != nil {
		store.Close()
		t.Fatalf("GetSession: %v", err)
	}
	if !session.AbsoluteExpiresAt.Equal(session.ExpiresAt) {
		store.Close()
		t.Fatalf("absolute expiry %v was not backfilled from idle expiry %v", session.AbsoluteExpiresAt, session.ExpiresAt)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close migrated database: %v", err)
	}

	reopened, err := NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("reopen migrated database: %v", err)
	}
	defer reopened.Close()
}
