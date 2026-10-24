import { getLocale, t } from '../i18n';
import { findVideoHistoryByReferences, type HistoryRecord } from './indexedDbService';

/** 完整路径或媒体地址的只读查询；不根据同名文件推断来源。 */
export function loadAssetVideoHistory(filePath?: string, src?: string, projectId?: string, signal?: AbortSignal): Promise<HistoryRecord | null> {
  return findVideoHistoryByReferences([filePath, src].filter((value): value is string => !!value), projectId, signal);
}

const VIDEO_PARAMETERS: ReadonlyArray<readonly [string, string]> = [
  ['seedanceResolution', '请求分辨率'], ['seedanceRatio', '请求宽高比'], ['seedanceDuration', '请求时长'],
  ['videoResolution', '视频分辨率'], ['videoFps', '视频帧率'], ['videoFrames', '视频帧数'], ['generateAudio', '生成音频'],
  ['resolution', '生成分辨率'], ['aspectRatio', '宽高比'], ['duration', '生成时长'],
  ['fps', '帧率'], ['seed', '随机种子'], ['quality', '质量'], ['negativePrompt', '反向提示词'],
];

/** 仅展示已保存的白名单参数，不展示路径、凭据或任意嵌套对象。 */
export function describeAssetVideoHistory(history: HistoryRecord): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (history.model) rows.push({ label: '模型', value: history.model });
  if (history.provider) rows.push({ label: '供应商', value: history.provider });
  for (const [key, label] of VIDEO_PARAMETERS) {
    const value = history.params?.[key];
    if (typeof value === 'string' && value.trim() || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') {
      rows.push({ label, value: typeof value === 'boolean' ? value ? t('是') : t('否')
        : (key === 'duration' || key === 'seedanceDuration') && typeof value === 'number' ? t('{seconds} 秒', { seconds: value }) : String(value) });
    }
  }
  if (Number.isFinite(history.timestamp) && history.timestamp > 0) rows.push({ label: '生成时间', value: new Date(history.timestamp).toLocaleString(getLocale()) });
  return rows;
}
