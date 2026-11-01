import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { NoticeMailPersonFailure } from '../../../src/inbox/mail/contract.js';
import { createNoticeMailStore } from '../../../src/inbox/mail/store.js';
import {
  config,
  maintenance,
  observer,
  own,
  preferences,
  queryAsOwner,
  seedFailure,
  seedNoticeWorkspace,
} from '../notices.fixture.js';

const enable = (scope: { workspaceId: string; actorId: string }) =>
  preferences().replace({
    ...scope,
    mode: 'immediate',
    hour: 9,
    timeZone: 'UTC',
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });

describe('one person whose notice mail fails', () => {
  it('keeps one person whose mail keeps failing from blocking everyone after them, and retries them later', async () => {
    const f = await seedNoticeWorkspace();
    const [first, second] = [f.members.owner, f.members.admin].sort();
    if (first === undefined || second === undefined)
      throw new Error('two members are seeded');
    await enable({ workspaceId: f.workspaceId, actorId: first });
    await enable({ workspaceId: f.workspaceId, actorId: second });
    await seedFailure(f.workspaceId, f.workflowId);
    await observer().foldPending(100);
    let sealingWorks = false;
    const attempts: string[] = [];
    const reported: NoticeMailPersonFailure[] = [];
    const store = own(
      createNoticeMailStore(
        config(),
        maintenance(),
        (input) => {
          attempts.push(input.actorId);
          if (input.actorId === first && !sealingWorks)
            throw new Error('sealing failed');
          return {
            ciphertext: 'sealed-test-content',
            nonce: 'nonce',
            tag: 'tag',
            keyVersion: 'mail-v1',
          };
        },
        { onPersonFailed: (failure) => reported.push(failure) },
      ),
    );
    const prepareUntil = async (done: () => boolean) => {
      for (let cycle = 0; cycle < 60 && !done(); cycle += 1)
        await store.prepare();
    };
    await prepareUntil(() => attempts.includes(second));
    expect(attempts).toContain(second);
    expect(
      reported.map(({ workspaceId, actorId, failures }) => ({
        workspaceId,
        actorId,
        failures,
      })),
    ).toEqual([{ workspaceId: f.workspaceId, actorId: first, failures: 1 }]);
    expect(reported[0]?.error).toBeInstanceOf(Error);

    // It waits its turn rather than costing an attempt every cycle.
    for (let cycle = 0; cycle < 3; cycle += 1) await store.prepare();
    expect(attempts.filter((id) => id === first)).toHaveLength(1);

    sealingWorks = true;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      await prepareUntil(
        () => attempts.filter((id) => id === first).length > 1,
      );
    } finally {
      vi.useRealTimers();
    }
    const batches = await queryAsOwner<{ user_id: string }>(
      'select user_id from app.notice_mail_batches where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    expect(batches.map((row) => row.user_id).sort()).toEqual([first, second]);
  });
});
