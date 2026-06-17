import type {
  AdminUser,
  AdminUserPage,
  AdminSetupStatusResponse,
  ApiError,
  AuditPage,
  ChangeAccountPasswordRequest,
  Device,
  Group,
  HealthResponse,
  Id,
  Item,
  LoginRequest,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  PutEnvelopeRequest,
  RegisterDeviceRequest,
  RegisterRequest,
  Result,
  SessionResponse,
  UserMe,
  Vault,
  VersionResponse,
} from '@2fa/api-types';

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

export interface AuthProvider {
  getToken(): string | null;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  auth?: AuthProvider;
  defaultHeaders?: Record<string, string>;
}

const SECRET_HEADER_NAMES: ReadonlySet<string> = new Set([
  'x-sync-password',
  'x-sync-key',
  'x-vault-key',
  'x-encryption-key',
]);

function assertNoSecretHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (SECRET_HEADER_NAMES.has(lower)) {
      throw new Error(`refusing to send sensitive header: ${name}`);
    }
  }
}

function joinUrl(base: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const left = base.endsWith('/') ? base.slice(0, -1) : base;
  const right = path.startsWith('/') ? path : `/${path}`;
  return left + right;
}

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string';
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly auth: AuthProvider | undefined;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: ApiClientOptions) {
    if (!opts.baseUrl) {
      throw new Error('ApiClient: baseUrl is required');
    }
    this.baseUrl = opts.baseUrl;
    const f = opts.fetch ?? (globalThis.fetch ? ((input, init) => globalThis.fetch(input, init)) as FetchLike : undefined);
    if (!f) {
      throw new Error('ApiClient: fetch is not available; pass options.fetch');
    }
    this.fetchImpl = f;
    this.auth = opts.auth;
    this.defaultHeaders = { ...(opts.defaultHeaders ?? {}) };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: { signal?: AbortSignal },
  ): Promise<Result<T>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.defaultHeaders,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const token = this.auth?.getToken() ?? null;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    assertNoSecretHeaders(headers);

    const res = await this.fetchImpl(joinUrl(this.baseUrl, path), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(init?.signal ? { signal: init.signal } : {}),
    });

    if (res.status === 204) {
      if (res.ok) {
        return { ok: true, status: 204, data: undefined as T };
      }
      return {
        ok: false,
        status: res.status,
        error: { code: 'http.no_content_error', message: `HTTP ${res.status}` },
      };
    }

    let payload: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (res.ok) {
      return { ok: true, status: res.status, data: payload as T };
    }

    if (isApiError(payload)) {
      return { ok: false, status: res.status, error: payload };
    }
    return {
      ok: false,
      status: res.status,
      error: { code: 'http.error', message: `HTTP ${res.status}` },
    };
  }

  meta = {
    health: (): Promise<Result<HealthResponse>> => this.request('GET', '/v1/meta/health'),
    version: (): Promise<Result<VersionResponse>> => this.request('GET', '/v1/meta/version'),
  };

  auth_ = {
    register: (req: RegisterRequest): Promise<Result<SessionResponse>> =>
      this.request('POST', '/v1/auth/register', req),
    login: (req: LoginRequest): Promise<Result<SessionResponse>> =>
      this.request('POST', '/v1/auth/login', req),
    logout: (): Promise<Result<void>> => this.request('POST', '/v1/auth/logout'),
    me: (): Promise<Result<UserMe>> => this.request('GET', '/v1/auth/me'),
    changePassword: (req: ChangeAccountPasswordRequest): Promise<Result<void>> =>
      this.request('PUT', '/v1/auth/password', req),
  };

  devices = {
    list: (): Promise<Result<{ devices: Device[] }>> => this.request('GET', '/v1/devices'),
    register: (req: RegisterDeviceRequest): Promise<Result<Device>> =>
      this.request('POST', '/v1/devices', req),
    revoke: (id: Id): Promise<Result<void>> =>
      this.request('DELETE', `/v1/devices/${encodeURIComponent(id)}`),
  };

  sync = {
    vault: (): Promise<Result<Vault>> => this.request('GET', '/v1/sync/vault'),
    putEnvelope: (req: PutEnvelopeRequest): Promise<Result<Vault>> =>
      this.request('PUT', '/v1/sync/vault/envelope', req),
    pull: (req: PullRequest): Promise<Result<PullResponse>> =>
      this.request('POST', '/v1/sync/pull', req),
    push: (req: PushRequest): Promise<Result<PushResponse>> =>
      this.request('POST', '/v1/sync/push', req),
    item: (id: Id): Promise<Result<Item>> =>
      this.request('GET', `/v1/sync/items/${encodeURIComponent(id)}`),
    group: (id: Id): Promise<Result<Group>> =>
      this.request('GET', `/v1/sync/groups/${encodeURIComponent(id)}`),
  };

  admin = {
    setupStatus: (): Promise<Result<AdminSetupStatusResponse>> =>
      this.request('GET', '/v1/admin/setup/status'),
    setup: (req: RegisterRequest): Promise<Result<SessionResponse>> =>
      this.request('POST', '/v1/admin/setup', req),
    login: (req: LoginRequest): Promise<Result<SessionResponse>> =>
      this.request('POST', '/v1/admin/auth/login', req),
    listUsers: (params?: { limit?: number; cursor?: string }): Promise<Result<AdminUserPage>> => {
      const q = new URLSearchParams();
      if (params?.limit !== undefined) q.set('limit', String(params.limit));
      if (params?.cursor !== undefined) q.set('cursor', params.cursor);
      const suffix = q.toString();
      return this.request('GET', `/v1/admin/users${suffix ? `?${suffix}` : ''}`);
    },
    getUser: (id: Id): Promise<Result<AdminUser>> =>
      this.request('GET', `/v1/admin/users/${encodeURIComponent(id)}`),
    disableUser: (id: Id): Promise<Result<void>> =>
      this.request('POST', `/v1/admin/users/${encodeURIComponent(id)}/disable`),
    enableUser: (id: Id): Promise<Result<void>> =>
      this.request('POST', `/v1/admin/users/${encodeURIComponent(id)}/enable`),
    listUserDevices: (userId: Id): Promise<Result<{ devices: Device[] }>> =>
      this.request('GET', `/v1/admin/users/${encodeURIComponent(userId)}/devices`),
    revokeDevice: (userId: Id, deviceId: Id): Promise<Result<void>> =>
      this.request(
        'DELETE',
        `/v1/admin/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}`,
      ),
    audit: (params?: { limit?: number; cursor?: string }): Promise<Result<AuditPage>> => {
      const q = new URLSearchParams();
      if (params?.limit !== undefined) q.set('limit', String(params.limit));
      if (params?.cursor !== undefined) q.set('cursor', params.cursor);
      const suffix = q.toString();
      return this.request('GET', `/v1/admin/audit${suffix ? `?${suffix}` : ''}`);
    },
  };
}

export type { ApiError, Result } from '@2fa/api-types';
