import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import {
  lockWorkflowCallAdmission,
  reserveWorkflowCallAdmission,
  WorkflowCallAdmissionCorruptError,
  WorkflowCallAdmissionRefusedError,
  WorkflowCallAdmissionStoppedError,
  type WorkflowCallAdmissionProof,
} from '../src/execution/workflow-calls/workflow-call-admission.js';
import {
  serializeStoredExecutionValueV1,
  STORED_EXECUTION_VALUE_LIMITS_V1,
} from '../src/execution/stored-execution-value.js';
import type { WorkspaceTransaction } from '../src/tenant-access/workspace.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const parentRunId = '00000000-0000-4000-8000-000000000002';
const candidateRunId = '00000000-0000-4000-8000-000000000003';
const outboxEventId = '00000000-0000-4000-8000-000000000004';
const pin = {
  workflowId: '00000000-0000-4000-8000-000000000005',
  versionId: '00000000-0000-4000-8000-000000000006',
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
};
const context = {
  parentRunId,
  expectedParentRevision: 7,
  invocationKey: 'call/root',
};
const input = {
  context,
  candidateRunId,
  workflowId: pin.workflowId,
  workflowVersionId: pin.versionId,
  engineVersion: 'engine-v3',
};
const deadlineAt = '2026-10-02T13:00:00+02:00';
const common = { pin, engineVersion: input.engineVersion };
const allowed = {
  kind: 'allowed',
  ...common,
  inputRef: { schemaVersion: 1, kind: 'inline', value: { name: 'input' } },
  inputRefJson: '{"kind":"inline","schemaVersion":1,"value":{"name":"input"}}',
  inputChecksum: 'c'.repeat(64),
  deadlineAt,
};
const recorded = {
  kind: 'recorded',
  ...common,
  accepted: {
    acceptedAt: '2026-10-02T12:00:00+02:00',
    outboxEventId,
    runId: candidateRunId,
    status: 'queued',
  },
};
const refused = {
  kind: 'refused',
  ...common,
  reasonCode: 'workflow.child_capacity_unavailable',
};
const stopped = { kind: 'stopped', ...common, reason: 'cancel_requested' };
function fixture(rows: readonly unknown[] = [{ proof: allowed }]) {
  const execute = vi
    .fn<(query: SQL) => Promise<{ rows: readonly unknown[] }>>()
    .mockResolvedValue({ rows });
  return {
    execute,
    transaction: {
      workspaceId,
      db: { execute },
    } as unknown as WorkspaceTransaction,
  };
}
function allowedProof(proof: WorkflowCallAdmissionProof) {
  if (proof.kind !== 'allowed')
    throw new Error('Expected allowed admission proof');
  return proof;
}
async function reserveFixture(rows: readonly unknown[] = [{ reserved: true }]) {
  const proof = allowedProof(
    await lockWorkflowCallAdmission(fixture().transaction, input),
  );
  const transaction = fixture(rows);
  return { ...transaction, proof };
}

