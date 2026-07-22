import React from 'react';
import type { RemoteConfig } from './utils/sync-config';

export interface RemoteReLoginPanelProps {
  readonly config: RemoteConfig;
  readonly reLoginPassword: string;
  readonly onPasswordChange: (value: string) => void;
  readonly isSyncing: boolean;
  readonly onSubmit: (e: React.FormEvent) => void;
  readonly onDisconnect: () => void;
  readonly onReconnect: () => void;
}

export const RemoteReLoginPanel: React.FC<RemoteReLoginPanelProps> = ({
  config,
  reLoginPassword,
  onPasswordChange,
  isSyncing,
  onSubmit,
  onDisconnect,
  onReconnect,
}) => {
  const isRevoked = config.reauthReason === 'device_revoked';

  if (isRevoked) {
    return (
      <div className="bg-slate-900/40 backdrop-blur-md border border-slate-800/80 rounded-2xl p-4 space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="text-xs font-semibold text-rose-400">同步设备已被撤销</h3>
          <button
            type="button"
            onClick={onDisconnect}
            className="min-h-[44px] min-w-[44px] flex items-center justify-end rounded-sm text-[10px] text-rose-400 hover:underline hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            断开连接
          </button>
        </div>
        <p className="text-[10px] text-slate-400 leading-normal">
          需要重新连接以注册新设备，本地保管库不会受影响
        </p>
        <div className="text-[11px] text-slate-400 space-y-1.5 bg-slate-900/30 p-2.5 rounded-xl border border-slate-800/50">
          <div className="flex justify-between">
            <span>服务器：</span>
            <span className="font-mono truncate max-w-[180px] text-slate-200">{config.baseUrl}</span>
          </div>
          <div className="flex justify-between">
            <span>用户名：</span>
            <span className="font-mono text-slate-200">{config.username}</span>
          </div>
          <div className="flex justify-between">
            <span>设备标签：</span>
            <span className="text-slate-200">{config.deviceLabel}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onReconnect}
          className="w-full min-h-[44px] bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white font-medium text-xs py-2.5 px-4 rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
        >
          重新连接设备
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="bg-slate-900/40 backdrop-blur-md border border-slate-800/80 rounded-2xl p-4 space-y-3">
      <div className="flex justify-between items-center">
        <h3 className="text-xs font-semibold text-rose-400">同步服务器登录已过期</h3>
        <button
          type="button"
          onClick={onDisconnect}
          className="min-h-[44px] min-w-[44px] flex items-center justify-end rounded-sm text-[10px] text-rose-400 hover:underline hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
        >
          断开连接
        </button>
      </div>
      <p className="text-[10px] text-slate-400 leading-normal">
        重新登录后将继续同步，本地保管库不会受影响
      </p>
      <div className="text-[11px] text-slate-400 space-y-1.5 bg-slate-900/30 p-2.5 rounded-xl border border-slate-800/50">
        <div className="flex justify-between">
          <span>服务器：</span>
          <span className="font-mono truncate max-w-[180px] text-slate-200">{config.baseUrl}</span>
        </div>
        <div className="flex justify-between">
          <span>用户名：</span>
          <span className="font-mono text-slate-200">{config.username}</span>
        </div>
        <div className="flex justify-between">
          <span>设备标签：</span>
          <span className="text-slate-200">{config.deviceLabel}</span>
        </div>
      </div>
      <div>
        <label htmlFor="re-login-password" className="block text-[10px] font-semibold text-slate-400 mb-1">
          账户密码
        </label>
        <input
          id="re-login-password"
          type="password"
          value={reLoginPassword}
          onChange={(e) => onPasswordChange(e.target.value)}
          autoComplete="current-password"
          className="w-full px-3 py-1.5 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
          required
        />
      </div>
      <button
        type="submit"
        disabled={isSyncing}
        className="w-full min-h-[44px] bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 disabled:from-rose-600/50 disabled:to-pink-600/50 text-white font-medium text-xs py-2.5 px-4 rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
      >
        {isSyncing ? '登录中...' : '重新登录'}
      </button>
    </form>
  );
};
