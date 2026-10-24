import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  reconcileUnknownOutcomeEvidence,
  UnknownOutcomeReconciliationMismatchError,
  UnknownOutcomeReconciliationStateError,
} from '../../../src/outbox/reconciliation.repository.js';
import { mocks, evidencePayload, reconciliationWith } from './fixture.js';

export function registerProcessesExactEvidenceDeliveryIdentity(): void {
  it('processes exact evidence delivery identity and validates its public signal', async () => {
    const fixture = reconciliationWith();
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).resolves.toEqual({ kind: 'processed' });
    expect(fixture.execute).toHaveBeenCalledTimes(2);

    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, {
        ...fixture.input,
        signal: {} as AbortSignal,
      }),
    ).rejects.toThrow();
    expect(mocks.consumeInboxMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing outbox', null],
    ['wrong aggregate id', { aggregate_id: randomUUID() }],
    ['wrong aggregate type', { aggregate_type: 'workflow-run' }],
    ['wrong job', { job_name: 'advance-workflow-run' }],
    ['wrong checksum', { payload_checksum: 'c'.repeat(64) }],
    [
      'wrong payload attempt',
      { payload: { ...evidencePayload, attemptId: randomUUID() } },
    ],
    [
      'wrong payload command',
      { payload: { ...evidencePayload, evidenceCommandId: randomUUID() } },
    ],
    [
      'wrong payload event',
      { payload: { ...evidencePayload, outboxEventId: randomUUID() } },
    ],
    [
      'wrong payload workspace',
      { payload: { ...evidencePayload, workspaceId: randomUUID() } },
    ],
    ['malformed payload', { payload: {} }],
  ])('rejects %s before reading evidence', async (_scenario, override) => {
    const fixture = reconciliationWith(override);
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationMismatchError);
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', null],
    ['no longer unknown', { status: 'succeeded' }],
  ])('rejects %s evidence state without completion', async (_scenario, row) => {
    const fixture = reconciliationWith(undefined, row);
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationStateError);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });

  it('returns duplicate without reading durable evidence again', async () => {
    const fixture = reconciliationWith();
    mocks.consumeInboxMessage.mockResolvedValueOnce({ status: 'duplicate' });
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).resolves.toEqual({ kind: 'duplicate' });
    expect(fixture.execute).not.toHaveBeenCalled();
  });
}
