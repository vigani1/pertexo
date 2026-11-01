import { and, eq, sql } from 'drizzle-orm';
import { workflowVersions, databaseSchema } from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
  parseWorkspaceId,
} from '@pertexo/database/primitives';
import type { FormSubmissionResponse } from '@pertexo/contracts';
import { coordinateEvent } from '../coordination/accept.repository.js';
import type { PreparedFormEvent } from './contract.js';
import { generatePersistedId } from '@pertexo/database/platform';

import { WorkflowAlreadyRunningError } from '../../runs/commands/acceptance/errors.js';
import { recordWorkflowTriggerSkip } from '../skips.repository.js';
import { readFormDefinition } from './definition.js';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  canonicalJson,
  DEFAULT_FORM_THANK_YOU_MESSAGE,
  type FormConfig,
} from '@pertexo/workflow-model';
import { acceptWorkflowRun } from '../../runs/commands/acceptance.repository.js';
import { readWorkflowRunAcceptanceReplay } from '../../runs/commands/acceptance/replay.repository.js';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import { FormChangedError, FormUnavailableError } from './errors.js';
import type { SubmitFormInput } from './contract.js';
import { markFormUploadsSubmitted } from '../../artifacts/form-uploads/unsent.queries.js';
import type { readFormVersion } from './records.queries.js';

export async function submitForm(
  client: PoolClient,
  input: SubmitFormInput,
  {
    prepare,
    publicAccess,
    loaded,
    prepared,
  }: Readonly<{
    prepare: InitialCheckpointFactory;
    publicAccess: boolean;
    loaded: Awaited<ReturnType<typeof readFormVersion>>;
    prepared: PreparedFormEvent | undefined;
  }>,
) {
  // Match ordinary admission: workspace precedes workflow/publication locks.
  const { version, form, nodeId } = loaded;
  const { identity, command } = formSubmissionIdentity(input);
  const transaction = {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(input.workspaceId),
  };
  const previous = await claimCommand<FormSubmissionResponse>(client, {
    ...command,
    requestHash: identity.requestHash,
    resourceId: input.workflowId,
  });
  if (previous !== null)
    return {
      ...previous,
      replayed: true,
    };
  const replay = await readWorkflowRunAcceptanceReplay(transaction, identity);
  if (replay !== null) {
    let acceptedForm = form;
    // The confirmed request hash binds the original version after republication.
    if (version.id !== input.versionId) {
      const original = await transaction.db
        .select({ graphJson: workflowVersions.graphJson })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workspaceId, input.workspaceId),
            eq(workflowVersions.workflowId, input.workflowId),
            eq(workflowVersions.id, input.versionId),
          ),
        )
        .catch(rethrowQueryFailure);
      const row = original[0];
      if (row === undefined) throw new FormUnavailableError();
      acceptedForm = readFormDefinition(row.graphJson).form;
    }
    const receipt = submissionReceipt(
      acceptedForm,
      { runId: replay.runId, replayed: true },
      { publicAccess },
    );
    await completeCommand(client, command, receipt);
    return receipt;
  }
  if (version.id !== input.versionId) throw new FormChangedError();
  if (prepared?.versionId !== version.id) throw new FormChangedError();
  if ('error' in prepared) throw prepared.error;
  const initial = prepare(version);
  const startRun = () =>
    acceptWorkflowRun(transaction, {
      ...identity,
      workflowId: input.workflowId,
      workflowVersionId: version.id,
      initialCheckpoint: initial.checkpoint,
      ...(initial.validateInput === undefined
        ? {}
        : { validateInput: initial.validateInput }),
      triggerType: 'form',
      ...(input.actorId === undefined ? {} : { startedBy: input.actorId }),
      runInput: prepared.input,
    });
  if (prepared.coordination !== undefined) {
    const result = await coordinateEvent(
      transaction,
      {
        eventId: generatePersistedId(),
        workflowId: input.workflowId,
        nodeId,
        source: 'form',
        version,
        prepared: prepared.coordination,
        ...(input.actorId === undefined ? {} : { startedBy: input.actorId }),
      },
      startRun,
    );
    // A started run or a held event keeps the input, so its files are sent.
    if (
      'runId' in result ||
      ('coordinated' in result && result.status === 'pending')
    )
      await markFormUploadsSubmitted(
        client,
        input.workspaceId,
        prepared.uploadIds,
      );
    const receipt =
      'coordinated' in result || 'skipped' in result
        ? { accepted: false as const, ...result, replayed: false }
        : submissionReceipt(form, result, { publicAccess });
    await completeCommand(client, command, receipt);
    return receipt;
  }
  let accepted;
  await transaction.db
    .execute(sql`savepoint form_run_admission`)
    .catch(rethrowQueryFailure);
  try {
    accepted = await startRun();
  } catch (error) {
    if (!(error instanceof WorkflowAlreadyRunningError)) throw error;
    await transaction.db
      .execute(sql`rollback to savepoint form_run_admission`)
      .catch(rethrowQueryFailure);
    await transaction.db
      .execute(sql`release savepoint form_run_admission`)
      .catch(rethrowQueryFailure);
    await recordWorkflowTriggerSkip(transaction, input.workflowId, 'form');
    const receipt = {
      accepted: false as const,
      skipped: true as const,
      reason: 'concurrency_limit' as const,
      replayed: false,
    };
    await completeCommand(client, command, receipt);
    return receipt;
  }
  await transaction.db
    .execute(sql`release savepoint form_run_admission`)
    .catch(rethrowQueryFailure);
  await markFormUploadsSubmitted(client, input.workspaceId, prepared.uploadIds);
  const receipt = submissionReceipt(
    form,
    { runId: accepted.runId, replayed: accepted.duplicate },
    { publicAccess },
  );
  await completeCommand(client, command, receipt);
  return receipt;
}
function submissionReceipt(
  form: FormConfig,
  result: Readonly<{ runId: string; replayed: boolean }>,
  { publicAccess }: Readonly<{ publicAccess: boolean }>,
) {
  return {
    accepted: true as const,
    thankYouMessage: form.thankYouMessage ?? DEFAULT_FORM_THANK_YOU_MESSAGE,
    ...(form.redirectUrl === undefined
      ? {}
      : { redirectUrl: form.redirectUrl }),
    replayed: result.replayed,
    ...(publicAccess ? {} : { runId: result.runId }),
  };
}

export function formSubmissionIdentity(input: SubmitFormInput) {
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const scope = `form:${input.workflowId}:${input.actorId ?? 'public'}`;
  const identity = {
    operation: 'workflow.run.accept' as const,
    scope,
    keyHash: digest(input.idempotencyKey),
    requestHash: digest(
      canonicalJson({
        versionId: input.versionId,
        values: input.values,
        actorId: input.actorId ?? null,
      }),
    ),
  };
  const command = {
    workspaceId: input.workspaceId,
    operation: 'form.submit',
    scope,
    idempotencyKey: input.idempotencyKey,
  };
  return { identity, command };
}
