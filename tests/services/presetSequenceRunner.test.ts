import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData, PresetAdvancedConfig, PresetSequenceStep, UserPreset } from '../../src/types';
import { useAppStore } from '../../src/store/useAppStore';
import * as generationService from '../../src/services/generationService';
import { runPresetSequence } from '../../src/services/presetSequenceService';
import { MAX_PRESET_CONCURRENCY } from '../../src/services/presetTemplateService';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function arrange(
  references: Array<PresetSequenceStep['referenceSource']>,
  executionMode?: PresetAdvancedConfig['executionMode'],
) {
  const preset: UserPreset = {
    id: 'preset-series', nodeType: 'ai-image', name: '产品系列', description: '',
    promptTemplate: '', triggerMode: 'direct', mode: 'advanced',
    advanced: {
      executionMode,
      parameters: [],
      steps: references.map((referenceSource, index) => ({
        id: `step-${index}`, name: `主题 ${index}`, nodeType: 'ai-image',
        promptTemplate: `生成主题 ${index}`, referenceSource,
      })),
    },
  };
  const state: ReturnType<typeof useAppStore.getState> = {
    ...useAppStore.getInitialState(),
    currentProjectId: 'project-1',
    nodes: [{ id: 'source', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '产品原图', role: 'source', status: 'success' } }],
  };
  const planned: Node<BaseNodeData>[] = [];
  state.addNodesWithEdges = vi.fn((nodes: Node<BaseNodeData>[]) => {
    planned.push(...nodes);
    state.nodes = [...state.nodes, ...nodes];
  });
  state.showToast = vi.fn();
  vi.spyOn(useAppStore, 'getState').mockImplementation(() => state);

  const calls: number[] = [];
  const started = references.map(() => deferred<void>());
  const responses = references.map(() => deferred<generationService.GenerationResult>());
  const executions: Array<Promise<generationService.GenerationResult>> = [];
  let active = 0;
  let peak = 0;
  vi.spyOn(generationService, 'executeGeneration').mockImplementation((nodeId) => {
    const index = planned.findIndex((node) => node.id === nodeId);
    if (index < 0) throw new Error('执行了不属于本次指令的节点');
    calls.push(index);
    active += 1;
    peak = Math.max(peak, active);
    started[index].resolve(undefined);
    executions[index] = responses[index].promise.finally(() => { active -= 1; });
    return executions[index];
  });

  return {
    state, planned, calls, started, responses, executions,
    peakActive: () => peak,
    run: () => runPresetSequence({ preset, sourceNodeId: 'source', values: {} }),
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('runPresetSequence 调度', () => {
  it('未选择执行模式时，同源独立步骤仍逐个生成', async () => {
    const task = arrange(['source', 'source', 'source']);
    const result = task.run();
    expect(task.calls).toEqual([0]);
    task.responses[0].resolve({ success: true });
    await task.started[1].promise;
    expect(task.calls).toEqual([0, 1]);
    task.responses[1].resolve({ success: true });
    await task.started[2].promise;
    expect(task.calls).toEqual([0, 1, 2]);
    task.responses[2].resolve({ success: true });
    await expect(result).resolves.toEqual({ success: true, completedSteps: 3 });
    expect(task.peakActive()).toBe(1);
    expect(task.state.addNodesWithEdges).toHaveBeenCalledOnce();
  });

  it('并发模式同时启动同源步骤，释放槽位后再启动下一步且不超过上限', async () => {
    const count = MAX_PRESET_CONCURRENCY + 2;
    const task = arrange(Array.from({ length: count }, () => 'source'), 'parallel');
    const result = task.run();
    expect(task.calls).toEqual(Array.from({ length: MAX_PRESET_CONCURRENCY }, (_, index) => index));

    for (let index = 0; index < 2; index += 1) {
      task.responses[index].resolve({ success: true });
      await task.started[MAX_PRESET_CONCURRENCY + index].promise;
      expect(task.calls).toHaveLength(MAX_PRESET_CONCURRENCY + index + 1);
    }
    for (let index = 2; index < count; index += 1) task.responses[index].resolve({ success: true });
    await expect(result).resolves.toEqual({ success: true, completedSteps: count });
    expect(task.peakActive()).toBe(MAX_PRESET_CONCURRENCY);
  });

  it('混合引用仅等待真正的前一步依赖，不等待无关分支', async () => {
    const task = arrange(['source', 'previous', 'source', 'previous', 'source'], 'parallel');
    const result = task.run();
    expect(task.calls).toEqual([0, 2, 4]);

    task.responses[2].resolve({ success: true });
    await task.started[3].promise;
    expect(task.calls).toEqual([0, 2, 4, 3]);
    task.responses[0].resolve({ success: true });
    await task.started[1].promise;
    expect(task.calls).toEqual([0, 2, 4, 3, 1]);
    for (const index of [1, 3, 4]) task.responses[index].resolve({ success: true });
    await expect(result).resolves.toEqual({ success: true, completedSteps: 5 });
    expect(task.peakActive()).toBeLessThanOrEqual(MAX_PRESET_CONCURRENCY);
  });

  it.each(['失败结果', '异常拒绝'] as const)('%s 停止启动新任务，等待已开始任务并保留成功数', async (failureKind) => {
    const task = arrange(['source', 'source', 'source', 'source', 'source'], 'parallel');
    const result = task.run();
    expect(task.calls).toEqual([0, 1, 2]);
    if (failureKind === '失败结果') task.responses[1].resolve({ success: false, message: '模型拒绝请求' });
    else task.responses[1].reject(new Error('模型连接异常'));
    await task.executions[1].catch(() => undefined);
    task.responses[0].resolve({ success: true });
    await task.executions[0];
    task.responses[2].resolve({ success: true });

    await expect(result).resolves.toEqual({
      success: false, completedSteps: 2, failedStepIndex: 1,
      message: failureKind === '失败结果' ? '模型拒绝请求' : '模型连接异常',
    });
    expect(task.calls).toEqual([0, 1, 2]);
    expect(task.state.showToast).toHaveBeenLastCalledWith(expect.stringContaining('已停在步骤 2'), 'error');
  });

  it('删除仍在等待依赖的步骤后，也停止启动已就绪的独立分支', async () => {
    const task = arrange(['source', 'previous', 'source', 'previous', 'source'], 'parallel');
    const result = task.run();
    expect(task.calls).toEqual([0, 2, 4]);
    task.state.nodes = task.state.nodes.filter((node) => node.id !== task.planned[1].id);
    task.responses[3].resolve({ success: true });
    task.responses[2].resolve({ success: true });
    await task.executions[2];
    // 让已完成分支的 Promise.race 通知调度器，步骤 0 此时仍未结束。
    await Promise.resolve();
    await Promise.resolve();
    task.responses[0].resolve({ success: true });
    task.responses[4].resolve({ success: true });
    await expect(result).resolves.toMatchObject({ success: false, completedSteps: 3, failedStepIndex: 1 });
    expect(task.calls).toEqual([0, 2, 4]);
  });

  it.each(['切换项目', '删除原图', '删除待执行节点', '删除运行节点'] as const)('%s 后不再启动后续步骤', async (change) => {
    const task = arrange(['source', 'source', 'source']);
    const result = task.run();
    expect(task.calls).toEqual([0]);
    if (change === '切换项目') task.state.currentProjectId = 'project-2';
    else {
      const removedId = change === '删除原图' ? 'source'
        : task.planned[change === '删除待执行节点' ? 1 : 0].id;
      task.state.nodes = task.state.nodes.filter((node) => node.id !== removedId);
    }
    task.responses[0].resolve({ success: true });

    await expect(result).resolves.toMatchObject({
      success: false,
      completedSteps: change === '切换项目' || change === '删除运行节点' ? 0 : 1,
    });
    expect(task.calls).toEqual([0]);
  });
});
