import type { ReactNode } from 'react';
import type {
  CharacterReferenceImage,
  DramaAssetLibrary,
  DramaCharacter,
  DramaProp,
  DramaScene,
} from '../../../types/dramaAssets';
import { getFileCategory } from '../../../services/fileService';
import { parseDramaMentionId } from '../../../types/dramaAssets';
import { resolveDramaActionMediaRef } from '../../../services/dramaAssetPrompt';
import { bestNodeThumb, getNodeChipIconPath, getNodeMetaMap, numberMediaReferenceLabels } from './mentionEditorDom';
import { parseShotlistRowMentionId } from '../../../types/shotlist';

const CHIP_STYLE: Record<string, string> = {
  'ai-text': 'chip-text',
  'ai-image': 'chip-image',
  'ai-video': 'chip-video',
  'ai-audio': 'chip-audio',
  'ai-markdown': 'chip-markdown',
  'ai-storyboard': 'chip-image',
  'ai-shotlist': 'chip-text',
};

const WF_IO_STYLE: Record<string, string> = {
  prompt: 'chip-workflow-prompt',
  image: 'chip-workflow-image',
  video: 'chip-workflow-video',
  audio: 'chip-workflow-audio',
};

const WF_IO_ICON: Record<string, string> = {
  prompt: 'T',
  image: 'I',
  video: 'V',
  audio: 'A',
};

export interface PromptChipRenderOptions {
  nodes?: Array<{ id: string; data?: Record<string, unknown> }>;
  dramaAssets?: DramaAssetLibrary;
  nodeMetaMap?: ReturnType<typeof getNodeMetaMap>;
  emptyText?: string;
}

/** 与可编辑胶囊相同，按括号深度读取完整工作流值，保留其中的引用令牌。 */
function readWorkflowValue(prompt: string, start: number): { value?: string; end: number } {
  if (prompt[start] !== '(') return { end: start };
  let depth = 1;
  let index = start + 1;
  while (index < prompt.length && depth > 0) {
    if (prompt[index] === '(') depth += 1;
    else if (prompt[index] === ')') depth -= 1;
    index += 1;
  }
  // 未闭合时保留后面的原始正文，不吞掉其它引用。
  return depth === 0 ? { value: prompt.slice(start + 1, index - 1), end: index } : { end: start };
}

