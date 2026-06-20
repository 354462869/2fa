/**
 * Wire-format types mirroring docs/openapi.yaml. These types are the
 * source of truth shared by extension, admin SPA, and any test
 * fixtures. Keep them in lockstep with the OpenAPI document.
 */

export type Id = string;
export type Base64 = string;
export type Timestamp = string;

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiError };

export interface HealthResponse {
  status: 'ok';
}

export interface VersionResponse {
  version: string;
  api: string;
  build?: string;
}

export type Role = 'user' | 'admin';

export interface UserMe {
  id: Id;
  username: string;
  role: Role;
  disabled?: boolean;
  created_at: Timestamp;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  device_id?: Id;
}

export interface AdminSetupStatusResponse {
  needs_setup: boolean;
}

export interface ChangeAccountPasswordRequest {
  current_password: string;
  new_password: string;
}

export interface SessionResponse {
  token: string;
  user: UserMe;
  expires_at?: Timestamp;
}

export interface Device {
  id: Id;
  label: string;
  created_at: Timestamp;
  last_seen_at?: Timestamp;
  revoked?: boolean;
}

export interface RegisterDeviceRequest {
  id: Id;
  label: string;
}

export type AeadAlg = 'A256GCM' | 'XCHACHA20P1305' | (string & {});
export type Kdf = 'argon2id' | (string & {});

export interface KdfParams {
  [key: string]: unknown;
}

export interface VaultEnvelope {
  alg: AeadAlg;
  kdf: Kdf;
  kdf_params?: KdfParams;
  kdf_salt_b64: Base64;
  wrapped_dek_b64: Base64;
  wrap_iv_b64: Base64;
}

export interface RecordCipher {
  alg: AeadAlg;
  iv_b64: Base64;
  ct_b64: Base64;
  aad_b64?: Base64;
}

export interface Vault {
  user_id: Id;
  seq: number;
  envelope_rev: number;
  envelope?: VaultEnvelope;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PutEnvelopeRequest {
  envelope: VaultEnvelope;
  expected_rev: number | null;
}

export interface Item {
  id: Id;
  group_id?: Id | null;
  rev: number;
  seq: number;
  deleted: boolean;
  updated_at: Timestamp;
  ciphertext?: RecordCipher | null;
}

export interface Group {
  id: Id;
  rev: number;
  seq: number;
  deleted: boolean;
  sort_index: number;
  updated_at: Timestamp;
  ciphertext?: RecordCipher | null;
}

export interface Account {
  id: Id;
  rev: number;
  seq: number;
  deleted: boolean;
  kind: string;
  platform: string;
  display_name: string;
  login_identifier?: string | null;
  login_identifier_hash?: string | null;
  status: string;
  tags_json?: unknown;
  metadata_json?: unknown;
  /** Server-populated. Optional on locally-constructed objects pre-sync. */
  created_at?: Timestamp;
  updated_at: Timestamp;
  secret_ciphertext?: RecordCipher | null;
}

export interface Relation {
  id: Id;
  rev: number;
  seq: number;
  deleted: boolean;
  kind: string;
  from_kind: string;
  from_id: Id;
  to_kind: string;
  to_id: Id;
  /** Server-populated alias mirroring `kind`. */
  relation_type?: string;
  /** Server-populated when `from_kind === 'account'`. */
  from_account_id?: Id | null;
  /** Server-populated when `to_kind === 'account'`. */
  to_account_id?: Id | null;
  metadata_json?: unknown;
  /** Server-populated. Optional on locally-constructed objects pre-sync. */
  created_at?: Timestamp;
  updated_at: Timestamp;
  secret_ciphertext?: RecordCipher | null;
}

export interface PullRequest {
  since_seq: number;
  limit?: number;
}

export interface PullResponse {
  items: Item[];
  groups: Group[];
  accounts: Account[];
  relations: Relation[];
  next_seq: number;
  has_more: boolean;
}

export interface PushItem {
  id: Id;
  group_id?: Id | null;
  deleted: boolean;
  expected_rev: number | null;
  ciphertext?: RecordCipher | null;
}

export interface PushGroup {
  id: Id;
  deleted: boolean;
  sort_index: number;
  expected_rev: number | null;
  ciphertext?: RecordCipher | null;
}

export interface PushAccount {
  id: Id;
  deleted: boolean;
  kind: string;
  platform: string;
  display_name: string;
  login_identifier?: string | null;
  login_identifier_hash?: string | null;
  status: string;
  tags_json?: unknown;
  metadata_json?: unknown;
  expected_rev: number | null;
  secret_ciphertext?: RecordCipher | null;
}

export interface PushRelation {
  id: Id;
  deleted: boolean;
  kind?: string;
  from_kind?: string;
  from_id?: Id;
  to_kind?: string;
  to_id?: Id;
  /** Alias for `kind`. Used when `kind` is omitted. */
  relation_type?: string;
  /** Alias for `from_id` with `from_kind` defaulted to `'account'`. */
  from_account_id?: Id;
  /** Alias for `to_id` with `to_kind` defaulted to `'account'`. */
  to_account_id?: Id;
  metadata_json?: unknown;
  expected_rev: number | null;
  secret_ciphertext?: RecordCipher | null;
}

export interface PushRequest {
  items?: PushItem[];
  groups?: PushGroup[];
  accounts?: PushAccount[];
  relations?: PushRelation[];
}

export type RecordKind = 'item' | 'group' | 'account' | 'relation';

export interface AppliedRecord {
  id: Id;
  kind: RecordKind;
  rev: number;
  seq: number;
}

export interface ConflictRecord {
  id: Id;
  kind: RecordKind;
  current_rev: number;
  current_seq: number;
  current_item?: Item | null;
  current_group?: Group | null;
  current_account?: Account | null;
  current_relation?: Relation | null;
}

export interface PushResponse {
  applied: AppliedRecord[];
  conflicts: ConflictRecord[];
  next_seq: number;
}

export interface AdminUser {
  id: Id;
  username: string;
  role: Role;
  disabled: boolean;
  device_count: number;
  last_sync_at?: Timestamp;
  ciphertext_bytes?: number;
  created_at: Timestamp;
}

export interface AdminUserPage {
  users: AdminUser[];
  next_cursor?: string | null;
}

export type AdminAccount = Omit<Account, 'secret_ciphertext'>;
export type AdminRelation = Omit<Relation, 'secret_ciphertext'>;

export interface AdminAccountPage {
  accounts: AdminAccount[];
}

export interface AdminRelationPage {
  relations: AdminRelation[];
}

export type ActorKind = 'user' | 'admin' | 'system';

export interface AuditEntry {
  id: Id;
  at: Timestamp;
  actor_kind: ActorKind;
  actor_id?: Id | null;
  action: string;
  target_kind?: string | null;
  target_id?: Id | null;
  ip?: string | null;
  user_agent?: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  next_cursor?: string | null;
}
