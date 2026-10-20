import { useState } from 'react';
import type { McpClientOption } from '../../types/mcpClient';
import ModalOverlay from '../shared/ModalOverlay';

export default function McpConnectionPicker({ options, selected, onToggle, onSettings, disabled }: {
  options: McpClientOption[]; selected: string[];
  onToggle: (id: string, enabled: boolean) => void; onSettings: () => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = options.filter((item) => selected.includes(item.id)).length;
  return <>
    <button type="button" className={`ui-btn ui-btn--ghost ui-btn--sm${count ? ' is-active' : ''}`} disabled={disabled} onClick={() => setOpen(true)} aria-label={`选择本会话 MCP 连接，已启用 ${count} 个`} title="为本会话选择外部 MCP 服务">MCP{count ? ` ${count}` : ''}</button>
    <ModalOverlay isOpen={open} onClose={() => setOpen(false)} ariaLabel="本会话 MCP 连接" className="w-full max-w-sm" zIndex={300}>
      <div className="space-y-3 rounded-xl border border-canvas-border bg-canvas-surface p-3 text-canvas-text">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">本会话 MCP 连接</h3><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setOpen(false)}>完成</button></div>
        <p className="text-xs text-canvas-text-secondary">只向模型提供本会话勾选的服务；工具权限在连接设置中管理。</p>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {options.map((item) => <label key={item.id} className="flex items-center gap-2 rounded-md border border-canvas-border p-2 text-sm">
            <input type="checkbox" checked={selected.includes(item.id)} disabled={disabled || (item.toolCount === 0 && !selected.includes(item.id))} onChange={(event) => onToggle(item.id, event.target.checked)} />
            <span className="min-w-0 flex-1 break-words">{item.name}<span className="block text-xs text-canvas-text-muted">{item.toolCount ? `${item.toolCount} 个已授权工具` : '请先在设置中授权工具'}</span></span>
          </label>)}
          {options.length === 0 && <p className="text-sm text-canvas-text-muted">尚无可用连接，请先添加 MCP 地址。</p>}
        </div>
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => { setOpen(false); onSettings(); }}>管理 MCP 连接</button>
      </div>
    </ModalOverlay>
  </>;
}
