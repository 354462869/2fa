package storage

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

func sqlOpenLegacy(path string) (*sql.DB, error) {
	return sql.Open("sqlite3", path+"?_foreign_keys=1")
}

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

	applied, conflicts, nextSeq, err := store.PushRecords(ctx, "user-1", items, groups, nil, nil)
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

	pulledItems, pulledGroups, pulledAccounts, pulledRelations, pullSeq, hasMore, err := store.PullRecords(ctx, "user-1", 0, 100)
	if err != nil {
		t.Fatalf("PullRecords failed: %v", err)
	}
	if len(pulledItems) != 2 {
		t.Fatalf("expected 2 items, got %d", len(pulledItems))
	}
	if len(pulledGroups) != 1 {
		t.Fatalf("expected 1 group, got %d", len(pulledGroups))
	}
	if len(pulledAccounts) != 0 || len(pulledRelations) != 0 {
		t.Fatalf("expected no accounts/relations, got %d/%d", len(pulledAccounts), len(pulledRelations))
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
	store.PushRecords(ctx, "user-1", items, nil, nil, nil)

	staleRev := int64(99)
	conflictItems := []PushItemInput{
		{ID: "item-1", Deleted: false, ExpectedRev: &staleRev, Ciphertext: []byte(`{"alg":"A256GCM","iv_b64":"z","ct_b64":"w"}`)},
	}
	applied, conflicts, _, err := store.PushRecords(ctx, "user-1", conflictItems, nil, nil, nil)
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
	}}, nil, nil)
	store.PushRecords(ctx, "user-1", []PushItemInput{{
		ID: "item-second", Ciphertext: []byte(`{"alg":"A256GCM"}`),
	}}, nil, nil, nil)

	items, groups, accounts, relations, nextSeq, hasMore, err := store.PullRecords(ctx, "user-1", 0, 1)
	if err != nil {
		t.Fatalf("PullRecords failed: %v", err)
	}
	if len(items) != 0 || len(groups) != 1 || groups[0].ID != "group-first" || len(accounts) != 0 || len(relations) != 0 {
		t.Fatalf("first global page returned items=%d groups=%v accounts=%d relations=%d", len(items), groups, len(accounts), len(relations))
	}
	if nextSeq != 1 || !hasMore {
		t.Fatalf("first page nextSeq=%d hasMore=%v", nextSeq, hasMore)
	}

	items, groups, accounts, relations, nextSeq, hasMore, err = store.PullRecords(ctx, "user-1", nextSeq, 1)
	if err != nil {
		t.Fatalf("second PullRecords failed: %v", err)
	}
	if len(items) != 1 || items[0].ID != "item-second" || len(groups) != 0 || len(accounts) != 0 || len(relations) != 0 {
		t.Fatalf("second global page returned items=%v groups=%d accounts=%d relations=%d", items, len(groups), len(accounts), len(relations))
	}
	if nextSeq != 2 || hasMore {
		t.Fatalf("second page nextSeq=%d hasMore=%v", nextSeq, hasMore)
	}
}

