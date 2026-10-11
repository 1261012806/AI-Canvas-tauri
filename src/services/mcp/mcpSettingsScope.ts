/** 应用设置审计域：不创建或选中 CanvasProject，也不向项目工具授予访问权。 */
export const MCP_SETTINGS_SCOPE_ID = 'mcp-global-settings';
export const MCP_SETTINGS_CONVERSATION_ID = `mcp-control-${MCP_SETTINGS_SCOPE_ID}`;
export const MCP_SETTINGS_TOOL_NAMES = [
  'tools_search', 'tools_describe', 'provider_docs_read', 'provider_models_select',
  'provider_config_preview', 'provider_config_apply',
] as const;

interface Scope {
  projectId: string;
  conversationId: string;
  toolAllowlist?: readonly string[];
}

export function isMcpSettingsTool(name: string): boolean {
  return MCP_SETTINGS_TOOL_NAMES.some((value) => value === name);
}

export function isMcpSettingsContext(context: Scope): boolean {
  return context.projectId === MCP_SETTINGS_SCOPE_ID
    && context.conversationId === MCP_SETTINGS_CONVERSATION_ID
    && Boolean(context.toolAllowlist?.length)
    && context.toolAllowlist!.every(isMcpSettingsTool);
}

export function isMcpSettingsToolContext(context: Scope, toolName: string): boolean {
  return isMcpSettingsContext(context) && isMcpSettingsTool(toolName)
    && context.toolAllowlist!.includes(toolName);
}
