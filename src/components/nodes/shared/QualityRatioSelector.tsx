/**
 * QualityRatioSelector — 图像分辨率、生成质量和宽高比选择器
 */
import { useState, useRef, useEffect } from 'react';
import AnimatedButton from '../../shared/AnimatedButton';
import { useT } from '../../../i18n';

interface RatioOption {
  value: string;
  className: string;
}

interface QualityRatioSelectorProps {
  imageSize?: string;
  imageQuality?: string;
  imageQualities?: readonly string[];
  defaultImageQuality?: string;
  imageBackground?: string;
  imageBackgrounds?: readonly string[];
  defaultImageBackground?: string;
  imageBackgroundIsFixed?: boolean;
  aspectRatio?: string;
  onChangeImageSize?: (size: string) => void;
  onChangeImageQuality?: (quality: string | undefined) => void;
  onChangeImageBackground?: (background: string | undefined) => void;
  onChangeAspectRatio: (ratio: string) => void;
  /** 是否显示分辨率选择区，默认 true */
  showImageSize?: boolean;
  /** 是否显示"自适应"选项，默认 true */
  showAdaptive?: boolean;
  /** 自定义比例选项列表，不传则使用默认 */
  ratios?: RatioOption[];
  /** 自定义分辨率档位，不传则使用通用档位 */
  imageSizes?: readonly string[];
  /** 弹出方向：'top'(默认，向上，适合底部工具栏) | 'bottom'(向下，适合顶部工具栏) */
  placement?: 'top' | 'bottom';
}

