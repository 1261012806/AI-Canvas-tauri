import { useAppStore } from '../store/useAppStore';
import { GENERAL_MODEL_CATEGORY_LABELS, getNodeTypeConfig } from '../types';
import type { ReferencePreviewContent, ReferencePreviewSource } from '../types/referencePreview';
import { DRAMA_ASSET_KIND_LABEL, parseDramaMentionId, type DramaAsset } from '../types/dramaAssets';
import { formatShotVideoPrompt, parseShotlistRowMentionId } from '../types/shotlist';
import { gridBoundaries } from '../utils/storyboardGrid';
import { defaultModelGroups, findMediaModelOption } from '../components/nodes/shared/defaultModels';
import {
  collectCharacterReferenceUrls, findDramaAsset, formatDramaAssetTextBrief, listGlobalDramaAssets,
  resolveDramaActionMediaRef, resolveDramaAssetImageRef, resolveDramaVoiceRef,
} from './dramaAssetPrompt';
import { getAssetUrlFromPath, getFileCategory, readAssetTextFile } from './fileService';
import { readChatImageReference } from './chat/chatImageReferenceService';
import { GENERAL_ASSISTANT_SCOPE_ID } from './chat/assistantScope';
import { loadGlobalDramaAssetCards } from './globalDramaAssetService';
import { getAssetIndexByPath } from './indexedDbService';
import { formatSize } from '../utils/assetFormat';
import { CHARACTER_REFERENCE_KIND_LABELS, CHARACTER_VOICE_KIND_LABELS } from '../components/character/characterReferencePresentation';

type PreviewState = ReturnType<typeof useAppStore.getState>;
type PreviewNode = PreviewState['nodes'][number];
type PreviewKind = ReferencePreviewContent['kind'];
type PreviewDetails = NonNullable<ReferencePreviewContent['details']>;

function withDetails(preview: ReferencePreviewContent, details: PreviewDetails): ReferencePreviewContent {
  const rows = new Map((preview.details ?? []).map((row) => [row.label, row]));
  for (const row of details) rows.set(row.label, row);
  return { ...preview, details: rows.size ? [...rows.values()] : undefined };
}

function addDetail(details: PreviewDetails, label: string, value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) return;
  // 这里只投影展示字段；配置地址、文件位置与凭据不能变成右侧参数。
  if (/(?:[a-z]:[\\/]|\\\\|(?:https?|file|asset):\/\/)|(?:^|\s)\/\S|(?:api[_-]?key|token|secret)\s*[:=]/i.test(value)) return;
  details.push({ label, value: value.trim() });
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function seconds(value: unknown): string | undefined {
  return positive(value) ? `${Number(value.toFixed(2))} 秒` : undefined;
}

function pixelSize(width: unknown, height: unknown): string | undefined {
  return positive(width) && positive(height) ? `${width} × ${height}` : undefined;
}

