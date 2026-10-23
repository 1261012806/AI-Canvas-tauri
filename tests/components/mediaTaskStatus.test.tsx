import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const mocks = vi.hoisted(() => ({
  state: { currentProjectId: 'project' as string | null,
    nodes: [{ id: 'media', data: { type: 'ai-image', label: '图片', mediaTaskState: 'paused', status: 'idle' } as BaseNodeData }],
    showToast: vi.fn() },
  tasks: [] as Array<Record<string, unknown>>, resume: vi.fn(), discard: vi.fn(),
  busy: false, confirmed: undefined as string | undefined, cursor: 0,
}));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'),
  memo: <T,>(component: T) => component,
  useState: () => mocks.cursor++ === 0
    ? [mocks.busy, (value: boolean) => { mocks.busy = value; }]
    : [mocks.confirmed, (value: string | undefined) => { mocks.confirmed = value; }],
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state) }));
vi.mock('../../src/services/pollManager', () => ({
  getPendingTasksForProject: () => mocks.tasks, resumeMediaNodeTask: mocks.resume, discardMediaTask: mocks.discard,
}));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
import MediaTaskStatus from '../../src/components/nodes/shared/MediaTaskStatus';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function render(overlay = false) { mocks.cursor = 0; return MediaTaskStatus({ nodeId: 'media', overlay }); }
const queryButton = () => elements(render()).find((element) => element.props['aria-label'] === '继续查询 / 保存');

beforeEach(() => {
  mocks.busy = false; mocks.confirmed = undefined; mocks.state.currentProjectId = 'project';
  mocks.state.nodes[0].data = { type: 'ai-image', label: '图片', mediaTaskState: 'paused', status: 'idle' };
  mocks.tasks = [{ projectId: 'project', nodeId: 'media', nodeType: 'ai-image', taskId: 'original', attemptId: 'first', submitted: true, mediaRecoveryState: 'query_paused' }];
  mocks.resume.mockReset().mockResolvedValue(undefined); mocks.discard.mockReset(); mocks.state.showToast.mockReset();
});

describe('跨媒体原任务续取入口', () => {
  it.each(['ai-image', 'ai-video', 'ai-audio'] as const)('%s 复用 UI Kit 按钮且只调用续取', async (kind) => {
    mocks.tasks[0].nodeType = kind;
    const button = queryButton()!;
    expect(button.props.className).toContain(`ui-btn--node-${kind.slice(3)}`);
    (button.props.onClick as () => void)();
    expect(mocks.resume).toHaveBeenCalledWith('media');
    expect(queryButton()?.props.disabled).toBe(true);
    await vi.waitFor(() => expect(mocks.busy).toBe(false));
  });

  it('提交未知不提供伪查询，解除记录必须确认当前attempt', () => {
    mocks.tasks[0].taskId = ''; mocks.tasks[0].submitted = false;
    mocks.state.nodes[0].data.mediaTaskState = 'submit_unknown';
    expect(queryButton()).toBeUndefined();
    const checkbox = elements(render()).find((element) => element.type === 'input')!;
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    let clear = elements(render()).find((element) => element.type === 'button')!;
    expect(clear.props.disabled).toBe(false);
    mocks.tasks[0].attemptId = 'new-attempt';
    clear = elements(render()).find((element) => element.type === 'button')!;
    expect(clear.props.disabled).toBe(true);
    expect(mocks.discard).not.toHaveBeenCalled();
  });

  it('生成成功但保存未完成显示交付阶段，并保留查询入口', () => {
    mocks.state.nodes[0].data.mediaTaskState = 'delivery_pending';
    mocks.tasks[0].mediaRecoveryState = 'delivery_pending';
    expect(elements(render()).find((element) => element.type === 'span')?.props.children)
      .toBe('媒体已生成，保存或回填尚未完成；可继续取回原结果。');
    expect(queryButton()).toBeDefined();
  });

  it('批量已取得部分ID但后续提交未知时仍禁止伪续取', () => {
    mocks.tasks[0].mediaSubmissionUncertain = true;
    mocks.tasks[0].mediaRecoveryState = 'submit_unknown';
    mocks.state.nodes[0].data.mediaTaskState = 'submit_unknown';
    expect(queryButton()).toBeUndefined();
    expect(elements(render()).some((element) => element.type === 'input')).toBe(true);
  });

  it('查询正在进行或项目未打开时不重复显示恢复按钮', () => {
    mocks.state.nodes[0].data.status = 'loading'; expect(render()).toBeNull();
    mocks.state.nodes[0].data.status = 'idle'; mocks.state.currentProjectId = null; expect(render()).toBeNull();
  });
});
