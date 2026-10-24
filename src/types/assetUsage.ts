/** 最近使用的持久化记录只保存稳定身份，不复制文件路径或媒体正文。 */
export interface AssetUsageRecord {
  assetId: string;
  usedAt: number;
}

export type AssetUsageTarget =
  | { kind: 'file'; assetId?: string; path: string; name: string }
  | { kind: 'creative'; scope: 'global' | 'project'; assetKind: import('./dramaAssets').DramaAssetKind;
      assetId: string; ownerId?: string; name: string };

export interface AssetUsageLocation {
  key: string;
  kind: 'node' | 'creative' | 'history' | 'chat' | 'task' | 'video-editor' | 'workflow' | 'preset' | 'image-details';
  projectId?: string;
  projectName?: string;
  nodeId?: string;
  name: string;
  live?: boolean;
}

export interface AssetUsageReport {
  locations: AssetUsageLocation[];
  signature: string;
}