describe('locked Workflow Call admission proof', () => {
  it('binds only exact parent, revision, invocation and canonical candidate to worker SQL', async () => {
    const test = fixture();
    const proof = allowedProof(
      await lockWorkflowCallAdmission(test.transaction, input),
    );
    expect(test.execute).toHaveBeenCalledOnce();
    const query = test.execute.mock.calls[0]?.[0];
    if (query === undefined) throw new Error('Expected SQL query');
    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain('app.lock_workflow_call_admission(');
    expect(compiled.params).toEqual([
      parentRunId,
      7,
      context.invocationKey,
      candidateRunId,
    ]);
    expect(compiled.params).not.toContain(workspaceId);
    expect(proof).toEqual({
      kind: 'allowed',
      context,
      candidateRunId,
      inputRef: allowed.inputRef,
      inputChecksum: allowed.inputChecksum,
      deadlineAt,
      pin,
      storedInputJson: serializeStoredExecutionValueV1(allowed.inputRef),
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.context)).toBe(true);
    expect(Object.isFrozen(proof.pin)).toBe(true);
    expect(Object.isFrozen(proof.inputRef)).toBe(true);
  });

  it('accepts retained artifact input without loading artifact bytes', async () => {
    const inputRef = {
      schemaVersion: 1,
      kind: 'artifact',
      artifactId: outboxEventId,
    };
    const test = fixture([
      {
        proof: { ...allowed, inputRef, inputRefJson: JSON.stringify(inputRef) },
      },
    ]);
    expect(
      allowedProof(await lockWorkflowCallAdmission(test.transaction, input))
        .inputRef,
    ).toEqual(inputRef);
    expect(test.execute).toHaveBeenCalledOnce();
  });

  it('uses the exact stored-input value budget, not the larger proof wrapper size', async () => {
    const value = 'x'.repeat(STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes - 2);
    const inputRef = { schemaVersion: 1, kind: 'inline', value };
    expect(
      Buffer.byteLength(JSON.stringify({ ...allowed, inputRef })),
    ).toBeGreaterThan(262_144);
    const test = fixture([
      {
        proof: { ...allowed, inputRef, inputRefJson: JSON.stringify(inputRef) },
      },
    ]);
    expect(
      allowedProof(await lockWorkflowCallAdmission(test.transaction, input))
        .inputRef,
    ).toEqual(inputRef);
    await expect(
      lockWorkflowCallAdmission(
        fixture([
          {
            proof: {
              ...allowed,
              inputRef: { ...inputRef, value: `${value}x` },
            },
          },
        ]).transaction,
        input,
      ),
    ).rejects.toBeInstanceOf(WorkflowCallAdmissionCorruptError);
  });

  it.each([
    null,
    { schemaVersion: 1, kind: 'inline', value: '\u0000' },
    { schemaVersion: 1, kind: 'inline', value: Infinity },
    { schemaVersion: 1, kind: 'artifact', artifactId: 'bad' },
    { schemaVersion: 1, kind: 'inline', value: {}, extra: true },
  ])('contains invalid stored input as corrupt proof %#', async (inputRef) => {
    await expect(
      lockWorkflowCallAdmission(
        fixture([{ proof: { ...allowed, inputRef } }]).transaction,
        input,
      ),
    ).rejects.toBeInstanceOf(WorkflowCallAdmissionCorruptError);
  });

  it('returns a recorded duplicate with normalized Date and no fresh reserve query', async () => {
    const test = fixture([{ proof: recorded }]);
    const proof = await lockWorkflowCallAdmission(test.transaction, input);
    expect(proof).toEqual({
      kind: 'recorded',
      accepted: {
        ...recorded.accepted,
        acceptedAt: new Date('2026-10-02T10:00:00.000Z'),
        duplicate: true,
      },
    });
    expect(test.execute).toHaveBeenCalledOnce();
    expect(Object.isFrozen(proof)).toBe(true);
    if (proof.kind !== 'recorded')
      throw new Error('Expected recorded acceptance');
    expect(Object.isFrozen(proof.accepted)).toBe(true);
  });

  it('accepts driver Date timestamps and retains deadline as an ISO string', async () => {
    const date = new Date('2026-10-02T10:00:00.000Z');
    const prior = await lockWorkflowCallAdmission(
      fixture([
        {
          proof: {
            ...recorded,
            accepted: { ...recorded.accepted, acceptedAt: date },
          },
        },
      ]).transaction,
      input,
    );
    expect(prior).toMatchObject({ accepted: { acceptedAt: date } });
    const next = allowedProof(
      await lockWorkflowCallAdmission(
        fixture([{ proof: { ...allowed, deadlineAt: date } }]).transaction,
        input,
      ),
    );
    expect(next.deadlineAt).toBe(date.toISOString());
  });

  it.each([
    'workflow.child_capacity_unavailable',
    'workflow.child_queue_unavailable',
    'workflow.child_entitlement_unavailable',
    'workflow.child_authority_unavailable',
    'workflow.child_admission_unavailable',
    'workflow.child_compatibility_unavailable',
  ])('accepts only the explicit refusal code %s', async (reasonCode) => {
    await expect(
      lockWorkflowCallAdmission(
        fixture([{ proof: { ...refused, reasonCode } }]).transaction,
        input,
      ),
    ).rejects.toMatchObject({
      name: 'WorkflowCallAdmissionRefusedError',
      reasonCode,
      message: reasonCode,
    });
  });

  it.each(['cancel_requested', 'deadline_expired'])(
    'keeps ancestor %s distinct from refusal',
    async (reason) => {
      const operation = lockWorkflowCallAdmission(
        fixture([{ proof: { ...stopped, reason } }]).transaction,
        input,
      );
      await expect(operation).rejects.toBeInstanceOf(
        WorkflowCallAdmissionStoppedError,
      );
      await expect(operation).rejects.not.toBeInstanceOf(
        WorkflowCallAdmissionRefusedError,
      );
      await expect(operation).rejects.toMatchObject({ reason });
    },
  );

  it.each([allowed, recorded, refused, stopped])(
    'validates exact workflow/version/engine on every outcome $kind',
    async (proof) => {
      for (const changed of [
        { ...proof, pin: { ...pin, workflowId: parentRunId } },
        { ...proof, pin: { ...pin, versionId: parentRunId } },
        { ...proof, engineVersion: 'other-engine' },
        { ...proof, pin: { ...pin, checksum: 'wf:v3:sha256:invalid' } },
        {
          ...proof,
          pin: {
            ...pin,
            callableContractIdentity: 'callable:v1:sha256:invalid',
          },
        },
      ]) {
        await expect(
          lockWorkflowCallAdmission(
            fixture([{ proof: changed }]).transaction,
            input,
          ),
        ).rejects.toBeInstanceOf(WorkflowCallAdmissionCorruptError);
      }
    },
  );

  it.each(
    [[], [{ proof: allowed }, { proof: allowed }], [{}], [{ proof: null }]].map(
      (rows) => ({ rows }),
    ),
  )('rejects missing, duplicate or empty proof rows %#', async ({ rows }) => {
    await expect(
      lockWorkflowCallAdmission(fixture(rows).transaction, input),
    ).rejects.toBeInstanceOf(WorkflowCallAdmissionCorruptError);
  });

  it.each([
    { ...allowed, extra: true },
    { ...allowed, engineVersion: '' },
    { ...allowed, inputChecksum: 'C'.repeat(64) },
    { ...allowed, deadlineAt: '2026-10-02' },
    { ...allowed, deadlineAt: new Date(NaN) },
    { ...allowed, pin: { ...pin, actorId: parentRunId } },
    { ...recorded, accepted: { ...recorded.accepted, duplicate: true } },
    { ...recorded, accepted: { ...recorded.accepted, acceptedAt: 'bad' } },
    { ...recorded, accepted: { ...recorded.accepted, status: 'future' } },
    { ...refused, reasonCode: 'PTA01' },
    { ...stopped, reason: 'failed' },
    { ...stopped, inputRef: allowed.inputRef },
    { kind: 'unknown', ...common },
  ])('rejects malformed or extra union fields %#', async (proof) => {
    await expect(
      lockWorkflowCallAdmission(fixture([{ proof }]).transaction, input),
    ).rejects.toBeInstanceOf(WorkflowCallAdmissionCorruptError);
  });

  it.each([
    { expectedParentRevision: -1 },
    { expectedParentRevision: 2_147_483_647 },
    { expectedParentRevision: 1.5 },
    { parentRunId: 'not-uuid' },
    { invocationKey: '' },
    { invocationKey: 'x'.repeat(257) },
    { invocationKey: '界'.repeat(86) },
    { workspaceId },
    { rootRunId: parentRunId },
    { actorId: parentRunId },
  ])(
    'rejects invalid or caller-selected authority context before SQL %#',
    async (patch) => {
      const test = fixture();
      await expect(
        lockWorkflowCallAdmission(test.transaction, {
          ...input,
          context: { ...context, ...patch },
        }),
      ).rejects.toBeDefined();
      expect(test.execute).not.toHaveBeenCalled();
    },
  );

  it('accepts the maximum revision and exact UTF-8 key bound', async () => {
    const test = fixture();
    const exact = {
      ...context,
      expectedParentRevision: 2_147_483_646,
      invocationKey: `${'界'.repeat(85)}x`,
    };
    expect(
      allowedProof(
        await lockWorkflowCallAdmission(test.transaction, {
          ...input,
          context: exact,
        }),
      ).context,
    ).toEqual(exact);
  });

  it('rejects malformed canonical candidate before SQL', async () => {
    const test = fixture();
    await expect(
      lockWorkflowCallAdmission(test.transaction, {
        ...input,
        candidateRunId: 'caller-candidate',
      }),
    ).rejects.toBeDefined();
    expect(test.execute).not.toHaveBeenCalled();
  });
});

