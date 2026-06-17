package storage

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type SQLiteStore struct {
	db *sql.DB
}

func NewSQLiteStore(dbPath string) (*SQLiteStore, error) {
	dir := filepath.Dir(dbPath)
	if err := ensureDir(dir); err != nil {
		return nil, fmt.Errorf("ensure db directory: %w", err)
	}

	separator := "?"
	if strings.Contains(dbPath, "?") {
		separator = "&"
	}
	db, err := sql.Open("sqlite3", dbPath+separator+"_foreign_keys=1&_journal_mode=WAL")
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	store := &SQLiteStore{db: db}
	if err := store.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate schema: %w", err)
	}

	return store, nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

func (s *SQLiteStore) migrate() error {
	schema := `
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	username TEXT UNIQUE NOT NULL,
	password_hash TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'user',
	disabled INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	device_id TEXT NOT NULL DEFAULT '',
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS devices (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	label TEXT NOT NULL,
	revoked INTEGER NOT NULL DEFAULT 0,
	last_seen_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

CREATE TABLE IF NOT EXISTS vaults (
	user_id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL DEFAULT 0,
	envelope_rev INTEGER NOT NULL DEFAULT 0,
	envelope BLOB,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS items (
	id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	group_id TEXT,
	rev INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	ciphertext BLOB,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, id),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_seq ON items(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_items_group_id ON items(user_id, group_id);

CREATE TABLE IF NOT EXISTS groups (
	id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	rev INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	sort_index INTEGER NOT NULL DEFAULT 0,
	ciphertext BLOB,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, id),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_groups_seq ON groups(user_id, seq);

CREATE TABLE IF NOT EXISTS audit_log (
	id TEXT PRIMARY KEY,
	at TEXT NOT NULL,
	actor_kind TEXT NOT NULL,
	actor_id TEXT,
	action TEXT NOT NULL,
	target_kind TEXT,
	target_id TEXT,
	ip TEXT,
	user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_kind, actor_id);
`
	_, err := s.db.Exec(schema)
	return err
}

func (s *SQLiteStore) CreateUser(ctx context.Context, user *User) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO users (id, username, password_hash, role, disabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		user.ID, user.Username, user.PasswordHash, user.Role, boolToInt(user.Disabled),
		user.CreatedAt.Format(time.RFC3339), user.UpdatedAt.Format(time.RFC3339))
	if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed") {
		return ErrUserExists
	}
	return err
}

func (s *SQLiteStore) GetUserByID(ctx context.Context, id string) (*User, error) {
	var user User
	var disabled int
	var createdAt, updatedAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, username, password_hash, role, disabled, created_at, updated_at
		FROM users WHERE id = ?`, id).Scan(
		&user.ID, &user.Username, &user.PasswordHash, &user.Role, &disabled, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	user.Disabled = intToBool(disabled)
	user.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	user.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return &user, nil
}

func (s *SQLiteStore) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	var user User
	var disabled int
	var createdAt, updatedAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, username, password_hash, role, disabled, created_at, updated_at
		FROM users WHERE username = ?`, username).Scan(
		&user.ID, &user.Username, &user.PasswordHash, &user.Role, &disabled, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	user.Disabled = intToBool(disabled)
	user.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	user.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return &user, nil
}

