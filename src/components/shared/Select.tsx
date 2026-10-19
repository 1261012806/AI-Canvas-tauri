/**
 * Select — 统一风格的自定义下拉选择组件
 *
 * 视觉与 ui-kit 的 .ui-menu 保持一致：圆角卡片、暗色底、分组/悬停/选中态。
 * 底层保留隐藏的原生 <select>，用于表单提交和无 JS 回退。
 *
 * 支持普通选项与 optgroup 分组两种数据形式。
 * 尺寸不强制：通过 size prop 提供 sm/md/lg 三档，也可传 className / triggerClassName 完全自定义。
 */
import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { calcAnchoredPosition } from '../../utils/popupPosition';

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectOptionGroup<T extends string = string> {
  label: ReactNode;
  options: SelectOption<T>[];
}

export type SelectOptions<T extends string = string> = (SelectOption<T> | SelectOptionGroup<T>)[];

interface SelectProps<T extends string = string> extends Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'autoFocus' | 'onFocus' | 'onBlur' | 'onPointerDown' | 'onPointerUp' | 'onPointerCancel' | 'onKeyDown' | 'onKeyUp' | 'aria-describedby'> {
  value: T | number;
  onChange: (value: T) => void;
  options?: SelectOptions<T>;
  /** 也支持声明式 option/optgroup，复用动态选项和翻译，不渲染原生弹层。 */
  children?: ReactNode;
  required?: boolean;
  name?: string;
  'data-tooltip'?: string;
  placeholder?: string;
  disabled?: boolean;
  /** 尺寸；不指定时走 md（32px） */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** 单独控制触发器样式，用于覆盖默认高度/字号等 */
  triggerClassName?: string;
  /** 直接设置触发器内联样式，可精确覆盖高度等 */
  triggerStyle?: CSSProperties;
  id?: string;
  title?: string;
  'aria-label'?: string;
  /** 默认通过 Portal + fixed 定位避开父级裁剪；仅明确需要容器内菜单时设为 false。 */
  fixedMenu?: boolean;
  /** 自定义模式直接在当前控件内编辑，右侧按钮仍可选择预设。 */
  customInput?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    autoFocus?: boolean;
    onFocus?: () => void;
    onBlur?: () => void;
  };
}

function readOptions(children: ReactNode): SelectOptions {
  const result: SelectOptions = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; label?: string; disabled?: boolean }>(child)) return;
    if (child.type === Fragment) result.push(...readOptions(child.props.children));
    if (child.type === 'option') {
      const label = child.props.label ?? child.props.children;
      result.push({ value: String(child.props.value ?? optionLabelString(label)), label, disabled: child.props.disabled });
    }
    if (child.type === 'optgroup') {
      result.push({ label: child.props.label, options: readOptions(child.props.children).flatMap((item) => (
        isOptionGroup(item) ? item.options : [{ ...item, disabled: child.props.disabled || item.disabled }]
      )) });
    }
  });
  return result;
}

function isOptionGroup<T extends string>(
  item: SelectOption<T> | SelectOptionGroup<T>,
): item is SelectOptionGroup<T> {
  return 'options' in item && Array.isArray(item.options);
}

function optionLabelString(label: ReactNode): string {
  if (label === null || label === undefined) return '';
  if (typeof label === 'string' || typeof label === 'number' || typeof label === 'boolean') {
    return String(label);
  }
  if (Array.isArray(label)) return label.map(optionLabelString).join('');
  if (isValidElement<{ children?: ReactNode }>(label)) return optionLabelString(label.props.children);
  return '';
}

