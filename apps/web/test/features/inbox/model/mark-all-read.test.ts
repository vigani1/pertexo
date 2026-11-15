import { describe, expect, it } from 'vitest';
import { markAllReadCut } from '@/features/inbox/model/mark-all-read';

describe('mark all read', () => {
  it('marks up to the revision the list showed when there is unread work', () => {
    expect(
      markAllReadCut({
        workspaceStatus: 'active',
        listedRevision: '42',
        unreadCount: 3,
      }),
    ).toBe('42');
  });

  it('is unavailable outside an active workspace, before the list loads, or with nothing unread', () => {
    expect(
      markAllReadCut({
        workspaceStatus: 'suspended',
        listedRevision: '42',
        unreadCount: 3,
      }),
    ).toBeUndefined();
    expect(
      markAllReadCut({
        workspaceStatus: 'active',
        listedRevision: undefined,
        unreadCount: 3,
      }),
    ).toBeUndefined();
    expect(
      markAllReadCut({
        workspaceStatus: 'active',
        listedRevision: '42',
        unreadCount: 0,
      }),
    ).toBeUndefined();
    expect(
      markAllReadCut({
        workspaceStatus: 'active',
        listedRevision: '42',
        unreadCount: undefined,
      }),
    ).toBeUndefined();
  });
});
