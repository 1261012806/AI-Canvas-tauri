import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import ComfyInstallDialog from '../../src/components/comfyui/ComfyInstallDialog';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, Channel: class {} }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

afterEach(() => vi.unstubAllGlobals());

it('安装弹窗首屏就包含目录表单，不等待原生检测成功，也不默认开始安装', () => {
  vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0; Win64; x64' });
  vi.stubGlobal('window', {});
  const html = renderToStaticMarkup(<ComfyInstallDialog onClose={vi.fn()} onInstalled={vi.fn()} onLaunch={vi.fn()} />);
  expect(html).toContain('comfy-install-variant');
  expect(html).toContain('comfy-install-name');
  expect(html).toContain('安装位置');
  expect(html).toContain('选择位置');
  const installButton = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(([button]) => button).find((button) => button.includes('开始安装'));
  expect(installButton).toContain('disabled=""');
  expect(invokeMock).not.toHaveBeenCalled();
});