func TestPushPullAccountsRelationsAndStats(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	store.CreateUser(ctx, &User{ID: "user-1", Username: "account-sync", PasswordHash: "hash", Role: "user", CreatedAt: now, UpdatedAt: now})
	store.GetOrCreateVault(ctx, "user-1")

	maskedLogin := "a***@example.com"
	loginHash := "sha256:login"
	accounts := []PushAccountInput{{
		ID: "acct-1", Kind: "login", Platform: "example", DisplayName: "Example Account",
		LoginIdentifier: &maskedLogin, LoginIdentifierHash: &loginHash, Status: "active",
		TagsJSON: []byte(`["prod"]`), MetadataJSON: []byte(`{"risk":"low"}`),
		SecretCiphertext: []byte(`{"alg":"A256GCM","iv_b64":"YQ==","ct_b64":"Yg=="}`),
	}}
	relations := []PushRelationInput{{
		ID: "rel-1", Kind: "uses_totp", FromKind: "account", FromID: "acct-1", ToKind: "item", ToID: "item-1",
		MetadataJSON:     []byte(`{"label":"primary"}`),
		SecretCiphertext: []byte(`{"alg":"A256GCM","iv_b64":"Yw==","ct_b64":"ZA=="}`),
	}}

	applied, conflicts, nextSeq, err := store.PushRecords(ctx, "user-1", nil, nil, accounts, relations)
	if err != nil {
		t.Fatalf("PushRecords accounts/relations failed: %v", err)
	}
	if len(applied) != 2 || len(conflicts) != 0 || nextSeq != 2 {
		t.Fatalf("applied=%d conflicts=%d nextSeq=%d", len(applied), len(conflicts), nextSeq)
	}

	_, _, pulledAccounts, pulledRelations, pullSeq, hasMore, err := store.PullRecords(ctx, "user-1", 0, 100)
	if err != nil {
		t.Fatalf("PullRecords failed: %v", err)
	}
	if len(pulledAccounts) != 1 || pulledAccounts[0].ID != "acct-1" || pulledAccounts[0].Seq != 1 {
		t.Fatalf("unexpected accounts: %+v", pulledAccounts)
	}
	if len(pulledRelations) != 1 || pulledRelations[0].ID != "rel-1" || pulledRelations[0].Seq != 2 {
		t.Fatalf("unexpected relations: %+v", pulledRelations)
	}
	if pullSeq != 2 || hasMore {
		t.Fatalf("pullSeq=%d hasMore=%v", pullSeq, hasMore)
	}

	_, _, ciphertextBytes, err := store.GetUserStats(ctx, "user-1")
	if err != nil {
		t.Fatalf("GetUserStats failed: %v", err)
	}
	wantBytes := int64(len(accounts[0].SecretCiphertext) + len(relations[0].SecretCiphertext))
	if ciphertextBytes != wantBytes {
		t.Fatalf("ciphertextBytes=%d want %d", ciphertextBytes, wantBytes)
	}
}

func TestAccountRelationConflictAndTombstone(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	store.CreateUser(ctx, &User{ID: "user-1", Username: "account-conflict", PasswordHash: "hash", Role: "user", CreatedAt: now, UpdatedAt: now})
	store.GetOrCreateVault(ctx, "user-1")

	secret := []byte(`{"alg":"A256GCM","iv_b64":"YQ==","ct_b64":"Yg=="}`)
	store.PushRecords(ctx, "user-1", nil, nil, []PushAccountInput{{ID: "acct-1", Kind: "login", Platform: "example", DisplayName: "Example", Status: "active", SecretCiphertext: secret}}, nil)
	store.PushRecords(ctx, "user-1", nil, nil, nil, []PushRelationInput{{ID: "rel-1", Kind: "uses_totp", FromKind: "account", FromID: "acct-1", ToKind: "item", ToID: "item-1", SecretCiphertext: secret}})

	staleRev := int64(99)
	applied, conflicts, _, err := store.PushRecords(ctx, "user-1", nil, nil, []PushAccountInput{{ID: "acct-1", Kind: "login", Platform: "example", DisplayName: "Updated", Status: "active", ExpectedRev: &staleRev, SecretCiphertext: secret}}, nil)
	if err != nil {
		t.Fatalf("stale account push failed: %v", err)
	}
	if len(applied) != 0 || len(conflicts) != 1 || conflicts[0].Kind != "account" || conflicts[0].CurrentRev != 1 {
		t.Fatalf("unexpected account conflict applied=%d conflicts=%+v", len(applied), conflicts)
	}

	goodRev := int64(1)
	applied, conflicts, _, err = store.PushRecords(ctx, "user-1", nil, nil, nil, []PushRelationInput{{ID: "rel-1", Deleted: true, Kind: "uses_totp", FromKind: "account", FromID: "acct-1", ToKind: "item", ToID: "item-1", ExpectedRev: &goodRev}})
	if err != nil {
		t.Fatalf("relation tombstone push failed: %v", err)
	}
	if len(applied) != 1 || len(conflicts) != 0 {
		t.Fatalf("unexpected tombstone result applied=%d conflicts=%d", len(applied), len(conflicts))
	}
	relation, err := store.GetRelation(ctx, "user-1", "rel-1")
	if err != nil {
		t.Fatalf("GetRelation failed: %v", err)
	}
	if !relation.Deleted || len(relation.SecretCiphertext) != 0 {
		t.Fatalf("expected tombstoned relation without secret, got deleted=%v secret_len=%d", relation.Deleted, len(relation.SecretCiphertext))
	}
}

