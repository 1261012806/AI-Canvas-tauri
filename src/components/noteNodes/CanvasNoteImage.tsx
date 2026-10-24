/**
 * noteNodes/CanvasNoteImage — 画布笔记的图片渲染层。
 * 按笔记的圆角样式渲染嵌入图片，图片缺失时给出占位提示，不参与几何计算。
 */
import { memo } from 'react';
import { useT } from '../../i18n';
import type { CanvasNoteData } from '../../types';

interface CanvasNoteImageProps {
  note: CanvasNoteData;
  imageUrl?: string;
  label: string;
}

function CanvasNoteImage({ note, imageUrl, label }: CanvasNoteImageProps) {
  const t = useT();
  if (!imageUrl) {
    return <div className="canvas-note-image-missing">{t('图片不可用')}</div>;
  }
  return (
    <img
      className={`canvas-note-image canvas-note-image--${note.style.roundness}`}
      src={imageUrl}
      alt={label}
      draggable={false}
    />
  );
}

export default memo(CanvasNoteImage);