export default function QualityRatioSelector({
  imageSize = '1K',
  imageQuality,
  imageQualities,
  defaultImageQuality,
  imageBackground,
  imageBackgrounds,
  defaultImageBackground,
  imageBackgroundIsFixed,
  aspectRatio = '16:9',
  onChangeImageSize,
  onChangeImageQuality,
  onChangeImageBackground,
  onChangeAspectRatio,
  showImageSize = true,
  showAdaptive = true,
  ratios: customRatios,
  imageSizes = ['720p', '1K', '2K', '4K'],
  placement = 'top',
}: QualityRatioSelectorProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close popup on outside click (capture phase to beat React Flow event interception)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handler, true);
    }
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open]);

  // Close popup on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    if (open) {
      window.addEventListener('keydown', handler);
    }
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  const DEFAULT_RATIOS: RatioOption[] = [
    { value: '1:1', className: 'img-rp-sq' },
    { value: '9:16', className: 'img-rp-tall' },
    { value: '16:9', className: 'img-rp-wide' },
    { value: '3:4', className: 'img-rp-p34' },
    { value: '4:3', className: 'img-rp-l43' },
    { value: '3:2', className: 'img-rp-l32' },
    { value: '2:3', className: 'img-rp-p23' },
    { value: '5:4', className: 'img-rp-l54' },
    { value: '4:5', className: 'img-rp-p45' },
    { value: '21:9', className: 'img-rp-ultra' },
    { value: '1:4', className: 'img-rp-p14' },
    { value: '4:1', className: 'img-rp-l41' },
    { value: '1:6', className: 'img-rp-p16' },
    { value: '6:1', className: 'img-rp-l61' },
    { value: '1:8', className: 'img-rp-p18' },
    { value: '8:1', className: 'img-rp-l81' },
  ];

  const ratios = customRatios || DEFAULT_RATIOS;
  const selectedQuality = imageQualities?.find((quality) => quality.toLowerCase() === imageQuality?.toLowerCase())
    ?? imageQualities?.find((quality) => quality.toLowerCase() === defaultImageQuality?.toLowerCase());
  const backgroundDefault = imageBackgrounds?.find((background) => background.toLowerCase() === defaultImageBackground?.toLowerCase());
  const fixedBackground = imageBackgroundIsFixed === true && backgroundDefault !== undefined;
  const selectedBackground = fixedBackground ? backgroundDefault : imageBackground === '' ? undefined
    : imageBackgrounds?.find((background) => background.toLowerCase() === imageBackground?.toLowerCase()) ?? backgroundDefault;
  const backgroundLabels: Record<string, string> = { auto: t('自动'), transparent: t('透明'), opaque: t('不透明') };
  const backgroundSummaries: Record<string, string> = { auto: t('自动背景'), transparent: t('透明背景'), opaque: t('不透明背景') };
  const summary = [aspectRatio, showImageSize ? imageSize : undefined, selectedQuality,
    selectedBackground ? backgroundSummaries[selectedBackground] ?? selectedBackground : undefined].filter(Boolean).join(' · ');

  return (
    <div className="ui-schema-renderer" data-ui-schema-model="apimart/gemini-3.1-flash-image-preview" data-ui-schema-placement="resolution" ref={ref}>
      <div className="ui-schema-quality-ratio-pill" data-ui-schema-composite-field="qualityRatio">
        <AnimatedButton
          type="button"
          className="img-pill-btn ui-schema-menu-trigger"
          data-ui-schema-menu-trigger="qualityRatio"
          aria-label={summary}
          aria-expanded={open}
          title={summary}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" />
            <path d="M9 21V9" />
          </svg>
          <span className="ui-schema-pill-label ui-schema-quality-ratio-label">
            {summary}
          </span>
        </AnimatedButton>

        {open && (
          <div className={`img-ratio-popup ui-schema-popup ui-schema-quality-ratio-popup${placement === 'bottom' ? ' img-ratio-popup--down' : ''}`}>
            {showImageSize && (
              <div className="img-rp-quality-area" data-ui-schema-field="imageSize" data-ui-schema-type="segmented" data-ui-schema-default="2K">
                <div className="img-rp-section-label">{t('分辨率')}</div>
                <div className="ui-segmented ui-segmented--brand" role="group" aria-label={t('分辨率')}>
                  {imageSizes.map((size) => (
                    <AnimatedButton
                      key={size}
                      type="button"
                      className={`ui-segmented__item ui-schema-option${imageSize.toLowerCase() === size.toLowerCase() ? ' is-active' : ''}`}
                      aria-pressed={imageSize.toLowerCase() === size.toLowerCase()}
                      data-ui-schema-value={size}
                      data-ui-schema-option-label={size}
                      onClick={() => onChangeImageSize?.(size)}
                    >
                      {size}
                    </AnimatedButton>
                  ))}
                </div>
              </div>
            )}

            {!!imageQualities?.length && (
              <div data-ui-schema-field="imageQuality" data-ui-schema-type="segmented" data-ui-schema-default={defaultImageQuality}>
                <div className="img-rp-section-label">{t('生成质量')}</div>
                <div className="ui-segmented ui-segmented--brand" role="group" aria-label={t('生成质量')}>
                  {imageQualities.map((quality) => (
                    <AnimatedButton
                      key={quality}
                      type="button"
                      className={`ui-segmented__item ui-schema-option${selectedQuality === quality ? ' is-active' : ''}`}
                      aria-pressed={selectedQuality === quality}
                      data-ui-schema-value={quality}
                      data-ui-schema-option-label={quality}
                      onClick={() => onChangeImageQuality?.(quality)}
                    >
                      {quality}
                    </AnimatedButton>
                  ))}
                </div>
              </div>
            )}

            {!!imageBackgrounds?.length && (
              <div data-ui-schema-field="imageBackground" data-ui-schema-type="segmented" data-ui-schema-default={defaultImageBackground}>
                <div className="img-rp-section-label">{t('生成背景')}</div>
                <div className="ui-segmented ui-segmented--brand" role="group" aria-label={t('生成背景')}>
                  {(!fixedBackground ? ['', ...imageBackgrounds] : imageBackgrounds).map((background) => (
                    <AnimatedButton
                      key={background}
                      type="button"
                      className={`ui-segmented__item ui-schema-option${(selectedBackground ?? '') === background ? ' is-active' : ''}`}
                      aria-pressed={(selectedBackground ?? '') === background}
                      data-ui-schema-value={background}
                      data-ui-schema-option-label={background ? backgroundLabels[background] ?? background : t('接口默认')}
                      onClick={() => onChangeImageBackground?.(background)}
                    >
                      {background ? backgroundLabels[background] ?? background : t('接口默认')}
                    </AnimatedButton>
                  ))}
                </div>
              </div>
            )}

            <div className="img-rp-ratio-area" data-ui-schema-field="aspectRatio" data-ui-schema-type="segmented" data-ui-schema-default={showAdaptive ? '自适应' : '16:9'}>
              <div className="img-rp-section-label">{t('比例')}</div>
              <div className={`img-rp-ratio-split${showAdaptive ? ' has-adaptive' : ''}`}>
                {showAdaptive && (
                  <div className="img-rp-ratio-left">
                    <AnimatedButton
                      type="button"
                      className={`img-rp-large-adaptive ui-schema-option ${aspectRatio === '自适应' ? 'active' : ''}`}
                      data-label="自适应"
                      data-ui-schema-value="自适应"
                      onClick={() => onChangeAspectRatio('自适应')}
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <path d="M3 9h18" />
                        <path d="M9 21V9" />
                      </svg>
                      <span>{t('自适应')}</span>
                    </AnimatedButton>
                  </div>
                )}
                <div className="img-rp-ratio-right">
                  {ratios.map((r) => (
                    <AnimatedButton
                      key={r.value}
                      type="button"
                      className={`img-rp-ratio-item ui-schema-option ${aspectRatio === r.value ? 'active' : ''}`}
                      data-label={r.value}
                      data-ui-schema-value={r.value}
                      onClick={() => onChangeAspectRatio(r.value)}
                    >
                      <span className={`img-rp-icon ${r.className}`}></span>
                      <span>{r.value}</span>
                    </AnimatedButton>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