function nodeDetails(source: ReferencePreviewSource, state: PreviewState): PreviewDetails {
  const shot = parseShotlistRowMentionId(source.id);
  const cell = /^(.*)\/cell\/(\d+)$/.exec(source.id);
  const node = state.nodes.find((item) => item.id === (shot?.nodeId || cell?.[1] || source.id));
  const details: PreviewDetails = [{ label: '来源', value: '画布节点' }];
  if (!node) return details;
  const data = node.data;
  const type = node.type || data.type;
  const sourceLabels: Record<string, string> = { 'source-image': '源图像', 'source-video': '源视频', 'source-audio': '源音频', 'source-text': '源文本' };
  addDetail(details, '节点类型', sourceLabels[type] || getNodeTypeConfig(type).label);
  addDetail(details, '来源节点', nodeTitle(node, source.label));
  if (Number.isSafeInteger(data.displayId) && data.displayId! >= 0) addDetail(details, '节点编号', `#${data.displayId}`);
  const status = data.videoTaskState === 'paused' ? '查询已暂停'
    : data.status ? { idle: '空闲', loading: '生成中', success: '已完成', error: '失败' }[data.status] : undefined;
  addDetail(details, '状态', status);
  if (data.model) {
    const general = state.config.generalModels?.find((item) => item.id === data.model?.replace(/^general\//, ''));
    const model = findMediaModelOption(data.model, state.config.generalModels, state.config, state.workflows)
      || defaultModelGroups.flatMap((group) => group.models).find((item) => item.value === data.model);
    addDetail(details, '模型', general?.name || model?.label);
  }
  if (shot) {
    const row = data.shotlistRows?.find((item) => item.id === shot.rowId);
    addDetail(details, '分镜表', nodeTitle(node, source.label));
    if (row) {
      addDetail(details, '镜头编号', row.shotNo);
      addDetail(details, '镜头时长', seconds(row.duration));
      addDetail(details, '景别', row.shotSize);
      addDetail(details, '运镜', row.camera);
    }
    return details;
  }
  if (cell) {
    const index = Number(cell[2]);
    const cols = data.storyboardCols;
    const rows = data.storyboardRows;
    if (Number.isSafeInteger(index) && positive(cols) && Number.isSafeInteger(cols)
      && positive(rows) && Number.isSafeInteger(rows) && index < cols * rows) {
      addDetail(details, '宫格位置', `第 ${Math.floor(index / cols) + 1} 行 · 第 ${index % cols + 1} 列`);
      addDetail(details, '宫格布局', `${cols} 列 × ${rows} 行`);
      addDetail(details, '图片来源', data.storyboardOverrides?.[index] ? '该格覆盖图' : '源图裁片');
    }
    addDetail(details, '源宫格图尺寸', pixelSize(data.imageWidth, data.imageHeight));
  } else if (type === 'ai-video' || type === 'source-video') {
    addDetail(details, '视频尺寸', pixelSize(data.videoWidth, data.videoHeight));
    addDetail(details, '视频时长', seconds(data.videoDuration));
  } else addDetail(details, '图片尺寸', pixelSize(data.imageWidth, data.imageHeight));
  if (type === 'ai-video' || type === 'source-video') {
    addDetail(details, '请求分辨率', data.seedanceResolution);
    addDetail(details, '请求比例', data.seedanceRatio);
    addDetail(details, '请求时长', data.seedanceDuration === -1 ? '自动' : seconds(data.seedanceDuration));
    if (positive(data.videoResolution)) addDetail(details, '视频分辨率参数', String(data.videoResolution));
    if (positive(data.videoFps)) addDetail(details, '帧率参数', `${data.videoFps} fps`);
    if (positive(data.videoFrames)) addDetail(details, '帧数参数', String(data.videoFrames));
  } else if (['ai-image', 'source-image', 'ai-storyboard', 'ai-animation', 'ai-panorama'].includes(type)) {
    addDetail(details, '生成尺寸参数', data.imageSize);
    addDetail(details, '请求比例', data.aspectRatio);
  } else if (type === 'ai-audio' || type === 'source-audio') {
    addDetail(details, '音频格式', data.audioFormat);
    addDetail(details, '音乐时长参数', seconds(data.musicDuration));
  }
  return details;
}

function dramaDetails(source: ReferencePreviewSource, asset: DramaAsset): PreviewDetails {
  const { assetId, referenceImageId, voiceClipId, actionId, actionMediaId, mergeAll } = parseDramaMentionId(source.id);
  const details: PreviewDetails = [
    { label: '来源', value: assetId.startsWith('global/') ? '全局创作资产库' : '创作资产库' },
    { label: '资产类型', value: DRAMA_ASSET_KIND_LABEL[asset.kind] },
  ];
  addDetail(details, '资产名称', asset.name);
  addDetail(details, '简介', asset.summary);
  addDetail(details, '外观约束', asset.visualNotes);
  addDetail(details, '剧情作用', asset.storyRole);
  if (asset.kind === 'character') {
    addDetail(details, '身份', asset.identity);
    addDetail(details, '默认服装', asset.wardrobeDefault);
    addDetail(details, '声音约束', asset.voiceNotes);
    const reference = referenceImageId !== undefined ? asset.referenceImages?.find((item) => item.id === referenceImageId)
      : asset.referenceImages?.find((item) => item.id === asset.primaryReferenceImageId) || asset.referenceImages?.[0];
    if (voiceClipId !== undefined) {
      const voice = resolveDramaVoiceRef(asset, voiceClipId);
      addDetail(details, '引用内容', '指定声音片段');
      if (voice) {
        addDetail(details, '声音用途', CHARACTER_VOICE_KIND_LABELS[voice.kind]);
        addDetail(details, '音频时长', seconds(voice.durationSec));
      }
    } else if (actionId !== undefined) {
      const action = asset.actions?.find((item) => item.id === actionId);
      const media = resolveDramaActionMediaRef(asset, actionId, actionMediaId);
      addDetail(details, '引用内容', '指定动作素材');
      addDetail(details, '动作名称', action?.name);
      addDetail(details, '动作素材', media?.name ? fileName(media.name) : undefined);
    } else if (mergeAll) {
      addDetail(details, '引用内容', '全部参考图');
      if (asset.referenceImages) addDetail(details, '库内参考图数量', String(asset.referenceImages.length));
    } else {
      addDetail(details, '引用内容', referenceImageId !== undefined ? '指定参考图' : '默认参考图');
      if (reference) addDetail(details, '参考图用途', CHARACTER_REFERENCE_KIND_LABELS[reference.kind]);
    }
  } else if (asset.kind === 'scene') {
    addDetail(details, '场景类型', asset.placeType);
    addDetail(details, '时段', asset.timeOfDay);
    addDetail(details, '氛围', asset.atmosphere);
    addDetail(details, '空间约束', asset.spatialNotes);
  } else {
    addDetail(details, '道具分类', asset.category);
    addDetail(details, '归属', asset.ownerName);
    addDetail(details, '道具作用', asset.significance);
  }
  return details;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('预览读取已取消', 'AbortError');
}

function unavailable(title: string, message: string, kind: PreviewKind = 'text'): ReferencePreviewContent {
  return { kind, title, unavailable: message };
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || '素材';
}

/** 本地路径仍交给现有文件服务；只将可展示的媒体来源交给视图。 */
async function mediaUrl(value: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  checkAbort(signal);
  const url = value?.trim();
  if (!url) return undefined;
  if (/^(?:[a-z]:[\\/]|[\\/])/i.test(url)) {
    const resolved = await getAssetUrlFromPath(url);
    checkAbort(signal);
    return resolved || undefined;
  }
  if (/^data:(?:image|video|audio)\//i.test(url) || /^blob:/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || !['http:', 'https:', 'asset:'].includes(parsed.protocol)
      || (parsed.protocol === 'asset:' && parsed.hostname !== 'localhost')) return undefined;
    return url;
  } catch { return undefined; }
}

async function mediaPreview(
  kind: 'image' | 'video' | 'audio', title: string, url: string | undefined,
  signal?: AbortSignal, extra: Partial<ReferencePreviewContent> = {},
): Promise<ReferencePreviewContent> {
  const resolved = await mediaUrl(url, signal);
  return resolved ? { ...extra, kind, title, mediaUrl: resolved }
    : { ...extra, ...unavailable(title, '该媒体尚未就绪或原始引用已失效', kind) };
}

function nodeTitle(node: PreviewNode, fallback: string): string {
  return node.data.label || node.data.fileName || fallback;
}

async function previewNode(source: ReferencePreviewSource, state: PreviewState, signal?: AbortSignal): Promise<ReferencePreviewContent> {
  const shot = parseShotlistRowMentionId(source.id);
  if (shot) {
    const sheet = state.nodes.find((node) => node.id === shot.nodeId && (node.type || node.data.type) === 'ai-shotlist');
    const row = sheet?.data.shotlistRows?.find((item) => item.id === shot.rowId);
    if (!sheet || !row) return unavailable(source.label, '该分镜表或镜头已删除');
    return { kind: 'markdown', title: `${nodeTitle(sheet, source.label)} · 第${row.shotNo || sheet.data.shotlistRows!.indexOf(row) + 1}镜`,
      text: formatShotVideoPrompt(row) || '此镜头尚未填写内容' };
  }
  // 无效虚拟 ID 不能误回落到整表或宫格原图。
  if (source.id.includes('/shot/')) return unavailable(source.label, '镜头引用格式无效');
  const cell = /^(.*)\/cell\/(\d+)$/.exec(source.id);
  const node = state.nodes.find((item) => item.id === (cell?.[1] || source.id));
  if (!node) return unavailable(source.label, '引用的节点已不存在');
  const data = node.data;
  const title = nodeTitle(node, source.label);
  const type = node.type || data.type;
  if (cell) {
    if (type !== 'ai-storyboard') return unavailable(source.label, '宫格来源已失效', 'image');
    const index = Number(cell[2]);
    const cols = Math.max(1, Math.floor(data.storyboardCols || 1));
    const rows = Math.max(1, Math.floor(data.storyboardRows || 1));
    if (!Number.isSafeInteger(index) || index >= cols * rows) return unavailable(source.label, '该宫格已不存在', 'image');
    const override = data.storyboardOverrides?.[index];
    if (override) return mediaPreview('image', `${title} · 第${index + 1}格`, override.url || override.filePath, signal, { prompt: data.prompt });
    const x = gridBoundaries(cols, data.storyboardColPositions);
    const y = gridBoundaries(rows, data.storyboardRowPositions);
    const col = index % cols;
    const row = Math.floor(index / cols);
    const crop = { x: x[col], y: y[row], width: x[col + 1] - x[col], height: y[row + 1] - y[row] };
    if (!Object.values(crop).every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
      || crop.x + crop.width > 100.000001 || crop.y + crop.height > 100.000001) return unavailable(source.label, '宫格裁切范围已失效', 'image');
    // 与 storyboardGrid 一致，裁切矩形使用 0–100 的百分比坐标。
    return mediaPreview('image', `${title} · 第${index + 1}格`, data.imageUrl || data.filePath || data.thumbnailUrl, signal,
      { imageCrop: crop, prompt: data.prompt });
  }
  if (source.id.includes('/cell/')) return unavailable(source.label, '宫格引用格式无效', 'image');
  if (type === 'ai-shotlist') {
    const text = data.shotlistRows?.map((row) => formatShotVideoPrompt(row)).filter(Boolean).join('\n\n---\n\n');
    return { kind: 'markdown', title, text: text || data.output || data.prompt || '分镜表尚未填写内容' };
  }
  const extra = { prompt: data.prompt };
  if (type === 'ai-video' || type === 'source-video') return mediaPreview('video', title, data.videoUrl || data.filePath, signal, extra);
  if (type === 'ai-audio' || type === 'source-audio') return mediaPreview('audio', title, data.audioUrl || data.filePath, signal, extra);
  if (type === 'ai-director' && data.directorCaptureUrls?.length) {
    const images = [];
    for (const [index, url] of data.directorCaptureUrls.entries()) {
      const resolved = await mediaUrl(url, signal);
      if (resolved) images.push({ url: resolved, label: `截图 ${index + 1}` });
    }
    return images.length ? { kind: 'image', title, mediaUrl: images[0].url, images, ...extra }
      : unavailable(title, '导演台截图已不可用', 'image');
  }
  if (['ai-image', 'source-image', 'ai-panorama', 'ai-animation', 'ai-storyboard'].includes(type || '')) {
    return mediaPreview('image', title, data.imageUrl || data.filePath || data.thumbnailUrl, signal, extra);
  }
  const text = data.output || data.prompt;
  if (!text && type === 'source-text' && data.filePath) return previewAsset({ kind: 'asset', id: data.filePath, label: title }, state, signal);
  return text ? { kind: type === 'ai-markdown' ? 'markdown' : 'text', title, text, prompt: data.output ? data.prompt : undefined }
    : unavailable(title, '该节点尚无可预览的正文或生成结果');
}

async function previewDrama(source: ReferencePreviewSource, state: PreviewState, signal?: AbortSignal): Promise<ReferencePreviewContent> {
  const { assetId } = parseDramaMentionId(source.id);
  let asset = findDramaAsset(state.dramaAssets, assetId, listGlobalDramaAssets(state));
  if (!asset && assetId.startsWith('global/')) {
    // 直接从聊天或只读提示词打开时，资产面板可能尚未加载；临时读取，不改写窗口 Store。
    const assets = await loadGlobalDramaAssetCards();
    checkAbort(signal);
    asset = findDramaAsset(state.dramaAssets, assetId, assets);
  }
  if (!asset) return withDetails(unavailable(source.label, '引用的创作资产已不存在'), [
    { label: '来源', value: assetId.startsWith('global/') ? '全局创作资产库' : '创作资产库' },
  ]);
  return withDetails(await previewDramaContent(source, state, asset, signal), dramaDetails(source, asset));
}

async function previewDramaContent(source: ReferencePreviewSource, state: PreviewState, asset: DramaAsset, signal?: AbortSignal): Promise<ReferencePreviewContent> {
  const { assetId, referenceImageId, actionId, actionMediaId, voiceClipId, mergeAll } = parseDramaMentionId(source.id);
  const title = asset.name || source.label;
  const description = `${assetId.startsWith('global/') ? '全局创作资产库' : '创作资产库'} · ${DRAMA_ASSET_KIND_LABEL[asset.kind]}`;
  const text = formatDramaAssetTextBrief(asset);
  const extra = { description, text };
  if (voiceClipId !== undefined) {
    const voice = resolveDramaVoiceRef(asset, voiceClipId);
    return voice ? mediaPreview('audio', voice.label, voice.url, signal, { ...extra, text: voice.transcript })
      : unavailable(title, '指定声音片段已删除或尚无音频', 'audio');
  }
  if (actionId !== undefined) {
    const media = resolveDramaActionMediaRef(asset, actionId, actionMediaId);
    const action = asset.kind === 'character' ? asset.actions?.find((item) => item.id === actionId) : undefined;
    return media ? mediaPreview(media.kind === 'video' ? 'video' : 'image', media.label, media.url, signal,
      { ...extra, prompt: action?.prompt }) : unavailable(title, '指定动作素材已删除或尚未就绪');
  }
  const nodes = assetId.startsWith('global/') ? [] : state.nodes;
  if (mergeAll) {
    const images = [];
    for (const [index, url] of collectCharacterReferenceUrls(asset, nodes).entries()) {
      const resolved = await mediaUrl(url, signal);
      if (resolved) images.push({ url: resolved, label: `${title} · 参考图 ${index + 1}` });
    }
    return images.length ? { kind: 'image', title, ...extra, images, mediaUrl: images[0].url }
      : { ...extra, ...unavailable(title, '全部参考图暂无可用图片', 'image') };
  }
  if (referenceImageId !== undefined) {
    const reference = asset.kind === 'character' ? asset.referenceImages?.find((item) => item.id === referenceImageId) : undefined;
    const image = reference && asset.kind === 'character'
      ? resolveDramaAssetImageRef({ ...asset, imageNodeId: undefined, imageUrl: undefined, referenceImages: [reference] }, nodes, referenceImageId) : null;
    return image ? mediaPreview('image', title, image.imageUrl, signal, { ...extra, prompt: reference?.prompt })
      : { ...extra, ...unavailable(title, '指定参考图已删除或尚无图片', 'image') };
  }
  const image = resolveDramaAssetImageRef(asset, nodes);
  return image ? mediaPreview('image', title, image.imageUrl, signal, extra) : { kind: 'markdown', title, ...extra };
}

async function previewAsset(source: ReferencePreviewSource, state: PreviewState, signal?: AbortSignal): Promise<ReferencePreviewContent> {
  const title = source.label || fileName(source.id);
  const category = getFileCategory(fileName(source.id));
  const details: PreviewDetails = [{ label: '来源', value: '素材库文件' }];
  addDetail(details, '文件名称', fileName(source.id));
  addDetail(details, '文件类型', { image: '图像', video: '视频', audio: '音频', text: '文本', other: '其他' }[category]);
  let preview: ReferencePreviewContent;
  if (category === 'text') {
    const snapshot = await readAssetTextFile(source.id, signal);
    checkAbort(signal);
    if (Number.isFinite(snapshot.size) && snapshot.size >= 0) addDetail(details, '文件大小', formatSize(snapshot.size));
    preview = { kind: /\.md$/i.test(source.id) ? 'markdown' : 'text', title, text: snapshot.content };
  } else {
    preview = category === 'image' || category === 'video' || category === 'audio'
      ? await mediaPreview(category, title, source.id, signal) : unavailable(title, '此文件格式暂不支持在应用内预览');
    const key = source.id.replace(/\\/g, '/').replace(/\/+$/, '');
    // 仅查已索引的精确路径，不扫描目录、登记资产或为预览探测原文件。
    const indexed = await getAssetIndexByPath(key).catch(() => undefined);
    checkAbort(signal);
    if (indexed) {
      if (Number.isFinite(indexed.size) && indexed.size >= 0) addDetail(details, '文件大小（已索引）', formatSize(indexed.size));
      addDetail(details, '文件归属', { project: '项目文件', global: '全局素材', folder: '外部文件夹' }[indexed.source]);
    }
    const matches = state.nodes.filter((node) => [node.data.filePath, node.data.imageUrl, node.data.videoUrl, node.data.audioUrl]
      .some((value) => typeof value === 'string' && value.replace(/\\/g, '/').replace(/\/+$/, '') === key));
    if (matches.length === 1) {
      const data = matches[0].data;
      if (category === 'image') addDetail(details, '图片尺寸', pixelSize(data.imageWidth, data.imageHeight));
      else if (category === 'video') {
        addDetail(details, '视频尺寸', pixelSize(data.videoWidth, data.videoHeight));
        addDetail(details, '视频时长', seconds(data.videoDuration));
      }
    }
  }
  return withDetails(preview, details);
}

/** 仅识别完整的单个媒体引用；不执行工作流，也不解释普通文本中的指令。 */
function singleReference(value: string): ReferencePreviewSource | undefined {
  const node = /^@\{([^:}\r\n]+):([^}\r\n]*)\}$/.exec(value);
  if (node) return { kind: 'node', id: node[1], label: node[2] };
  const drama = /^@drama\{([^:}\r\n]+):([^}\r\n]*)\}$/.exec(value);
  if (drama) return { kind: 'drama', id: drama[1], label: drama[2] };
  const asset = /^@asset\{([^}\r\n]+)\}$/.exec(value);
  if (asset) {
    try { return { kind: 'asset', id: decodeURIComponent(asset[1]), label: '' }; } catch { return undefined; }
  }
  const image = /^@image\{(chat-ref-[a-f0-9-]{36}\.(?:png|jpg|webp))\|[^}\r\n]*\}$/.exec(value);
  if (image) return { kind: 'chat-image', id: image[1], label: '助手参考图' };
  return undefined;
}

