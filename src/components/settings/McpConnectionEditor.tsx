import { useEffect, useRef, useState } from 'react';
import type { McpClientConnection, McpClientToolInfo } from '../../types/mcpClient';
import { useAppStore } from '../../store/useAppStore';
import { discoverMcpTools, sanitizeMcpText, saveMcpClientConnection } from '../../services/mcp/mcpClientService';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';

export default function McpConnectionEditor({ connection, onClose }: { connection: McpClientConnection; onClose: () => void }) {
  const [draft, setDraft] = useState(connection);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [tools, setTools] = useState<McpClientToolInfo[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const save = async (discover: boolean) => {
    setBusy(true); setError(''); setNotice('');
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      const current = useAppStore.getState().config.mcpClientConnections?.find((item) => item.id === draft.id);
      const endpointChanged = draft.url.trim() !== current?.url || draft.authHeader !== current?.authHeader || !!token.trim() || clearToken;
      if (endpointChanged) setTools([]);
      const next = { ...draft, enabled: discover ? true : draft.enabled, tools: endpointChanged ? {} : draft.tools };
      await saveMcpClientConnection(next, token, clearToken);
      if (controller.signal.aborted) return;
      const saved = useAppStore.getState().config.mcpClientConnections!.find((item) => item.id === draft.id)!;
      setDraft(saved); setToken(''); setClearToken(false);
      if (discover) {
        const catalog = await discoverMcpTools(saved.id, controller.signal);
        if (controller.signal.aborted) return;
        setTools(catalog);
        setNotice(`连接成功，发现 ${catalog.length} 个工具。请选择授权后保存；服务端只读提示不会自动授权。`);
      } else setNotice('已保存连接与工具授权');
    } catch (cause) {
      if (!controller.signal.aborted) {
        const current = useAppStore.getState().config.mcpClientConnections?.find((item) => item.id === draft.id);
        if (current) setDraft(current);
        setError(sanitizeMcpText(cause instanceof Error ? cause.message : '保存连接失败', 300));
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };

  const visibleTools = tools.filter((tool) => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <ModalOverlay isOpen onClose={onClose} ariaLabel="配置外部 MCP 连接" className="w-full max-w-2xl" zIndex={300}>
    <div className="flex max-h-[85vh] flex-col overflow-hidden rounded-xl border border-canvas-border bg-canvas-surface text-canvas-text">
      <div className="flex items-center justify-between gap-2 border-b border-canvas-border p-3">
        <h3 className="text-sm font-medium">外部 MCP 连接</h3>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onClose}>关闭</button>
      </div>
      <fieldset disabled={busy} className="min-h-0 space-y-3 overflow-y-auto p-3">
        <label className="ui-field"><span className="ui-label">连接名称</span>
          <input className="ui-input" value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：团队知识库" />
        </label>
        <label className="ui-field"><span className="ui-label">Streamable HTTP 地址</span>
          <input className="ui-input" type="url" value={draft.url} maxLength={2048} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" autoComplete="off" />
          <span className="text-xs text-canvas-text-muted">支持 HTTPS 或本机 HTTP。地址不能带密钥、查询参数或片段。</span>
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="ui-field"><span className="ui-label">认证方式</span>
            <Select value={draft.authHeader} onChange={(event) => setDraft({ ...draft, authHeader: event.target.value as McpClientConnection['authHeader'] })}>
              <option value="authorization">Bearer Token</option><option value="x-api-key">X-API-Key</option>
            </Select>
          </label>
          <label className="ui-field"><span className="ui-label">令牌（可留空）</span>
            <input className="ui-input" type="password" value={token} maxLength={8192} autoComplete="new-password" disabled={clearToken}
              onChange={(event) => setToken(event.target.value)} placeholder={draft.hasSecret ? '已保存；留空保留原令牌' : '无认证时留空'} />
          </label>
        </div>
        {draft.hasSecret && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={clearToken} onChange={(event) => { setClearToken(event.target.checked); setToken(''); }} />清除已保存的令牌</label>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />允许助手选择此连接</label>
        <div className="ui-alert ui-alert--warning text-xs">仅连接你信任的服务。工具参数会发送到该服务；外部写操作可能修改数据或产生费用。只读权限须由你确认。当前支持 Token 认证，OAuth 登录服务暂不支持。</div>
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => void save(true)}>保存并读取工具</button>
        {tools.length > 0 && <section className="space-y-2" aria-label="MCP 工具授权">
          <h4 className="text-sm font-medium">工具授权</h4>
          <input className="ui-input ui-input--sm" aria-label="搜索 MCP 工具" placeholder="搜索工具名称或说明" value={query} onChange={(event) => setQuery(event.target.value)} />
          <p className="text-xs text-canvas-text-muted">默认禁用。授权绑定当前说明与参数；定义变化后需重新授权。</p>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {visibleTools.map((tool) => {
              const grant = draft.tools[tool.name];
              const changed = !!grant && grant.fingerprint !== tool.fingerprint;
              return <div key={tool.name} className="rounded-md border border-canvas-border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-all text-sm font-medium">{tool.name}</span>
                  <Select aria-label={`${tool.name} 的授权`} value={changed ? 'disabled' : grant?.access ?? 'disabled'} onChange={(event) => {
                    const nextTools = new Map(Object.entries(draft.tools));
                    const access = event.target.value;
                    if (access === 'disabled') nextTools.delete(tool.name);
                    else nextTools.set(tool.name, { access: access as 'read' | 'write', fingerprint: tool.fingerprint });
                    setDraft({ ...draft, tools: Object.fromEntries(nextTools) });
                  }}>
                    <option value="disabled">禁用</option><option value="read">我确认为只读</option><option value="write">允许写操作</option>
                  </Select>
                </div>
                <p className="mt-1 break-words text-xs text-canvas-text-secondary">{sanitizeMcpText(tool.description, 500) || '服务未提供说明'}</p>
                {tool.readOnlyHint && <p className="mt-1 text-xs text-canvas-text-muted">服务标注：只读（仅供参考）</p>}
                {changed && <p className="mt-1 text-xs text-canvas-text-secondary">定义已变化，旧授权失效</p>}
                <details className="mt-1 text-xs"><summary className="cursor-pointer text-canvas-text-secondary">查看参数定义</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">{sanitizeMcpText(JSON.stringify(tool.inputSchema, null, 2), 16_000)}</pre></details>
              </div>;
            })}
            {visibleTools.length === 0 && <p className="text-xs text-canvas-text-muted">没有匹配的工具</p>}
          </div>
        </section>}
      </fieldset>
      <div className="space-y-2 border-t border-canvas-border p-3">
        {busy && <p role="status" className="text-xs text-canvas-text-secondary">正在保存或连接 MCP…</p>}
        {error && <p role="alert" className="text-xs text-canvas-text-secondary">{error}</p>}
        {notice && <p role="status" className="text-xs text-canvas-text-secondary">{notice}</p>}
        <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy} onClick={() => void save(false)}>保存连接与授权</button>
      </div>
    </div>
  </ModalOverlay>;
}
