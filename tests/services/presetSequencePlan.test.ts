import { describe, expect, it } from 'vitest';
import { buildPresetSequencePlan } from '../../src/services/presetSequenceService';
import { validatePresetAdvancedConfig } from '../../src/services/presetTemplateService';
import type { BaseNodeData, PresetSequenceStep, UserPreset } from '../../src/types';

const preset: UserPreset = {
  id: 'preset-1',
  nodeType: 'ai-image',
  name: '两步链',
  description: '',
  promptTemplate: '',
  triggerMode: 'direct',
  mode: 'advanced',
  advanced: {
    parameters: [],
    steps: [
      { id: 's1', name: '步骤 1', nodeType: 'ai-image', promptTemplate: '{{currentPrompt}} 放大' },
      { id: 's2', name: '步骤 2', nodeType: 'ai-image', promptTemplate: '再来一版' },
    ],
  },
};

const source = (data: Partial<BaseNodeData>, parentId?: string) => ({
  id: 'node-src',
  position: { x: 10, y: 20 },
  ...(parentId ? { parentId } : {}),
  data: {
    type: 'ai-image',
    label: '源图',
    role: 'source',
    status: 'success',
    prompt: '一只猫',
    ...data,
  } as BaseNodeData,
});

describe('buildPresetSequencePlan', () => {
  it('源节点在分组内时，派生节点继承 parentId，否则坐标会被当成绝对值', () => {
    const { nodes } = buildPresetSequencePlan({
      preset,
      sourceNode: source({}, 'group-1'),
      values: {},
    });
    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.parentId === 'group-1')).toBe(true);
  });

  it('不在分组内时不写 parentId', () => {
    const { nodes } = buildPresetSequencePlan({ preset, sourceNode: source({}), values: {} });
    expect(nodes[0].parentId).toBeUndefined();
  });

  it('旧指令未设置参考来源时，提示词和连线仍按上一步串联', () => {
    const { nodes, edges } = buildPresetSequencePlan({ preset, sourceNode: source({}), values: {} });
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([
      ['node-src', nodes[0].id],
      [nodes[0].id, nodes[1].id],
    ]);
    expect(nodes[1].data.prompt).toBe(`@{${nodes[0].id}:步骤 1}\n再来一版`);
  });

  it('各步骤选择原始输入时，全部引用并连向同一源图，保留各自主题', () => {
    const { nodes, edges } = buildPresetSequencePlan({
      preset: {
        ...preset,
        advanced: {
          parameters: [],
          steps: ['产品特写', '人物使用', '生活场景'].map((theme, index): PresetSequenceStep => ({
            id: `theme-${index}`,
            name: theme,
            nodeType: 'ai-image',
            referenceSource: 'source',
            promptTemplate: theme,
          })),
        },
      },
      sourceNode: source({}),
      values: {},
    });
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual(
      nodes.map((node) => ['node-src', node.id]),
    );
    expect(nodes.map((node) => node.data.prompt)).toEqual([
      '@{node-src:源图}\n产品特写',
      '@{node-src:源图}\n人物使用',
      '@{node-src:源图}\n生活场景',
    ]);
  });

  it('可在同一指令中混用原始输入和上一步结果', () => {
    const { nodes, edges } = buildPresetSequencePlan({
      preset: {
        ...preset,
        advanced: {
          parameters: [],
          steps: [
            preset.advanced!.steps[0],
            { ...preset.advanced!.steps[1], referenceSource: 'source' },
            { id: 's3', name: '步骤 3', nodeType: 'ai-image', referenceSource: 'previous', promptTemplate: '细化场景' },
          ],
        },
      },
      sourceNode: source({}),
      values: {},
    });
    expect(edges.map((edge) => edge.source)).toEqual(['node-src', 'node-src', nodes[1].id]);
    expect(nodes[2].data.prompt).toBe(`@{${nodes[1].id}:步骤 2}\n细化场景`);
  });

  it('首步即使设置上一步结果，也回到原始输入', () => {
    const { nodes, edges } = buildPresetSequencePlan({
      preset: {
        ...preset,
        advanced: {
          parameters: [],
          steps: [{ ...preset.advanced!.steps[0], referenceSource: 'previous' }],
        },
      },
      sourceNode: source({}),
      values: {},
    });
    expect(edges[0].source).toBe('node-src');
    expect(nodes[0].data.prompt).toBe('@{node-src:源图}\n一只猫 放大');
  });

  it('provider=comfyui 时继承源节点 workflowId，步骤自带的优先', () => {
    const withWorkflow: UserPreset = {
      ...preset,
      advanced: {
        parameters: [],
        steps: [
          preset.advanced!.steps[0],
          { ...preset.advanced!.steps[1], provider: 'comfyui', model: 'comfyui/workflow', workflowId: 'wf-step' },
        ],
      },
    };
    const { nodes } = buildPresetSequencePlan({
      preset: withWorkflow,
      sourceNode: source({ provider: 'comfyui', model: 'comfyui/workflow', workflowId: 'wf-src' }),
      values: {},
    });
    expect(nodes[0].data.workflowId).toBe('wf-src');
    expect(nodes[1].data.workflowId).toBe('wf-step');
  });

  it('非 comfyui 步骤不带 workflowId', () => {
    const { nodes } = buildPresetSequencePlan({
      preset,
      sourceNode: source({ provider: 'apimart', model: 'z-image', workflowId: 'wf-src' }),
      values: {},
    });
    expect(nodes[0].data.workflowId).toBeUndefined();
  });
});

