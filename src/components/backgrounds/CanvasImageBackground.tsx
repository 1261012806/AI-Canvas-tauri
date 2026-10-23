import type { AppearanceCanvasConfig } from '../../types';
import { resolveThemeImageSource } from '../../services/fs/themeAssets';

/** 图片、滤镜与蒙版独立分层，供画布及外观预览共用。 */
export default function CanvasImageBackground({ canvas, className = '', baseColor }: {
  canvas: Partial<AppearanceCanvasConfig>;
  className?: string;
  baseColor?: string;
}) {
  const imageSource = resolveThemeImageSource(canvas.imageDataUrl);
  const blur = canvas.imageBlur ?? 0;
  const brightness = canvas.imageBrightness ?? 1;
  const contrast = canvas.imageContrast ?? 1;
  const saturation = canvas.imageSaturation ?? 1;
  const filtered = blur !== 0 || brightness !== 1 || contrast !== 1 || saturation !== 1;
  const overlayOpacity = canvas.imageOverlayOpacity ?? 0;

  return (
    <span className={`absolute inset-0 overflow-hidden pointer-events-none ${className}`}
      style={{ backgroundColor: baseColor }} aria-hidden="true">
      {imageSource && <>
        <span className="absolute inset-0 bg-no-repeat" style={{
          backgroundImage: `url("${imageSource}")`,
          backgroundSize: canvas.imageFit === 'fill' ? '100% 100%' : canvas.imageFit ?? 'cover',
          backgroundPosition: canvas.imagePosition ?? 'center',
          opacity: canvas.imageOpacity ?? 1,
          filter: filtered ? `blur(${blur}px) brightness(${brightness}) contrast(${contrast}) saturate(${saturation})` : undefined,
        }} />
        {overlayOpacity > 0 && <span className="absolute inset-0" style={{
          backgroundColor: canvas.imageOverlayColor,
          opacity: overlayOpacity,
        }} />}
      </>}
    </span>
  );
}
