/**
 * 稳定资产身份索引：assetId 是身份，path 只是最近位置。
 * 第一阶段使用 size + mtime 指纹在已扫描范围内识别移动/重命名；后续可无缝升级为分块哈希。
 */
import { exists, stat } from '@tauri-apps/plugin-fs';
import {
  getAssetIndexById,
  getAssetIndexByPath,
  getAssetIndexesByFingerprint,
  getLegacyAssetMeta,
  putAssetIndex,
  putAssetMeta,
  type AssetIndexRecord,
} from '../indexedDbService';
import { stripVerbatimPrefix } from './core';

export type AssetSource = AssetIndexRecord['source'];

export interface IdentifyAssetOptions {
  assetId?: string;
  rootPath?: string;
  projectId?: string;
  source: AssetSource;
  size?: number;
  mtimeMs?: number;
}

function normalizePath(path: string): string {
  return stripVerbatimPrefix(path).replace(/\\/g, '/').replace(/\/+$/, '');
}

export function getRelativeAssetPath(path: string, rootPath: string): string | undefined {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(rootPath);
  const pathForCompare = /^[A-Za-z]:\//.test(normalizedPath) ? normalizedPath.toLowerCase() : normalizedPath;
  const rootForCompare = /^[A-Za-z]:\//.test(normalizedRoot) ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return undefined;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

function createAssetId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function pathExists(path: string): Promise<boolean> {
  return exists(path).catch(() => false);
}

async function migrateLegacyTags(assetId: string, path: string): Promise<void> {
  const legacy = await getLegacyAssetMeta(path).catch(() => undefined);
  if (!legacy?.tags?.length) return;
  await putAssetMeta({
    assetId,
    path,
    tags: legacy.tags,
    taggedBy: legacy.taggedBy,
    updatedAt: legacy.updatedAt,
  }).catch(() => undefined);
}

/** 注册/刷新磁盘资产；自动恢复仅接受唯一丢失候选及一致内容摘要，旧记录交给显式修复。 */
export async function identifyAsset(path: string, options: IdentifyAssetOptions): Promise<AssetIndexRecord> {
  const normalizedPath = normalizePath(path);
  const fileStat = options.size == null || options.mtimeMs == null
    ? await stat(normalizedPath)
    : null;
  const size = options.size ?? fileStat?.size ?? 0;
  const mtimeMs = options.mtimeMs ?? fileStat?.mtime?.getTime() ?? 0;
  const fingerprint = `${size}:${mtimeMs}`;
  const rootPath = options.rootPath ? normalizePath(options.rootPath) : undefined;
  const relativePath = rootPath ? getRelativeAssetPath(normalizedPath, rootPath) : undefined;

  let existing = options.assetId ? await getAssetIndexById(options.assetId) : undefined;
  existing ??= await getAssetIndexByPath(normalizedPath);

  if (!existing) {
    const candidates = await getAssetIndexesByFingerprint(fingerprint);
    const missingCandidates: AssetIndexRecord[] = [];
    for (const candidate of candidates) {
      try { await stat(candidate.path); }
      catch (error) {
        if (/no such file|path not found|not found|找不到指定|ENOENT|os error [23]\b/i.test(String(error))) missingCandidates.push(candidate);
        // 权限/读取错误不当作丢失，也不自动接管身份。
      }
    }
    if (missingCandidates.length === 1 && missingCandidates[0].contentDigest) {
      const { fingerprintAssetImage } = await import('./assetImageMetadata');
      const content = await fingerprintAssetImage(normalizedPath);
      if (content.digest === missingCandidates[0].contentDigest) existing = missingCandidates[0];
    }
  }

  const record: AssetIndexRecord = {
    assetId: existing?.assetId ?? options.assetId ?? createAssetId(),
    path: normalizedPath,
    relativePath,
    rootPath,
    projectId: options.projectId,
    source: options.source,
    fingerprint,
    size,
    mtimeMs,
    ...(existing?.contentDigest && existing.size === size && existing.mtimeMs === mtimeMs ? { contentDigest: existing.contentDigest } : {}),
    status: 'online',
    updatedAt: Date.now(),
  };
  await putAssetIndex(record);
  await migrateLegacyTags(record.assetId, normalizedPath);
  return record;
}

export async function resolveIndexedAssetPath(assetId: string): Promise<string | null> {
  const record = await getAssetIndexById(assetId);
  if (!record || !(await pathExists(record.path))) return null;
  return record.path;
}
