package storage

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound     = errors.New("storage: not found")
	ErrConflict     = errors.New("storage: conflict")
	ErrUserExists   = errors.New("storage: user already exists")
	ErrDeviceExists = errors.New("storage: device already exists")
	ErrInvalidInput = errors.New("storage: invalid input")
)

type Store interface {
	Close() error

	CreateUser(ctx context.Context, user *User) error
	GetUserByID(ctx context.Context, id string) (*User, error)
	GetUserByUsername(ctx context.Context, username string) (*User, error)
	UpdateUserPassword(ctx context.Context, userID, newHash string) error
	SetUserDisabled(ctx context.Context, userID string, disabled bool) error
	ListUsers(ctx context.Context, limit int, cursor string) ([]*User, string, error)
	CountUsers(ctx context.Context) (int, error)

	CreateSession(ctx context.Context, session *Session) error
	GetSession(ctx context.Context, token string) (*Session, error)
	DeleteSession(ctx context.Context, token string) error
	DeleteSessionsByUser(ctx context.Context, userID string) error
	DeleteSessionsByDevice(ctx context.Context, deviceID string) error

	CreateDevice(ctx context.Context, device *Device) error
	GetDevice(ctx context.Context, deviceID string) (*Device, error)
	ListDevicesByUser(ctx context.Context, userID string) ([]*Device, error)
	UpdateDeviceLastSeen(ctx context.Context, deviceID string, at time.Time) error
	RevokeDevice(ctx context.Context, deviceID string) error
	CountDevicesByUser(ctx context.Context, userID string) (int, error)

	GetOrCreateVault(ctx context.Context, userID string) (*Vault, error)
	GetVault(ctx context.Context, userID string) (*Vault, error)
	UpdateVaultEnvelope(ctx context.Context, userID string, expectedRev *int64, envelope []byte) (*Vault, error)

	GetItem(ctx context.Context, userID, itemID string) (*Item, error)
	GetGroup(ctx context.Context, userID, groupID string) (*Group, error)

	PullRecords(ctx context.Context, userID string, sinceSeq int64, limit int) ([]*Item, []*Group, int64, bool, error)

	PushRecords(ctx context.Context, userID string, items []PushItemInput, groups []PushGroupInput) ([]AppliedResult, []ConflictResult, int64, error)

	CreateAuditEntry(ctx context.Context, entry *AuditEntry) error
	ListAuditEntries(ctx context.Context, limit int, cursor string) ([]*AuditEntry, string, error)

	GetUserStats(ctx context.Context, userID string) (deviceCount int, lastSyncAt *time.Time, ciphertextBytes int64, err error)
}
