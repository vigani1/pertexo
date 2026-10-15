import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { canonicalJson, parseFormValues } from '@pertexo/workflow-model';
import { databaseSchema } from '../../schema.js';
import { parseWorkspaceId } from '../../tenant-access/transactions.js';
import {
  acceptWorkflowRun,
  readWorkflowRunAcceptanceReplay,
} from '../../runs/commands/acceptance.js';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import { FormChangedError, type FormStore } from './contract.js';
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
  const replay = await readWorkflowRunAcceptanceReplay(transaction, identity);
  if (replay !== null)
    return {
      accepted: true as const,
      replayed: true,
      ...(publicAccess ? {} : { runId: replay.runId }),
    };
  if (version.id !== input.versionId) throw new FormChangedError();
  const values = parseFormValues(form.fields, input.values);
  const now = await client.query<{ now: Date }>('select clock_timestamp() now');
  const at = now.rows[0]?.now;
  if (at === undefined) throw new Error('Form admission clock missing');
  const initial = prepare(version);
  const accepted = await acceptWorkflowRun(transaction, {
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
  return {
    accepted: true as const,
    replayed: accepted.duplicate,
    ...(publicAccess ? {} : { runId: accepted.runId }),
  };
}
