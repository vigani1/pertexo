import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  NoticeMailPersonFailure,
  NoticeMailToSeal,
} from '../../../src/inbox/mail/contract.js';
import { createNoticeMailStore } from '../../../src/inbox/mail/store.js';
import { WorkspaceAccessDeniedError } from '../../../src/tenant-access/errors.js';
import { identity } from '../../support/workflow-authoring.js';
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

const MINUTE = 60_000;
const SEALED = {
  ciphertext: 'sealed-test-content',
  nonce: 'nonce',
  tag: 'tag',
  keyVersion: 'mail-v1',
};

const enable = (scope: { workspaceId: string; actorId: string }) =>
  preferences().replace({
    ...scope,
    mode: 'immediate',
    hour: 9,
    timeZone: 'UTC',
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });

afterEach(() => {
  vi.useRealTimers();
});

/** Moves only the clock the backoff reads; the database keeps its own. */
function clockAt(now: number) {
  vi.useFakeTimers({ toFake: ['Date'], now });
}

/** A failure waiting to be mailed to every member named, and a sender that can be broken. */
async function mailWaiting(extraMembers = 0) {
  const f = await seedNoticeWorkspace();
  const people = [f.members.owner, f.members.admin];
  for (let index = 0; index < extraMembers; index += 1) {
    const id = randomUUID();
    await identity.createUser({
      id,
      email: `${id}@example.test`,
      displayName: 'Operator',
    });
    await queryAsOwner(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'operator','active')",
      [f.workspaceId, id],
      f.workspaceId,
    );
    await queryAsOwner('update app.users set email_verified=true where id=$1', [
      id,
    ]);
    people.push(id);
  }
  people.sort();
  for (const actorId of people)
    await enable({ workspaceId: f.workspaceId, actorId });
  await seedFailure(f.workspaceId, f.workflowId);
  await observer().foldPending(100);

  const attempts: string[] = [];
  const reported: NoticeMailPersonFailure[] = [];
  const failing = new Set<string>();
  let onSeal: (input: NoticeMailToSeal) => void = () => undefined;
  const store = own(
    createNoticeMailStore(
      config(),
      maintenance(),
      (input) => {
        if (input.workspaceId !== f.workspaceId) return SEALED;
        attempts.push(input.actorId);
        onSeal(input);
        if (failing.has(input.actorId)) throw new Error('sealing failed');
        return SEALED;
      },
      {
        onPersonFailed: (failure) => {
          if (failure.workspaceId === f.workspaceId) reported.push(failure);
        },
      },
    ),
  );
  /** Enough cycles to walk everyone, across pages and other tests' workspaces. */
  const walk = async () => {
    for (let cycle = 0; cycle < 8; cycle += 1) await store.prepare();
  };
  const batches = async () =>
    (
      await queryAsOwner<{ user_id: string }>(
        'select user_id from app.notice_mail_batches where workspace_id=$1',
        [f.workspaceId],
        f.workspaceId,
      )
    )
      .map((row) => row.user_id)
      .sort();
  const attemptsBy = (actorId: string) =>
    attempts.filter((id) => id === actorId).length;
  return {
    ...f,
    people,
    store,
    reported,
    failing,
    walk,
    batches,
    attemptsBy,
    sealing: (hook: (input: NoticeMailToSeal) => void) => {
      onSeal = hook;
    },
  };
}

