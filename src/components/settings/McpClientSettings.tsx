import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { McpClientConnection } from '../../types/mcpClient';
import { removeMcpClientConnection, sanitizeMcpText, saveMcpClientConnection } from '../../services/mcp/mcpClientService';
import McpConnectionEditor from './McpConnectionEditor';

export default function McpClientSettings() {
  const connections = useAppStore((state) => state.config.mcpClientConnections);
  const hydrated = useAppStore((state) => state.configHydrated);
  const [editing, setEditing] = useState<McpClientConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (cause) { setError(sanitizeMcpText(cause instanceof Error ? cause.message : 'MCP 设置失败', 300)); }
    finally { setBusy(false); }
  };
  if (!('__TAURI_INTERNALS__' in window)) return <p className="text-sm text-canvas-text-secondary">外部 MCP 连接仅在 Tauri 桌面应用中可用。</p>;
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-medium">助手连接外部服务</h3><p className="mt-1 text-xs text-canvas-text-secondary">通用对话与画布助手共用连接；在输入框 MCP 菜单中为每个会话启用。</p></div>
      <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!hydrated || busy || (connections?.length ?? 0) >= 16} onClick={() => setEditing({ id: crypto.randomUUID(), name: '', url: '', enabled: true, revision: crypto.randomUUID(), authHeader: 'authorization', hasSecret: false, tools: {} })}>添加连接</button>
    </div>
    {error && <p role="alert" className="ui-alert ui-alert--warning text-xs">{error}</p>}
    {!connections?.length && <div className="rounded-md border border-canvas-border p-3 text-sm text-canvas-text-secondary">尚未添加连接。添加 MCP 地址、读取工具并授权后，助手即可按需调用。</div>}
    {connections?.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-canvas-border bg-canvas-card p-3">
      <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.name}</p><p className="mt-1 text-xs text-canvas-text-muted">{item.enabled ? '可供会话选择' : '已停用'} · {Object.keys(item.tools).length} 个授权工具 · {item.hasSecret ? '已保存认证' : '无认证'}</p></div>
      <div className="flex gap-1">
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={() => setEditing(item)}>配置</button>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => void run(() => saveMcpClientConnection({ ...item, enabled: !item.enabled }))}>{item.enabled ? '停用' : '启用'}</button>
        <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={busy} onClick={() => void run(() => removeMcpClientConnection(item.id))}>移除</button>
      </div>
    </div>)}
    {editing && <McpConnectionEditor key={editing.id} connection={editing} onClose={() => setEditing(null)} />}
  </div>;
}
