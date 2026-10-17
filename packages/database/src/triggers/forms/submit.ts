import { formSubmissionResponseSchema } from '@pertexo/contracts';
import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import { WorkflowAlreadyRunningError } from '../../runs/commands/concurrency.js';
import { recordWorkflowTriggerSkip } from '../skips.js';
import { readFormDefinition } from './definition.js';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  canonicalJson,
  parseFormValues,
  DEFAULT_FORM_THANK_YOU_MESSAGE,
  type FormConfig,
} from '@pertexo/workflow-model';
import { databaseSchema } from '../../schema.js';
import { parseWorkspaceId } from '../../tenant-access/transactions.js';
import {
  acceptWorkflowRun,
  readWorkflowRunAcceptanceReplay,
} from '../../runs/commands/acceptance.js';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import {
  FormChangedError,
  FormUnavailableError,
  type FormStore,
} from './contract.js';
import type { readFormVersion } from './read.js';

export async function submitForm(
  client: PoolClient,
  input: Parameters<FormStore['submit']>[0],
  prepare: InitialCheckpointFactory,
  publicAccess: boolean,
  loaded: Awaited<ReturnType<typeof readFormVersion>>,
) {
  // Match ordinary admission: workspace precedes workflow/publication locks.
  const { version, form } = loaded;
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
  const transaction = {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(input.workspaceId),
  };
  const command = {
    workspaceId: input.workspaceId,
    operation: 'form.submit',
    scope,
    idempotencyKey: input.idempotencyKey,
  };
  const previous = await claimCommand(client, {
    ...command,
    requestHash: identity.requestHash,
    resourceId: input.workflowId,
  });
  if (previous !== null)
    return formSubmissionResponseSchema.parse({
      ...formSubmissionResponseSchema.parse(previous),
      replayed: true,
    });
  const replay = await readWorkflowRunAcceptanceReplay(transaction, identity);
  if (replay !== null) {
    let acceptedForm = form;
    // The confirmed request hash binds the original version after republication.
    if (version.id !== input.versionId) {
      const original = await client.query<{ graph_json: unknown }>(
        'select graph_json from app.workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',
        [input.workspaceId, input.workflowId, input.versionId],
      );
      const row = original.rows[0];
      if (row === undefined) throw new FormUnavailableError();
      acceptedForm = readFormDefinition(row.graph_json).form;
    }
    const receipt = submissionReceipt(
      acceptedForm,
      { runId: replay.runId, replayed: true },
      publicAccess,
    );
    await completeCommand(client, command, receipt);
    return receipt;
  }
  if (version.id !== input.versionId) throw new FormChangedError();
  const values = parseFormValues(form.fields, input.values);
  const now = await client.query<{ now: Date }>('select clock_timestamp() now');
  const at = now.rows[0]?.now;
  if (at === undefined) throw new Error('Form admission clock missing');
  const initial = prepare(version);
  let accepted;
  await client.query('savepoint form_run_admission');
  try {
    accepted = await acceptWorkflowRun(transaction, {
      ...identity,
      workflowId: input.workflowId,
      workflowVersionId: version.id,
      initialCheckpoint: initial.checkpoint,
      ...(initial.validateInput === undefined
        ? {}
        : { validateInput: initial.validateInput }),
      triggerType: 'form',
      ...(input.actorId === undefined ? {} : { startedBy: input.actorId }),
      runInput: {
        values,
        submittedBy: input.actorId ?? null,
        submittedAt: at.toISOString(),
      },
    });
  } catch (error) {
    if (!(error instanceof WorkflowAlreadyRunningError)) throw error;
    await client.query('rollback to savepoint form_run_admission');
    await client.query('release savepoint form_run_admission');
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
  await client.query('release savepoint form_run_admission');
  const receipt = submissionReceipt(
    form,
    { runId: accepted.runId, replayed: accepted.duplicate },
    publicAccess,
  );
  await completeCommand(client, command, receipt);
  return receipt;
}
function submissionReceipt(
  form: FormConfig,
  result: Readonly<{ runId: string; replayed: boolean }>,
  publicAccess: boolean,
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
