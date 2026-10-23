import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import type { AppearanceCanvasPanelId, AppearanceTheme } from '../../types';
import { installSystemAppearanceListener, resolveAppearanceMode, resolveAppearanceTheme } from '../../services/appearance/appearanceRuntime';
import CanvasImageBackground from '../backgrounds/CanvasImageBackground';
import { useT } from '../../i18n';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';

export type AppearanceLayoutTarget = AppearanceCanvasPanelId | 'canvas' | 'surface' | 'node' | 'background' | 'card' | 'hover' | 'border';

const subscribeSystemMode = (onChange: () => void) => installSystemAppearanceListener(onChange);
const getSystemMode = () => resolveAppearanceMode('system');
const getServerMode = () => 'dark' as const;

function PreviewRegion({ label, className = '', onClick, children }: {
  label: string;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <button type="button" className={`appearance-layout__region ${className}`}
      aria-label={t('设置{region}外观', { region: label })} aria-haspopup="dialog" title={label} onClick={onClick}>
      {children}
    </button>
  );
}

function PreviewIcons({ icons }: { icons: readonly string[] }) {
  return <>{icons.map((icon) => <Icon key={icon} icon={icon} width="15" aria-hidden="true" />)}</>;
}

export default function AppearanceLayoutPreview({ theme, disabled, renderControls }: {
  theme: AppearanceTheme;
  disabled: boolean;
  renderControls: (target: AppearanceLayoutTarget) => ReactNode;
}) {
  const t = useT();
  useSyncExternalStore(subscribeSystemMode, getSystemMode, getServerMode);
  const [selection, setSelection] = useState<{ target: AppearanceLayoutTarget; label: string } | null>(null);
  const resolved = resolveAppearanceTheme(theme);
  const { canvas } = resolved;
  const previewStyle = {
    '--layout-canvas-color': canvas.color,
    '--layout-grid-color': canvas.gridColor,
    '--layout-grid-size': `${Math.max(8, canvas.gridSize / 2)}px`,
  } as CSSProperties;
  const select = (target: AppearanceLayoutTarget, label: string) => setSelection({ target, label });
  const surfaceHint = t('小地图、操作记录和弹窗共用窗口背景。');

  return (
    <div className="ui-stack" data-purpose="appearance-layout-preview">
      <div className="ui-row ui-row--between">
        <p className="ui-hint">{t('点击画布或悬浮面板，设置对应的颜色与背景图片。')}</p>
        <span className="ui-badge ui-badge--outline shrink-0">{t('实时预览')}</span>
      </div>
      <div className="appearance-layout" style={previewStyle} data-background={canvas.kind}>
        <PreviewRegion label={t('画布背景')} className="appearance-layout__canvas" onClick={() => select('canvas', t('画布背景'))}>
          {canvas.kind === 'image' && <CanvasImageBackground canvas={canvas} baseColor={canvas.color} />}
          {canvas.kind === 'solar-system' && <span className="solar-stars absolute inset-0" />}
          {canvas.kind === 'frosted-glass' && <span className="canvas-bg-frosted-preview absolute inset-0" />}
          {canvas.gridVisible && <span className="appearance-layout__grid" />}
          <span className="appearance-layout__empty">
            <Icon icon="mingcute:ai-fill" width="34" aria-hidden="true" />
            <span className="font-semibold">AI Canvas</span>
            <span className="text-[11px]">{t('点击设置画布背景')}</span>
          </span>
        </PreviewRegion>
        <PreviewRegion label={t('项目栏')} className="appearance-layout__surface appearance-layout__projects"
          onClick={() => select('projectBar', t('项目栏'))}>
          <Icon icon="mingcute:ai-fill" width="17" className="text-brand" aria-hidden="true" />
          <span className="font-semibold">AI Canvas</span><span className="appearance-layout__divider" />
          <span>{t('空白')}</span><Icon icon="lucide:plus" width="13" aria-hidden="true" />
        </PreviewRegion>
        <PreviewRegion label={t('左侧工具栏')} className="appearance-layout__surface appearance-layout__sidebar"
          onClick={() => select('sidebar', t('左侧工具栏'))}>
          <Icon icon="lucide:plus" width="18" className="text-brand" aria-hidden="true" />
          <PreviewIcons icons={['lucide:grip', 'lucide:folder', 'lucide:contact-round', 'lucide:briefcase-business', 'lucide:settings']} />
        </PreviewRegion>
        <PreviewRegion label={t('节点底色')} className="appearance-layout__node" onClick={() => select('node', t('节点底色'))}>
          <span className="flex items-center gap-1.5 font-medium"><Icon icon="lucide:image" width="13" aria-hidden="true" />{t('生成图像')}</span>
          <span className="appearance-layout__node-content"><Icon icon="lucide:image-plus" width="20" aria-hidden="true" /></span>
          <span className="text-[10px] text-canvas-text-muted">{t('点击设置节点底色')}</span>
        </PreviewRegion>
        <PreviewRegion label={t('小地图')} className="appearance-layout__surface appearance-layout__minimap"
          onClick={() => select('surface', t('小地图'))}>
          <span className="appearance-layout__minimap-viewport" />
        </PreviewRegion>
        <PreviewRegion label={t('绘图工具栏')} className="appearance-layout__surface appearance-layout__drawing"
          onClick={() => select('drawingToolbar', t('绘图工具栏'))}>
          <PreviewIcons icons={['lucide:mouse-pointer-2', 'lucide:square', 'lucide:diamond', 'lucide:circle', 'lucide:arrow-right', 'lucide:pencil', 'lucide:type', 'lucide:image']} />
        </PreviewRegion>
        <PreviewRegion label={t('画布控制栏')} className="appearance-layout__surface appearance-layout__viewport"
          onClick={() => select('viewportToolbar', t('画布控制栏'))}>
          <PreviewIcons icons={['lucide:grid-3x3', 'lucide:scan', 'lucide:minus']} /><span>100%</span>
          <PreviewIcons icons={['lucide:plus', 'lucide:lock-keyhole']} />
        </PreviewRegion>
      </div>
      <div className="flex flex-wrap gap-2" aria-label={t('界面配色区域')}>
        {([
          ['background', '页面背景', 'bg-canvas-bg'],
          ['surface', '窗口 / 弹窗背景', 'bg-canvas-surface'],
          ['card', '组件底色', 'bg-canvas-card'],
          ['hover', '组件悬浮底色', 'bg-canvas-hover'],
          ['border', '组件边框', 'bg-canvas-border'],
        ] as const).map(([target, label, colorClass]) => (
          <button key={target} type="button" className="ui-btn ui-btn--sm" aria-haspopup="dialog"
            onClick={() => select(target, t(label))}>
            <span className={`h-3 w-3 shrink-0 rounded border border-canvas-border ${colorClass}`} aria-hidden="true" />{t(label)}
          </button>
        ))}
      </div>
      <p className="ui-hint">{t('预览跟随当前明暗主题，修改后自动保存。')}</p>
      <ModalOverlay isOpen={selection !== null} onClose={() => setSelection(null)}
        ariaLabel={selection ? t('设置{region}外观', { region: selection.label }) : t('区域外观')}
        className="w-[min(360px,calc(100vw-24px))] max-h-[80vh]" zIndex={320} motionPreset="quick" backdropBlur={false}>
        <div className="ui-card__header shrink-0">
          <h3 className="ui-card__title flex-1">{selection?.label}</h3>
          <PopupCloseButton ariaLabel={t('关闭区域外观设置')} onClick={() => setSelection(null)} />
        </div>
        <div className="overflow-y-auto p-3">
          <fieldset disabled={disabled} className="m-0 min-w-0 space-y-3 border-0 p-0">
            <p className="ui-hint">{selection?.target === 'surface' ? surfaceHint : selection?.target === 'node'
              ? t('所有节点共用这套底色和背景图片。') : t('修改后立即应用，并自动保存到当前外观。')}</p>
            {selection && renderControls(selection.target)}
          </fieldset>
        </div>
      </ModalOverlay>
    </div>
  );
}
