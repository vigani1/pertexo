import { generatePersistedId } from '@pertexo/database/platform';
import { decodeStoredValue } from '../../shared/stored-values.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';
import { serializeStoredExecutionValue } from '../../shared/stored-execution.js';
import { requireTransactionConnectionBindings } from '../../shared/resources/connection-bindings.repository.js';
import { connectionScope } from '../../shared/resources/connection-scope.repository.js';

import { resolvePreviewSample } from './samples.repository.js';

import type { Role } from '@pertexo/policy';
import { lockActorArtifactReferences } from '../../artifacts/references/lock-references.js';
import { captureWorkspaceVariableRevision } from '../../variables/head.repository.js';

import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { PREVIEW_STATUS } from '../preview-state.js';

import { PreviewAcceptanceCorruptError } from '../preview.errors.js';
import {
  assertAdmission,
  assertPreviewWorkflow,
} from './acceptance/admission.repository.js';
import type {
  AcceptPreviewRunInput,
  AcceptedPreviewRun,
} from './acceptance/preview-acceptance.types.js';
import { assertPreviewDeadlines } from './acceptance/limits.js';
import {
  readExistingAcceptance,
  resolveInput,
} from './acceptance/replay.repository.js';
import {
  claimPreviewIdempotency,
  completePreviewIdempotency,
  insertAcceptedPreviewRun,
  insertQueuedPreviewAttempt,
  lockPreviewAcceptanceKey,
} from './acceptance/accepted-preview.repository.js';
export async function acceptPreviewRun(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  role: Role,
): Promise<AcceptedPreviewRun> {
  const resources = await assertPreviewWorkflow(
    transaction,
    role,
    input.actorUserId,
    input.workflowId,
  );
  await lockPreviewAcceptanceKey(
    transaction,
    `preview:${transaction.workspaceId}:${input.scope}:${input.keyHash}`,
  );
  const existing = await readExistingAcceptance(transaction, input);
  if (existing !== null) return existing;

  const now = new Date();
  assertPreviewDeadlines(input, now);
  const draftGraph = await assertAdmission(
    transaction,
    input.workflowId,
    input.draftRevision,
  );
  const sample = await resolvePreviewSample(
    transaction,
    {
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      ...(input.expectedSampleId === undefined
        ? {}
        : { expectedSampleId: input.expectedSampleId }),
    },
    draftGraph,
  );
  const resolvedInput =
    sample === undefined
      ? await resolveInput(transaction, input.workflowId, input.input, now)
      : {
          priorPreviewRunId: null,
          stored: serializeStoredExecutionValue({ kind: 'inline', value: {} }),
        };

  await assertPreviewInputAuthority(transaction, input, {
    resources,
    sample,
    resolvedInput,
  });
  const idempotencyRecordId = generatePersistedId();
  const previewRunId = generatePersistedId();
  const dispatch =
    sample === undefined
      ? {
          kind: 'execution' as const,
          previewAttemptId: generatePersistedId(),
          outboxEventId: generatePersistedId(),
        }
      : { kind: 'pinned' as const, ...sample };
  const previewAttemptId =
    dispatch.kind === 'execution' ? dispatch.previewAttemptId : null;
  const outboxEventId =
    dispatch.kind === 'execution' ? dispatch.outboxEventId : null;
  const resultRef =
    sample === undefined
      ? { outboxEventId, previewAttemptId }
      : { pinnedSampleId: sample.id };

  const claimed = await claimPreviewIdempotency(transaction, input, {
    id: idempotencyRecordId,
    previewRunId,
  });
  if (!claimed) {
    const raced = await readExistingAcceptance(transaction, input);
    if (raced === null) throw new PreviewAcceptanceCorruptError();
    return raced;
  }

  const insertedRun = await insertAcceptedPreviewRun(transaction, input, {
    previewRunId,
    sample,
    resolvedInput,
    variableSetRevision: await captureWorkspaceVariableRevision(transaction),
  });
  if (insertedRun === undefined) throw new PreviewAcceptanceCorruptError();
  if (dispatch.kind === 'execution')
    await persistPreviewAttempt(transaction, input, {
      previewRunId,
      previewAttemptId: dispatch.previewAttemptId,
      outboxEventId: dispatch.outboxEventId,
    });
  await recordAcceptedPreview(transaction, input, { previewRunId, sample });
  if (
    !(await completePreviewIdempotency(
      transaction,
      idempotencyRecordId,
      resultRef,
    ))
  )
    throw new PreviewAcceptanceCorruptError();

  return Object.freeze({
    acceptedAt: insertedRun.acceptedAt,
    completedAt: insertedRun.completedAt,
    duplicate: false,
    expiresAt: input.expiresAt,
    outboxEventId,
    previewAttemptId,
    previewRunId,
    status:
      sample === undefined ? PREVIEW_STATUS.queued : PREVIEW_STATUS.succeeded,
    ...(sample === undefined
      ? {}
      : { pinnedSampleId: sample.id, pinnedOutput: sample.output }),
  });
}

