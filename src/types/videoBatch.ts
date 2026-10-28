export type VideoBatchScope = 'episode' | 'selected' | 'pending';
export type VideoBatchItemStatus = 'waiting' | 'running' | 'success' | 'error' | 'cancelled' | 'unknown';

export interface VideoBatchItem {
  nodeId: string;
  label: string;
  fingerprint: string;
  /** 已检查的有效 H3 策略摘要；不保存配置正文或原生运行时。 */
  comfyH3SettingsFingerprint?: string;
  duration?: number;
  status: VideoBatchItemStatus;
  message?: string;
}

/** Only identities and summaries persist. Never store prompts, credentials or media paths. */
export interface VideoBatch {
  id: string;
  projectId: string;
  createdAt: number;
  items: VideoBatchItem[];
}

export interface VideoPreflightItem {
  nodeId: string;
  label: string;
  fingerprint: string;
  comfyH3SettingsFingerprint?: string;
  duration?: number;
  issues: string[];
  existing: boolean;
  stale: boolean;
}
