package http

import "time"

type RegisterRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type LoginRequest struct {
	Username string  `json:"username"`
	Password string  `json:"password"`
	DeviceID *string `json:"device_id,omitempty"`
}

type AdminSetupStatusResponse struct {
	NeedsSetup bool `json:"needs_setup"`
}

type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

type SessionResponse struct {
	Token     string    `json:"token"`
	User      UserMe    `json:"user"`
	ExpiresAt time.Time `json:"expires_at"`
}

type UserMe struct {
	ID        string    `json:"id"`
	Username  string    `json:"username"`
	Role      string    `json:"role"`
	Disabled  bool      `json:"disabled"`
	CreatedAt time.Time `json:"created_at"`
}

type RegisterDeviceRequest struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type DeviceResponse struct {
	ID         string    `json:"id"`
	Label      string    `json:"label"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	Revoked    bool      `json:"revoked"`
}

type VaultEnvelope struct {
	Alg        string                 `json:"alg"`
	Kdf        string                 `json:"kdf"`
	KdfParams  map[string]interface{} `json:"kdf_params,omitempty"`
	KdfSaltB64 string                 `json:"kdf_salt_b64"`
	WrappedDEK string                 `json:"wrapped_dek_b64"`
	WrapIV     string                 `json:"wrap_iv_b64"`
}

type VaultResponse struct {
	UserID      string         `json:"user_id"`
	Seq         int64          `json:"seq"`
	EnvelopeRev int64          `json:"envelope_rev"`
	Envelope    *VaultEnvelope `json:"envelope,omitempty"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
}

type PutEnvelopeRequest struct {
	Envelope    VaultEnvelope `json:"envelope"`
	ExpectedRev *int64        `json:"expected_rev"`
}

type RecordCipher struct {
	Alg    string  `json:"alg"`
	IVB64  string  `json:"iv_b64"`
	CTB64  string  `json:"ct_b64"`
	AADB64 *string `json:"aad_b64,omitempty"`
}

type ItemResponse struct {
	ID         string        `json:"id"`
	GroupID    *string       `json:"group_id,omitempty"`
	Rev        int64         `json:"rev"`
	Seq        int64         `json:"seq"`
	Deleted    bool          `json:"deleted"`
	UpdatedAt  time.Time     `json:"updated_at"`
	Ciphertext *RecordCipher `json:"ciphertext,omitempty"`
}

type GroupResponse struct {
	ID         string        `json:"id"`
	Rev        int64         `json:"rev"`
	Seq        int64         `json:"seq"`
	Deleted    bool          `json:"deleted"`
	SortIndex  int64         `json:"sort_index"`
	UpdatedAt  time.Time     `json:"updated_at"`
	Ciphertext *RecordCipher `json:"ciphertext,omitempty"`
}

type PullRequest struct {
	SinceSeq int64 `json:"since_seq"`
	Limit    int   `json:"limit"`
}

type PullResponse struct {
	Items   []ItemResponse  `json:"items"`
	Groups  []GroupResponse `json:"groups"`
	NextSeq int64           `json:"next_seq"`
	HasMore bool            `json:"has_more"`
}

type PushItemInput struct {
	ID          string        `json:"id"`
	GroupID     *string       `json:"group_id,omitempty"`
	Deleted     bool          `json:"deleted"`
	ExpectedRev *int64        `json:"expected_rev"`
	Ciphertext  *RecordCipher `json:"ciphertext,omitempty"`
}

type PushGroupInput struct {
	ID          string        `json:"id"`
	Deleted     bool          `json:"deleted"`
	SortIndex   int64         `json:"sort_index"`
	ExpectedRev *int64        `json:"expected_rev"`
	Ciphertext  *RecordCipher `json:"ciphertext,omitempty"`
}

type PushRequest struct {
	Items  []PushItemInput  `json:"items,omitempty"`
	Groups []PushGroupInput `json:"groups,omitempty"`
}

type AppliedRecord struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Rev  int64  `json:"rev"`
	Seq  int64  `json:"seq"`
}

type ConflictRecord struct {
	ID           string         `json:"id"`
	Kind         string         `json:"kind"`
	CurrentRev   int64          `json:"current_rev"`
	CurrentSeq   int64          `json:"current_seq"`
	CurrentItem  *ItemResponse  `json:"current_item,omitempty"`
	CurrentGroup *GroupResponse `json:"current_group,omitempty"`
}

type PushResponse struct {
	Applied   []AppliedRecord  `json:"applied"`
	Conflicts []ConflictRecord `json:"conflicts"`
	NextSeq   int64            `json:"next_seq"`
}

type AdminUser struct {
	ID              string     `json:"id"`
	Username        string     `json:"username"`
	Role            string     `json:"role"`
	Disabled        bool       `json:"disabled"`
	DeviceCount     int        `json:"device_count"`
	LastSyncAt      *time.Time `json:"last_sync_at,omitempty"`
	CiphertextBytes int64      `json:"ciphertext_bytes"`
	CreatedAt       time.Time  `json:"created_at"`
}

type AdminUserPage struct {
	Users      []AdminUser `json:"users"`
	NextCursor *string     `json:"next_cursor,omitempty"`
}

type AuditEntry struct {
	ID         string    `json:"id"`
	At         time.Time `json:"at"`
	ActorKind  string    `json:"actor_kind"`
	ActorID    *string   `json:"actor_id,omitempty"`
	Action     string    `json:"action"`
	TargetKind *string   `json:"target_kind,omitempty"`
	TargetID   *string   `json:"target_id,omitempty"`
	IP         *string   `json:"ip,omitempty"`
	UserAgent  *string   `json:"user_agent,omitempty"`
}

type AuditPage struct {
	Entries    []AuditEntry `json:"entries"`
	NextCursor *string      `json:"next_cursor,omitempty"`
}

type APIError struct {
	Code    string                 `json:"code"`
	Message string                 `json:"message"`
	Details map[string]interface{} `json:"details,omitempty"`
}
