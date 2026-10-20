/** 外部 MCP 客户端的可持久化配置；认证与 SDK 实例不进入 Store。 */
export interface McpClientToolGrant {
  access: 'read' | 'write';
  fingerprint: string;
}

export interface McpClientConnection {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  revision: string;
  authHeader: 'authorization' | 'x-api-key';
  hasSecret: boolean;
  tools: Record<string, McpClientToolGrant>;
}

/** 主窗口投影给独立助手的目录，不包含地址、认证或参数 schema。 */
export interface McpClientOption {
  id: string;
  name: string;
  toolCount: number;
}

export interface McpClientToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  fingerprint: string;
  readOnlyHint: boolean;
}
