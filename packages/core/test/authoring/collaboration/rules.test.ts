import { describe, expect, it } from 'vitest';
import { mentionsReachable } from '../../../src/authoring/collaboration/mention-access.js';
import { stepSnapshotLabel } from '../../../src/authoring/collaboration/comment-step-label.js';

describe('comment mentions', () => {
  it('reaches people who are all active members able to read the workflow', () => {
    expect(
      mentionsReachable(
        [
          { userId: 'a', role: 'viewer' },
          { userId: 'b', role: 'owner' },
        ],
        ['a', 'b'],
      ),
    ).toBe(true);
  });

  it('refuses when a mentioned person is no longer an active member', () => {
    expect(
      mentionsReachable([{ userId: 'a', role: 'viewer' }], ['a', 'b']),
    ).toBe(false);
  });
});

describe('a former step’s label', () => {
  it('keeps a short label as it is', () => {
    expect(stepSnapshotLabel('Send invoice')).toBe('Send invoice');
  });

  it('ends a long label with an ellipsis within 256 units, whole graphemes only', () => {
    const label = stepSnapshotLabel('👍🏽'.repeat(100));
    expect(label.length).toBeLessThanOrEqual(256);
    expect(label.endsWith('…')).toBe(true);
    expect(label.slice(0, -1).length % '👍🏽'.length).toBe(0);
  });
});
