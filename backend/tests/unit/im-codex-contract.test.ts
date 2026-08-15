import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  binding: {
    id: 'binding-1',
    organization_id: 'org-1',
    business_scope_id: 'scope-1',
    channel_type: 'slack',
    channel_id: 'channel-1',
    channel_name: 'Audit',
    bot_token_enc: 'test-token',
    webhook_url: null,
    config: {},
    is_enabled: true,
    sticky_session_id: 'session-1',
    created_by: 'user-1',
    created_at: new Date(),
    updated_at: new Date(),
  },
  imChannelRepository: {
    findById: vi.fn(),
    findByChannelTypeAndId: vi.fn(),
    updateStickySession: vi.fn(),
  },
  imThreadSessionRepository: {
    findByThread: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
  },
  chatSessionRepository: {
    findById: vi.fn(),
    update: vi.fn(),
  },
  chatService: {
    processMessage: vi.fn(),
    createSession: vi.fn(),
  },
}));

vi.mock('../../src/repositories/im-channel.repository.js', () => ({
  imChannelRepository: mocks.imChannelRepository,
  imThreadSessionRepository: mocks.imThreadSessionRepository,
}));
vi.mock('../../src/repositories/chat.repository.js', () => ({
  chatSessionRepository: mocks.chatSessionRepository,
}));
vi.mock('../../src/services/chat.service.js', () => ({
  chatService: mocks.chatService,
}));

import { IMService } from '../../src/services/im.service.js';
import { SlackAdapter } from '../../src/services/slack-adapter.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.imChannelRepository.findByChannelTypeAndId.mockResolvedValue(mocks.binding);
  mocks.chatSessionRepository.findById.mockResolvedValue({ id: 'session-1' });
  mocks.imThreadSessionRepository.upsert.mockResolvedValue({});
});

describe('IM Codex contract', () => {
  it('forwards the complete normalized ChatService text to the enabled adapter', async () => {
    mocks.chatService.processMessage.mockResolvedValue({
      text: 'Complete Codex response',
      sessionId: 'session-1',
      contentBlocks: [{ type: 'text', text: 'Complete Codex response' }],
    });
    const adapter = {
      verifyRequest: vi.fn(),
      parseEvent: vi.fn(),
      sendReply: vi.fn().mockResolvedValue(undefined),
    };
    const service = new IMService();
    service.registerAdapter('slack', adapter);

    const result = await service.handleMessage({
      channelType: 'slack',
      channelId: 'channel-1',
      threadId: 'thread-1',
      userId: 'slack-user',
      text: 'hello',
      isExplicitThread: false,
    });

    expect(result).toEqual({
      text: 'Complete Codex response',
      sessionId: 'session-1',
    });
    expect(adapter.sendReply).toHaveBeenCalledWith(
      mocks.binding,
      'thread-1',
      'Complete Codex response',
      undefined,
    );
  });

  it('does not call the adapter when the runtime fails', async () => {
    mocks.chatService.processMessage.mockRejectedValue(new Error('Codex failed'));
    const adapter = {
      verifyRequest: vi.fn(),
      parseEvent: vi.fn(),
      sendReply: vi.fn(),
    };
    const service = new IMService();
    service.registerAdapter('slack', adapter);

    await expect(service.handleMessage({
      channelType: 'slack',
      channelId: 'channel-1',
      threadId: 'thread-1',
      userId: 'slack-user',
      text: 'hello',
      isExplicitThread: false,
    })).rejects.toThrow('Codex failed');
    expect(adapter.sendReply).not.toHaveBeenCalled();
  });

  it('rejects an enabled Slack binding without delivery credentials', async () => {
    const adapter = new SlackAdapter();
    await expect(adapter.sendReply({
      ...mocks.binding,
      bot_token_enc: null,
    }, 'thread-1', 'response')).rejects.toThrow('has no bot token');
  });
});
