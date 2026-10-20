import { lazy, Suspense, useState } from 'react';
import McpControlSettings from './McpControlSettings';

const McpClientSettings = lazy(() => import('./McpClientSettings'));

export default function McpSettings() {
  const [tab, setTab] = useState<'client' | 'control'>('client');
  return <div className="space-y-3">
    <div className="ui-segmented flex-wrap" aria-label="MCP 功能">
      <button type="button" className={`ui-segmented__item${tab === 'client' ? ' is-active' : ''}`} aria-pressed={tab === 'client'} onClick={() => setTab('client')}>助手连接外部服务</button>
      <button type="button" className={`ui-segmented__item${tab === 'control' ? ' is-active' : ''}`} aria-pressed={tab === 'control'} onClick={() => setTab('control')}>外部控制本应用</button>
    </div>
    {tab === 'control' ? <McpControlSettings /> : <Suspense fallback={<p role="status" className="text-sm text-canvas-text-secondary">正在加载连接设置…</p>}><McpClientSettings /></Suspense>}
  </div>;
}
