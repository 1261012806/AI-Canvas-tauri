/**
 * Agent 工具权限的本地固定策略矩阵，根据模式和 effect 返回放行、确认或拒绝决策。
 */
import type { AgentMode } from '../../types/agent';
import type {
  AgentToolDefinition,
  AgentToolEffect,
} from './toolRegistry';

export type AgentPolicyDecision =
  | { outcome: 'allow'; reason: string }
  | {
      outcome: 'require_approval';
      reason: string;
      approvalKind: Exclude<AgentToolEffect, 'read'>;
    }
  | { outcome: 'deny'; reason: string; errorCode: string };

export interface AgentPolicyContext {
  mode: AgentMode;
  projectId: string;
  conversationId: string;
  taskId: string;
  baseRevision?: number;
}

export function evaluateAgentToolPolicy(
  definition: AgentToolDefinition,
  input: unknown,
  context: AgentPolicyContext,
): AgentPolicyDecision {
  if (context.mode === 'plan' && definition.effect !== 'read') {
    return {
      outcome: 'deny',
      reason: 'Plan 模式只允许使用只读工具',
      errorCode: 'AGENT_PLAN_MODE_READ_ONLY',
    };
  }

  const authorization = definition.authorize?.(context, input);
  if (authorization && !authorization.allowed) {
    return {
      outcome: 'deny',
      reason: authorization.reason || '当前会话没有执行该工具的授权',
      errorCode: 'AGENT_TOOL_UNAUTHORIZED',
    };
  }

  // 需要用户作答的工具在任何模式下都必须停下等人：自动"批准"等于替用户做决定，
  // 拿不到选择结果，工具本身也无事可做。
  if (definition.effect === 'user_choice') {
    return {
      outcome: 'require_approval',
      reason: '需要你从清单中选择',
      approvalKind: 'user_choice',
    };
  }

  if (context.mode === 'autonomous') {
    return {
      outcome: 'allow',
      reason: `C 自主模式允许自动执行 ${definition.effect} 工具`,
    };
  }

  switch (definition.effect) {
    case 'read':
      return { outcome: 'allow', reason: '只读工具可自动执行' };
    case 'canvas_write':
      return {
        outcome: 'require_approval',
        reason: 'B 协作模式的画布写操作需要确认',
        approvalKind: 'canvas_write',
      };
    case 'file_write':
      return {
        outcome: 'require_approval',
        reason: '本地文件写入始终需要确认',
        approvalKind: 'file_write',
      };
    case 'permanent_delete':
      return {
        outcome: 'require_approval',
        reason: '永久删除始终需要二次确认',
        approvalKind: 'permanent_delete',
      };
    case 'media_generation':
      return {
        outcome: 'require_approval',
        reason: '付费媒体生成和重新生成每次都需要确认',
        approvalKind: 'media_generation',
      };
    case 'memory_write':
      return {
        outcome: 'require_approval',
        reason: '项目记忆必须由用户确认后保存',
        approvalKind: 'memory_write',
      };
    case 'config_write':
      return {
        outcome: 'require_approval',
        reason: 'API 厂商配置必须由用户确认后保存',
        approvalKind: 'config_write',
      };
    case 'asset_write':
      return {
        outcome: 'require_approval',
        reason: '写入资产库与角色库必须由用户确认',
        approvalKind: 'asset_write',
      };
    case 'external_write':
      return {
        outcome: 'require_approval',
        reason: 'B 协作模式的外部 MCP 操作需要确认',
        approvalKind: 'external_write',
      };
  }
}