/** 把包含 @提及标记的提示词渲染为与 MentionEditor 一致的彩色标签芯片 */
export function renderPromptWithChips(
  prompt: string,
  options: PromptChipRenderOptions = {},
): ReactNode {
  if (!prompt || !prompt.trim()) {
    return options.emptyText ?? '暂无生成信息';
  }

  const regex = /@asset\{([^}]+)\}|@drama\{([^:]+):([^}]+)\}|@\{([^:]+):([^}]+)\}|@wf\{([^|]+)\|([^|]+)\|([^|}]+)\}|@skill\{([^|}]+)\|([^}]+)\}/g;
  if (!regex.test(prompt)) {
    return prompt;
  }
  regex.lastIndex = 0;

  const nodes = options.nodes;
  const dramaAssets = options.dramaAssets;
  const metaMap = options.nodeMetaMap || (nodes ? getNodeMetaMap(nodes as never) : new Map());

  // 与 MentionEditor 共用按媒体类型分别编号的规则。
  const references: Parameters<typeof numberMediaReferenceLabels>[0] = [];
  let scanMatch: RegExpExecArray | null;
  while ((scanMatch = regex.exec(prompt)) !== null) {
    if (scanMatch[1] !== undefined) {
      let path = scanMatch[1];
      try { path = decodeURIComponent(scanMatch[1]); } catch { /* 保留原值 */ }
      const name = path.split(/[\\/]/).pop() || '';
      references.push(getFileCategory(name) === 'image' ? { kind: 'image', key: `asset:${encodeURIComponent(path)}` } : undefined);
    } else if (scanMatch[2] !== undefined) {
      const dramaId = scanMatch[2];
      const { assetId, actionId, actionMediaId, voiceClipId } = parseDramaMentionId(dramaId);
      const asset = dramaAssets?.characters.find((item) => item.id === assetId)
        || dramaAssets?.scenes.find((item) => item.id === assetId)
        || dramaAssets?.props.find((item) => item.id === assetId);
      const action = actionId !== undefined ? resolveDramaActionMediaRef(asset, actionId, actionMediaId) : undefined;
      references.push({ kind: voiceClipId !== undefined ? 'audio' : action?.kind === 'video' ? 'video' : 'image', key: `drama:${dramaId}` });
    } else if (scanMatch[4] !== undefined) {
      const nodeId = scanMatch[4];
      const meta = metaMap.get(nodeId);
      references.push(meta?.mediaReference || (meta?.imageReferenceKey
        ? { kind: 'image', key: meta.imageReferenceKey }
        : !meta && !parseShotlistRowMentionId(nodeId) ? { kind: 'image', key: `node:${nodeId}` } : undefined));
    } else {
      references.push(undefined);
    }
    if (scanMatch[6] !== undefined) regex.lastIndex = readWorkflowValue(prompt, regex.lastIndex).end;
  }
  const referenceLabels = numberMediaReferenceLabels(references);
  regex.lastIndex = 0;

  const elements: ReactNode[] = [];
  let lastIndex = 0;
  let matchIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(prompt)) !== null) {
    if (match.index > lastIndex) {
      elements.push(prompt.slice(lastIndex, match.index));
    }
    const currentIdx = matchIdx++;

    if (match[1] !== undefined) {
      let path = match[1];
      try { path = decodeURIComponent(match[1]); } catch { /* 保留原值 */ }
      const name = path.split(/[\\/]/).pop() || 'asset';
      const isImage = getFileCategory(name) === 'image';
      const referenceLabel = referenceLabels[currentIdx];
      const displayName = name.length > 18 ? `${name.slice(0, 16)}…` : name;

      elements.push(
        <span key={`asset-${match.index}`} className="prompt-chip chip-asset cursor-pointer" data-asset-path={path} title={name} role="button" tabIndex={0}>
          <span className="prompt-chip-icon">{isImage ? '🖼' : '📄'}</span>
          <span className="prompt-chip-id">{displayName}</span>
          {referenceLabel !== undefined && (
            <span className="prompt-chip-id prompt-chip-image-index prompt-chip-media-index text-canvas-text-secondary">{referenceLabel}</span>
          )}
        </span>,
      );
      lastIndex = regex.lastIndex;
    } else if (match[2] !== undefined) {
      const dramaId = match[2];
      const dramaName = match[3] || '资产';
      let kind = 'character';
      let thumb: string | undefined;
      let icon = '人';

      if (dramaAssets) {
        const { assetId, referenceImageId, actionId, actionMediaId, voiceClipId } = parseDramaMentionId(dramaId);
        const found = dramaAssets.characters.find((a: DramaCharacter) => a.id === assetId)
          || dramaAssets.scenes.find((a: DramaScene) => a.id === assetId)
          || dramaAssets.props.find((a: DramaProp) => a.id === assetId);
        if (voiceClipId !== undefined) {
          kind = 'voice';
          icon = '♪';
        } else if (actionId !== undefined) {
          const media = resolveDramaActionMediaRef(found, actionId, actionMediaId);
          kind = media?.kind === 'video' ? 'action-video' : 'action-image';
          thumb = media && media.kind !== 'video' ? media.url : undefined;
          icon = '动';
        } else if (found) {
          kind = found.kind;
          icon = kind === 'character' ? '人' : kind === 'scene' ? '场' : '道';
          const picked = referenceImageId && found.kind === 'character'
            ? found.referenceImages?.find((img: CharacterReferenceImage) => img.id === referenceImageId)
            : undefined;
          if (picked) {
            thumb = picked.imageUrl;
          } else if (found.imageNodeId && nodes) {
            const node = nodes.find((n) => n.id === found.imageNodeId);
            thumb = bestNodeThumb(node?.data ?? {}) || found.imageUrl;
          } else {
            thumb = found.imageUrl;
          }
        }
      }

      const chipStyle = kind === 'voice' ? 'chip-audio' : kind === 'action-video' ? 'chip-video' : 'chip-image';
      const displayName = dramaName.length > 16 ? `${dramaName.slice(0, 14)}…` : dramaName;
      const referenceLabel = referenceLabels[currentIdx];

      elements.push(
        <span
          key={`drama-${match.index}`}
          className={`prompt-chip ${chipStyle} cursor-pointer`}
          data-drama-id={dramaId}
          data-drama-label={dramaName}
          title={dramaName}
          role="button" tabIndex={0}
        >
          <span className="prompt-chip-icon">
            {thumb ? <img src={thumb} className="prompt-chip-thumb" alt="" /> : icon}
          </span>
          <span className="prompt-chip-id">{displayName}</span>
          {referenceLabel !== undefined && (
            <span className="prompt-chip-id prompt-chip-image-index prompt-chip-media-index text-canvas-text-secondary">{referenceLabel}</span>
          )}
        </span>,
      );
      lastIndex = regex.lastIndex;
    } else if (match[4] !== undefined) {
      const nodeId = match[4];
      const label = match[5] || '生成图像';
      const shot = parseShotlistRowMentionId(nodeId);
      const meta = metaMap.get(nodeId);
      const node = nodes?.find((n) => n.id === (shot?.nodeId || (nodeId.includes('/cell/') ? nodeId.split('/')[0] : nodeId)));
      const nodeType = shot ? 'ai-shotlist' : meta?.type || (node?.data?.type as string) || 'ai-image';
      const iconPath = getNodeChipIconPath(nodeType);
      const thumbUrl = meta?.thumbnailUrl || (node ? bestNodeThumb(node.data ?? {}) || (node.data?.imageUrl as string) : undefined);
      const isMedia = nodeType === 'ai-image' || nodeType === 'ai-video' || nodeType === 'ai-storyboard';
      const showThumbnail = !iconPath && isMedia && !!thumbUrl;
      const displayId = shot ? undefined : meta?.displayId ?? (node?.data?.displayId as number | undefined);
      const liveLabel = shot ? meta?.label || `${label}（镜头已失效）` : label;
      const displayLabel = displayId != null ? `#${displayId}` : liveLabel;
      const title = displayId != null ? `${label} (#${displayId})` : liveLabel;
      const referenceLabel = referenceLabels[currentIdx];

      elements.push(
        <span
          key={`node-${match.index}`}
          className={`prompt-chip prompt-chip-node ${CHIP_STYLE[nodeType] || 'chip-image'} cursor-pointer`}
          data-ref-id={nodeId}
          data-ref-label={label}
          title={title}
          role="button" tabIndex={0}
        >
          <span className={`prompt-chip-icon${showThumbnail ? ' has-thumbnail' : ''}`} aria-hidden="true">
            {showThumbnail ? <img src={thumbUrl} className="prompt-chip-thumb" alt="" /> : iconPath ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={iconPath} />
              </svg>
            ) : '@'}
          </span>
          <span className="prompt-chip-id">{displayLabel}</span>
          {referenceLabel !== undefined && (
            <span className="prompt-chip-id prompt-chip-image-index prompt-chip-media-index text-canvas-text-secondary">{referenceLabel}</span>
          )}
        </span>,
      );
      lastIndex = regex.lastIndex;
    } else if (match[6] !== undefined) {
      const ioId = match[6];
      const ioTitle = match[7];
      const ioType = match[8] || 'prompt';
      const input = readWorkflowValue(prompt, regex.lastIndex);
      elements.push(
        <span key={`wf-${match.index}`} className={`prompt-chip prompt-chip-wf ${WF_IO_STYLE[ioType] || WF_IO_STYLE.prompt}`} data-wf-id={ioId}
          data-wf-title={ioTitle} data-wf-preview-value={input.value} role="button" tabIndex={0}>
          <span className="prompt-chip-wf-prefix">
            <span className="prompt-chip-icon">{WF_IO_ICON[ioType] || '?'}</span>
            <span className="prompt-chip-wf-id">#{ioId}</span>
            <span className="prompt-chip-wf-colon">:</span>
          </span>
          <span className={input.value === undefined ? 'prompt-chip-wf-title' : 'prompt-chip-wf-value'}>{input.value ?? ioTitle}</span>
        </span>,
      );
      lastIndex = input.end;
      regex.lastIndex = input.end;
    } else if (match[9] !== undefined) {
      const skillId = match[9];
      let skillName = match[10];
      try { skillName = decodeURIComponent(match[10]); } catch { /* 保留原值 */ }
      elements.push(
        <span key={`skill-${match.index}`} className="prompt-chip chip-skill cursor-pointer" data-skill-id={skillId} data-skill-name={skillName} title={skillName} role="button" tabIndex={0}>
          <span className="prompt-chip-icon prompt-chip-skill-icon" aria-hidden="true">✦</span>
          <span className="prompt-chip-skill-name">{skillName.length > 20 ? `${skillName.slice(0, 18)}...` : skillName}</span>
        </span>,
      );
      lastIndex = regex.lastIndex;
    }
  }

  if (lastIndex < prompt.length) {
    elements.push(prompt.slice(lastIndex));
  }

  return elements;
}
