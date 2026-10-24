/**
 * character/characterReferencePresentation — 角色参考图与声音素材的展示辅助。
 * 提供参考图类别（主视觉/头像/全身/表情/转面/服装）与声音类别（音色/台词/情绪）的中文标签、
 * 裁剪矩形样式、声音片段标题与时长格式化等纯展示逻辑，供角色库与角色资产弹窗复用。
 */
import { t } from '../../i18n';
import type {
  CharacterCropRect,
  CharacterReferenceImage,
  CharacterVoiceClip,
} from '../../types/dramaAssets';

export const CHARACTER_REFERENCE_KIND_LABELS: Record<CharacterReferenceImage['kind'], string> = {
  primary: '主视觉',
  avatar: '头像',
  full_body: '全身',
  expression: '表情',
  turnaround: '转面',
  outfit: '服装',
  other: '其他',
};

export const CHARACTER_VOICE_KIND_LABELS: Record<CharacterVoiceClip['kind'], string> = {
  timbre: '音色参考',
  line: '台词样本',
  emotion: '情绪演绎',
  other: '其他',
};

/** 声音片段展示名：优先自定义名，其次用途标签 */
export function voiceClipTitle(clip: CharacterVoiceClip): string {
  return clip.label?.trim() || t(CHARACTER_VOICE_KIND_LABELS[clip.kind]);
}

export function formatVoiceDuration(durationSec?: number): string {
  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return '--:--';
  const total = Math.round(durationSec);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/** 头像框宽高比，裁切编辑器与角色条头像共用，保证裁出来的区域不会被拉伸 */
export const AVATAR_ASPECT = 9 / 11;

/**
 * zoom=1 时的归一化裁剪框：像素宽高比锁定为 AVATAR_ASPECT，并贴满图片的短边。
 * imageRatio 为图片自身的 宽/高。
 */
export function avatarCropBase(imageRatio: number) {
  const shape = AVATAR_ASPECT / imageRatio;
  return shape >= 1
    ? { baseWidth: 1, baseHeight: 1 / shape }
    : { baseWidth: shape, baseHeight: 1 };
}

export function cropImageStyle(crop?: CharacterCropRect) {
  if (!crop) return undefined;
  return {
    width: `${100 / crop.width}%`,
    height: `${100 / crop.height}%`,
    left: `${-crop.x / crop.width * 100}%`,
    top: `${-crop.y / crop.height * 100}%`,
  };
}