describe('one person whose notice mail keeps failing', () => {
  it('blocks nobody after them, across a page of ten', async () => {
    const f = await mailWaiting(11);
    const [first] = f.people;
    if (first === undefined) throw new Error('People are seeded');
    f.failing.add(first);

    await f.walk();

    expect(await f.batches()).toEqual(f.people.slice(1));
    expect(f.attemptsBy(first)).toBe(1);
  });

  it('retries after a delay growing from one minute to one hour, and their mail still arrives', async () => {
    const f = await mailWaiting();
    const [unlucky] = f.people;
    if (unlucky === undefined) throw new Error('People are seeded');
    f.failing.add(unlucky);
    let now = Date.now();
    clockAt(now);
    await f.walk();
    expect(f.attemptsBy(unlucky)).toBe(1);

    const delays = [1, 2, 4, 8, 16, 32, 60, 60].map(
      (minutes) => minutes * MINUTE,
    );
    for (const [index, delay] of delays.entries()) {
      const attempts = index + 1;
      clockAt(now + delay - 1_000);
      await f.walk();
      expect(f.attemptsBy(unlucky), `still waiting ${String(delay)}`).toBe(
        attempts,
      );
      now += delay + 1_000;
      clockAt(now);
      await f.walk();
      expect(f.attemptsBy(unlucky), `tried after ${String(delay)}`).toBe(
        attempts + 1,
      );
    }
    expect(f.reported.map(({ failures }) => failures)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(await f.batches()).not.toContain(unlucky);

    f.failing.delete(unlucky);
    clockAt(now + 60 * MINUTE + 1_000);
    await f.walk();

    expect(await f.batches()).toEqual(f.people);
  });

  it('starts the delay over after a success', async () => {
    const f = await mailWaiting();
    const [unlucky] = f.people;
    if (unlucky === undefined) throw new Error('People are seeded');
    f.failing.add(unlucky);
    const now = Date.now();
    clockAt(now);
    await f.walk();
    clockAt(now + MINUTE + 1_000);
    await f.walk();
    expect(f.reported.map(({ failures }) => failures)).toEqual([1, 2]);

    f.failing.delete(unlucky);
    clockAt(now + 3 * MINUTE + 2_000);
    await f.walk();
    expect(await f.batches()).toContain(unlucky);

    // That mail has gone out, so the next failure is theirs to be mailed about.
    await queryAsOwner(
      'update app.notice_mail_batches set released_at=clock_timestamp() where workspace_id=$1 and user_id=$2',
      [f.workspaceId, unlucky],
      f.workspaceId,
    );
    await queryAsOwner(
      'update app.notice_preferences set next_due_at=clock_timestamp() where workspace_id=$1 and user_id=$2',
      [f.workspaceId, unlucky],
      f.workspaceId,
    );
    await seedFailure(f.workspaceId, f.workflowId);
    await observer().foldPending(100);
    f.failing.add(unlucky);
    clockAt(now + 4 * MINUTE);
    await f.walk();

    expect(f.reported.at(-1)?.failures).toBe(1);
  });

  it('reports who failed and how many times, and nothing the mail would say', async () => {
    const f = await mailWaiting();
    const [unlucky] = f.people;
    if (unlucky === undefined) throw new Error('People are seeded');
    f.failing.add(unlucky);

    await f.walk();

    const [failure] = f.reported;
    if (failure === undefined) throw new Error('Expected the report');
    const { error, ...fields } = failure;
    expect(fields).toEqual({
      workspaceId: f.workspaceId,
      actorId: unlucky,
      failures: 1,
    });
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(fields)).not.toContain('@example.test');
  });
});

describe('what is not a person failing', () => {
  it('ends the cycle on an abort, without counting it or moving past them', async () => {
    const f = await mailWaiting();
    const [unlucky, next] = f.people;
    if (unlucky === undefined || next === undefined)
      throw new Error('People are seeded');
    const controller = new AbortController();
    f.failing.add(unlucky);
    f.sealing(() => {
      controller.abort();
    });

    let result: unknown;
    for (let cycle = 0; cycle < 8 && result === undefined; cycle += 1)
      await f.store.prepare(controller.signal).catch((error: unknown) => {
        result = error;
      });

    expect(result).toBeInstanceOf(Error);
    expect(f.reported).toEqual([]);
    expect(f.attemptsBy(next)).toBe(0);

    f.failing.clear();
    f.sealing(() => undefined);
    await f.walk();

    expect(await f.batches()).toEqual(f.people);
  });

  it('neither reports nor delays someone who has lost their access', async () => {
    const f = await mailWaiting();
    const [denied] = f.people;
    if (denied === undefined) throw new Error('People are seeded');
    f.sealing((input) => {
      if (input.actorId === denied)
        throw new WorkspaceAccessDeniedError('no longer a member');
    });

    await f.walk();
    const tried = f.attemptsBy(denied);
    expect(tried).toBeGreaterThan(0);
    await f.walk();

    expect(f.attemptsBy(denied)).toBeGreaterThan(tried);
    expect(f.reported).toEqual([]);
  });
});