type PreviewSample = Awaited<ReturnType<typeof resolvePreviewSample>>;
async function assertPreviewInputAuthority(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  {
    resources,
    sample,
    resolvedInput,
  }: Readonly<{
    resources: Awaited<ReturnType<typeof assertPreviewWorkflow>>;
    sample: PreviewSample;
    resolvedInput: Awaited<ReturnType<typeof resolveInput>>;
  }>,
): Promise<void> {
  if (sample === undefined) {
    await requireTransactionConnectionBindings(
      transaction,
      connectionScope(
        { workspaceId: transaction.workspaceId, actorId: input.actorUserId },
        resources.role,
        'connection:use',
      ),
      Object.entries(input.executableNode.connectionRefs ?? {}).map(
        ([slot, id]) => ({
          id,
          path: `$.nodes.${input.nodeId}.connectionRefs.${slot}`,
        }),
      ),
    );
    await lockActorArtifactReferences(
      transaction,
      input.actorUserId,
      decodeStoredValue((): unknown => JSON.parse(resolvedInput.stored)),
      resolvedInput.priorPreviewRunId ?? undefined,
    );
    await lockActorArtifactReferences(
      transaction,
      input.actorUserId,
      input.executableNode,
      resolvedInput.priorPreviewRunId ?? undefined,
    );
  }
}
async function recordAcceptedPreview(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  {
    previewRunId,
    sample,
  }: Readonly<{ previewRunId: string; sample: PreviewSample }>,
): Promise<void> {
  await appendAuditFact(transaction, {
    workspaceId: transaction.workspaceId,
    actorId: input.actorUserId,
    action: 'preview.execution_accepted',
    targetType: 'preview-run',
    targetId: previewRunId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: {
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      sideEffectClass: sample === undefined ? input.sideEffectClass : 'safe',
      mayContactProvider: sample === undefined && input.mayContactProvider,
      mayCauseExternalSideEffect:
        sample === undefined && input.mayCauseExternalSideEffect,
      ...(sample === undefined ? {} : { pinnedSampleId: sample.id }),
      dryRun: sample === undefined ? input.dryRun : 'not_supported',
      expiresAt: input.expiresAt.toISOString(),
    },
  });
}

async function persistPreviewAttempt(
  transaction: WorkspaceTransaction,
  input: AcceptPreviewRunInput,
  {
    previewRunId,
    previewAttemptId,
    outboxEventId,
  }: Readonly<{
    previewRunId: string;
    previewAttemptId: string;
    outboxEventId: string;
  }>,
): Promise<void> {
  await insertQueuedPreviewAttempt(transaction, input, {
    previewRunId,
    previewAttemptId,
  });

  const payload = {
    workspaceId: transaction.workspaceId,
    outboxEventId,
    previewRunId,
    previewAttemptId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  } as const;

  await insertOutboxEvent(transaction, {
    id: outboxEventId,
    jobName: 'execute-preview-attempt',
    aggregateType: 'preview-run',
    aggregateId: previewRunId,
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  });
}