describe('composeStepPrompt / previousResult', () => {
  it('模板不写 previousResult 时，上一步引用仍然前置', () => {
    const { nodes } = buildPresetSequencePlan({ preset, sourceNode: source({}), values: {} });
    expect(nodes[0].data.prompt).toBe('@{node-src:源图}\n一只猫 放大');
  });

  it('模板写了 {{previousResult}} 就按写的位置插入，不再前置', () => {
    const withSlot: UserPreset = {
      ...preset,
      advanced: {
        parameters: [],
        steps: [{
          id: 's1',
          name: '步骤 1',
          nodeType: 'ai-image',
          promptTemplate: '参考 {{previousResult}} 的构图，主体换成狗',
        }],
      },
    };
    const { nodes } = buildPresetSequencePlan({ preset: withSlot, sourceNode: source({}), values: {} });
    expect(nodes[0].data.prompt).toBe('参考 @{node-src:源图} 的构图，主体换成狗');
  });

  it('后续步骤选择原始输入时，旧变量槽位引用原图且不会混入上一步结果', () => {
    const { nodes } = buildPresetSequencePlan({
      preset: {
        ...preset,
        advanced: {
          parameters: [],
          steps: [
            preset.advanced!.steps[0],
            { ...preset.advanced!.steps[1], referenceSource: 'source', promptTemplate: '参考 {{previousResult}}，生成生活场景' },
          ],
        },
      },
      sourceNode: source({}),
      values: {},
    });
    expect(nodes[1].data.prompt).toBe('参考 @{node-src:源图}，生成生活场景');
  });
});

describe('validatePresetAdvancedConfig', () => {
  it('拒绝未知的执行方式，保留缺省顺序兼容', () => {
    expect(validatePresetAdvancedConfig(preset.advanced!)).toEqual([]);
    expect(validatePresetAdvancedConfig({
      ...preset.advanced!,
      executionMode: 'unknown' as 'parallel',
    })).toContain('快捷指令的执行方式无效');
  });

  it('拒绝未知的步骤参考来源', () => {
    const errors = validatePresetAdvancedConfig({
      parameters: [],
      steps: [{ ...preset.advanced!.steps[0], referenceSource: 'unknown' as 'source' }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('参考来源无效');
  });

  it('参数变量名占用内置变量时报错', () => {
    const errors = validatePresetAdvancedConfig({
      parameters: [{ id: 'p1', key: 'previousResult', label: '风格', type: 'text' }],
      steps: preset.advanced!.steps,
    });
    expect(errors[0]).toContain('内置变量');
  });

  it('{{previousResult}} 是合法变量，不算未定义', () => {
    const errors = validatePresetAdvancedConfig({
      parameters: [],
      steps: [{ id: 's1', name: '步骤 1', nodeType: 'ai-image', promptTemplate: '{{previousResult}} 放大' }],
    });
    expect(errors).toEqual([]);
  });
});