func (s *SQLiteStore) UpdateUserPassword(ctx context.Context, userID, newHash string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
		newHash, time.Now().UTC().Format(time.RFC3339), userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) SetUserDisabled(ctx context.Context, userID string, disabled bool) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?`,
		boolToInt(disabled), time.Now().UTC().Format(time.RFC3339), userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) ListUsers(ctx context.Context, limit int, cursor string) ([]*User, string, error) {
	query := `SELECT id, username, password_hash, role, disabled, created_at, updated_at
		FROM users WHERE id > ? ORDER BY id ASC LIMIT ?`
	rows, err := s.db.QueryContext(ctx, query, cursor, limit)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()

	var users []*User
	for rows.Next() {
		var u User
		var disabled int
		var createdAt, updatedAt string
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &disabled, &createdAt, &updatedAt); err != nil {
			return nil, "", err
		}
		u.Disabled = intToBool(disabled)
		u.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		u.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
		users = append(users, &u)
	}

	var nextCursor string
	if len(users) == limit {
		nextCursor = users[len(users)-1].ID
	}
	return users, nextCursor, rows.Err()
}

func (s *SQLiteStore) CountUsers(ctx context.Context) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count)
	return count, err
}

func (s *SQLiteStore) CreateSession(ctx context.Context, session *Session) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sessions (token_hash, user_id, device_id, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?)`,
		session.TokenHash, session.UserID, session.DeviceID,
		session.ExpiresAt.Format(time.RFC3339), session.CreatedAt.Format(time.RFC3339))
	return err
}

func (s *SQLiteStore) GetSession(ctx context.Context, tokenHash string) (*Session, error) {
	var sess Session
	var expiresAt, createdAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT token_hash, user_id, device_id, expires_at, created_at
		FROM sessions WHERE token_hash = ?`, tokenHash).Scan(
		&sess.TokenHash, &sess.UserID, &sess.DeviceID, &expiresAt, &createdAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	sess.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt)
	sess.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	return &sess, nil
}

func (s *SQLiteStore) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

func (s *SQLiteStore) DeleteSessionsByUser(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID)
	return err
}

func (s *SQLiteStore) DeleteSessionsByDevice(ctx context.Context, deviceID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE device_id = ?`, deviceID)
	return err
}

func (s *SQLiteStore) CreateDevice(ctx context.Context, device *Device) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO devices (id, user_id, label, revoked, last_seen_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		device.ID, device.UserID, device.Label, boolToInt(device.Revoked),
		device.LastSeenAt.Format(time.RFC3339), device.CreatedAt.Format(time.RFC3339))
	if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed") {
		return ErrDeviceExists
	}
	return err
}

func (s *SQLiteStore) GetDevice(ctx context.Context, deviceID string) (*Device, error) {
	var dev Device
	var revoked int
	var lastSeenAt, createdAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, label, revoked, last_seen_at, created_at
		FROM devices WHERE id = ?`, deviceID).Scan(
		&dev.ID, &dev.UserID, &dev.Label, &revoked, &lastSeenAt, &createdAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	dev.Revoked = intToBool(revoked)
	dev.LastSeenAt, _ = time.Parse(time.RFC3339, lastSeenAt)
	dev.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	return &dev, nil
}

func (s *SQLiteStore) ListDevicesByUser(ctx context.Context, userID string) ([]*Device, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, label, revoked, last_seen_at, created_at
		FROM devices WHERE user_id = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []*Device
	for rows.Next() {
		var dev Device
		var revoked int
		var lastSeenAt, createdAt string
		if err := rows.Scan(&dev.ID, &dev.UserID, &dev.Label, &revoked, &lastSeenAt, &createdAt); err != nil {
			return nil, err
		}
		dev.Revoked = intToBool(revoked)
		dev.LastSeenAt, _ = time.Parse(time.RFC3339, lastSeenAt)
		dev.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		devices = append(devices, &dev)
	}
	return devices, rows.Err()
}

func (s *SQLiteStore) UpdateDeviceLastSeen(ctx context.Context, deviceID string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE devices SET last_seen_at = ? WHERE id = ?`,
		at.Format(time.RFC3339), deviceID)
	return err
}

func (s *SQLiteStore) RevokeDevice(ctx context.Context, deviceID string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE devices SET revoked = 1 WHERE id = ?`, deviceID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) CountDevicesByUser(ctx context.Context, userID string) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM devices WHERE user_id = ?`, userID).Scan(&count)
	return count, err
}

