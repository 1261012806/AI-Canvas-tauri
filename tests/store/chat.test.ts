import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversation, ChatMessage } from '../../src/types/chat';

const historyMocks = vi.hoisted(() => ({
  saveConversation: vi.fn(async () => undefined),
  softDeleteConversation: vi.fn(async (conversation: ChatConversation) => conversation),
  loadProjectConversations: vi.fn<() => Promise<ChatConversation[]>>(),
  loadMessages: vi.fn<() => Promise<{ messages: ChatMessage[]; total: number }>>(),
  persistMessage: vi.fn(async () => undefined),
  clearConversationMessages: vi.fn(async () => undefined),
  repairInterruptedMessages: vi.fn(async () => [] as string[]),
}));

vi.mock('../../src/services/chat/chatHistoryService', () => historyMocks);

import { useAppStore } from '../../src/store/useAppStore';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../src/services/chat/assistantScope';

const storageValues = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => storageValues.set(key, value)),
  removeItem: vi.fn((key: string) => storageValues.delete(key)),
  clear: vi.fn(() => storageValues.clear()),
  key: vi.fn((index: number) => [...storageValues.keys()][index] ?? null),
  get length() {
    return storageValues.size;
  },
} satisfies Storage;

function conversation(id: string, updatedAt: number): ChatConversation {
  return {
    id,
    projectId: 'project-1',
    title: id,
    titleSource: 'auto',
    pinned: false,
    archived: false,
    agentMode: 'collaborative',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
  };
}

function message(id: string, conversationId: string): ChatMessage {
  return {
    id,
    conversationId,
    role: 'assistant',
    content: id,
    timestamp: 1,
    status: 'done',
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', localStorageMock);
  storageValues.clear();
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-1' });
  historyMocks.loadProjectConversations.mockReset();
  historyMocks.loadMessages.mockReset();
});

