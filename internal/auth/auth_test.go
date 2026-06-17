package auth

import (
	"context"
	"testing"
	"time"

	"github.com/daling/2fa/internal/storage"
)

func TestHashAndVerifyPassword(t *testing.T) {
	svc := &Service{}

	password := "my-secure-password-123"
	hash, err := svc.HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword failed: %v", err)
	}

	if hash == "" {
		t.Fatal("hash is empty")
	}

	valid, err := svc.VerifyPassword(password, hash)
	if err != nil {
		t.Fatalf("VerifyPassword failed: %v", err)
	}
	if !valid {
		t.Fatal("expected password to be valid")
	}

	valid, err = svc.VerifyPassword("wrong-password-xxx", hash)
	if err != nil {
		t.Fatalf("VerifyPassword with wrong password failed: %v", err)
	}
	if valid {
		t.Fatal("expected wrong password to be invalid")
	}
}

func TestCreateSessionStoresOnlyTokenHash(t *testing.T) {
	store, err := storage.NewSQLiteStore(t.TempDir() + "/sessions.sqlite")
	if err != nil {
		t.Fatalf("NewSQLiteStore failed: %v", err)
	}
	defer store.Close()

	now := time.Now().UTC()
	if err := store.CreateUser(context.Background(), &storage.User{
		ID: "session-user", Username: "session-user", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("CreateUser failed: %v", err)
	}

	svc := NewService(store, time.Hour)
	token, _, err := svc.CreateSession(context.Background(), "session-user", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	if _, err := store.GetSession(context.Background(), token); err != storage.ErrNotFound {
		t.Fatalf("raw token unexpectedly matched stored session: %v", err)
	}
	if _, err := store.GetSession(context.Background(), hashToken(token)); err != nil {
		t.Fatalf("hashed token did not match stored session: %v", err)
	}
}

func TestGenerateID(t *testing.T) {
	id1, err := GenerateID()
	if err != nil {
		t.Fatalf("GenerateID failed: %v", err)
	}
	id2, err := GenerateID()
	if err != nil {
		t.Fatalf("GenerateID failed: %v", err)
	}
	if id1 == id2 {
		t.Fatal("expected unique IDs")
	}
	if len(id1) < 8 {
		t.Fatalf("ID too short: %s", id1)
	}
}