export default function Select<T extends string = string>({
  value,
  onChange,
  options,
  children,
  required,
  name,
  placeholder = '请选择',
  disabled = false,
  size = 'md',
  className = '',
  triggerClassName = '',
  triggerStyle,
  id,
  title,
  'aria-label': ariaLabel,
  fixedMenu = true,
  customInput,
  autoFocus,
  onFocus,
  onBlur,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
  onKeyUp,
  'aria-describedby': ariaDescribedBy,
  'data-tooltip': tooltip,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef(false);
  const customEditing = !!customInput;
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const resolvedOptions = options ?? readOptions(children) as SelectOptions<T>;
  const expanded = open && !disabled;
  if (disabled && open) setOpen(false);
  const stringValue = String(value);

  const flatOptions = resolvedOptions.flatMap((item) => (isOptionGroup(item) ? item.options : [item]));
  const selected = flatOptions.find((o) => o.value === stringValue) ?? (children ? flatOptions[0] : undefined);

  useLayoutEffect(() => {
    if (!expanded && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      (customEditing ? inputRef.current : triggerRef.current)?.focus({ preventScroll: true });
    }
  }, [expanded, customEditing]);

  useEffect(() => {
    if (disabled) return;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as Node;
      if (!wrapRef.current?.contains(target) && !menuRef.current?.contains(target)) return;
      if (customEditing && target === inputRef.current && !expanded) {
        if (event.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setOpen(true);
        } else if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          inputRef.current?.blur();
        }
        if (!['Tab', 'F12'].includes(event.key) && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')) {
          event.stopImmediatePropagation();
        }
        return;
      }
      if (!expanded) {
        if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          setOpen(true);
        } else if (!['Escape', 'Tab', 'F12'].includes(event.key) && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')) {
          // 控件聚焦时，删除、撤销和字母键不能落到画布快捷键。
          event.stopImmediatePropagation();
        }
        return;
      }
      if (event.key === 'Escape' || event.key === 'Tab') {
        setOpen(false);
        (customEditing ? inputRef.current : triggerRef.current)?.focus({ preventScroll: true });
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopImmediatePropagation();
        const active = document.activeElement as HTMLButtonElement | null;
        if (active && menuRef.current?.contains(active)) active.click();
        else { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); }
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.stopImmediatePropagation();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : index < 0 ? (event.key === 'ArrowUp' ? items.length - 1 : 0)
        : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
      items[next]?.scrollIntoView({ block: 'nearest' });
    };
    // 比父弹窗的 document 捕获监听更早处理 Escape，先关闭当前下拉。
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [disabled, expanded, customEditing]);

  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideTrigger = wrapRef.current?.contains(target) ?? false;
      const insideMenu = menuRef.current?.contains(target) ?? false;
      if (!insideTrigger && !insideMenu) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [expanded]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!expanded || !fixedMenu || !menu) {
      menu?.removeAttribute('style');
      return;
    }
    const updatePosition = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect || !menu) return;
      const availableHeight = Math.max(rect.top - 12, window.innerHeight - rect.bottom - 12, 0);
      menu.style.position = 'fixed';
      // Portal 不再继承触发器容器的样式；按菜单内容测量，再限制到视口内。
      menu.style.width = 'max-content';
      menu.style.minWidth = '0';
      menu.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
      menu.style.maxHeight = `${Math.min(320, availableHeight)}px`;
      let layer = 300;
      for (let parent = wrapRef.current; parent; parent = parent.parentElement as HTMLDivElement | null) {
        const zIndex = Number.parseInt(window.getComputedStyle(parent).zIndex, 10);
        if (Number.isFinite(zIndex)) layer = Math.max(layer, zIndex + 1);
      }
      menu.style.zIndex = String(layer);
      const position = calcAnchoredPosition(rect, menu.offsetWidth, menu.offsetHeight, 4);
      menu.style.top = `${position.top}px`;
      menu.style.left = `${position.left}px`;
    };
    updatePosition();
    const selectedOption = menu.querySelector<HTMLElement>('[aria-selected="true"]');
    if (selectedOption) {
      menu.scrollTop = Math.max(0, selectedOption.offsetTop - (menu.clientHeight - selectedOption.offsetHeight) / 2);
    }
    const observer = new ResizeObserver(updatePosition);
    observer.observe(menu);
    if (wrapRef.current) observer.observe(wrapRef.current);
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
      menu.removeAttribute('style');
    };
  }, [expanded, fixedMenu]);

  const sizeClass = size === 'sm' ? 'ui-select--sm' : size === 'lg' ? 'ui-select--lg' : '';
  const rootClass = `ui-select ui-select--custom nodrag nopan ${sizeClass} ${className}`.trim();
  const triggerClass = `ui-select__trigger ${triggerClassName}`.trim();

  const renderOption = (option: SelectOption<T>, key: string | number) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={stringValue === option.value}
      disabled={option.disabled}
      className={`ui-menu__item break-words${stringValue === option.value ? ' is-active' : ''}${option.disabled ? ' is-disabled' : ''}`}
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        restoreFocusRef.current = true;
        onChange(option.value);
        setInvalid(false);
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }}
    >
      {option.label}
    </button>
  );

  const menu = expanded ? (
    <div
      className="ui-menu overscroll-contain"
      role="listbox"
      id={menuId}
      aria-label={ariaLabel}
      ref={menuRef}
      data-ui-select-portal={fixedMenu ? '' : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {resolvedOptions.map((item, index) => {
        if (isOptionGroup(item)) {
          return (
            <div key={`group-${index}`}>
              <span className="ui-menu__label">{item.label}</span>
              {item.options.map((option, optIndex) => renderOption(option, `${index}-${optIndex}`))}
            </div>
          );
        }
        return renderOption(item, index);
      })}
    </div>
  ) : null;

  const trigger = (
      <button
        ref={triggerRef}
        id={customEditing ? undefined : id}
        type="button"
        className={customEditing ? 'ui-input-affix rounded-r-[var(--ui-radius-md)] hover:text-canvas-text' : triggerClass}
        style={customEditing ? undefined : triggerStyle}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? menuId : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
        data-tooltip={tooltip}
        autoFocus={customEditing ? undefined : autoFocus}
        onFocus={onFocus}
        onBlur={onBlur}
        onPointerDown={(event) => { event.stopPropagation(); onPointerDown?.(event); }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onKeyUp={onKeyUp}
        disabled={disabled}
        onClick={(event) => { event.stopPropagation(); setOpen((v) => !v); }}
      >
        {!customEditing && <span className="ui-select__trigger-text">{selected?.label ?? placeholder}</span>}
        <svg
          className="ui-select__chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
  );

  return (
    <div className={rootClass} ref={wrapRef} title={title}>
      {customInput ? (
        <div className={`ui-input-group w-full ${size === 'sm' ? 'h-[var(--ui-control-h-sm)]' : size === 'lg' ? 'h-[var(--ui-control-h-lg)]' : 'h-[var(--ui-control-h)]'} ${disabled ? 'opacity-45' : ''}`} style={triggerStyle}>
          <input ref={inputRef} id={id} type="text" role="combobox"
            className={`ui-input h-full min-w-0 flex-1 ${size === 'sm' ? 'ui-input--sm' : size === 'lg' ? 'ui-input--lg' : ''}`}
            value={customInput.value} placeholder={customInput.placeholder ?? placeholder}
            disabled={disabled} autoFocus={customInput.autoFocus ?? autoFocus}
            aria-label={ariaLabel} aria-expanded={expanded} aria-controls={expanded ? menuId : undefined}
            aria-haspopup="listbox" aria-autocomplete="none" aria-describedby={ariaDescribedBy}
            onChange={(event) => customInput.onChange(event.target.value)}
            onFocus={() => customInput.onFocus?.()} onBlur={() => customInput.onBlur?.()}
            onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
          />
          {trigger}
        </div>
      ) : trigger}
      <select
        className="ui-select__native"
        value={stringValue}
        name={name}
        required={required}
        disabled={disabled}
        onInvalid={(event) => {
          event.preventDefault();
          setInvalid(true);
          triggerRef.current?.focus();
        }}
        onChange={(e) => { setInvalid(false); onChange(e.target.value as T); }}
        tabIndex={-1}
        aria-hidden="true"
      >
        {resolvedOptions.map((item, index) => {
          if (isOptionGroup(item)) {
            return (
              <optgroup key={`group-${index}`} label={optionLabelString(item.label)}>
                {item.options.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>
                    {optionLabelString(o.label)}
                  </option>
                ))}
              </optgroup>
            );
          }
          return (
            <option key={item.value} value={item.value} disabled={item.disabled}>
              {optionLabelString(item.label)}
            </option>
          );
        })}
      </select>
      {fixedMenu ? (menu ? createPortal(menu, document.body) : null) : menu}
    </div>
  );
}
