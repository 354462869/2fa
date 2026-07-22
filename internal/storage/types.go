package storage

import "time"

// User represents a registered account (normal user or admin).
type User struct {
	ID           string
	Username     string
	PasswordHash string
	Role         string // "user" or "admin"
	Disabled     bool
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Session represents an authenticated session bound to a user and optionally a device.
type Session struct {
	TokenHash         string
	UserID            string
	DeviceID          string // optional, may be empty
	ExpiresAt         time.Time
	AbsoluteExpiresAt time.Time
	CreatedAt         time.Time
}

// Device represents a registered client device.
type Device struct {
	ID         string
	UserID     string
	Label      string
	Revoked    bool
	LastSeenAt time.Time
	CreatedAt  time.Time
}

// Vault holds per-user envelope metadata and the current seq counter.
type Vault struct {
	UserID      string
	Seq         int64
	EnvelopeRev int64
	Envelope    []byte // JSON-encoded VaultEnvelope
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Item represents a TOTP item record.
type Item struct {
	ID         string
	UserID     string
	GroupID    *string // nullable
	Rev        int64
	Seq        int64
	Deleted    bool
	Ciphertext []byte // JSON-encoded RecordCipher
	UpdatedAt  time.Time
}

// Group represents a grouping record.
type Group struct {
	ID         string
	UserID     string
	Rev        int64
	Seq        int64
	Deleted    bool
	SortIndex  int64
	Ciphertext []byte // JSON-encoded RecordCipher
	UpdatedAt  time.Time
}

// Account represents server-visible account metadata plus encrypted secrets.
type Account struct {
	ID                  string
	UserID              string
	Rev                 int64
	Seq                 int64
	Deleted             bool
	Kind                string
	Platform            string
	DisplayName         string
	LoginIdentifier     *string
	LoginIdentifierHash *string
	Status              string
	TagsJSON            []byte
	MetadataJSON        []byte
	SecretCiphertext    []byte // JSON-encoded RecordCipher for sensitive account data
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// Relation represents a server-visible relationship between two records.
type Relation struct {
	ID               string
	UserID           string
	Rev              int64
	Seq              int64
	Deleted          bool
	Kind             string
	FromKind         string
	FromID           string
	ToKind           string
	ToID             string
	MetadataJSON     []byte
	SecretCiphertext []byte // JSON-encoded RecordCipher for sensitive relation data
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// AuditEntry represents a logged action for audit trail.
type AuditEntry struct {
	ID         string
	At         time.Time
	ActorKind  string // "user", "admin", "system"
	ActorID    *string
	Action     string
	TargetKind *string
	TargetID   *string
	IP         *string
	UserAgent  *string
}

// PushItemInput represents an item write request.
type PushItemInput struct {
	ID          string
	GroupID     *string
	Deleted     bool
	ExpectedRev *int64
	Ciphertext  []byte
}

// PushGroupInput represents a group write request.
type PushGroupInput struct {
	ID          string
	Deleted     bool
	SortIndex   int64
	ExpectedRev *int64
	Ciphertext  []byte
}

// PushAccountInput represents an account metadata write request.
type PushAccountInput struct {
	ID                  string
	Deleted             bool
	Kind                string
	Platform            string
	DisplayName         string
	LoginIdentifier     *string
	LoginIdentifierHash *string
	Status              string
	TagsJSON            []byte
	MetadataJSON        []byte
	ExpectedRev         *int64
	SecretCiphertext    []byte
}

// PushRelationInput represents a relation metadata write request.
type PushRelationInput struct {
	ID               string
	Deleted          bool
	Kind             string
	FromKind         string
	FromID           string
	ToKind           string
	ToID             string
	MetadataJSON     []byte
	ExpectedRev      *int64
	SecretCiphertext []byte
}

// ConflictResult represents a rejected write due to stale rev.
type ConflictResult struct {
	ID         string
	Kind       string // "item", "group", "account", or "relation"
	CurrentRev int64
	CurrentSeq int64
	Current    interface{} // *Item, *Group, *Account, or *Relation
}

// AppliedResult represents a successful write.
type AppliedResult struct {
	ID   string
	Kind string
	Rev  int64
	Seq  int64
}
