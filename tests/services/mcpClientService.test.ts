import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import type { McpClientConnection } from '../../src/types/mcpClient';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../src/services/chat/assistantScope';

const sdk = vi.hoisted(() => ({ request: vi.fn(), connect: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({ ...await importOriginal<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn(async () => undefined) }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  request = sdk.request;
  connect = sdk.connect;
  close = sdk.close;
} }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));

import { callExternalMcp, fingerprintMcpTool, getMcpClientOptions, parseMcpToolArguments, sanitizeMcpValue, selectedMcpConnection, validateMcpClientUrl } from '../../src/services/mcp/mcpClientService';

const tool = { name: 'lookup', description: 'Lookup records', inputSchema: { type: 'object' as const, properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } };
const context = () => ({ projectId: GENERAL_ASSISTANT_SCOPE_ID, conversationId: 'conv-mcp', signal: new AbortController().signal });

async function arrange() {
  const fingerprint = await fingerprintMcpTool(tool);
  const item: McpClientConnection = { id: crypto.randomUUID(), revision: crypto.randomUUID(), name: 'Knowledge', url: 'https://example.com/mcp', enabled: true, hasSecret: false, authHeader: 'authorization', tools: { lookup: { access: 'read', fingerprint } } };
  useAppStore.setState({ config: { ...useAppStore.getState().config, mcpClientConnections: [item] }, conversations: [{
    id: 'conv-mcp', projectId: GENERAL_ASSISTANT_SCOPE_ID, title: 'MCP', titleSource: 'auto', pinned: false, archived: false, agentMode: 'collaborative', createdAt: 1, updatedAt: 1, messageCount: 0, mcpServerIds: [item.id],
  }] });
  return { item, input: { serverId: item.id, toolName: tool.name, arguments: { query: 'hello' }, revision: item.revision, fingerprint, selectionRevision: 'legacy' } };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  sdk.request.mockReset();
  sdk.request.mockImplementation(async ({ method }: { method: string }) => method === 'tools/list'
    ? { tools: [tool] } : { content: [{ type: 'text', text: 'A real result' }] });
});

describe('external MCP client boundaries', () => {
  it('allows only HTTPS or loopback HTTP without embedded credentials', () => {
    expect(validateMcpClientUrl(' http://127.0.0.1:8080/mcp ')).toBe('http://127.0.0.1:8080/mcp');
    for (const url of ['file:///etc/passwd', 'http://example.com/mcp', 'https://user:pass@example.com/mcp', 'https://example.com/mcp?token=secret', 'https://example.com/mcp#fragment']) {
      expect(() => validateMcpClientUrl(url)).toThrow();
    }
  });

  it('does not expose endpoints or credentials in detached options and preserves schema structure', async () => {
    const { item } = await arrange();
    expect(getMcpClientOptions()).toEqual([{ id: item.id, name: item.name, toolCount: 1 }]);
    const schema = { type: 'object', properties: { api_key: { type: 'string' } } };
    expect(sanitizeMcpValue(schema)).toEqual(schema);
    expect(await fingerprintMcpTool({ b: 2, a: 1 })).toBe(await fingerprintMcpTool({ a: 1, b: 2 }));
  });

  it('rejects malformed, non-object and oversized dynamic arguments before sending', () => {
    expect(parseMcpToolArguments('{"query":"hello"}')).toEqual({ query: 'hello' });
    for (const value of ['null', '[]', '1', '{broken', `{"query":"${'x'.repeat(65_536)}"}`]) expect(() => parseMcpToolArguments(value)).toThrow();
  });

  it('requires explicit conversation selection and cannot reuse read authority for writes', async () => {
    const { item, input } = await arrange();
    await expect(callExternalMcp(context(), input, 'write')).rejects.toThrow('授权');
    const conversation = useAppStore.getState().conversations[0];
    useAppStore.setState({ conversations: [{ ...conversation, mcpServerIds: [] }] });
    expect(selectedMcpConnection(context(), item.id)).toBeUndefined();
    await expect(callExternalMcp(context(), input, 'read')).rejects.toThrow('授权');
    expect(sdk.request).not.toHaveBeenCalled();
  });

  it('refreshes tool identity before a call and never executes changed schemas', async () => {
    const { input } = await arrange();
    sdk.request.mockResolvedValue({ tools: [{ ...tool, description: 'Now deletes records' }] });
    await expect(callExternalMcp(context(), input, 'read')).rejects.toThrow('重新授权');
    expect(sdk.request.mock.calls.some(([request]) => request.method === 'tools/call')).toBe(false);
  });

  it('does not revive an earlier proposal after the conversation grants are renewed', async () => {
    const { input } = await arrange();
    const conversation = useAppStore.getState().conversations[0];
    useAppStore.setState({ conversations: [{ ...conversation, mcpSelectionRevision: 'renewed-selection' }] });
    await expect(callExternalMcp(context(), input, 'read')).rejects.toThrow('授权');
    expect(sdk.request).not.toHaveBeenCalled();
  });

  it('revokes a selected service while discovery is pending', async () => {
    const { input } = await arrange();
    let finish: ((value: { tools: typeof tool[] }) => void) | undefined;
    const pending = new Promise<{ tools: typeof tool[] }>((resolve) => { finish = resolve; });
    let started: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    sdk.request.mockImplementation(() => { started!(); return pending; });
    const execution = callExternalMcp(context(), input, 'read');
    await waiting;
    const conversation = useAppStore.getState().conversations[0];
    useAppStore.setState({ conversations: [{ ...conversation, mcpServerIds: [] }] });
    finish!({ tools: [tool] });
    await expect(execution).rejects.toThrow();
    expect(sdk.request.mock.calls.some(([request]) => request.method === 'tools/call')).toBe(false);
  });

  it('returns real text and carries remote execution errors as errors', async () => {
    const { input } = await arrange();
    expect(await callExternalMcp(context(), input, 'read')).toMatchObject({ text: 'A real result', isError: false });
    sdk.request.mockImplementation(async ({ method }: { method: string }) => method === 'tools/list'
      ? { tools: [tool] } : { isError: true, content: [{ type: 'text', text: 'Failed' }] });
    expect(await callExternalMcp(context(), input, 'read')).toMatchObject({ text: 'Failed', isError: true });
  });
});
