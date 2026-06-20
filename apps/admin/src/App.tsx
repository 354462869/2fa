import React, { useState, useEffect, useRef } from 'react';
import {
  Shield,
  Users,
  FileText,
  Activity,
  LogOut,
  Menu,
  X,
  Smartphone,
  AlertTriangle,
  Database,
  Info,
  RefreshCw,
  Search,
  CheckCircle,
  Clock,
  Link
} from 'lucide-react';
import { ApiClient } from '@2fa/api-client';
import type { AdminUser, AuditEntry, Device, AdminAccount, AdminRelation } from '@2fa/api-types';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function renderTags(tags: unknown) {
  if (!tags) return null;
  let parsed: string[] = [];
  try {
    if (Array.isArray(tags)) {
      parsed = tags.map(String);
    } else if (typeof tags === 'string') {
      const p = JSON.parse(tags);
      if (Array.isArray(p)) {
        parsed = p.map(String);
      } else {
        parsed = [tags];
      }
    } else if (typeof tags === 'object' && tags !== null) {
      parsed = Object.keys(tags);
    }
  } catch {
    if (typeof tags === 'string') parsed = [tags];
  }
  if (parsed.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {parsed.map((tag, idx) => (
        <span key={idx} className="bg-slate-100 text-slate-600 text-[10px] px-1.5 py-0.5 rounded font-medium">
          {tag}
        </span>
      ))}
    </div>
  );
}

function renderMetadataSummary(meta: unknown) {
  if (!meta) return null;
  let text = '';
  try {
    if (typeof meta === 'object') {
      text = JSON.stringify(meta);
    } else if (typeof meta === 'string') {
      text = meta;
    }
  } catch {
    text = String(meta);
  }
  if (!text || text === '{}' || text === '[]') return null;
  return (
    <div className="text-[10px] text-slate-500 mt-1 font-mono break-all line-clamp-2" title={text}>
      元数据: {text}
    </div>
  );
}

function maskLoginIdentifier(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.includes('***')) return id;
  if (id.includes('@')) {
    const parts = id.split('@');
    const local = parts[0] || '';
    const domain = parts[1] || '';
    if (local.length <= 3) {
      return `${local.charAt(0)}***@${domain}`;
    }
    return `${local.slice(0, 3)}***@${domain}`;
  }
  if (id.length <= 4) {
    return `${id.charAt(0)}***`;
  }
  return `${id.slice(0, 3)}***${id.slice(-1)}`;
}

