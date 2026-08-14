import { describe, expect, it } from 'vitest';
import {
  appendContentBlocks,
  type ContentBlock,
} from '../../src/services/agent-types.js';

describe('appendContentBlocks', () => {
  it('merges adjacent text deltas while preserving tool boundaries', () => {
    const blocks: ContentBlock[] = [];

    appendContentBlocks(blocks, [{ type: 'text', text: 'Hel' }]);
    appendContentBlocks(blocks, [
      { type: 'text', text: 'lo' },
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} },
    ]);
    appendContentBlocks(blocks, [
      { type: 'text', text: 'Done' },
      { type: 'text', text: '.' },
    ]);

    expect(blocks).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} },
      { type: 'text', text: 'Done.' },
    ]);
  });
});