describe('chat conversation restoration', () => {
  it('does not let a late general-history load replace an opened project conversation', async () => {
    useAppStore.setState({ currentProjectId: null });
    let finish!: (conversations: ChatConversation[]) => void;
    historyMocks.loadProjectConversations.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const loading = useAppStore.getState().loadConversationsForProject(GENERAL_ASSISTANT_SCOPE_ID);
    useAppStore.setState({ currentProjectId: 'project-1', activeConversationId: 'project-conversation',
      conversations: [conversation('project-conversation', 2)] });
    finish([{ ...conversation('conv-general', 1), projectId: GENERAL_ASSISTANT_SCOPE_ID }]);
    await loading;
    expect(useAppStore.getState().activeConversationId).toBe('project-conversation');
    expect(useAppStore.getState().conversations.map((item) => item.id)).toEqual(['project-conversation']);
  });

  it('restores general history on the start page without creating a canvas project', async () => {
    const general = { ...conversation('conv-general', 1), projectId: GENERAL_ASSISTANT_SCOPE_ID };
    useAppStore.setState({ currentProjectId: null, projects: [] });
    historyMocks.loadProjectConversations.mockResolvedValue([general]);
    historyMocks.loadMessages.mockResolvedValue({ messages: [message('general-answer', general.id)], total: 1 });
    await useAppStore.getState().loadConversationsForProject(GENERAL_ASSISTANT_SCOPE_ID);
    expect(useAppStore.getState().activeConversationId).toBe(general.id);
    expect(useAppStore.getState().messages[0].content).toBe('general-answer');
    expect(useAppStore.getState().projects).toEqual([]);
  });

  it('keeps a new general conversation and its live message when an older list finishes loading', async () => {
    useAppStore.setState({ currentProjectId: null });
    let finish!: (conversations: ChatConversation[]) => void;
    historyMocks.loadProjectConversations.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });
    const loading = useAppStore.getState().loadConversationsForProject(GENERAL_ASSISTANT_SCOPE_ID);
    const id = useAppStore.getState().createConversation(GENERAL_ASSISTANT_SCOPE_ID);
    useAppStore.getState().addMessage(message('just-created', id));
    finish([]);
    await loading;
    expect(useAppStore.getState().activeConversationId).toBe(id);
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual(['just-created']);
  });

  it('does not replace an unbound general draft with a restored conversation', async () => {
    useAppStore.setState({ currentProjectId: null, chatComposerLiveDraft: '我正在输入的新问题' });
    historyMocks.loadProjectConversations.mockResolvedValue([{ ...conversation('conv-old', 1), projectId: GENERAL_ASSISTANT_SCOPE_ID }]);
    await useAppStore.getState().loadConversationsForProject(GENERAL_ASSISTANT_SCOPE_ID);
    expect(useAppStore.getState().activeConversationId).toBeNull();
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('我正在输入的新问题');
    expect(historyMocks.loadMessages).not.toHaveBeenCalled();
  });

  it('keeps per-conversation drafts and does not apply a delayed draft to the newly selected conversation', () => {
    useAppStore.setState({ conversations: [conversation('a', 1), conversation('b', 2)] });
    const store = useAppStore.getState();
    store.setActiveConversation('a');
    store.setChatComposerLiveDraft('甲的草稿');
    store.setActiveConversation('b');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('');
    store.setChatComposerLiveDraft('乙的草稿');
    store.setChatComposerLiveDraft('甲的最后一次输入', 'a');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('乙的草稿');
    store.setActiveConversation('a');
    expect(useAppStore.getState().chatComposerLiveDraft).toBe('甲的最后一次输入');
    store.setChatComposerLiveDraft('');
    expect(useAppStore.getState().chatComposerDrafts).toEqual({ b: '乙的草稿' });
    store.setChatComposerLiveDraft('不存在的会话', 'missing');
    expect(useAppStore.getState().chatComposerDrafts).not.toHaveProperty('missing');
  });

  it('keeps drafts and the active view when toggling between embedded and detached chat', () => {
    useAppStore.setState({ conversations: [conversation('a', 1)] });
    const store = useAppStore.getState();
    store.setActiveConversation('a');
    store.setChatComposerLiveDraft('还没发出去');
    store.setChatPanelView('tasks');
    store.setChatPanelDetached(true);
    store.closeChat();
    store.setChatPanelDetached(false);
    store.openChat();
    expect(useAppStore.getState()).toMatchObject({ chatComposerLiveDraft: '还没发出去', chatPanelView: 'tasks', activeConversationId: 'a' });
  });

  it('restores the selected conversation and loads its messages after restart', async () => {
    const conversations = [conversation('conversation-newest', 2), conversation('conversation-selected', 1)];
    useAppStore.setState({ conversations });
    useAppStore.getState().setActiveConversation('conversation-selected');

    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ currentProjectId: 'project-1' });
    historyMocks.loadProjectConversations.mockResolvedValue(conversations);
    historyMocks.loadMessages.mockResolvedValue({
      messages: [message('restored-message', 'conversation-selected')],
      total: 1,
    });

    await useAppStore.getState().loadConversationsForProject('project-1');

    expect(useAppStore.getState().activeConversationId).toBe('conversation-selected');
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual(['restored-message']);
    expect(historyMocks.loadMessages).toHaveBeenCalledWith('conversation-selected', 0, 200);
  });

  it('scopes an episode to its series owner for load and create', async () => {
    // series-1 是剧集，ep-2 是它的分集（parentId 指向 series-1）
    useAppStore.setState({
      projects: [
        { id: 'series-1', name: 'S', createdAt: 1, updatedAt: 1 },
        { id: 'ep-2', name: 'E2', createdAt: 1, updatedAt: 1, parentId: 'series-1', episodeNo: 2 },
      ],
      currentProjectId: 'ep-2',
    });
    historyMocks.loadProjectConversations.mockResolvedValue([]);
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });

    await useAppStore.getState().loadConversationsForProject('ep-2');
    expect(historyMocks.loadProjectConversations).toHaveBeenCalledWith('series-1');

    const id = useAppStore.getState().createConversation('ep-2');
    expect(useAppStore.getState().conversations.find((c) => c.id === id)?.projectId).toBe('series-1');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'ai-canvas.chat.active-conversation:series-1',
      id,
    );
  });

  it('keeps a normal top-level project scoped to itself', async () => {
    useAppStore.setState({
      projects: [{ id: 'project-1', name: 'P', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-1',
    });
    historyMocks.loadProjectConversations.mockResolvedValue([]);
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });

    await useAppStore.getState().loadConversationsForProject('project-1');
    expect(historyMocks.loadProjectConversations).toHaveBeenCalledWith('project-1');
    const id = useAppStore.getState().createConversation('project-1');
    expect(useAppStore.getState().conversations.find((c) => c.id === id)?.projectId).toBe('project-1');
  });

  it('falls back to the first available conversation when the saved one no longer exists', async () => {
    localStorageMock.setItem(
      'ai-canvas.chat.active-conversation:project-1',
      'conversation-deleted',
    );
    historyMocks.loadProjectConversations.mockResolvedValue([
      conversation('conversation-fallback', 2),
    ]);
    historyMocks.loadMessages.mockResolvedValue({ messages: [], total: 0 });

    await useAppStore.getState().loadConversationsForProject('project-1');

    expect(useAppStore.getState().activeConversationId).toBe('conversation-fallback');
    expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
      'ai-canvas.chat.active-conversation:project-1',
      'conversation-fallback',
    );
  });
});
