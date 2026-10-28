import { t } from '../../../i18n';
import { PRESET_NODE_TYPES, PRESET_NODE_TYPE_LABELS } from '../../../types';
import type { NodeType, UserPreset } from '../../../types';
import { isAdvancedPreset } from '../../../services/presetSequenceService';
import { getGenerationNodeType } from '../../../utils/nodeGeneration';
import type { SlashCommandItem } from './slashCommands';

export type ShortcutEntryPoint = 'prompt' | 'toolbar';

/** 仅用于菜单说明，不进入节点、预设或运行状态。 */
export interface ShortcutPresentation {
  modeLabel: string;
  executionLabel: string;
  inputLabel: string;
  detail: string;
}

const EXTRACT_COMMAND_IDS = [
  'text-extract-characters',
  'text-extract-scenes',
  'text-extract-props',
];

function getTargetTypeLabel(nodeType: NodeType, translate: typeof t): string | undefined {
  const generationType = getGenerationNodeType(nodeType);
  const presetType = PRESET_NODE_TYPES.find((type) => type === generationType);
  // 先从共享中文类型标签去掉分类后缀，再翻译类型本身。
  return presetType ? translate(PRESET_NODE_TYPE_LABELS[presetType].replace(/预设$/u, '')) : undefined;
}

function getBasicPresentation(
  entryPoint: ShortcutEntryPoint,
  sourceNodeType: NodeType,
  insertPrompt: boolean,
  translate: typeof t,
): ShortcutPresentation {
  if (entryPoint === 'toolbar') {
    const typeLabel = getTargetTypeLabel(sourceNodeType, translate);
    return {
      // 工具栏始终新建并立即执行，包括保存为“加入提示词”的基础预设。
      modeLabel: translate('直接触发'),
      executionLabel: typeLabel
        ? translate('新建{type}节点', { type: typeLabel })
        : translate('新建节点'),
      inputLabel: translate('节点提示词＋源节点引用'),
      detail: translate('读取原节点提示词填入模板，附上原节点引用后新建节点并立即生成；引用会提供原节点的正文或媒体。'),
    };
  }

  return {
    modeLabel: translate(insertPrompt ? '加入提示词' : '直接触发'),
    // 提示词面板的筛选类型可能被导演台适配为 ai-text，不据此标注本节点类型。
    executionLabel: translate(insertPrompt ? '本节点提示词' : '本节点'),
    inputLabel: translate('提示词框'),
    detail: translate(insertPrompt
      ? '把提示词框内容填入模板后，追加到本节点提示词，等待手动生成。'
      : '把提示词框内容填入模板，在本节点立即生成；本次模板不会写回提示词框。'),
  };
}

/** 同一内置指令在提示词面板与节点工具栏的执行位置不同。 */
export function getBuiltinShortcutPresentation(
  command: SlashCommandItem,
  entryPoint: ShortcutEntryPoint,
  sourceNodeType: NodeType,
  translate: typeof t = t,
): ShortcutPresentation {
  const presentation = getBasicPresentation(entryPoint, sourceNodeType, false, translate);
  if (entryPoint === 'prompt' && getGenerationNodeType(sourceNodeType) === 'ai-text'
    && EXTRACT_COMMAND_IDS.includes(command.id)) {
    presentation.inputLabel = translate('提示词框／节点正文');
    presentation.detail = translate('优先读取提示词框内容；提取正文为空且没有 @ 节点引用时，读取本节点正文。两者都为空时提示补充正文；已有 @ 引用时按引用读取。');
  }
  if (command.postProcess === 'character-8-direction-grid') {
    presentation.executionLabel += translate('＋新建宫格节点');
    presentation.detail += ' ' + translate('生成成功后还会另建角色8向宫格节点。');
  }
  return presentation;
}

/** 基础预设沿用入口行为；高级预设按每步实际节点类型展示。 */
export function getUserPresetPresentation(
  preset: UserPreset,
  entryPoint: ShortcutEntryPoint,
  sourceNodeType: NodeType,
  translate: typeof t = t,
): ShortcutPresentation {
  if (!isAdvancedPreset(preset) || !preset.advanced) {
    return getBasicPresentation(entryPoint, sourceNodeType, preset.triggerMode !== 'direct', translate);
  }

  const runs: { type: NodeType; count: number }[] = [];
  for (const step of preset.advanced.steps) {
    const previous = runs[runs.length - 1];
    if (previous?.type === step.nodeType) previous.count += 1;
    else runs.push({ type: step.nodeType, count: 1 });
  }
  const types = runs.map(({ type, count }) => {
    const label = getTargetTypeLabel(type, translate) ?? translate('节点');
    return count > 1 ? `${label}×${count}` : label;
  }).join('→');

  return {
    modeLabel: translate(preset.advanced.executionMode === 'parallel' ? '按依赖并发' : '顺序执行'),
    executionLabel: types
      ? translate('新建节点 · {types}', { types })
      : translate('新建节点'),
    inputLabel: translate('原节点提示词＋步骤参考'),
    detail: translate('填写运行参数后新建各步骤节点；模板输入取原节点提示词，各步按设置引用原节点或上一步结果，第一步始终引用原节点。'),
  };
}
