import { describe, expect, it } from 'vitest';

import type { NoticeMailToSeal } from '../../../src/inbox/mail/contract.js';
import { createNoticeMailStore } from '../../../src/inbox/mail/store.js';
import { createNoticePreferencesStore } from '../../../src/inbox/preferences/store.js';
import {
  claim,
  complete,
  failedRun,
  fence,
  load,
  sendThatMayHaveGoneOut,
  storedIntent,
  type Alert,
} from '../../notifications/rotation.support.js';
import {
  actorId,
  asAdmin,
  randomUUID,
  workspaceA,
} from '../../runs/run-store/fixtures.js';
import {
  anotherRun,
  appConfig,
  deadLetter,
  deliver,
  failedAlert,
  failedHoursAgo,
  maintenanceConfig,
  noticeOf,
  owner,
  raisedNotice,
  reader,
  scan,
} from './alerts.support.js';

describe('which finished alerts raise the notice', () => {
  it('raises one for an outcome nobody can confirm, like a dead letter', async () => {
    const alert = await failedRun('slack');
    const { attemptNumber } = await claim(alert);
    await load(alert, attemptNumber);
    await fence(alert, attemptNumber);
    await complete(alert, attemptNumber, {
      kind: 'outcome_unknown',
      safeErrorCode: 'delivery.provider_ambiguous',
      possiblyDispatched: true,
    });
    expect((await storedIntent(alert.intentId)).status).toBe('outcome_unknown');

    expect(await raisedNotice(alert.destinationId)).toMatchObject({
      noticeKind: 'failure_alert_attention',
      name: 'Slack',
      unread: true,
    });
  });

  it.each([
    ['pending', () => Promise.resolve()],
    [
      'claimed',
      async (alert: Alert) => {
        await claim(alert);
      },
    ],
    [
      'dispatching',
      async (alert: Alert) => {
        const { attemptNumber } = await claim(alert);
        await load(alert, attemptNumber);
        await fence(alert, attemptNumber);
      },
    ],
    [
      'retry',
      async (alert: Alert) => {
        await sendThatMayHaveGoneOut(alert);
      },
    ],
  ] as const)('stays quiet while an alert is %s', async (status, reach) => {
    const alert = await failedRun('email');
    await reach(alert);
    expect((await storedIntent(alert.intentId)).status).toBe(status);

    await scan();

    expect(await noticeOf(alert.destinationId)).toBeUndefined();
  });

  it('ignores a failure more than a week old', async () => {
    const alert = await failedAlert();
    await failedHoursAgo(alert, 169);

    await scan();

    expect(await noticeOf(alert.destinationId)).toBeUndefined();
  });

  it('ignores an old failure when the latest alert arrived', async () => {
    const alert = await failedAlert();
    await deliver(await anotherRun(alert));

    await scan();

    expect(await noticeOf(alert.destinationId)).toBeUndefined();
  });
});

describe('one notice per destination', () => {
  it('stays one quiet notice however many runs fail', async () => {
    const alert = await failedAlert();
    const first = await raisedNotice(alert.destinationId);
    await reader.markThreadRead({
      ...owner,
      threadId: first.id,
      revision: first.revision,
    });

    for (let run = 0; run < 3; run += 1)
      await deadLetter(await anotherRun(alert));
    await scan();

    expect(await noticeOf(alert.destinationId)).toEqual({
      ...first,
      unread: false,
    });
    const { rows } = await asAdmin((pool) =>
      pool.query(
        `select id from app.workspace_inbox_threads
          where workspace_id=$1 and notice_kind='failure_alert_attention'
            and subject_id=$2`,
        [workspaceA, alert.destinationId],
      ),
    );
    expect(rows).toHaveLength(1);
  });

  it('gives two destinations of one kind a notice each, in the same words', async () => {
    const [one, two] = [await failedAlert(), await failedAlert()];

    const [first, second] = [
      await raisedNotice(one.destinationId),
      await raisedNotice(two.destinationId),
    ];

    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ name: 'Slack' });
    expect(second).toMatchObject({ name: 'Slack' });
  });

  it('sends one mail however many runs fail', async () => {
    await asAdmin((pool) =>
      pool.query('update app.users set email_verified=true where id=$1', [
        actorId,
      ]),
    );
    const preferences = createNoticePreferencesStore(appConfig(), {
      emailAvailable: true,
    });
    const sent: NoticeMailToSeal[] = [];
    const mail = createNoticeMailStore(
      appConfig(),
      maintenanceConfig(),
      (input) => {
        sent.push(input);
        return {
          ciphertext: 'sealed-test-content',
          nonce: 'nonce',
          tag: 'tag',
          keyVersion: 'mail-v1',
        };
      },
    );
    try {
      const { revision } = await preferences.read(owner);
      await preferences.replace({
        ...owner,
        mode: 'immediate',
        hour: 9,
        timeZone: 'UTC',
        expectedRevision: revision,
        idempotencyKey: randomUUID(),
      });
      // What's already standing isn't news: this destination's failure comes after.
      for (let cycle = 0; cycle < 3; cycle += 1) await mail.prepare();
      const alert = await failedAlert();
      await raisedNotice(alert.destinationId);
      const mailsAboutIt = () =>
        sent.filter(({ items }) =>
          items.some((item) => item.subjectId === alert.destinationId),
        );
      for (let cycle = 0; cycle < 5; cycle += 1) await mail.prepare();
      expect(mailsAboutIt()).toHaveLength(1);

      for (let run = 0; run < 2; run += 1)
        await deadLetter(await anotherRun(alert));
      await scan();
      for (let cycle = 0; cycle < 5; cycle += 1) await mail.prepare();

      expect(mailsAboutIt()).toHaveLength(1);
    } finally {
      await Promise.all([preferences.close(), mail.close()]);
    }
  });
});
