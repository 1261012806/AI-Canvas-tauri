import { useState } from 'react';
import { useT } from '../../i18n';
import NumberStepper from '../shared/NumberStepper';
import Select from '../shared/Select';

/** 使用真实公用控件，展示内部组件配色在不同状态下的效果。 */
export default function AppearanceComponentPreview() {
  const t = useT();
  const [selected, setSelected] = useState('card');
  const [count, setCount] = useState(12);
  return (
    <div className="ui-stack mt-3" aria-label={t('内部组件配色预览')}>
      <div className="ui-row ui-row--between">
        <span className="ui-label">{t('实时预览')}</span>
        <span className="ui-hint">{t('仅用于预览，不修改其他设置。')}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="ui-card p-3 gap-2">
          <span className="ui-label">{t('普通卡片')}</span>
          <span className="ui-hint">{t('设置卡片与列表共用组件底色。')}</span>
        </div>
        <div className="rounded-xl border border-canvas-border bg-canvas-hover p-3 ui-stack">
          <span className="ui-label">{t('悬浮状态')}</span>
          <span className="ui-hint">{t('鼠标经过组件时使用悬浮底色。')}</span>
        </div>
      </div>
      <div className="ui-segmented self-start" role="group" aria-label={t('分段选项预览')}>
        {([['card', '卡片'], ['list', '列表'], ['option', '选项']] as const).map(([value, label]) => (
          <button key={value} type="button" className={`ui-segmented__item ${selected === value ? 'is-active' : ''}`}
            aria-pressed={selected === value} onClick={() => setSelected(value)}>{t(label)}</button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input className="ui-input" readOnly value={t('输入框预览')} aria-label={t('输入框预览')} />
        <div className="ui-row">
          <Select aria-label={t('下拉选项预览')} value={selected} onChange={setSelected} className="flex-1 min-w-0">
            <option value="card">{t('卡片')}</option>
            <option value="list">{t('列表')}</option>
            <option value="option">{t('选项')}</option>
          </Select>
          <NumberStepper value={count} onChange={setCount} min={0} max={100} size="sm" aria-label={t('数字输入预览')} />
        </div>
      </div>
    </div>
  );
}
