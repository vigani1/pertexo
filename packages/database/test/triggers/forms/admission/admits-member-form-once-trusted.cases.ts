import { randomBytes, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { FormValuesInvalidError } from '@pertexo/workflow-model';

import {
  FormUnavailableError,
  FormChangedError,
  FormAccessConflictError,
} from '../../../../src/triggers/forms/contract.js';

import { admin } from '../../../lifecycle/calls/fixtures.js';

import { store, submitForm, fixture } from './fixture.js';

export function registerAdmitsMemberFormOnceTrusted(): void {
  it('admits a member form once with trusted starter and output metadata, without granting arbitrary start access', async () => {
    const f = await fixture();
    const scope = { ...f, actorId: f.viewerId };
    const shown = await store.read(scope);
    expect(shown.versionId).toBe(f.versionId);
    const command = {
      ...scope,
      versionId: f.versionId,
      values: { amount: 0, message: ' ' },
      idempotencyKey: 'member',
    };
    const first = await submitForm(command);
    const again = await submitForm(command);
    expect(again).toEqual({ ...first, replayed: true });
    const row = await admin.query(
      `select trigger_type,started_by,input_ref from app.workflow_runs where id=$1`,
      [first.runId],
    );
    expect(row.rows[0]).toMatchObject({
      trigger_type: 'form',
      started_by: f.viewerId,
      input_ref: {
        kind: 'inline',
        value: {
          values: { amount: 0 },
          submittedBy: f.viewerId,
          submittedAt: expect.any(String) as unknown,
        },
      },
    });
    expect(
      (
        await admin.query(
          `select id from app.outbox_events where aggregate_id=$1 and job_name='advance-workflow-run'`,
          [first.runId],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('keeps public keys out of receipts and audit; rotates and disables them immediately', async () => {
    const f = await fixture();
    const capability = randomBytes(32).toString('base64url');
    const access = await store.setAccess({
      ...f,
      access: 'public',
      expectedRevision: 0,
      capability,
      idempotencyKey: 'enable',
    });
    expect(access.access).toBe('public');
    if (access.publicId === null) throw new Error('Public identity missing');
    const grant = await store.discover({
      publicId: access.publicId,
      capability,
    });
    const { versionId } = await store.read(
      { workspaceId: f.workspaceId, workflowId: f.workflowId },
      grant,
    );
    const submitted = await submitForm(
      {
        workspaceId: f.workspaceId,
        workflowId: f.workflowId,
        versionId,
        values: { amount: 12 },
        idempotencyKey: 'public',
      },
      grant,
    );
    expect(submitted).toEqual({
      accepted: true,
      replayed: false,
      thankYouMessage: 'Thanks for your response.',
    });
    const run = await admin.query(
      `select started_by,input_ref from app.workflow_runs where workspace_id=$1 and workflow_id=$2`,
      [f.workspaceId, f.workflowId],
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({
      started_by: null,
      input_ref: { value: { submittedBy: null } },
    });
    const receipt = await admin.query(
      `select result_ref from app.idempotency_records where workspace_id=$1`,
      [f.workspaceId],
    );
    const audit = await admin.query(
      `select metadata from app.audit_events where workspace_id=$1`,
      [f.workspaceId],
    );
    expect(
      JSON.stringify({ receipt: receipt.rows, audit: audit.rows }),
    ).not.toContain(capability);
    const nextCapability = randomBytes(32).toString('base64url');
    const rotated = await store.setAccess({
      ...f,
      access: 'public',
      expectedRevision: access.revision,
      capability: nextCapability,
      idempotencyKey: 'rotate',
    });
    await expect(
      store.discover({ publicId: access.publicId, capability }),
    ).rejects.toBeInstanceOf(FormUnavailableError);
    await expect(
      submitForm(
        {
          workspaceId: f.workspaceId,
          workflowId: f.workflowId,
          versionId,
          values: { amount: 1 },
          idempotencyKey: 'stale-grant',
        },
        grant,
      ),
    ).rejects.toBeInstanceOf(FormUnavailableError);
    await store.setAccess({
      ...f,
      access: 'members',
      expectedRevision: rotated.revision,
      idempotencyKey: 'off',
    });
    await expect(
      store.discover({ publicId: access.publicId, capability: nextCapability }),
    ).rejects.toBeInstanceOf(FormUnavailableError);
  });

  it('rejects invalid values, stale versions and competing access writes without admitting a run', async () => {
    const f = await fixture();
    await expect(
      submitForm({
        ...f,
        versionId: f.versionId,
        values: { amount: '12' },
        idempotencyKey: 'bad',
      }),
    ).rejects.toBeInstanceOf(FormValuesInvalidError);
    await expect(
      submitForm({
        ...f,
        versionId: randomUUID(),
        values: { amount: 12 },
        idempotencyKey: 'stale',
      }),
    ).rejects.toBeInstanceOf(FormChangedError);
    const capability = randomBytes(32).toString('base64url');
    const results = await Promise.allSettled(
      [0, 1].map((n) =>
        store.setAccess({
          ...f,
          access: 'public',
          capability,
          expectedRevision: 0,
          idempotencyKey: `race-${String(n)}`,
        }),
      ),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toMatchObject([
      { reason: expect.any(FormAccessConflictError) as unknown },
    ]);
    expect(
      (
        await admin.query(
          `select id from app.workflow_runs where workspace_id=$1 and workflow_id=$2`,
          [f.workspaceId, f.workflowId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('rechecks current membership and workspace scope for every member response', async () => {
    const f = await fixture(),
      foreign = await fixture();
    await expect(
      store.read({ ...f, workflowId: foreign.workflowId, actorId: f.viewerId }),
    ).rejects.toBeInstanceOf(FormUnavailableError);
    await admin.query(
      "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
      [f.workspaceId, f.viewerId],
    );
    await expect(
      submitForm({
        ...f,
        actorId: f.viewerId,
        versionId: f.versionId,
        values: { amount: 1 },
        idempotencyKey: 'removed',
      }),
    ).rejects.toThrow();
    expect(
      (
        await admin.query(
          'select id from app.workflow_runs where workflow_id=$1',
          [f.workflowId],
        )
      ).rowCount,
    ).toBe(0);
  });
  it('keeps the public identity and exact access receipt across disable and re-enable', async () => {
    const f = await fixture();
    const firstCapability = randomBytes(32).toString('base64url');
    const firstCommand = {
      ...f,
      access: 'public' as const,
      expectedRevision: 0,
      capability: firstCapability,
      idempotencyKey: 'initial-access',
    };
    const initial = await store.setAccess(firstCommand);
    expect(initial).toEqual({
      access: 'public',
      publicId: expect.any(String) as unknown,
      revision: 1,
    });
    const disabled = await store.setAccess({
      ...f,
      access: 'members',
      expectedRevision: initial.revision,
      idempotencyKey: 'disable-access',
    });
    expect(disabled).toEqual({
      access: 'members',
      publicId: initial.publicId,
      revision: 2,
    });
    const secondCapability = randomBytes(32).toString('base64url');
    const enabled = await store.setAccess({
      ...f,
      access: 'public',
      expectedRevision: disabled.revision,
      capability: secondCapability,
      idempotencyKey: 'enable-access',
    });
    expect(enabled).toEqual({
      access: 'public',
      publicId: initial.publicId,
      revision: 3,
    });
    await expect(store.setAccess(firstCommand)).resolves.toEqual(initial);
    await expect(store.access(f)).resolves.toEqual(enabled);
    if (initial.publicId === null)
      throw new Error('Public identity is unavailable');
    await expect(
      store.discover({
        publicId: initial.publicId,
        capability: firstCapability,
      }),
    ).rejects.toBeInstanceOf(FormUnavailableError);
    await expect(
      store.discover({
        publicId: initial.publicId,
        capability: secondCapability,
      }),
    ).resolves.toMatchObject({
      workspaceId: f.workspaceId,
      workflowId: f.workflowId,
      publicId: initial.publicId,
    });
  });
}