func TestAccountRelationCreatedAtIsStableAcrossUpdates(t *testing.T) {
	store := setupTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	store.CreateUser(ctx, &User{ID: "user-1", Username: "ts-stable", PasswordHash: "hash", Role: "user", CreatedAt: now, UpdatedAt: now})
	store.GetOrCreateVault(ctx, "user-1")

	secret := []byte(`{"alg":"A256GCM","iv_b64":"YQ==","ct_b64":"Yg=="}`)
	if _, _, _, err := store.PushRecords(ctx, "user-1",
		nil, nil,
		[]PushAccountInput{{ID: "acct-1", Kind: "login", Platform: "example", DisplayName: "Example", Status: "active", SecretCiphertext: secret}},
		[]PushRelationInput{{ID: "rel-1", Kind: "uses_totp", FromKind: "account", FromID: "acct-1", ToKind: "item", ToID: "item-1", SecretCiphertext: secret}},
	); err != nil {
		t.Fatalf("initial push: %v", err)
	}

	acctBefore, err := store.GetAccount(ctx, "user-1", "acct-1")
	if err != nil {
		t.Fatalf("GetAccount: %v", err)
	}
	relBefore, err := store.GetRelation(ctx, "user-1", "rel-1")
	if err != nil {
		t.Fatalf("GetRelation: %v", err)
	}
	if acctBefore.CreatedAt.IsZero() || relBefore.CreatedAt.IsZero() {
		t.Fatalf("expected non-zero CreatedAt, got account=%v relation=%v", acctBefore.CreatedAt, relBefore.CreatedAt)
	}
	if !acctBefore.CreatedAt.Equal(acctBefore.UpdatedAt) {
		t.Fatalf("expected CreatedAt == UpdatedAt on first insert, got %v vs %v", acctBefore.CreatedAt, acctBefore.UpdatedAt)
	}

	time.Sleep(1100 * time.Millisecond)

	rev := int64(1)
	if _, _, _, err := store.PushRecords(ctx, "user-1",
		nil, nil,
		[]PushAccountInput{{ID: "acct-1", Kind: "login", Platform: "example", DisplayName: "Updated", Status: "active", ExpectedRev: &rev, SecretCiphertext: secret}},
		[]PushRelationInput{{ID: "rel-1", Kind: "uses_totp", FromKind: "account", FromID: "acct-1", ToKind: "item", ToID: "item-1", ExpectedRev: &rev, SecretCiphertext: secret}},
	); err != nil {
		t.Fatalf("update push: %v", err)
	}

	acctAfter, err := store.GetAccount(ctx, "user-1", "acct-1")
	if err != nil {
		t.Fatalf("GetAccount after update: %v", err)
	}
	relAfter, err := store.GetRelation(ctx, "user-1", "rel-1")
	if err != nil {
		t.Fatalf("GetRelation after update: %v", err)
	}
	if !acctAfter.CreatedAt.Equal(acctBefore.CreatedAt) {
		t.Fatalf("account CreatedAt mutated by update: before=%v after=%v", acctBefore.CreatedAt, acctAfter.CreatedAt)
	}
	if !relAfter.CreatedAt.Equal(relBefore.CreatedAt) {
		t.Fatalf("relation CreatedAt mutated by update: before=%v after=%v", relBefore.CreatedAt, relAfter.CreatedAt)
	}
	if !acctAfter.UpdatedAt.After(acctBefore.UpdatedAt) {
		t.Fatalf("account UpdatedAt did not advance: before=%v after=%v", acctBefore.UpdatedAt, acctAfter.UpdatedAt)
	}
	if !relAfter.UpdatedAt.After(relBefore.UpdatedAt) {
		t.Fatalf("relation UpdatedAt did not advance: before=%v after=%v", relBefore.UpdatedAt, relAfter.UpdatedAt)
	}
}

