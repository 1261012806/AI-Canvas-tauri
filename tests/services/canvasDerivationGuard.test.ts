import { describe, expect, it, vi } from 'vitest';
import {
  cancelCanvasDerivation,
  cancelProjectCanvasDerivations,
  completeCanvasDerivation,
  createOrReuseCanvasDerivationRuntime,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  registerCanvasImport,
} from '../../src/services/canvasDerivationGuard';

function createState(projectId = 'project-a') {
  let revision = 3;
  const state = {
    currentProjectId: projectId as string | null,
    nodes: [{ id: 'source' }, { id: 'placeholder' }],
    getCurrentRevision: () => revision,
  };
  return {
    state,
    setRevision: (nextRevision: number) => { revision = nextRevision; },
  };
}

describe('canvasDerivationGuard', () => {
  it('guards an empty-canvas import and invalidates it on project lifecycle cancellation', () => {
    const { state, setRevision } = createState();
    state.nodes = [];
    const cancel = vi.fn();
    const guard = registerCanvasImport(state, cancel)!;
    expect(isCanvasDerivationFresh(guard, state)).toBe(true);
    setRevision(4);
    expect(isCanvasDerivationFresh(guard, state)).toBe(false);
    setRevision(3);
    cancelProjectCanvasDerivations(state.currentProjectId!);
    expect(cancel).toHaveBeenCalledOnce();
    expect(isCanvasDerivationFresh(guard, state)).toBe(false);
    state.currentProjectId = null;
    expect(registerCanvasImport(state)).toBeNull();
  });
  it('requires the project, revision, source node and placeholder to remain current', () => {
    const { state, setRevision } = createState();
    const guard = registerCanvasDerivation(state, 'source', { placeholderNodeId: 'placeholder' });
    expect(guard).not.toBeNull();
    expect(isCanvasDerivationFresh(guard!, state)).toBe(true);

    setRevision(4);
    expect(isCanvasDerivationFresh(guard!, state)).toBe(false);
    setRevision(3);
    state.nodes = [{ id: 'source' }];
    expect(isCanvasDerivationFresh(guard!, state)).toBe(false);
    state.nodes = [{ id: 'placeholder' }];
    expect(isCanvasDerivationFresh(guard!, state)).toBe(false);
    state.nodes = [{ id: 'source' }, { id: 'placeholder' }];
    state.currentProjectId = 'project-b';
    expect(isCanvasDerivationFresh(guard!, state)).toBe(false);

    cancelCanvasDerivation(guard!);
  });

  it('cancels only operations from the project being switched away from', () => {
    const cleanupA = vi.fn();
    const cleanupB = vi.fn();
    const stateA = createState('project-a').state;
    const stateB = createState('project-b').state;
    const guardA = registerCanvasDerivation(stateA, 'source', { onCancel: cleanupA });
    const guardB = registerCanvasDerivation(stateB, 'source', { onCancel: cleanupB });

    cancelProjectCanvasDerivations('project-a');

    expect(cleanupA).toHaveBeenCalledTimes(1);
    expect(cleanupB).not.toHaveBeenCalled();
    expect(isCanvasDerivationFresh(guardA!, stateA)).toBe(false);
    expect(isCanvasDerivationFresh(guardB!, stateB)).toBe(true);
    completeCanvasDerivation(guardB!);
  });

  it('runs cleanup at most once', () => {
    const cleanup = vi.fn();
    const state = createState().state;
    const guard = registerCanvasDerivation(state, 'source', { onCancel: cleanup });

    cancelCanvasDerivation(guard!);
    cancelCanvasDerivation(guard!);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-flight result valid after hot reload and lets the old executor complete it', () => {
    const hotData = {};
    const oldExecutor = createOrReuseCanvasDerivationRuntime(hotData);
    const { state } = createState();
    const guard = oldExecutor.registerCanvasDerivation(state, 'source')!;
    const refreshed = createOrReuseCanvasDerivationRuntime(hotData);
    expect(refreshed.isCanvasDerivationFresh(guard, state)).toBe(true);
    oldExecutor.completeCanvasDerivation(guard);
    expect(refreshed.isCanvasDerivationFresh(guard, state)).toBe(false);
  });

  it('lets refreshed project cancellation stop old generation and import operations once', () => {
    const hotData = {};
    const oldExecutor = createOrReuseCanvasDerivationRuntime(hotData);
    const { state } = createState();
    const generationCancelled = vi.fn();
    const importCancelled = vi.fn();
    const guard = oldExecutor.registerCanvasDerivation(state, 'source', { onCancel: generationCancelled })!;
    const imported = oldExecutor.registerCanvasImport(state, importCancelled)!;
    const refreshed = createOrReuseCanvasDerivationRuntime(hotData);
    refreshed.cancelProjectCanvasDerivations('project-a');
    oldExecutor.cancelCanvasDerivation(guard);
    refreshed.cancelCanvasDerivation(imported);
    expect(generationCancelled).toHaveBeenCalledOnce();
    expect(importCancelled).toHaveBeenCalledOnce();
    expect(oldExecutor.isCanvasDerivationFresh(guard, state)).toBe(false);
    expect(refreshed.isCanvasDerivationFresh(imported, state)).toBe(false);
  });

  it('keeps unique operation identities when old and refreshed executors register in the same millisecond', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const hotData = {};
      const oldExecutor = createOrReuseCanvasDerivationRuntime(hotData);
      const { state } = createState();
      const first = oldExecutor.registerCanvasDerivation(state, 'source')!;
      const refreshed = createOrReuseCanvasDerivationRuntime(hotData);
      const second = refreshed.registerCanvasDerivation(state, 'source')!;
      const third = oldExecutor.registerCanvasDerivation(state, 'source')!;
      expect(new Set([first.operationId, second.operationId, third.operationId]).size).toBe(3);
      refreshed.completeCanvasDerivation(second);
      expect(oldExecutor.isCanvasDerivationFresh(first, state)).toBe(true);
      expect(refreshed.isCanvasDerivationFresh(second, state)).toBe(false);
      expect(refreshed.isCanvasDerivationFresh(third, state)).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it('keeps fresh document runtimes isolated and retains revision and placeholder checks across hot reload', () => {
    const hotData = {};
    const oldExecutor = createOrReuseCanvasDerivationRuntime(hotData);
    const { state, setRevision } = createState();
    const guard = oldExecutor.registerCanvasDerivation(state, 'source', { placeholderNodeId: 'placeholder' })!;
    const refreshed = createOrReuseCanvasDerivationRuntime(hotData);
    expect(createOrReuseCanvasDerivationRuntime().isCanvasDerivationFresh(guard, state)).toBe(false);
    expect(createOrReuseCanvasDerivationRuntime({}).isCanvasDerivationFresh(guard, state)).toBe(false);
    setRevision(4);
    expect(refreshed.isCanvasDerivationFresh(guard, state)).toBe(false);
    setRevision(3);
    state.nodes = [{ id: 'source' }];
    expect(refreshed.isCanvasDerivationFresh(guard, state)).toBe(false);
  });
});
