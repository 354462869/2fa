package storage

import (
	"context"
	"os"
	"testing"
	"time"
)

func setupTestStore(t *testing.T) *SQLiteStore {
	t.Helper()
	tmpFile := t.TempDir() + "/test.sqlite"
	store, err := NewSQLiteStore(tmpFile)
	if err != nil {
		t.Fatalf("NewSQLiteStore failed: %v", err)
	}
	t.Cleanup(func() {
		store.Close()
		os.Remove(tmpFile)
	})
	return store
}

func TestCreateAndGetUser(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Second)
	user := &User{
		ID:           "user-1",
		Username:     "alice",
		PasswordHash: "$argon2id$v=19$m=65536,t=1,p=4$abc$def",
		Role:         "user",
		Disabled:     false,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	if err := store.CreateUser(ctx, user); err != nil {
		t.Fatalf("CreateUser failed: %v", err)
	}

	got, err := store.GetUserByUsername(ctx, "alice")
	if err != nil {
		t.Fatalf("GetUserByUsername failed: %v", err)
	}
	if got.ID != "user-1" {
		t.Fatalf("got ID %q, want %q", got.ID, "user-1")
	}

	got2, err := store.GetUserByID(ctx, "user-1")
	if err != nil {
		t.Fatalf("GetUserByID failed: %v", err)
	}
	if got2.Username != "alice" {
		t.Fatalf("got Username %q, want %q", got2.Username, "alice")
	}

	err = store.CreateUser(ctx, user)
	if err != ErrUserExists {
		t.Fatalf("expected ErrUserExists, got %v", err)
	}
}

func TestSessionCRUD(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Second)
	user := &User{
		ID: "user-1", Username: "bob", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	}
	store.CreateUser(ctx, user)

	session := &Session{
		TokenHash: "tok-hash-1", UserID: "user-1", DeviceID: "",
		ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	}
	if err := store.CreateSession(ctx, session); err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	got, err := store.GetSession(ctx, "tok-hash-1")
	if err != nil {
		t.Fatalf("GetSession failed: %v", err)
	}
	if got.UserID != "user-1" {
		t.Fatalf("got UserID %q, want %q", got.UserID, "user-1")
	}

	if err := store.DeleteSession(ctx, "tok-hash-1"); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}

	_, err = store.GetSession(ctx, "tok-hash-1")
	if err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestSessionStoresOnlyTokenHash(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Second)
	store.CreateUser(ctx, &User{
		ID: "user-1", Username: "hashuser", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	})

	if err := store.CreateSession(ctx, &Session{
		TokenHash: "sha256-token-digest", UserID: "user-1",
		ExpiresAt: now.Add(time.Hour), CreatedAt: now,
	}); err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	var stored string
	if err := store.db.QueryRowContext(ctx, `SELECT token_hash FROM sessions`).Scan(&stored); err != nil {
		t.Fatalf("query token_hash: %v", err)
	}
	if stored != "sha256-token-digest" {
		t.Fatalf("stored token hash %q", stored)
	}
}

func TestDeviceCRUD(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Second)
	user := &User{
		ID: "user-1", Username: "carol", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	}
	store.CreateUser(ctx, user)

	device := &Device{
		ID: "dev-1", UserID: "user-1", Label: "Chrome on Mac",
		Revoked: false, LastSeenAt: now, CreatedAt: now,
	}
	if err := store.CreateDevice(ctx, device); err != nil {
		t.Fatalf("CreateDevice failed: %v", err)
	}

	devices, err := store.ListDevicesByUser(ctx, "user-1")
	if err != nil {
		t.Fatalf("ListDevicesByUser failed: %v", err)
	}
	if len(devices) != 1 {
		t.Fatalf("expected 1 device, got %d", len(devices))
	}

	if err := store.RevokeDevice(ctx, "dev-1"); err != nil {
		t.Fatalf("RevokeDevice failed: %v", err)
	}

	got, _ := store.GetDevice(ctx, "dev-1")
	if !got.Revoked {
		t.Fatal("expected device to be revoked")
	}
}

func TestVaultAndEnvelope(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Second)
	user := &User{
		ID: "user-1", Username: "dave", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	}
	store.CreateUser(ctx, user)

	vault, err := store.GetOrCreateVault(ctx, "user-1")
	if err != nil {
		t.Fatalf("GetOrCreateVault failed: %v", err)
	}
	if vault.Seq != 0 || vault.EnvelopeRev != 0 {
		t.Fatalf("expected fresh vault, got seq=%d rev=%d", vault.Seq, vault.EnvelopeRev)
	}

	envelope := []byte(`{"alg":"A256GCM","kdf":"argon2id","kdf_salt_b64":"abc","wrapped_dek_b64":"def","wrap_iv_b64":"ghi"}`)
	var expectedRev *int64
	updated, err := store.UpdateVaultEnvelope(ctx, "user-1", expectedRev, envelope)
	if err != nil {
		t.Fatalf("UpdateVaultEnvelope failed: %v", err)
	}
	if updated.EnvelopeRev != 1 {
		t.Fatalf("expected rev 1, got %d", updated.EnvelopeRev)
	}

	staleRev := int64(0)
	current, err := store.UpdateVaultEnvelope(ctx, "user-1", &staleRev, []byte(`{"alg":"stale"}`))
	if err != ErrConflict {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
	if current.EnvelopeRev != 1 {
		t.Fatalf("expected current rev 1, got %d", current.EnvelopeRev)
	}
}