function RelationGraph({ accounts, relations }: { accounts: AdminAccount[]; relations: AdminRelation[] }) {
  const activeAccounts = accounts.filter(acc => !acc.deleted);
  const activeRelations = relations.filter(rel => !rel.deleted);

  if (activeAccounts.length === 0) {
    return (
      <p className="text-slate-400 text-xs text-center py-6 bg-slate-50 border border-dashed border-slate-200 rounded-lg">
        暂无可见的关系图谱数据。
      </p>
    );
  }

  const cx = 200;
  const cy = 110;
  const rx = 120;
  const ry = 60;
  const N = activeAccounts.length;

  const nodes = activeAccounts.map((acc, index) => {
    let x = cx;
    let y = cy;
    if (N > 1) {
      const angle = (2 * Math.PI * index) / N - Math.PI / 2;
      x = cx + rx * Math.cos(angle);
      y = cy + ry * Math.sin(angle);
    }
    return { id: acc.id, x, y, account: acc };
  });

  const edges = activeRelations.map(rel => {
    const fromId = rel.from_account_id || rel.from_id;
    const toId = rel.to_account_id || rel.to_id;
    const fromNode = nodes.find(n => n.id === fromId);
    const toNode = nodes.find(n => n.id === toId);
    const label = rel.relation_type || rel.kind || '关联';
    return { fromNode, toNode, label, relation: rel };
  }).filter((e): e is { fromNode: typeof nodes[0], toNode: typeof nodes[0], label: string, relation: AdminRelation } => !!(e.fromNode && e.toNode));

  return (
    <div className="w-full border border-slate-200 rounded-xl bg-white p-2">
      <svg viewBox="0 0 400 220" className="w-full h-auto">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="20"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
          </marker>
        </defs>

        {edges.map((edge, idx) => {
          const { fromNode, toNode, label } = edge;
          const x1 = fromNode.x;
          const y1 = fromNode.y;
          const x2 = toNode.x;
          const y2 = toNode.y;
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;

          return (
            <g key={`edge-${idx}`}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#cbd5e1"
                strokeWidth="1.5"
                markerEnd="url(#arrow)"
              />
              <g transform={`translate(${midX}, ${midY})`}>
                <rect
                  x="-25"
                  y="-7"
                  width="50"
                  height="14"
                  rx="3"
                  fill="#f1f5f9"
                  stroke="#cbd5e1"
                  strokeWidth="0.5"
                />
                <text
                  textAnchor="middle"
                  y="3.5"
                  fontSize="8"
                  fontWeight="medium"
                  fill="#475569"
                >
                  {label.length > 8 ? `${label.slice(0, 7)}...` : label}
                </text>
              </g>
            </g>
          );
        })}

        {nodes.map((node) => {
          const { x, y, account } = node;
          return (
            <g key={node.id} className="group">
              <circle
                cx={x}
                cy={y}
                r="16"
                fill="#4f46e5"
                stroke="#ffffff"
                strokeWidth="2.5"
                className="drop-shadow-md cursor-pointer hover:fill-indigo-500 transition-colors duration-150"
              />
              <text
                x={x}
                y={y + 3}
                textAnchor="middle"
                fontSize="9"
                fontWeight="bold"
                fill="#ffffff"
                className="select-none pointer-events-none"
              >
                {account.platform ? account.platform.slice(0, 2).toUpperCase() : '?'}
              </text>

              <title>
                {`名称: ${account.display_name || '未命名'}\n` +
                 `平台: ${account.platform || '未知'}\n` +
                 `类型: ${account.kind || '未知'}\n` +
                 `状态: ${account.status || '活跃'}`}
              </title>

              <text
                x={x}
                y={y + 24}
                textAnchor="middle"
                fontSize="9"
                fontWeight="semibold"
                fill="#1e293b"
                className="select-none pointer-events-none"
              >
                {account.display_name ? (account.display_name.length > 8 ? `${account.display_name.slice(0, 6)}...` : account.display_name) : '未命名'}
              </text>

              <text
                x={x}
                y={y + 32}
                textAnchor="middle"
                fontSize="7"
                fill="#64748b"
                className="select-none pointer-events-none"
              >
                {account.platform.length > 10 ? `${account.platform.slice(0, 8)}...` : account.platform} ({account.status || '活跃'})
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState(() => sessionStorage.getItem('admin_base_url') || window.location.origin);
  const [token, setToken] = useState(() => sessionStorage.getItem('admin_token') || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(!!token);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'audit'>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userSearch, setUserSearch] = useState('');

  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  const [healthStatus, setHealthStatus] = useState<'ok' | 'error' | 'loading'>('loading');
  const [serverVersion, setServerVersion] = useState('');
  const [serverBuild, setServerBuild] = useState('');

  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [selectedUserDevices, setSelectedUserDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [selectedUserAccounts, setSelectedUserAccounts] = useState<AdminAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [selectedUserRelations, setSelectedUserRelations] = useState<AdminRelation[]>([]);
  const [relationsLoading, setRelationsLoading] = useState(false);

  const [confirmAction, setConfirmAction] = useState<{
    type: 'disable' | 'enable' | 'revoke';
    title: string;
    message: string;
    userId: string;
    deviceId?: string;
  } | null>(null);

  const [toasts, setToasts] = useState<Toast[]>([]);

  const apiClient = useRef<ApiClient | null>(null);
  const loginFormRef = useRef<HTMLFormElement | null>(null);
  const loginInFlightRef = useRef(false);

  useEffect(() => {
    if (isLoggedIn && baseUrl && token) {
      apiClient.current = new ApiClient({
        baseUrl,
        auth: { getToken: () => token }
      });
      loadOverviewData();
    }
  }, [isLoggedIn, baseUrl, token]);

  useEffect(() => {
    if (!isLoggedIn && baseUrl) {
      void loadSetupStatus(baseUrl);
    }
  }, [isLoggedIn, baseUrl]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedUser(null);
        setConfirmAction(null);
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const addToast = (type: 'success' | 'error' | 'info', message: string) => {
    const id = Math.random().toString(36).substring(2);
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  };

  const loadSetupStatus = async (url: string) => {
    try {
      const cleanUrl = url.replace(/\/+$/, '');
      const res = await new ApiClient({ baseUrl: cleanUrl }).admin.setupStatus();
      if (res.ok) {
        setNeedsSetup(res.data.needs_setup);
      }
    } catch {
      setNeedsSetup(false);
    }
  };

  const applySession = (cleanUrl: string, sessionToken: string) => {
    sessionStorage.setItem('admin_token', sessionToken);
    sessionStorage.setItem('admin_base_url', cleanUrl);
    setToken(sessionToken);
    setBaseUrl(cleanUrl);
    setIsLoggedIn(true);
  };

  const submitLogin = async (form: HTMLFormElement) => {
    if (loginInFlightRef.current) return;
    const values = new FormData(form);
    const submittedBaseUrl = String(values.get('baseUrl') ?? '').trim();
    const submittedUsername = String(values.get('username') ?? '').trim();
    const submittedPassword = String(values.get('password') ?? '');
    if (!submittedBaseUrl || !submittedUsername || !submittedPassword) return;

    loginInFlightRef.current = true;
    setIsLoggingIn(true);
    try {
      const cleanUrl = submittedBaseUrl.replace(/\/+$/, '');
      const api = new ApiClient({ baseUrl: cleanUrl });
      const res = await api.admin.login({ username: submittedUsername, password: submittedPassword });

      if (res.ok) {
        applySession(cleanUrl, res.data.token);
        addToast('success', '管理员登录成功。');
      } else {
        addToast('error', res.error.message || '凭据无效');
      }
    } catch (err: unknown) {
      addToast('error', getErrorMessage(err, '连接失败'));
    } finally {
      loginInFlightRef.current = false;
      setIsLoggingIn(false);
    }
  };

  const handleLogin = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void submitLogin(e.currentTarget);
  };

  const handleSetup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (loginInFlightRef.current) return;
    const submittedBaseUrl = baseUrl.trim();
    const submittedUsername = username.trim();
    if (!submittedBaseUrl || !submittedUsername || !password) return;
    if (password !== confirmPassword) {
      addToast('error', '两次输入的密码不一致');
      return;
    }
    if (password.length < 12) {
      addToast('error', '管理员密码至少需要 12 个字符');
      return;
    }

    loginInFlightRef.current = true;
    setIsLoggingIn(true);
    try {
      const cleanUrl = submittedBaseUrl.replace(/\/+$/, '');
      const res = await new ApiClient({ baseUrl: cleanUrl }).admin.setup({
        username: submittedUsername,
        password
      });
      if (res.ok) {
        setNeedsSetup(false);
        setConfirmPassword('');
        applySession(cleanUrl, res.data.token);
        addToast('success', '管理员账号已创建。');
      } else {
        addToast('error', res.error.message || '初始化失败');
        if (res.status === 409) {
          setNeedsSetup(false);
        }
      }
    } catch (err: unknown) {
      addToast('error', getErrorMessage(err, '初始化失败'));
    } finally {
      loginInFlightRef.current = false;
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem('admin_token');
    sessionStorage.removeItem('admin_base_url');
    setToken('');
    setIsLoggedIn(false);
    setUsers([]);
    setAuditEntries([]);
    setSelectedUser(null);
    setConfirmAction(null);
    addToast('info', '已退出登录。');
  };

  const loadOverviewData = async () => {
    if (!apiClient.current) return;
    setHealthStatus('loading');
    try {
      const healthRes = await apiClient.current.meta.health();
      if (healthRes.ok && healthRes.data.status === 'ok') {
        setHealthStatus('ok');
      } else {
        setHealthStatus('error');
      }

      const verRes = await apiClient.current.meta.version();
      if (verRes.ok) {
        setServerVersion(verRes.data.version);
        setServerBuild(verRes.data.build || 'unknown');
      }
    } catch {
      setHealthStatus('error');
    }
    
    await loadUsers();
    await loadAuditLogs(true);
  };

  const loadUsers = async () => {
    if (!apiClient.current) return;
    setUsersLoading(true);
    try {
      const res = await apiClient.current.admin.listUsers({ limit: 100 });
      if (res.ok) {
        setUsers(res.data.users);
      } else {
        addToast('error', '加载用户失败：' + res.error.message);
      }
    } catch (err: unknown) {
      addToast('error', getErrorMessage(err, '加载用户失败'));
    } finally {
      setUsersLoading(false);
    }
  };

  const loadAuditLogs = async (refresh = false) => {
    if (!apiClient.current) return;
    setAuditLoading(true);
    try {
      const cursorParam = refresh ? undefined : (auditCursor || undefined);
      const res = await apiClient.current.admin.audit({
        limit: 50,
        ...(cursorParam !== undefined ? { cursor: cursorParam } : {})
      });
      if (res.ok) {
        if (refresh) {
          setAuditEntries(res.data.entries);
        } else {
          setAuditEntries((prev) => [...prev, ...res.data.entries]);
        }
        setAuditCursor(res.data.next_cursor || null);
      } else {
        addToast('error', '加载审计日志失败：' + res.error.message);
      }
    } catch (err: unknown) {
      addToast('error', getErrorMessage(err, '加载审计日志失败'));
    } finally {
      setAuditLoading(false);
    }
  };

  const loadUserDevices = async (user: AdminUser) => {
    if (!apiClient.current) return;
    setDevicesLoading(true);
    setAccountsLoading(true);
    setRelationsLoading(true);
    setSelectedUser(user);
    setSelectedUserDevices([]);
    setSelectedUserAccounts([]);
    setSelectedUserRelations([]);

    const fetchDevices = async () => {
      try {
        const res = await apiClient.current!.admin.listUserDevices(user.id);
        if (res.ok) {
          setSelectedUserDevices(res.data.devices);
        } else {
          addToast('error', '获取设备失败：' + res.error.message);
        }
      } catch (err: unknown) {
        addToast('error', getErrorMessage(err, '加载设备失败'));
      } finally {
        setDevicesLoading(false);
      }
    };

    const fetchAccounts = async () => {
      try {
        const res = await apiClient.current!.admin.listUserAccounts(user.id);
        if (res.ok) {
          setSelectedUserAccounts(res.data.accounts);
        } else {
          addToast('error', '获取账户可见元数据失败：' + res.error.message);
        }
      } catch (err: unknown) {
        addToast('error', getErrorMessage(err, '加载账户可见元数据失败'));
      } finally {
        setAccountsLoading(false);
      }
    };

    const fetchRelations = async () => {
      try {
        const res = await apiClient.current!.admin.listUserRelations(user.id);
        if (res.ok) {
          setSelectedUserRelations(res.data.relations);
        } else {
          addToast('error', '获取关联可见元数据失败：' + res.error.message);
        }
      } catch (err: unknown) {
        addToast('error', getErrorMessage(err, '加载关联可见元数据失败'));
      } finally {
        setRelationsLoading(false);
      }
    };

    void Promise.all([fetchDevices(), fetchAccounts(), fetchRelations()]);
  };

  const executeConfirmedAction = async () => {
    if (!confirmAction || !apiClient.current) return;
    const { type, userId, deviceId } = confirmAction;
    setConfirmAction(null);

    try {
      if (type === 'disable') {
        const res = await apiClient.current.admin.disableUser(userId);
        if (res.ok) {
          addToast('success', '用户已被禁用。');
          await loadUsers();
          if (selectedUser && selectedUser.id === userId) {
            setSelectedUser({ ...selectedUser, disabled: true });
          }
        } else {
          addToast('error', res.error.message);
        }
      } else if (type === 'enable') {
        const res = await apiClient.current.admin.enableUser(userId);
        if (res.ok) {
          addToast('success', '用户已重新启用。');
          await loadUsers();
          if (selectedUser && selectedUser.id === userId) {
            setSelectedUser({ ...selectedUser, disabled: false });
          }
        } else {
          addToast('error', res.error.message);
        }
      } else if (type === 'revoke' && deviceId) {
        const res = await apiClient.current.admin.revokeDevice(userId, deviceId);
        if (res.ok) {
          addToast('success', '设备注册已被撤销。');
          if (selectedUser) {
            await loadUserDevices(selectedUser);
          }
          await loadUsers();
        } else {
          addToast('error', res.error.message);
        }
      }
    } catch (err: unknown) {
      addToast('error', getErrorMessage(err, '操作失败'));
    }
  };

  const filteredUsers = users.filter((u) =>
    u.username.toLowerCase().includes(userSearch.toLowerCase())
  );

  const totalCapacity = users.reduce((acc, u) => acc + (u.ciphertext_bytes || 0), 0);
  const totalDevices = users.reduce((acc, u) => acc + u.device_count, 0);

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4">
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-8 space-y-6">
          <div className="flex flex-col items-center text-center">
            <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mb-4">
              <Shield className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold text-slate-900">
              {needsSetup ? '初始化管理员账号' : '管理员控制门户'}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {needsSetup ? '检测到这是首次部署，请创建第一个管理员。' : '连接到您的自托管账号管理器后端部署。'}
            </p>
          </div>

          <form ref={loginFormRef} data-admin-login="true" onSubmit={needsSetup ? handleSetup : handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
                服务器基准 URL
              </label>
              <input
                type="url"
                name="baseUrl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
                管理员用户名
              </label>
              <input
                type="text"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
                密码
              </label>
              <input
                type="password"
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                required
              />
            </div>

            {needsSetup && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
                  确认密码
                </label>
                <input
                  type="password"
                  name="confirmPassword"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  required
                />
              </div>
            )}

            <button
              type="submit"
              data-admin-login-submit="true"
              disabled={isLoggingIn}
              className="w-full bg-slate-900 hover:bg-slate-800 disabled:bg-slate-700 text-white font-medium py-2 px-4 rounded-lg transition-colors focus:ring-2 focus:ring-indigo-500"
            >
              {isLoggingIn ? (needsSetup ? '正在初始化...' : '验证中...') : (needsSetup ? '创建管理员并进入后台' : '建立会话')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      <div className="md:hidden bg-slate-900 text-white p-4 flex items-center justify-between">
        <span className="font-bold flex items-center gap-2">
          <Shield className="w-5 h-5 text-indigo-400" />
          账号管理器 管理后台
        </span>
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="p-1 focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded"
        >
          {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      <aside
        className={`${
          mobileMenuOpen ? 'block' : 'hidden'
        } md:block w-full md:w-64 bg-slate-900 text-slate-300 flex flex-col justify-between shrink-0 z-40`}
      >
        <div className="p-6 space-y-8">
          <div className="hidden md:flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white">
              <Shield className="w-5 h-5" />
            </div>
            <span className="font-bold text-white tracking-tight">账号管理器 管理后台</span>
          </div>

          <nav className="space-y-1">
            <button
              onClick={() => {
                setActiveTab('overview');
                setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                activeTab === 'overview' ? 'bg-indigo-600 text-white' : 'hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Activity className="w-4 h-4" />
              系统状态
            </button>
            <button
              onClick={() => {
                setActiveTab('users');
                setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                activeTab === 'users' ? 'bg-indigo-600 text-white' : 'hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Users className="w-4 h-4" />
              用户目录
            </button>
            <button
              onClick={() => {
                setActiveTab('audit');
                setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                activeTab === 'audit' ? 'bg-indigo-600 text-white' : 'hover:bg-slate-800 hover:text-white'
              }`}
            >
              <FileText className="w-4 h-4" />
              审计日志
            </button>
          </nav>
        </div>

        <div className="p-6 border-t border-slate-800 space-y-4">
          <div className="text-[11px] text-slate-500 leading-normal">
            <div className="truncate">已连接：{baseUrl}</div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full bg-slate-800 hover:bg-rose-950 hover:text-rose-200 text-slate-300 font-semibold py-2 px-4 rounded-lg flex items-center justify-center gap-2 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <LogOut className="w-3.5 h-3.5" />
            结束会话
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-6 md:p-10">
        
        {activeTab === 'overview' && (
          <div className="space-y-8">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">系统状态</h1>
                <p className="text-sm text-slate-500 mt-1">实时健康检查与容量指标。</p>
              </div>
              <button
                onClick={loadOverviewData}
                className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 p-2 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500"
                title="刷新页面数据"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
                <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-lg flex items-center justify-center shrink-0">
                  <Users className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs text-slate-400 font-semibold block uppercase tracking-wider">用户总数</span>
                  <span className="text-2xl font-bold text-slate-900">{users.length}</span>
                </div>
              </div>

              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
                <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-lg flex items-center justify-center shrink-0">
                  <Smartphone className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs text-slate-400 font-semibold block uppercase tracking-wider">活跃设备</span>
                  <span className="text-2xl font-bold text-slate-900">{totalDevices}</span>
                </div>
              </div>

              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
                <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-lg flex items-center justify-center shrink-0">
                  <Database className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs text-slate-400 font-semibold block uppercase tracking-wider">保管库存储</span>
                  <span className="text-2xl font-bold text-slate-900">{(totalCapacity / 1024).toFixed(2)} KB</span>
                </div>
              </div>

              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
                <div className={`w-12 h-12 rounded-lg flex items-center justify-center shrink-0 ${
                  healthStatus === 'ok' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'
                }`}>
                  <Activity className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs text-slate-400 font-semibold block uppercase tracking-wider">API 健康度</span>
                  <span className="text-2xl font-bold text-slate-900">{healthStatus === 'ok' ? '健康' : '降级'}</span>
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-2xl">
              <h3 className="font-bold text-slate-900 mb-4 flex items-center gap-2">
                <Info className="w-4 h-4 text-indigo-500" />
                构建配置
              </h3>
              <div className="grid grid-cols-2 gap-y-3 text-sm">
                <span className="text-slate-500 font-medium">服务器 API 版本</span>
                <span className="font-mono text-slate-800 font-semibold">{serverVersion || '未知'}</span>
                <span className="text-slate-500 font-medium">构建元数据</span>
                <span className="font-mono text-slate-800 truncate">{serverBuild || '未知'}</span>
                <span className="text-slate-500 font-medium">目标 Node 版本</span>
                <span className="text-slate-800">Node v20.x + pnpm v9</span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'users' && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">用户目录</h1>
              <p className="text-sm text-slate-500 mt-1">挂起权限、监控存储使用情况并管理凭证。</p>
            </div>

            <div className="flex max-w-md">
              <div className="relative flex-1">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-400 pointer-events-none">
                  <Search className="w-4 h-4" />
                </span>
                <input
                  type="text"
                  placeholder="按用户名过滤用户..."
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent placeholder-slate-400"
                />
              </div>
            </div>

            {usersLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="h-16 w-full bg-slate-100 animate-pulse rounded-xl"></div>
                ))}
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="bg-white p-12 text-center rounded-xl border border-slate-200">
                <p className="text-slate-400 font-medium">没有符合条件的用户。</p>
              </div>
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                <table className="hidden sm:table w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                      <th className="p-4">用户名</th>
                      <th className="p-4">状态</th>
                      <th className="p-4">已注册设备</th>
                      <th className="p-4">已用容量</th>
                      <th className="p-4">创建时间</th>
                      <th className="p-4">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-slate-50">
                         <td className="p-4 font-semibold text-slate-800">{u.username}</td>
                         <td className="p-4">
                           <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                             u.disabled
                               ? 'bg-rose-50 text-rose-700'
                               : 'bg-emerald-50 text-emerald-700'
                           }`}>
                             <span className={`w-1.5 h-1.5 rounded-full ${u.disabled ? 'bg-rose-500' : 'bg-emerald-500'}`}></span>
                             {u.disabled ? '已禁用' : '活跃'}
                           </span>
                         </td>
                         <td className="p-4 text-slate-600 font-semibold">{u.device_count}</td>
                         <td className="p-4 text-slate-600">{((u.ciphertext_bytes || 0) / 1024).toFixed(2)} KB</td>
                         <td className="p-4 text-slate-500">{new Date(u.created_at).toLocaleDateString()}</td>
                         <td className="p-4 space-x-2">
                           <button
                             onClick={() => loadUserDevices(u)}
                             className="text-xs text-indigo-600 hover:underline font-semibold focus:outline-none"
                           >
                             管理设备
                           </button>
                           <button
                             onClick={() => {
                               if (u.disabled) {
                                 setConfirmAction({
                                   type: 'enable',
                                   title: '重新启用账户同步？',
                                   message: `您正在重新启用 ${u.username} 的同步权限。`,
                                   userId: u.id
                                 });
                               } else {
                                 setConfirmAction({
                                   type: 'disable',
                                   title: '禁用账户同步？',
                                   message: `您正在撤销 ${u.username} 的所有同步权限。他们将保留离线访问权限，但将被禁止上传或下载密文。`,
                                   userId: u.id
                                 });
                               }
                             }}
                             className={`text-xs font-semibold focus:outline-none ${
                               u.disabled ? 'text-emerald-600 hover:underline' : 'text-rose-600 hover:underline'
                             }`}
                           >
                             {u.disabled ? '启用同步' : '禁用同步'}
                           </button>
                         </td>
                       </tr>
                    ))}
                  </tbody>
                </table>

                <div className="sm:hidden divide-y divide-slate-100">
                  {filteredUsers.map((u) => (
                    <div key={u.id} className="p-4 space-y-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <span className="font-semibold text-slate-800 block">{u.username}</span>
                          <span className="text-[10px] text-slate-400 block mt-0.5">
                            创建于 {new Date(u.created_at).toLocaleDateString()}
                          </span>
                        </div>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          u.disabled ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'
                        }`}>
                          {u.disabled ? '已禁用' : '活跃'}
                        </span>
                      </div>
                      <div className="flex justify-between text-xs text-slate-500">
                        <span>设备: {u.device_count}</span>
                        <span>容量: {((u.ciphertext_bytes || 0) / 1024).toFixed(2)} KB</span>
                      </div>
                      <div className="flex gap-3 pt-1">
                        <button
                          onClick={() => loadUserDevices(u)}
                          className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs py-1.5 rounded font-semibold text-center focus:outline-none"
                        >
                          设备
                        </button>
                        <button
                          onClick={() => {
                            if (u.disabled) {
                              setConfirmAction({
                                type: 'enable',
                                title: '启用同步',
                                message: `为 ${u.username} 启用同步？`,
                                userId: u.id
                              });
                            } else {
                              setConfirmAction({
                                type: 'disable',
                                title: '禁用同步',
                                message: `为 ${u.username} 禁用同步？`,
                                userId: u.id
                              });
                            }
                          }}
                          className={`flex-1 border text-xs py-1.5 rounded font-semibold text-center focus:outline-none ${
                            u.disabled
                              ? 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'
                              : 'border-rose-200 text-rose-600 hover:bg-rose-50'
                          }`}
                        >
                          {u.disabled ? '启用' : '禁用'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'audit' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">审计日志</h1>
                <p className="text-sm text-slate-500 mt-1">不可变的管理员与身份验证日志记录。</p>
              </div>
              <button
                onClick={() => loadAuditLogs(true)}
                className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 p-2 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500"
                title="刷新日志数据"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {auditEntries.length === 0 && !auditLoading ? (
              <div className="bg-white p-12 text-center rounded-xl border border-slate-200">
                <p className="text-slate-400 font-medium">未记录任何日志。</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                        <th className="p-4">时间戳</th>
                        <th className="p-4">操作者</th>
                        <th className="p-4">操作</th>
                        <th className="p-4">目标</th>
                        <th className="p-4">IP 地址</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {auditEntries.map((entry) => (
                        <tr key={entry.id} className="hover:bg-slate-50">
                          <td className="p-4 text-slate-500 whitespace-nowrap">
                            <span className="flex items-center gap-1.5">
                              <Clock className="w-3.5 h-3.5 text-slate-400" />
                              {new Date(entry.at).toLocaleString()}
                            </span>
                          </td>
                          <td className="p-4">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase ${
                              entry.actor_kind === 'admin'
                                ? 'bg-indigo-50 text-indigo-700'
                                : entry.actor_kind === 'system'
                                ? 'bg-slate-100 text-slate-700'
                                : 'bg-slate-100 text-slate-800'
                            }`}>
                              {entry.actor_kind}
                            </span>
                            <span className="text-xs text-slate-500 font-mono block mt-0.5 truncate max-w-[120px]">
                              {entry.actor_id}
                            </span>
                          </td>
                          <td className="p-4 font-mono text-xs text-slate-700 font-bold">{entry.action}</td>
                          <td className="p-4">
                            {entry.target_kind ? (
                              <>
                                <span className="text-xs text-slate-600 font-medium block">{entry.target_kind}</span>
                                <span className="text-[10px] text-slate-400 font-mono block truncate max-w-[120px]">
                                  {entry.target_id}
                                </span>
                              </>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </td>
                          <td className="p-4 text-slate-600 font-mono text-xs">{entry.ip || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {auditCursor && (
                  <div className="flex justify-center pt-2">
                    <button
                      onClick={() => loadAuditLogs(false)}
                      disabled={auditLoading}
                      className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs py-2 px-4 rounded-lg font-semibold transition-colors focus:ring-2 focus:ring-indigo-500"
                    >
                      {auditLoading ? '正在加载更多日志...' : '加载更早的记录'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {selectedUser && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex justify-end z-50 animate-fade-in">
          <div className="bg-white w-full max-w-md h-full flex flex-col justify-between shadow-2xl border-l border-slate-200 animate-slide-in">
            <div className="p-6 overflow-y-auto flex-1 space-y-6">
              <div className="flex justify-between items-center pb-4 border-b border-slate-100">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 truncate">{selectedUser.username} 详情与元数据</h2>
                  <p className="text-xs text-slate-500 mt-0.5">管理已注册设备并查看同步元数据。</p>
                </div>
                <button
                  onClick={() => setSelectedUser(null)}
                  className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 transition-colors focus:outline-none"
                  aria-label="关闭面板"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
                  <Smartphone className="w-4 h-4 text-indigo-500" />
                  已注册设备 ({selectedUserDevices.length})
                </h3>
                {devicesLoading ? (
                  <div className="space-y-3">
                    {[1, 2].map((n) => (
                      <div key={n} className="h-16 w-full bg-slate-100 animate-pulse rounded-lg"></div>
                    ))}
                  </div>
                ) : selectedUserDevices.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-6 bg-slate-50 border border-dashed border-slate-200 rounded-lg">
                    未注册任何活跃设备。
                  </p>
                ) : (
                  <div className="space-y-3">
                    {selectedUserDevices.map((dev) => (
                      <div
                        key={dev.id}
                        className="border border-slate-200 rounded-xl p-4 flex justify-between items-center bg-slate-50"
                      >
                        <div className="min-w-0 pr-4">
                          <span className="font-semibold text-sm text-slate-800 flex items-center gap-1.5">
                            {dev.label}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono block mt-1 truncate">
                            ID：{dev.id}
                          </span>
                          <span className="text-[10px] text-slate-400 block mt-0.5">
                            添加时间：{new Date(dev.created_at).toLocaleDateString()}
                          </span>
                        </div>
                        <button
                          onClick={() => {
                            setConfirmAction({
                              type: 'revoke',
                              title: '撤销设备授权？',
                              message: `撤销 ${dev.label} 将立即终止其会话令牌。该设备在下一次同步请求时将被引导至锁定屏幕。`,
                              userId: selectedUser.id,
                              deviceId: dev.id
                            });
                          }}
                          className="border border-rose-200 hover:bg-rose-50 text-rose-600 font-semibold text-xs py-1.5 px-3 rounded-lg transition-colors focus:outline-none"
                        >
                          撤销
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-slate-100 pt-6 space-y-6">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                    <Shield className="w-4 h-4 text-indigo-500" />
                    服务端可见元数据 (不包含敏感密钥)
                  </div>
                  <p className="text-[10px] text-slate-400 leading-normal">
                    由于启用端到端加密，此处仅展示服务端同步所需的非敏感元数据。实际账户密码或 TOTP 密钥（secrets）已在客户端加密，服务端无权访问且不予展示。
                  </p>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 uppercase tracking-wider">
                    <Database className="w-3.5 h-3.5 text-indigo-500" />
                    关联账户 ({selectedUserAccounts.length})
                  </h4>
                  {accountsLoading ? (
                    <div className="space-y-3">
                      {[1, 2].map((n) => (
                        <div key={n} className="h-14 w-full bg-slate-100 animate-pulse rounded-lg"></div>
                      ))}
                    </div>
                  ) : selectedUserAccounts.length === 0 ? (
                    <p className="text-slate-400 text-xs text-center py-4 bg-slate-50 border border-dashed border-slate-200 rounded-lg">
                      无可见账户元数据。
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {selectedUserAccounts.map((acc) => (
                        <div key={acc.id} className="border border-slate-200 rounded-xl p-3 bg-slate-50 space-y-1.5 text-xs">
                          <div className="flex justify-between items-start gap-2">
                            <div className="min-w-0">
                              <span className="font-bold text-slate-800 text-sm block truncate">
                                {acc.display_name || '未命名账户'}
                              </span>
                              <span className="text-[11px] text-slate-500 block truncate">
                                {acc.platform} {acc.kind ? `(${acc.kind})` : ''}
                              </span>
                            </div>
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              acc.deleted ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'
                            }`}>
                              {acc.deleted ? '已删除' : (acc.status || '活跃')}
                            </span>
                          </div>

                          {acc.login_identifier && (
                            <div className="text-[11px] text-slate-600 bg-white px-2 py-1 rounded border border-slate-100 font-mono break-all">
                              登录标识: {maskLoginIdentifier(acc.login_identifier)}
                            </div>
                          )}

                          {renderTags(acc.tags_json)}
                          {renderMetadataSummary(acc.metadata_json)}

                          <div className="flex justify-between items-center text-[10px] text-slate-400 pt-1 border-t border-slate-100 font-mono">
                            <span>Seq: {acc.seq} | Rev: {acc.rev}</span>
                            <span>{new Date(acc.updated_at).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 uppercase tracking-wider">
                    <Activity className="w-3.5 h-3.5 text-indigo-500" />
                    关系图谱
                  </h4>
                  {relationsLoading || accountsLoading ? (
                    <div className="h-14 w-full bg-slate-100 animate-pulse rounded-lg"></div>
                  ) : (
                    <RelationGraph accounts={selectedUserAccounts} relations={selectedUserRelations} />
                  )}
                </div>

                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 uppercase tracking-wider">
                    <Link className="w-3.5 h-3.5 text-indigo-500" />
                    账户关系 ({selectedUserRelations.length})
                  </h4>
                  {relationsLoading ? (
                    <div className="space-y-3">
                      {[1, 2].map((n) => (
                        <div key={n} className="h-14 w-full bg-slate-100 animate-pulse rounded-lg"></div>
                      ))}
                    </div>
                  ) : selectedUserRelations.length === 0 ? (
                    <p className="text-slate-400 text-xs text-center py-4 bg-slate-50 border border-dashed border-slate-200 rounded-lg">
                      无可见关系元数据。
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {selectedUserRelations.map((rel) => (
                        <div key={rel.id} className="border border-slate-200 rounded-xl p-3 bg-slate-50 space-y-2 text-xs">
                          <div className="flex justify-between items-center">
                            <span className="font-bold text-slate-800">{rel.kind || '关联关系'}</span>
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              rel.deleted ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'
                            }`}>
                              {rel.deleted ? '已删除' : '活跃'}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-600 bg-white p-2 rounded border border-slate-100">
                            <div className="min-w-0">
                              <span className="text-slate-400 block uppercase tracking-wider text-[8px]">From ({rel.from_kind})</span>
                              <span className="font-mono break-all block">{rel.from_id}</span>
                            </div>
                            <div className="min-w-0">
                              <span className="text-slate-400 block uppercase tracking-wider text-[8px]">To ({rel.to_kind})</span>
                              <span className="font-mono break-all block">{rel.to_id}</span>
                            </div>
                          </div>

                          {renderMetadataSummary(rel.metadata_json)}

                          <div className="flex justify-between items-center text-[10px] text-slate-400 pt-1 border-t border-slate-100 font-mono">
                            <span>Seq: {rel.seq} | Rev: {rel.rev}</span>
                            <span>{new Date(rel.updated_at).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="bg-slate-50 p-6 border-t border-slate-100">
              <button
                onClick={() => setSelectedUser(null)}
                className="w-full bg-slate-800 hover:bg-slate-700 text-white font-semibold text-sm py-2 px-4 rounded-lg transition-colors focus:outline-none"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-[60] animate-fade-in">
          <div className="bg-white border border-slate-200 shadow-2xl rounded-2xl max-w-sm w-full p-6 space-y-4 animate-scale-in">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-rose-50 rounded-full flex items-center justify-center text-rose-600 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-slate-900">{confirmAction.title}</h3>
            </div>
            
            <p className="text-sm text-slate-600 leading-relaxed">{confirmAction.message}</p>
            
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setConfirmAction(null)}
                className="flex-1 border border-slate-200 text-slate-600 hover:bg-slate-50 py-2 rounded-lg text-sm font-semibold focus:outline-none"
              >
                取消
              </button>
              <button
                onClick={executeConfirmedAction}
                className="flex-1 bg-rose-600 hover:bg-rose-700 text-white py-2 rounded-lg text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-rose-500"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="fixed top-4 right-4 space-y-2 z-[70]">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-3 rounded-xl shadow-lg border text-sm font-semibold flex items-center gap-2 animate-fade-in ${
              t.type === 'success'
                ? 'bg-emerald-50 border-emerald-100 text-emerald-800'
                : t.type === 'error'
                ? 'bg-rose-50 border-rose-100 text-rose-800'
                : 'bg-indigo-50 border-indigo-100 text-indigo-800'
            }`}
          >
            {t.type === 'success' && <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />}
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
