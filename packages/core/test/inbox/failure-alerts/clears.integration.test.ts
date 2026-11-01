import { describe, expect, it } from 'vitest';

import {
  appendAddress,
  command,
  destinations,
  failedRun,
  rotateCredential,
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
  deadLetter,
  deliver,
  failedAlert,
  failedHoursAgo,
  healthChanged,
  noticeOf,
  owner,
  raisedNotice,
  reader,
  scan,
} from './alerts.support.js';

describe('when it clears and comes back', () => {
  it.each([
    [
      'a later alert arrives',
      (alert: Alert) => anotherRun(alert).then(deliver),
    ],
    ['the destination is edited', (alert: Alert) => appendAddress(alert)],
    [
      'its connection health changes',
      (alert: Alert) => healthChanged(alert.connectionId),
    ],
    [
      'its credential is rotated',
      (alert: Alert) => rotateCredential(alert.connectionId),
    ],
    [
      'only its secret changes',
      async (alert: Alert) => {
        const secretId = randomUUID();
        await asAdmin(async (pool) => {
          await pool.query(
            `insert into app.connection_secret_versions (
               id,workspace_id,connection_id,kms_key_reference,
               encrypted_data_key,ciphertext,nonce,auth_tag,created_by
             ) values ($1,$2,$3,'kms','key2','newer-cipher','CCCCCCCCCCCCCCCC',
               'CCCCCCCCCCCCCCCCCCCCCC',$4)`,
            [secretId, workspaceA, alert.connectionId, actorId],
          );
          await pool.query(
            'update app.connections set current_secret_version_id=$2 where id=$1',
            [alert.connectionId, secretId],
          );
        });
      },
    ],
    [
      'it is turned off with no policy pointing at it',
      (alert: Alert) =>
        destinations.setStatus({
          ...command(),
          destinationId: alert.destinationId,
          status: 'disabled',
        }),
    ],
  ] as const)(
    'clears for good when %s, and comes back unread on a new failure',
    async (_change, change) => {
      const alert = await failedAlert();
      const raised = await raisedNotice(alert.destinationId);
      await reader.markThreadRead({
        ...owner,
        threadId: raised.id,
        revision: raised.revision,
      });

      await change(alert);
      await scan(6);

      expect(await noticeOf(alert.destinationId)).toBeUndefined();

      await destinations.setStatus({
        ...command(),
        destinationId: alert.destinationId,
        status: 'enabled',
      });
      await deadLetter(await anotherRun(alert));
      expect(await raisedNotice(alert.destinationId)).toMatchObject({
        id: raised.id,
        occurrenceCount: 2,
        unread: true,
      });
    },
  );

  it('keeps standing until the failure is a week old, then leaves with no change', async () => {
    const alert = await failedAlert();
    const raised = await raisedNotice(alert.destinationId);

    await failedHoursAgo(alert, 167);
    await scan();
    expect(await noticeOf(alert.destinationId)).toEqual(raised);

    await failedHoursAgo(alert, 169);
    await scan();
    expect(await noticeOf(alert.destinationId)).toBeUndefined();

    await deadLetter(await anotherRun(alert));
    expect(await raisedNotice(alert.destinationId)).toMatchObject({
      unread: true,
      occurrenceCount: 2,
    });
  });

  it('does not flap across scans, standing or cleared', async () => {
    const alert = await failedAlert();
    const raised = await raisedNotice(alert.destinationId);

    await scan(10);
    expect(await noticeOf(alert.destinationId)).toEqual(raised);

    await healthChanged(alert.connectionId);
    await scan(10);
    expect(await noticeOf(alert.destinationId)).toBeUndefined();
    const { rows } = await asAdmin((pool) =>
      pool.query<{ occurrence_count: string; active: boolean }>(
        `select occurrence_count::text,active from app.workspace_inbox_threads
          where workspace_id=$1 and subject_id=$2`,
        [workspaceA, alert.destinationId],
      ),
    );
    expect(rows).toEqual([{ occurrence_count: '1', active: false }]);
  });

  it('does not let an old failure bring back a notice a newer delivery cleared', async () => {
    const alert = await failedAlert();
    await raisedNotice(alert.destinationId);
    await deliver(await anotherRun(alert));
    await scan();
    expect(await noticeOf(alert.destinationId)).toBeUndefined();

    // The newer delivery wins even after a change the old failure predates.
    await healthChanged(alert.connectionId);
    await scan();

    expect(await noticeOf(alert.destinationId)).toBeUndefined();
  });
});

describe('a changed cause', () => {
  it('makes a read notice unread again', async () => {
    const alert = await failedRun('slack');
    const workflowId = randomUUID();
    await asAdmin((pool) =>
      pool.query(
        'insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,$3,$4)',
        [workflowId, workspaceA, `Alerted ${workflowId}`, actorId],
      ),
    );
    await destinations.setWorkflowPolicy({
      ...command(),
      workflowId,
      destinationId: alert.destinationId,
    });
    await deadLetter(alert);
    const raised = await raisedNotice(alert.destinationId);
    await reader.markThreadRead({
      ...owner,
      threadId: raised.id,
      revision: raised.revision,
    });

    await asAdmin((pool) =>
      pool.query(
        "update app.connections set status='reauthorization_required' where id=$1",
        [alert.connectionId],
      ),
    );
    await scan();

    expect(await noticeOf(alert.destinationId)).toMatchObject({
      id: raised.id,
      unread: true,
      occurrenceCount: 2,
    });
  });
});

describe('a turned-off destination', () => {
  const setStatus = (alert: Alert, status: 'enabled' | 'disabled') =>
    destinations.setStatus({
      ...command(),
      destinationId: alert.destinationId,
      status,
    });

  it('has no notice from a recent failure without a policy', async () => {
    const alert = await failedAlert();
    await setStatus(alert, 'disabled');

    await scan();

    expect(await noticeOf(alert.destinationId)).toBeUndefined();
  });

  it('clears even when an alert already under way fails after it was turned off', async () => {
    const alert = await failedAlert();
    await raisedNotice(alert.destinationId);
    const underWay = await anotherRun(alert);

    await setStatus(alert, 'disabled');
    await deadLetter(underWay);
    await scan();

    expect(await noticeOf(alert.destinationId)).toBeUndefined();
  });

  it('has one while a policy points at it, until that policy goes', async () => {
    const alert = await failedRun('slack');
    const workflowId = randomUUID();
    await asAdmin((pool) =>
      pool.query(
        'insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,$3,$4)',
        [workflowId, workspaceA, `Alerted ${workflowId}`, actorId],
      ),
    );
    const policy = { workflowId, destinationId: alert.destinationId };
    await destinations.setWorkflowPolicy({ ...command(), ...policy });
    await deadLetter(alert);
    await setStatus(alert, 'disabled');

    expect(await raisedNotice(alert.destinationId)).toMatchObject({
      name: 'Slack',
    });

    await destinations.clearWorkflowPolicy({ ...command(), workflowId });
    await scan();

    expect(await noticeOf(alert.destinationId)).toBeUndefined();
  });
});