describe('canonical active-admission reservation', () => {
  it('binds exact proof identities to the existing FIFO reservation owner', async () => {
    const test = await reserveFixture();
    await reserveWorkflowCallAdmission(
      test.transaction,
      test.proof,
      outboxEventId,
    );
    const query = test.execute.mock.calls[0]?.[0];
    if (query === undefined) throw new Error('Expected SQL query');
    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain(
      'app.reserve_workflow_call_active_admission(',
    );
    expect(compiled.params).toEqual([
      parentRunId,
      7,
      context.invocationKey,
      candidateRunId,
      outboxEventId,
    ]);
    expect(test.execute).toHaveBeenCalledOnce();
  });

  it('converts only boolean false to explicit capacity refusal', async () => {
    const test = await reserveFixture([{ reserved: false }]);
    await expect(
      reserveWorkflowCallAdmission(test.transaction, test.proof, outboxEventId),
    ).rejects.toMatchObject({
      name: 'WorkflowCallAdmissionRefusedError',
      reasonCode: 'workflow.child_capacity_unavailable',
    });
  });

  it.each(
    [
      [],
      [{ reserved: true }, { reserved: true }],
      [{}],
      [{ reserved: null }],
      [{ reserved: 0 }],
      [{ reserved: 'false' }],
    ].map((rows) => ({ rows })),
  )('rejects noncanonical reserve results %#', async ({ rows }) => {
    const test = await reserveFixture(rows);
    await expect(
      reserveWorkflowCallAdmission(test.transaction, test.proof, outboxEventId),
    ).rejects.toBeInstanceOf(WorkflowCallAdmissionCorruptError);
  });

  it('rejects an invalid outbox ID before SQL', async () => {
    const test = await reserveFixture();
    await expect(
      reserveWorkflowCallAdmission(test.transaction, test.proof, 'bad'),
    ).rejects.toBeDefined();
    expect(test.execute).not.toHaveBeenCalled();
  });
});

describe('SQL failures never become child policy refusals', () => {
  it.each([
    'PTA01',
    'PTA02',
    'PTA03',
    '57014',
    '40P01',
    '40001',
    '23505',
    undefined,
  ])(
    'preserves rejection identity for %s on both SQL functions',
    async (code) => {
      const error =
        code === undefined
          ? undefined
          : Object.assign(new Error('SQL rejected'), { code });
      const test = fixture();
      test.execute.mockRejectedValueOnce(error);
      await expect(
        lockWorkflowCallAdmission(test.transaction, input),
      ).rejects.toBe(error);
      const reservation = await reserveFixture();
      reservation.execute.mockRejectedValueOnce(error);
      await expect(
        reserveWorkflowCallAdmission(
          reservation.transaction,
          reservation.proof,
          outboxEventId,
        ),
      ).rejects.toBe(error);
    },
  );
});
