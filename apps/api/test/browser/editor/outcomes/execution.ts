import { verifyCodeEvidence } from '../evidence/code/verify.js';
import { verifyWebhookResponseEvidence } from '../evidence/webhook-responses.js';
import { verifySampleEvidence } from '../evidence/samples/verify.js';

import { verifyErrorWorkflowEvidence } from '../evidence/error-workflows/verify.js';

import { verifyFailureRoutingEvidence } from '../evidence/failure-routing.js';

import { createHash } from 'node:crypto';

import { expect } from 'vitest';

import { verifyCallsEvidence } from '../evidence/calls.js';
import { verifyCallableEvidence } from '../evidence/callable.js';
import {
  submittedHttpEvidenceIds,
  verifyHttpEvidence,
} from '../evidence/http.js';

import { verifyScheduleEvidence } from '../evidence/schedule.js';

import { verifyExpressionAdmissionEvidence } from '../evidence/expression-admission.js';
import {
  verifyReceiptRecoveryEvidence,
  verifyRunRecoveryEvidence,
} from '../evidence/recovery.js';

import { fixtureState } from '../fixture/state.js';
import type { EditorBrowserJourneyContext } from '../fixture/contract.js';

export async function verifyEditorRunValuesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  const rows = await api
    .database()
    .query<{ key: string; value: string }>(
      'select key,value from app.workflow_run_values order by key',
    );
  expect(rows.rows).toEqual([{ key: 'orderId', value: 'A-1042' }]);
  return;
}

export async function verifyEditorCodeOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyCodeEvidence(api.database());
  return;
}

export async function verifyEditorWebhookResponsesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyWebhookResponseEvidence(api.database());
  return;
}

export async function verifyEditorPinnedSamplesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifySampleEvidence(api.database());
  return;
}

export async function verifyEditorErrorWorkflowsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyErrorWorkflowEvidence(api.database());
  return;
}

export async function verifyEditorCallableOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.callableEvidence === undefined)
    throw new Error('Callable browser evidence missing');
  await verifyCallableEvidence(api.database(), fixtureState.callableEvidence);
  if (fixtureState.callsEvidence === undefined)
    throw new Error('Workflow Call browser evidence missing');
  await verifyCallsEvidence(api.database(), fixtureState.callsEvidence);
  process.stdout.write(
    `Live browser callable verified identities ${JSON.stringify(fixtureState.callableEvidence)}\n`,
  );
  return;
}

export async function verifyEditorFailureRoutingOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (
    fixtureState.failureRoutingEvidence === undefined ||
    fixtureState.httpEffects === undefined
  )
    throw new Error('Failure routing browser evidence missing');
  await verifyFailureRoutingEvidence(
    api.database(),
    fixtureState.failureRoutingEvidence,
    fixtureState.httpEffects,
  );
  return;
}

/** The journey uploaded one workbook and a run created another from it. */
export async function verifyEditorSpreadsheetsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { rows } = await context.api
    .database()
    .query<{ purpose: string; count: number }>(
      `select purpose, count(*)::int as count from app.artifacts
        where media_type = $1 and status = 'available'
        group by purpose order by purpose`,
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    );
  const counts = Object.fromEntries(
    rows.map((row) => [row.purpose, row.count]),
  );
  expect(counts['node-output']).toBeGreaterThanOrEqual(1);
  expect(
    Object.values(counts).reduce((sum, count) => sum + count, 0),
  ).toBeGreaterThanOrEqual(2);
  process.stdout.write(
    `Live spreadsheet workbooks ${JSON.stringify(counts)}\n`,
  );
}

export function verifyEditorArtifactInputsOutcome(
  _context: EditorBrowserJourneyContext,
) {
  if (fixtureState.httpEffects === undefined)
    throw new Error('Owned artifact HTTP effects missing');
  if (process.env.F45_RELEASE_QUALIFICATION === 'true') {
    expect(fixtureState.httpEffects.requests).toBe(0);
    expect(fixtureState.httpEffects.effects).toBe(0);
    return;
  }
  expect(fixtureState.httpEffects.requests).toBe(7);
  expect(fixtureState.httpEffects.effects).toBe(7);
  const binary = Buffer.alloc(1048576);
  for (let index = 0; index < binary.length; index++)
    binary[index] = index % 256;
  const hash = (value: Buffer | string) =>
    createHash('sha256').update(value).digest('hex');
  expect(fixtureState.httpEffects.bodyHashes.slice(0, 5)).toEqual([
    hash(binary),
    hash('{}'),
    hash(''),
    hash('{}'),
    hash('multipart response source'),
  ]);
  expect(fixtureState.httpEffects.bodyHashes[6]).toBe(
    hash('one earlier effect'),
  );
  process.stdout.write(
    `Live artifact input destination hashes ${JSON.stringify(fixtureState.httpEffects.bodyHashes)}\n`,
  );
  return;
}

export async function verifyEditorWebhookControlledHttpOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (
    fixtureState.httpControl === undefined ||
    fixtureState.httpEffects === undefined
  )
    throw new Error('Owned HTTP control/effect evidence missing');
  const submitted = fixtureState.httpControl.readEvidence();
  process.stdout.write(
    `Live browser controlled HTTP submitted/unverified identities ${JSON.stringify(submittedHttpEvidenceIds(submitted))}\n`,
  );
  await verifyHttpEvidence(api.database(), submitted, fixtureState.httpEffects);
  process.stdout.write(
    `Live browser controlled HTTP verified evidence ${JSON.stringify({ ...submitted, effects: fixtureState.httpEffects })}\n`,
  );
  return;
}

export async function verifyEditorScheduleOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (
    fixtureState.scheduleEvidence === undefined ||
    fixtureState.scheduleRestart === undefined
  )
    throw new Error('Schedule restart/evidence missing');
  expect(fixtureState.scheduleRestart.scope).toEqual({
    workspaceId: fixtureState.scheduleEvidence.workspaceId,
    workflowId: fixtureState.scheduleEvidence.workflowId,
    workflowVersionId: fixtureState.scheduleEvidence.workflowVersionId,
  });
  expect(fixtureState.scheduleEvidence.triggerId).toBe(
    fixtureState.scheduleRestart.triggerId,
  );
  expect(fixtureState.scheduleEvidence.firstDueAt).toBe(
    fixtureState.scheduleRestart.nextFireAt,
  );
  process.stdout.write(
    `Live browser schedule submitted/unverified ${JSON.stringify({
      workspaceId: fixtureState.scheduleEvidence.workspaceId,
      workflowId: fixtureState.scheduleEvidence.workflowId,
      workflowVersionId: fixtureState.scheduleEvidence.workflowVersionId,
      triggerId: fixtureState.scheduleEvidence.triggerId,
      runId: fixtureState.scheduleEvidence.runId,
      occurrenceId: fixtureState.scheduleEvidence.occurrenceId,
      restartRequestId: fixtureState.scheduleRestart.requestId,
      firstDueAt: fixtureState.scheduleEvidence.firstDueAt,
      scheduledAt: fixtureState.scheduleEvidence.scheduledAt,
    })}\n`,
  );
  await verifyScheduleEvidence(api.database(), fixtureState.scheduleEvidence);
  process.stdout.write(
    `Live browser schedule evidence ${JSON.stringify({ ...fixtureState.scheduleEvidence, restartRequestId: fixtureState.scheduleRestart.requestId })}\n`,
  );
  return;
}

export async function verifyEditorExpressionAdmissionOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.expressionEvidence === undefined)
    throw new Error('Expression admission evidence missing');
  await verifyExpressionAdmissionEvidence(
    api.database(),
    fixtureState.expressionEvidence,
  );
  process.stdout.write(
    `Live browser expression admission ${JSON.stringify(fixtureState.expressionEvidence)}\n`,
  );
  return;
}

export async function verifyEditorReceiptsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.receiptEvidence === undefined)
    throw new Error('Receipt recovery evidence missing');
  await verifyReceiptRecoveryEvidence(
    api.database(),
    fixtureState.receiptEvidence,
  );
  process.stdout.write(
    `Live browser receipt recovery ${JSON.stringify(fixtureState.receiptEvidence)}\n`,
  );
  return;
}

export async function verifyEditorRunRecoveryOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.runRecoveryEvidence === undefined)
    throw new Error('Run recovery evidence missing');
  await verifyRunRecoveryEvidence(
    api.database(),
    fixtureState.runRecoveryEvidence,
  );
  process.stdout.write(
    `Live browser run recovery ${JSON.stringify(fixtureState.runRecoveryEvidence)}\n`,
  );
  return;
}