async function previewWorkflow(source: ReferencePreviewSource, state: PreviewState, signal?: AbortSignal): Promise<ReferencePreviewContent> {
  const owner = source.ownerNodeId ? state.nodes.find((node) => node.id === source.ownerNodeId) : undefined;
  const workflow = state.workflows.find((item) => item.id === owner?.data.workflowId);
  const io = workflow?.ioNodes?.find((item) => item.nodeId === source.id);
  const title = source.label || io?.title || '工作流输入';
  const value = source.value ?? owner?.data.workflowInputs?.[source.id];
  if (value === undefined) return unavailable(title, '未找到此工作流输入的当前值');
  const reference = singleReference(value.trim());
  if (reference) return { ...await resolveFromState(reference, state, signal), title };
  const type = io?.type || (/^data:(image|video|audio)\//i.exec(value.trim())?.[1]?.toLowerCase())
    || getFileCategory(value.trim().split(/[?#]/)[0]);
  if (type === 'image' || type === 'video' || type === 'audio') return mediaPreview(type, title, value, signal,
    { description: workflow?.name });
  return { kind: 'text', title, text: value, description: workflow?.name };
}

function previewModel(source: ReferencePreviewSource, state: PreviewState): ReferencePreviewContent {
  const general = state.config.generalModels?.find((item) => item.id === source.id.replace(/^general\//, ''));
  if (general) return { kind: 'text', title: general.name, text: general.description,
    details: [
      { label: '模型 ID', value: general.modelId },
      { label: '类型', value: GENERAL_MODEL_CATEGORY_LABELS[general.category] },
      ...(general.inputModalities?.length ? [{ label: '输入', value: general.inputModalities.join('、') }] : []),
      ...(general.contextWindow ? [{ label: '上下文窗口', value: String(general.contextWindow) }] : []),
    ] };
  const model = findMediaModelOption(source.id, state.config.generalModels, state.config, state.workflows)
    || defaultModelGroups.flatMap((group) => group.models).find((item) => item.value === source.id);
  return model ? { kind: 'text', title: model.label, text: model.description,
    details: [{ label: '模型 ID', value: model.value }, { label: '适用节点', value: model.nodeTypes.join('、') }] }
    : unavailable(source.label, '该模型已删除或不在当前模型目录中');
}

async function resolveFromState(source: ReferencePreviewSource, state: PreviewState, signal?: AbortSignal): Promise<ReferencePreviewContent> {
  checkAbort(signal);
  switch (source.kind) {
    case 'node': return withDetails(await previewNode(source, state, signal), nodeDetails(source, state));
    case 'drama': return previewDrama(source, state, signal);
    case 'asset': return previewAsset(source, state, signal);
    case 'workflow': return previewWorkflow(source, state, signal);
    case 'model': return previewModel(source, state);
    case 'skill': {
      const skill = [...state.userSkills, ...state.agentPackageSkills].find((item) => item.id === source.id);
      return skill ? { kind: 'markdown', title: skill.name, text: skill.content, description: skill.description }
        : unavailable(source.label, '该 Skill 已删除、停用或不在当前目录中');
    }
    case 'chat-image': {
      const url = await readChatImageReference(state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID, source.id, signal);
      checkAbort(signal);
      return { kind: 'image', title: source.label || '助手参考图', mediaUrl: url };
    }
  }
}

/** 读取窗口内当前引用内容，不生成、不执行 Skill，也不写入 Store 或磁盘。 */
export async function resolveReferencePreview(
  source: ReferencePreviewSource,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ReferencePreviewContent> {
  checkAbort(signal);
  const state = useAppStore.getState();
  try {
    const preview = await resolveFromState(source, state, signal);
    checkAbort(signal);
    return preview;
  } catch (error) {
    checkAbort(signal);
    if (error instanceof Error && error.name === 'AbortError') throw error;
    // 原生错误可能含本地路径或请求信息，不带入预览、消息或日志。
    return unavailable(source.label || '引用预览', '内容无法读取，请确认原始内容仍存在且文件读取权限可用');
  }
}
