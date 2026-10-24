import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LazyLoadBoundary } from '../../src/components/shared/LazyLoadBoundary';

describe('LazyLoadBoundary recovery', () => {
  it('keeps the plain button and its action when an effect fails', () => {
    const onClick = vi.fn();
    const fallback = <button onClick={onClick}>生成</button>;
    const boundary = new LazyLoadBoundary({
      label: '按钮特效', children: <span>effect</span>, errorFallback: fallback,
    });
    boundary.state = LazyLoadBoundary.getDerivedStateFromError();
    expect(boundary.render()).toBe(fallback);
    fallback.props.onClick();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('hides a failed decoration when its fallback is null', () => {
    const boundary = new LazyLoadBoundary({ label: '边框', children: <span />, errorFallback: null });
    boundary.state = LazyLoadBoundary.getDerivedStateFromError();
    expect(boundary.render()).toBeNull();
  });

  it.each([
    ['project-a', 'node-b'],
    ['project-a', null],
    ['project-b', 'node-a'],
  ])('recovers after switching to %s / %s', (projectId, nodeId) => {
    const props = { label: '节点编辑器', children: <input />, resetKey: JSON.stringify(['project-a', 'node-a']) };
    const boundary = new LazyLoadBoundary(props);
    boundary.state = { ...boundary.state, ...LazyLoadBoundary.getDerivedStateFromError() };
    expect(LazyLoadBoundary.getDerivedStateFromProps(props, boundary.state)).toBeNull();
    const next = { ...props, resetKey: JSON.stringify([projectId, nodeId]) };
    const recovery = LazyLoadBoundary.getDerivedStateFromProps(next, boundary.state);
    expect(recovery).toEqual({ failed: false, resetKey: next.resetKey });
    boundary.state = { ...boundary.state, ...recovery };
    expect(boundary.render()).toBe(props.children);
  });

  it('preserves the existing error message for features without a custom fallback', () => {
    const boundary = new LazyLoadBoundary({ label: '节点编辑器', children: null });
    boundary.state = LazyLoadBoundary.getDerivedStateFromError();
    expect(renderToStaticMarkup(boundary.render())).toContain('节点编辑器加载失败');
  });
});
