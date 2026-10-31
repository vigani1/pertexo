import { QUEUE_NAME } from '@pertexo/queue';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import { delay } from '../../support/recovery/facts.js';
import { invitationMailSettings } from '../../support/recovery/promises/maintenance.js';
import {
  pauseQueue,
  queuedJobs,
  resumeQueue,
} from '../../support/recovery/queues.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';
import {
  startMailbox,
  type Mailbox,
} from '../../support/recovery/stand-ins/smtp.js';

const INVITED = 'invited-once@example.test';
// Long enough for the losing copy's retry, a second after it lost, to come back
// while the winner is still waiting on the server.
const SERVER_ANSWER_MS = 8_000;
const MAIL_TIMEOUT_MS = 20_000;
// The retries and the next redelivery would both land in this time if unconfirmed.
const QUIET_MS = 15_000;
// Past the 5 s between scans.
const SCAN_MS = 8_000;

type EventFacts = Readonly<{
  delivery_due_at: Date | null;
  failed_at: Date | null;
  published_at: Date | null;
  redeliveries: number;
}>;

/**
 * Late is not lost, and nothing can tell the two apart in advance: the job from
 * before and the one sent again for it can both be waiting, under different job
 * IDs, when the queue moves again. Plain SMTP can't deduplicate, so what they
 * read and did in Postgres is all that stands between the person and two emails.
 */
describeFaults('two copies of one invitation job, running at once', () => {
  let stack: Stack;
  let mailbox: Mailbox;
  let waitingCopies: number;
  let invitation: string | undefined;
  let attempt: string | undefined;
  let event: EventFacts | undefined;
  let receipts: number;

  beforeAll(async () => {
    mailbox = await startMailbox({
      answerAfterMs: SERVER_ANSWER_MS,
      greetTogether: 2,
    });
    const settings = invitationMailSettings(mailbox);
    stack = await startStack('invitation-copies', {
      ...settings,
      workerEnvironment: {
        ...settings.workerEnvironment,
        INVITATION_EMAIL_TIMEOUT_MILLIS: String(MAIL_TIMEOUT_MS),
      },
    });
    const workspace = await stack.api.createWorkspace('recovery-copies');
    await pauseQueue(stack, QUEUE_NAME.maintenance);
    await stack.api.invite(workspace, INVITED);

    // The real way there: unconfirmed past its time, so it is delivered again.
    const deadline = Date.now() + RECOVERY_LIMIT_MS;
    for (;;) {
      const [row] = await stack.sql<{ again: boolean }>(
        `select published_at is not null and redeliveries = 1 as again
           from app.outbox_events
          where job_name='deliver-workspace-invitation'`,
      );
      if (row?.again === true) break;
      if (Date.now() > deadline)
        throw new Error('The invitation was never delivered again');
      await delay(200);
    }
    waitingCopies = await queuedJobs(stack, QUEUE_NAME.maintenance);
    await resumeQueue(stack, QUEUE_NAME.maintenance);

    const read = async (): Promise<string | undefined> =>
      (
        await stack.sql<{ delivery_status: string }>(
          `select delivery_status from app.workspace_invitations where workspace_id=$1`,
          [workspace],
        )
      )[0]?.delivery_status;
    invitation = await read();
    while (invitation === 'queued' && Date.now() < deadline) {
      await delay(250);
      invitation = await read();
    }
    await delay(QUIET_MS);

    invitation = await read();
    attempt = (
      await stack.sql<{ status: string }>(
        `select status from app.workspace_invitation_delivery_attempts where workspace_id=$1`,
        [workspace],
      )
    )[0]?.status;
    // The scan only looks at a row once its time has come, so bring that forward.
    await stack.sql(
      `update app.outbox_events set delivery_due_at=clock_timestamp()
        where job_name='deliver-workspace-invitation'`,
    );
    await delay(SCAN_MS);
    event = (
      await stack.sql<EventFacts>(
        `select delivery_due_at, failed_at, published_at, redeliveries
           from app.outbox_events
          where job_name='deliver-workspace-invitation'`,
      )
    )[0];
    receipts =
      (
        await stack.sql<{ count: number }>(
          `select count(*)::int as count from app.inbox_receipts r
             join app.outbox_events e on e.id=r.message_id
            where e.job_name='deliver-workspace-invitation'`,
        )
      )[0]?.count ?? 0;
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
    await mailbox.close();
  }, SCENARIO_LIMIT_MS);

  // A copy reaches the server only if it read the attempt as still to be sent. Two
  // there at once means both did, so this is the race and not two jobs in a row.
  it('really has both copies past their read, at the same moment', () => {
    expect(waitingCopies).toBe(2);
    expect(mailbox.mostConnectedAtOnce()).toBeGreaterThanOrEqual(2);
  });

  it('sends one email', () => {
    expect(mailbox.messages()).toEqual([INVITED]);
  });

  it('shows the invitation as sent', () => {
    expect(invitation).toBe('submitted');
    expect(attempt).toBe('submitted');
  });

  it('leaves nothing to deliver again', () => {
    expect(receipts).toBe(1);
    expect(event?.delivery_due_at).toBeNull();
    expect(event?.failed_at).toBeNull();
    expect(event?.published_at).not.toBeNull();
    expect(event?.redeliveries).toBe(1);
  });
});
