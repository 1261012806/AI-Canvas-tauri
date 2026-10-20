import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import AgentCenterPanel, {
  AgentPackageCard,
} from '../../src/components/chat/AgentCenterPanel';
import EmptyChatState from '../../src/components/chat/EmptyChatState';
import { setLocale } from '../../src/i18n';
import { useAppStore } from '../../src/store/useAppStore';
import type { AgentPackageInstallation } from '../../src/types/agentPackage';

function installation(
  partial: Partial<AgentPackageInstallation> = {},
): AgentPackageInstallation {
  return {
    id: 'agent-package-1',
    packageId: 'com.example.drama',
    manifest: {
      schemaVersion: 1,
      id: 'com.example.drama',
      name: '短剧制作助手',
      version: '1.2.0',
      description: '按阶段协助短剧制作',
      entrypoints: { instructions: 'AGENTS.md' },
      supportedScopes: ['global', 'project'],
      supportedSurfaces: ['assistant'],
      routing: { userInvocable: true, autoInvoke: false },
    },
    source: {
      sourceId: 'opaque-source-1',
      sourceType: 'folder',
      displayName: '短剧知识库',
    },
    entrypoints: ['AGENTS.md'],
    skillCount: 28,
    fileCount: 534,
    totalBytes: 620_000_000,
    warnings: ['文档记录的 Skill 数量与扫描结果不一致'],
    health: 'ready',
    contentHash: 'hash-1',
    enabled: true,
    mcpSkillReadEnabled: false,
    installedAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

beforeEach(() => {
  setLocale('zh-CN');
  useAppStore.setState({
    agentPackages: [],
    agentCatalogStatus: 'ready',
    agentCatalogErrorCode: undefined,
    agentPackageSkillCatalogErrorCode: undefined,
  });
});

describe('AgentCenterPanel', () => {
  it('零智能体时保留默认助手并提供两种上传入口', () => {
    const markup = renderToStaticMarkup(
      <AgentCenterPanel allowInstall onClose={() => {}} />,
    );

    expect(markup).toContain('默认助手');
    expect(markup).toContain('始终可用');
    expect(markup).toContain('选择文件夹');
    expect(markup).toContain('选择压缩包');
    expect(markup).toContain('还没有安装外部智能体');
    expect(markup).toContain('这不会影响默认助手和软件其他功能');
  });

  it('展示安装包版本、来源、健康、规模、提醒和状态操作', () => {
    const markup = renderToStaticMarkup(
      <AgentPackageCard
        installation={installation()}
        busy={false}
        allowInstall
        onToggle={() => {}}
        onToggleMcpSkillRead={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain('短剧制作助手');
    expect(markup).toContain('v1.2.0');
    expect(markup).toContain('链接文件夹');
    expect(markup).toContain('28 个 Skill');
    expect(markup).toContain('534 个文件');
    expect(markup).toContain('文档记录的 Skill 数量与扫描结果不一致');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('MCP 只读');
    expect(markup).toContain('允许 MCP 读取智能体 短剧制作助手 的 Skill');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('移除智能体 短剧制作助手');
  });

  it('只读投影不显示上传、启停和移除入口', () => {
    const markup = renderToStaticMarkup(
      <AgentPackageCard
        installation={installation()}
        busy={false}
        allowInstall={false}
        onToggle={() => {}}
        onToggleMcpSkillRead={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain('短剧制作助手');
    expect(markup).not.toContain('aria-checked');
    expect(markup).not.toContain('移除智能体 短剧制作助手');
  });

  it('大纲默认折叠，完整展示多层入口并合并重复的目录和 Skill', () => {
    const markup = renderToStaticMarkup(
      <AgentPackageCard
        installation={installation({ entrypoints: [
          'AGENTS.md',
          '02-剧本创作/writer/SKILL.md',
          './02-剧本创作\\writer\\SKILL.md',
          '海外短剧/02-剧本创作/optimizer/SKILL.md',
          ...Array.from({ length: 28 }, (_, index) => `04-分镜设计/shot-${index}/SKILL.md`),
        ] })}
        busy={false}
        allowInstall
        onToggle={() => {}}
        onToggleMcpSkillRead={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain('智能体大纲');
    expect(markup.match(/<details[^>]*>/)?.[0]).not.toContain('open');
    expect(markup).toContain('AGENTS.md');
    expect(markup).toContain('02-剧本创作');
    expect(markup).toContain('海外短剧');
    expect(markup.match(/>writer</g)).toHaveLength(1);
    expect(markup).toContain('optimizer');
    for (let index = 0; index < 28; index += 1) {
      expect(markup).toContain(`>shot-${index}<`);
    }
  });

  it('停用和只读卡片仍可浏览安装目录，包内文本不会成为 HTML', () => {
    const markup = renderToStaticMarkup(
      <AgentPackageCard
        installation={installation({ enabled: false, entrypoints: ['<script>alert(1)</script>/SKILL.md'] })}
        busy={false}
        allowInstall={false}
        onToggle={() => {}}
        onToggleMcpSkillRead={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain('智能体大纲');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('role="switch"');
  });
});

describe('EmptyChatState', () => {
  it('使用通用助手文案并在主窗口提供智能体中心入口', () => {
    const markup = renderToStaticMarkup(
      <EmptyChatState
        onNew={() => {}}
        onList={() => {}}
        onOpenAgents={() => {}}
      />,
    );

    expect(markup).toContain('有什么可以帮你？');
    expect(markup).toContain('问答、写作、翻译和资料分析，直接开始就好。对话会自动保存。');
    expect(markup).toContain('智能体中心');
    expect(markup).not.toContain('画布 AI 助手');
  });
});
