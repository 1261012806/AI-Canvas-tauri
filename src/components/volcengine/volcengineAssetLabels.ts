import { t } from '../../i18n';

const STATUS_LABELS: Record<string, string> = {
  Creating: '创建中',
  Active: '可用',
  Failed: '失败',
  Deleting: '删除中',
};

export function getVolcengineAssetStatusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? t(STATUS_LABELS[status]) : status;
}