func (s *SQLiteStore) GetOrCreateVault(ctx context.Context, userID string) (*Vault, error) {
	vault, err := s.GetVault(ctx, userID)
	if err == nil {
		return vault, nil
	}
	if err != ErrNotFound {
		return nil, err
	}

	now := time.Now().UTC()
	_, err = s.db.ExecContext(ctx, `
		INSERT OR IGNORE INTO vaults (user_id, seq, envelope_rev, envelope, created_at, updated_at)
		VALUES (?, 0, 0, NULL, ?, ?)`,
		userID, now.Format(time.RFC3339), now.Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	return s.GetVault(ctx, userID)
}

func (s *SQLiteStore) GetVault(ctx context.Context, userID string) (*Vault, error) {
	var vault Vault
	var createdAt, updatedAt string
	var envelope []byte
	err := s.db.QueryRowContext(ctx, `
		SELECT user_id, seq, envelope_rev, envelope, created_at, updated_at
		FROM vaults WHERE user_id = ?`, userID).Scan(
		&vault.UserID, &vault.Seq, &vault.EnvelopeRev, &envelope, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	vault.Envelope = envelope
	vault.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	vault.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return &vault, nil
}

func (s *SQLiteStore) UpdateVaultEnvelope(ctx context.Context, userID string, expectedRev *int64, envelope []byte) (*Vault, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var currentRev int64
	err = tx.QueryRowContext(ctx, `SELECT envelope_rev FROM vaults WHERE user_id = ?`, userID).Scan(&currentRev)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	if (expectedRev == nil && currentRev != 0) || (expectedRev != nil && *expectedRev != currentRev) {
		if err := tx.Rollback(); err != nil {
			return nil, err
		}
		vault, getErr := s.GetVault(ctx, userID)
		if getErr != nil {
			return nil, getErr
		}
		return vault, ErrConflict
	}

	newRev := currentRev + 1
	now := time.Now().UTC()
	_, err = tx.ExecContext(ctx, `
		UPDATE vaults SET envelope_rev = ?, envelope = ?, updated_at = ? WHERE user_id = ?`,
		newRev, envelope, now.Format(time.RFC3339), userID)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetVault(ctx, userID)
}

func (s *SQLiteStore) GetItem(ctx context.Context, userID, itemID string) (*Item, error) {
	var item Item
	var groupID sql.NullString
	var deleted int
	var updatedAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, group_id, rev, seq, deleted, ciphertext, updated_at
		FROM items WHERE user_id = ? AND id = ?`, userID, itemID).Scan(
		&item.ID, &item.UserID, &groupID, &item.Rev, &item.Seq, &deleted, &item.Ciphertext, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if groupID.Valid {
		item.GroupID = &groupID.String
	}
	item.Deleted = intToBool(deleted)
	item.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return &item, nil
}

func (s *SQLiteStore) GetGroup(ctx context.Context, userID, groupID string) (*Group, error) {
	var group Group
	var deleted int
	var updatedAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, rev, seq, deleted, sort_index, ciphertext, updated_at
		FROM groups WHERE user_id = ? AND id = ?`, userID, groupID).Scan(
		&group.ID, &group.UserID, &group.Rev, &group.Seq, &deleted, &group.SortIndex, &group.Ciphertext, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	group.Deleted = intToBool(deleted)
	group.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return &group, nil
}

func (s *SQLiteStore) PullRecords(ctx context.Context, userID string, sinceSeq int64, limit int) ([]*Item, []*Group, int64, bool, error) {
	type recordRef struct {
		kind string
		id   string
		seq  int64
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT kind, id, seq FROM (
			SELECT 'item' AS kind, id, seq FROM items WHERE user_id = ? AND seq > ?
			UNION ALL
			SELECT 'group' AS kind, id, seq FROM groups WHERE user_id = ? AND seq > ?
		) ORDER BY seq ASC LIMIT ?`,
		userID, sinceSeq, userID, sinceSeq, limit)
	if err != nil {
		return nil, nil, 0, false, err
	}

	refs := make([]recordRef, 0, limit)
	maxSeq := sinceSeq
	for rows.Next() {
		var ref recordRef
		if err := rows.Scan(&ref.kind, &ref.id, &ref.seq); err != nil {
			rows.Close()
			return nil, nil, 0, false, err
		}
		refs = append(refs, ref)
		if ref.seq > maxSeq {
			maxSeq = ref.seq
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, 0, false, err
	}
	if err := rows.Close(); err != nil {
		return nil, nil, 0, false, err
	}

	items := make([]*Item, 0, len(refs))
	var groups []*Group
	for _, ref := range refs {
		if ref.kind == "item" {
			item, err := s.GetItem(ctx, userID, ref.id)
			if err != nil {
				return nil, nil, 0, false, err
			}
			items = append(items, item)
			continue
		}
		group, err := s.GetGroup(ctx, userID, ref.id)
		if err != nil {
			return nil, nil, 0, false, err
		}
		groups = append(groups, group)
	}

	var vaultSeq int64
	if err := s.db.QueryRowContext(ctx, `SELECT seq FROM vaults WHERE user_id = ?`, userID).Scan(&vaultSeq); err != nil {
		return nil, nil, 0, false, err
	}
	hasMore := vaultSeq > maxSeq
	return items, groups, maxSeq, hasMore, nil
}

func (s *SQLiteStore) PushRecords(ctx context.Context, userID string, items []PushItemInput, groups []PushGroupInput) ([]AppliedResult, []ConflictResult, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, 0, err
	}
	defer tx.Rollback()

	var vaultSeq int64
	err = tx.QueryRowContext(ctx, `SELECT seq FROM vaults WHERE user_id = ?`, userID).Scan(&vaultSeq)
	if err != nil {
		return nil, nil, 0, err
	}

	var applied []AppliedResult
	var conflicts []ConflictResult
	now := time.Now().UTC()

	for _, input := range items {
		var currentRev sql.NullInt64
		var recordSeq sql.NullInt64
		err := tx.QueryRowContext(ctx, `SELECT rev, seq FROM items WHERE user_id = ? AND id = ?`, userID, input.ID).Scan(&currentRev, &recordSeq)

		isNew := err == sql.ErrNoRows
		if err != nil && !isNew {
			return nil, nil, 0, err
		}

		if isNew && input.ExpectedRev != nil {
			conflicts = append(conflicts, ConflictResult{
				ID:         input.ID,
				Kind:       "item",
				CurrentRev: 0,
				CurrentSeq: 0,
			})
			continue
		}

		if !isNew {
			if input.ExpectedRev == nil || *input.ExpectedRev != currentRev.Int64 {
				item, _ := s.getItemTx(ctx, tx, userID, input.ID)
				conflicts = append(conflicts, ConflictResult{
					ID:         input.ID,
					Kind:       "item",
					CurrentRev: currentRev.Int64,
					CurrentSeq: recordSeq.Int64,
					Current:    item,
				})
				continue
			}
		}

		vaultSeq++
		newRev := int64(1)
		if !isNew {
			newRev = currentRev.Int64 + 1
		}

		var groupIDVal interface{} = nil
		if input.GroupID != nil {
			groupIDVal = *input.GroupID
		}

		if isNew {
			_, err = tx.ExecContext(ctx, `
				INSERT INTO items (id, user_id, group_id, rev, seq, deleted, ciphertext, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				input.ID, userID, groupIDVal, newRev, vaultSeq, boolToInt(input.Deleted), input.Ciphertext, now.Format(time.RFC3339))
		} else {
			_, err = tx.ExecContext(ctx, `
				UPDATE items SET group_id = ?, rev = ?, seq = ?, deleted = ?, ciphertext = ?, updated_at = ?
				WHERE user_id = ? AND id = ?`,
				groupIDVal, newRev, vaultSeq, boolToInt(input.Deleted), input.Ciphertext, now.Format(time.RFC3339), userID, input.ID)
		}
		if err != nil {
			return nil, nil, 0, err
		}

		applied = append(applied, AppliedResult{
			ID:   input.ID,
			Kind: "item",
			Rev:  newRev,
			Seq:  vaultSeq,
		})
	}

	for _, input := range groups {
		var currentRev sql.NullInt64
		var recordSeq sql.NullInt64
		err := tx.QueryRowContext(ctx, `SELECT rev, seq FROM groups WHERE user_id = ? AND id = ?`, userID, input.ID).Scan(&currentRev, &recordSeq)

		isNew := err == sql.ErrNoRows
		if err != nil && !isNew {
			return nil, nil, 0, err
		}

		if isNew && input.ExpectedRev != nil {
			conflicts = append(conflicts, ConflictResult{
				ID:         input.ID,
				Kind:       "group",
				CurrentRev: 0,
				CurrentSeq: 0,
			})
			continue
		}

		if !isNew {
			if input.ExpectedRev == nil || *input.ExpectedRev != currentRev.Int64 {
				group, _ := s.getGroupTx(ctx, tx, userID, input.ID)
				conflicts = append(conflicts, ConflictResult{
					ID:         input.ID,
					Kind:       "group",
					CurrentRev: currentRev.Int64,
					CurrentSeq: recordSeq.Int64,
					Current:    group,
				})
				continue
			}
		}

		vaultSeq++
		newRev := int64(1)
		if !isNew {
			newRev = currentRev.Int64 + 1
		}

		if isNew {
			_, err = tx.ExecContext(ctx, `
				INSERT INTO groups (id, user_id, rev, seq, deleted, sort_index, ciphertext, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				input.ID, userID, newRev, vaultSeq, boolToInt(input.Deleted), input.SortIndex, input.Ciphertext, now.Format(time.RFC3339))
		} else {
			_, err = tx.ExecContext(ctx, `
				UPDATE groups SET rev = ?, seq = ?, deleted = ?, sort_index = ?, ciphertext = ?, updated_at = ?
				WHERE user_id = ? AND id = ?`,
				newRev, vaultSeq, boolToInt(input.Deleted), input.SortIndex, input.Ciphertext, now.Format(time.RFC3339), userID, input.ID)
		}
		if err != nil {
			return nil, nil, 0, err
		}

		applied = append(applied, AppliedResult{
			ID:   input.ID,
			Kind: "group",
			Rev:  newRev,
			Seq:  vaultSeq,
		})
	}

	_, err = tx.ExecContext(ctx, `UPDATE vaults SET seq = ?, updated_at = ? WHERE user_id = ?`,
		vaultSeq, now.Format(time.RFC3339), userID)
	if err != nil {
		return nil, nil, 0, err
	}

	if err := tx.Commit(); err != nil {
		return nil, nil, 0, err
	}

	return applied, conflicts, vaultSeq, nil
}

func (s *SQLiteStore) getItemTx(ctx context.Context, tx *sql.Tx, userID, itemID string) (*Item, error) {
	var item Item
	var groupID sql.NullString
	var deleted int
	var updatedAt string
	err := tx.QueryRowContext(ctx, `
		SELECT id, user_id, group_id, rev, seq, deleted, ciphertext, updated_at
		FROM items WHERE user_id = ? AND id = ?`, userID, itemID).Scan(
		&item.ID, &item.UserID, &groupID, &item.Rev, &item.Seq, &deleted, &item.Ciphertext, &updatedAt)
	if err != nil {
		return nil, err
	}
	if groupID.Valid {
		item.GroupID = &groupID.String
	}
	item.Deleted = intToBool(deleted)
	item.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return &item, nil
}

func (s *SQLiteStore) getGroupTx(ctx context.Context, tx *sql.Tx, userID, groupID string) (*Group, error) {
	var group Group
	var deleted int
	var updatedAt string
	err := tx.QueryRowContext(ctx, `
		SELECT id, user_id, rev, seq, deleted, sort_index, ciphertext, updated_at
		FROM groups WHERE user_id = ? AND id = ?`, userID, groupID).Scan(
		&group.ID, &group.UserID, &group.Rev, &group.Seq, &deleted, &group.SortIndex, &group.Ciphertext, &updatedAt)
	if err != nil {
		return nil, err
	}
	group.Deleted = intToBool(deleted)
	group.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return &group, nil
}

func (s *SQLiteStore) CreateAuditEntry(ctx context.Context, entry *AuditEntry) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO audit_log (id, at, actor_kind, actor_id, action, target_kind, target_id, ip, user_agent)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		entry.ID, entry.At.Format(time.RFC3339), entry.ActorKind,
		nullString(entry.ActorID), entry.Action,
		nullString(entry.TargetKind), nullString(entry.TargetID),
		nullString(entry.IP), nullString(entry.UserAgent))
	return err
}

func (s *SQLiteStore) ListAuditEntries(ctx context.Context, limit int, cursor string) ([]*AuditEntry, string, error) {
	query := `SELECT id, at, actor_kind, actor_id, action, target_kind, target_id, ip, user_agent
		FROM audit_log WHERE id > ? ORDER BY at DESC, id ASC LIMIT ?`
	rows, err := s.db.QueryContext(ctx, query, cursor, limit)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()

	var entries []*AuditEntry
	for rows.Next() {
		var e AuditEntry
		var at string
		var actorID, targetKind, targetID, ip, userAgent sql.NullString
		if err := rows.Scan(&e.ID, &at, &e.ActorKind, &actorID, &e.Action, &targetKind, &targetID, &ip, &userAgent); err != nil {
			return nil, "", err
		}
		e.At, _ = time.Parse(time.RFC3339, at)
		if actorID.Valid {
			e.ActorID = &actorID.String
		}
		if targetKind.Valid {
			e.TargetKind = &targetKind.String
		}
		if targetID.Valid {
			e.TargetID = &targetID.String
		}
		if ip.Valid {
			e.IP = &ip.String
		}
		if userAgent.Valid {
			e.UserAgent = &userAgent.String
		}
		entries = append(entries, &e)
	}

	var nextCursor string
	if len(entries) == limit {
		nextCursor = entries[len(entries)-1].ID
	}
	return entries, nextCursor, rows.Err()
}

func (s *SQLiteStore) GetUserStats(ctx context.Context, userID string) (int, *time.Time, int64, error) {
	deviceCount, err := s.CountDevicesByUser(ctx, userID)
	if err != nil {
		return 0, nil, 0, err
	}

	var lastSyncAt sql.NullString
	err = s.db.QueryRowContext(ctx, `SELECT updated_at FROM vaults WHERE user_id = ?`, userID).Scan(&lastSyncAt)
	if err != nil && err != sql.ErrNoRows {
		return 0, nil, 0, err
	}

	var lastSync *time.Time
	if lastSyncAt.Valid {
		t, _ := time.Parse(time.RFC3339, lastSyncAt.String)
		lastSync = &t
	}

	var totalBytes int64
	rows, err := s.db.QueryContext(ctx, `
		SELECT LENGTH(ciphertext) FROM items WHERE user_id = ? AND ciphertext IS NOT NULL
		UNION ALL
		SELECT LENGTH(ciphertext) FROM groups WHERE user_id = ? AND ciphertext IS NOT NULL`,
		userID, userID)
	if err != nil {
		return 0, nil, 0, err
	}
	defer rows.Close()

	for rows.Next() {
		var size int64
		if err := rows.Scan(&size); err != nil {
			return 0, nil, 0, err
		}
		totalBytes += size
	}

	return deviceCount, lastSync, totalBytes, rows.Err()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func intToBool(i int) bool {
	return i != 0
}

func nullString(s *string) interface{} {
	if s == nil {
		return nil
	}
	return *s
}

func ensureDir(path string) error {
	if path == "" || path == "." {
		return nil
	}
	return os.MkdirAll(path, 0755)
}