func TestPushAndPullRecords(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Second)
	user := &User{
		ID: "user-1", Username: "eve", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	}
	store.CreateUser(ctx, user)
	store.GetOrCreateVault(ctx, "user-1")

	items := []PushItemInput{
		{ID: "item-1", Deleted: false, ExpectedRev: nil, Ciphertext: []byte(`{"alg":"A256GCM","iv_b64":"x","ct_b64":"y"}`)},
		{ID: "item-2", Deleted: false, ExpectedRev: nil, Ciphertext: []byte(`{"alg":"A256GCM","iv_b64":"a","ct_b64":"b"}`)},
	}
	groups := []PushGroupInput{
		{ID: "grp-1", Deleted: false, SortIndex: 100, ExpectedRev: nil, Ciphertext: []byte(`{"alg":"A256GCM","iv_b64":"m","ct_b64":"n"}`)},
	}

	applied, conflicts, nextSeq, err := store.PushRecords(ctx, "user-1", items, groups)
	if err != nil {
		t.Fatalf("PushRecords failed: %v", err)
	}
	if len(applied) != 3 {
		t.Fatalf("expected 3 applied, got %d", len(applied))
	}
	if len(conflicts) != 0 {
		t.Fatalf("expected 0 conflicts, got %d", len(conflicts))
	}
	if nextSeq != 3 {
		t.Fatalf("expected nextSeq=3, got %d", nextSeq)
	}

	pulledItems, pulledGroups, pullSeq, hasMore, err := store.PullRecords(ctx, "user-1", 0, 100)
	if err != nil {
		t.Fatalf("PullRecords failed: %v", err)
	}
	if len(pulledItems) != 2 {
		t.Fatalf("expected 2 items, got %d", len(pulledItems))
	}
	if len(pulledGroups) != 1 {
		t.Fatalf("expected 1 group, got %d", len(pulledGroups))
	}
	if pullSeq != 3 {
		t.Fatalf("expected pullSeq=3, got %d", pullSeq)
	}
	if hasMore {
		t.Fatal("expected no more records")
	}
}

func TestPushConflictDetection(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Second)
	user := &User{
		ID: "user-1", Username: "frank", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	}
	store.CreateUser(ctx, user)
	store.GetOrCreateVault(ctx, "user-1")

	items := []PushItemInput{
		{ID: "item-1", Deleted: false, ExpectedRev: nil, Ciphertext: []byte(`{"alg":"A256GCM","iv_b64":"x","ct_b64":"y"}`)},
	}
	store.PushRecords(ctx, "user-1", items, nil)

	staleRev := int64(99)
	conflictItems := []PushItemInput{
		{ID: "item-1", Deleted: false, ExpectedRev: &staleRev, Ciphertext: []byte(`{"alg":"A256GCM","iv_b64":"z","ct_b64":"w"}`)},
	}
	applied, conflicts, _, err := store.PushRecords(ctx, "user-1", conflictItems, nil)
	if err != nil {
		t.Fatalf("PushRecords (conflict) failed: %v", err)
	}
	if len(applied) != 0 {
		t.Fatalf("expected 0 applied, got %d", len(applied))
	}
	if len(conflicts) != 1 {
		t.Fatalf("expected 1 conflict, got %d", len(conflicts))
	}
	if conflicts[0].CurrentRev != 1 {
		t.Fatalf("expected currentRev=1, got %d", conflicts[0].CurrentRev)
	}
}

func TestPullRecordsUsesGlobalSequenceLimit(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	store.CreateUser(ctx, &User{
		ID: "user-1", Username: "global-seq", PasswordHash: "hash",
		Role: "user", CreatedAt: now, UpdatedAt: now,
	})
	store.GetOrCreateVault(ctx, "user-1")

	store.PushRecords(ctx, "user-1", nil, []PushGroupInput{{
		ID: "group-first", SortIndex: 1, Ciphertext: []byte(`{"alg":"A256GCM"}`),
	}})
	store.PushRecords(ctx, "user-1", []PushItemInput{{
		ID: "item-second", Ciphertext: []byte(`{"alg":"A256GCM"}`),
	}}, nil)

	items, groups, nextSeq, hasMore, err := store.PullRecords(ctx, "user-1", 0, 1)
	if err != nil {
		t.Fatalf("PullRecords failed: %v", err)
	}
	if len(items) != 0 || len(groups) != 1 || groups[0].ID != "group-first" {
		t.Fatalf("first global page returned items=%d groups=%v", len(items), groups)
	}
	if nextSeq != 1 || !hasMore {
		t.Fatalf("first page nextSeq=%d hasMore=%v", nextSeq, hasMore)
	}

	items, groups, nextSeq, hasMore, err = store.PullRecords(ctx, "user-1", nextSeq, 1)
	if err != nil {
		t.Fatalf("second PullRecords failed: %v", err)
	}
	if len(items) != 1 || items[0].ID != "item-second" || len(groups) != 0 {
		t.Fatalf("second global page returned items=%v groups=%d", items, len(groups))
	}
	if nextSeq != 2 || hasMore {
		t.Fatalf("second page nextSeq=%d hasMore=%v", nextSeq, hasMore)
	}
}

func TestAuditLog(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()

	userID := "user-1"
	entry := &AuditEntry{
		ID:        "audit-1",
		At:        time.Now().UTC(),
		ActorKind: "admin",
		ActorID:   &userID,
		Action:    "admin.user.disable",
	}

	if err := store.CreateAuditEntry(ctx, entry); err != nil {
		t.Fatalf("CreateAuditEntry failed: %v", err)
	}

	entries, _, err := store.ListAuditEntries(ctx, 10, "")
	if err != nil {
		t.Fatalf("ListAuditEntries failed: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Action != "admin.user.disable" {
		t.Fatalf("got action %q", entries[0].Action)
	}
}