func TestMigrationBackfillsCreatedAtOnLegacyDB(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/legacy.sqlite"

	legacy, err := sqlOpenLegacy(dbPath)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	if _, err := legacy.Exec(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'user',
			disabled INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE accounts (
			id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			rev INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			deleted INTEGER NOT NULL DEFAULT 0,
			kind TEXT NOT NULL DEFAULT '',
			platform TEXT NOT NULL DEFAULT '',
			display_name TEXT NOT NULL DEFAULT '',
			login_identifier TEXT,
			login_identifier_hash TEXT,
			status TEXT NOT NULL DEFAULT '',
			tags_json BLOB,
			metadata_json BLOB,
			secret_ciphertext BLOB,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, id)
		);
		CREATE TABLE relations (
			id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			rev INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			deleted INTEGER NOT NULL DEFAULT 0,
			kind TEXT NOT NULL DEFAULT '',
			from_kind TEXT NOT NULL DEFAULT '',
			from_id TEXT NOT NULL DEFAULT '',
			to_kind TEXT NOT NULL DEFAULT '',
			to_id TEXT NOT NULL DEFAULT '',
			metadata_json BLOB,
			secret_ciphertext BLOB,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, id)
		);
	`); err != nil {
		legacy.Close()
		t.Fatalf("create legacy schema: %v", err)
	}
	if _, err := legacy.Exec(
		`INSERT INTO accounts (id, user_id, rev, seq, deleted, kind, platform, display_name, status, updated_at)
		 VALUES ('acct-old', 'user-1', 1, 1, 0, 'login', 'example', 'Old Account', 'active', '2024-01-02T03:04:05Z')`,
	); err != nil {
		legacy.Close()
		t.Fatalf("insert legacy account: %v", err)
	}
	if _, err := legacy.Exec(
		`INSERT INTO relations (id, user_id, rev, seq, deleted, kind, from_kind, from_id, to_kind, to_id, updated_at)
		 VALUES ('rel-old', 'user-1', 1, 2, 0, 'uses_totp', 'account', 'acct-old', 'item', 'item-old', '2024-02-03T04:05:06Z')`,
	); err != nil {
		legacy.Close()
		t.Fatalf("insert legacy relation: %v", err)
	}
	legacy.Close()

	store, err := NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("open with new store: %v", err)
	}
	defer store.Close()

	var acctCreatedAt string
	if err := store.db.QueryRow(`SELECT created_at FROM accounts WHERE id = ?`, "acct-old").Scan(&acctCreatedAt); err != nil {
		t.Fatalf("query backfilled created_at: %v", err)
	}
	if acctCreatedAt != "2024-01-02T03:04:05Z" {
		t.Fatalf("account created_at not backfilled from updated_at: %q", acctCreatedAt)
	}
	var relCreatedAt string
	if err := store.db.QueryRow(`SELECT created_at FROM relations WHERE id = ?`, "rel-old").Scan(&relCreatedAt); err != nil {
		t.Fatalf("query backfilled relation created_at: %v", err)
	}
	if relCreatedAt != "2024-02-03T04:05:06Z" {
		t.Fatalf("relation created_at not backfilled from updated_at: %q", relCreatedAt)
	}

	store.Close()
	store2, err := NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("re-open after migration: %v", err)
	}
	defer store2.Close()
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
