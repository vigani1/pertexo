import { createWorkflowRunDatabase } from '../../../../src/runs/runs.repository.js';
import { RunRequiresFormError } from '../../../../src/runs/commands/forms.queries.js';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';

import { createCheckpoint } from '@pertexo/workflow-engine';
import { FormValuesInvalidError } from '@pertexo/workflow-model';

import {
  FormUnavailableError,
  FormChangedError,
} from '../../../../src/triggers/forms/errors.js';
import { parseDatabaseConfig } from '../../../../src/config.js';
import { admin } from '../../../lifecycle/calls/fixtures.js';
import {
  adminUrl,
  apiUrl,
  userId,
  withDatabase,
} from '../../../lifecycle/retention.support.js';
import { store, submitForm, fixture, insertFormRevision } from './fixture.js';

export function registerLinearizesDuplicateFormSubmissionsRejects(): void {
  it('linearizes duplicate form submissions and rejects forged or changed command input', async () => {
    const f = await fixture();
    const command = {
      ...f,
      versionId: f.versionId,
      values: { amount: 1 },
      idempotencyKey: 'race',
    };
    const responses = await Promise.all([
      submitForm(command),
      submitForm(command),
    ]);
    expect(new Set(responses.map((x) => x.runId)).size).toBe(1);
    expect(responses.filter((x) => x.replayed)).toHaveLength(1);
    await expect(
      submitForm({ ...command, values: { amount: 2 } }),
    ).rejects.toThrow(/idempotency/iu);
    await expect(
      submitForm({
        ...command,
        idempotencyKey: 'forge',
        values: { amount: 1, submittedBy: f.viewerId },
      }),
    ).rejects.toBeInstanceOf(FormValuesInvalidError);
  });

  it('revokes a public grant when publication replaces the form entry, and never revives its key', async () => {
    const f = await fixture();
    const capability = randomBytes(32).toString('base64url');
    const access = await store.setAccess({
      ...f,
      access: 'public',
      expectedRevision: 0,
      capability,
      idempotencyKey: 'enable',
    });
    if (access.publicId === null) throw new Error('Missing public identity');
    const { revokeRemovedFormAccess } =
      await import('../../../../src/triggers/forms/publication.repository.js');
    const client = admin;
    try {
      await client.query('begin');
      await client.query(
        'select id from app.workflows where id=$1 for update',
        [f.workflowId],
      );
      await revokeRemovedFormAccess(client, f.workspaceId, f.workflowId, {
        settings: {},
        nodes: [],
        edges: [],
      });
      await client.query('commit');
    } finally {
      await client.query('rollback');
    }
    await expect(
      store.discover({ publicId: access.publicId, capability }),
    ).rejects.toBeInstanceOf(FormUnavailableError);
    expect(await store.access(f)).toMatchObject({
      access: 'members',
      revision: 2,
    });
  });

  it('keeps the accepted receipt and message through republication but refuses a new response from the old schema', async () => {
    const f = await fixture({
      thankYouMessage: 'Original acceptance.',
      redirectUrl: 'https://example.test/original',
    });
    const command = {
      ...f,
      versionId: f.versionId,
      values: { amount: 1 },
      idempotencyKey: 'before-publication',
    };
    const accepted = await submitForm(command);
    expect(accepted.thankYouMessage).toBe('Original acceptance.');
    expect(accepted.redirectUrl).toBe('https://example.test/original');
    const versionId = await insertFormRevision(f, {
      title: 'A newer form',
      thankYouMessage: 'A newer message.',
      redirectUrl: 'https://example.test/newer',
    });
    await admin.query(
      'update app.workflows set published_version_id=$2 where id=$1',
      [f.workflowId, versionId],
    );
    expect(await submitForm(command)).toEqual({ ...accepted, replayed: true });
    await expect(
      submitForm({ ...command, idempotencyKey: 'new-stale-response' }),
    ).rejects.toBeInstanceOf(FormChangedError);
    const shown = await store.read(f);
    expect(shown).toMatchObject({ versionId, form: { title: 'A newer form' } });
    expect(shown.form).not.toHaveProperty('thankYouMessage');
    expect(shown.form).not.toHaveProperty('redirectUrl');
  });

  it('reports a changed form, not an unavailable one, when publication commits while a response waits for its lock', async () => {
    const f = await fixture();
    const versionId = await insertFormRevision(f, {
      title: 'A republished form',
    });
    const publisher = new Client({ connectionString: withDatabase(adminUrl) });
    await publisher.connect();
    let response: Promise<unknown> | undefined;
    try {
      await publisher.query('begin');
      await publisher.query(
        'update app.workflows set published_version_id=$2 where id=$1',
        [f.workflowId, versionId],
      );
      response = submitForm({
        ...f,
        versionId: f.versionId,
        values: { amount: 1 },
        idempotencyKey: 'waits-for-publication',
      });
      const refused = expect(response).rejects.toBeInstanceOf(FormChangedError);
      await vi.waitFor(
        async () => {
          const waiting = await admin.query<{ count: number }>(
            "select count(*)::int count from pg_stat_activity where datname=current_database() and usename='pertexo_app' and wait_event_type='Lock'",
          );
          expect(waiting.rows[0]?.count).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );
      await publisher.query('commit');
      await refused;
    } finally {
      await publisher.query('rollback').catch(() => undefined);
      await response?.catch(() => undefined);
      await publisher.end();
    }
  });

  it('replays only the exact captured Form submission and refuses invented metadata', async () => {
    const f = await fixture();
    const submitted = await submitForm({
      ...f,
      versionId: f.versionId,
      values: { amount: 1 },
      idempotencyKey: 'original',
    });
    if (submitted.runId === undefined) throw new Error('Missing member run');
    await admin.query(
      "update app.workflow_runs set status='failed',completed_at=clock_timestamp() where id=$1",
      [submitted.runId],
    );
    const source = await admin.query<{
      input_ref: { kind: 'inline'; value: Record<string, unknown> };
    }>('select input_ref from app.workflow_runs where id=$1', [
      submitted.runId,
    ]);
    const input = source.rows[0]?.input_ref.value;
    if (input === undefined) throw new Error('Missing input');
    const runs = createWorkflowRunDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    try {
      const command = {
        workspaceId: f.workspaceId,
        sourceRunId: submitted.runId,
        workflowVersionId: f.versionId,
        actorId: userId,
        input,
        scope: `workflow:${f.workflowId}:replay`,
        idempotencyKeyHash: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
        checkpointFactory: (version: { id: string }) => ({
          checkpoint: createCheckpoint({
            workflowVersionId: version.id,
            iterationBudget: 200,
            nextEventSequence: 2,
          }),
        }),
      };
      const replay = await runs.replay(command);
      expect(replay.run.triggerType).toBe('replay');
      await expect(
        runs.replay({
          ...command,
          idempotencyKeyHash: 'c'.repeat(64),
          requestHash: 'd'.repeat(64),
          input: { ...input, submittedBy: f.viewerId },
        }),
      ).rejects.toBeInstanceOf(RunRequiresFormError);
      await admin.query(
        "update app.workflow_runs set created_at=clock_timestamp()-interval '31 days',input_ref_expires_at=clock_timestamp()-interval '2 days' where id=$1",
        [submitted.runId],
      );
      await expect(
        runs.replay({
          ...command,
          idempotencyKeyHash: 'e'.repeat(64),
          requestHash: 'f'.repeat(64),
        }),
      ).rejects.toBeInstanceOf(RunRequiresFormError);
    } finally {
      await runs.close();
    }
  });
}
