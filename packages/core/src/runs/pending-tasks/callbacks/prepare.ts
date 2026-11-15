import { CallbackPreviewRefusedError } from './callback.errors.js';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import { lockWorkspaceExecutionCounter } from '../../admission-locks.repository.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { callbackScopeHash } from './scope-hash.js';
import {
  readPendingTaskAllowance,
  hasPendingTaskCapacity,
} from '../lifecycle/allowance.repository.js';
import { callbackWaitConfigSchema } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { assertCapabilityExecution } from '../../../attempts/dispatch/fence.repository.js';
import { lockCapabilityExecution } from '../../../attempts/dispatch/fence.js';
import { generatePersistedId } from '@pertexo/database/platform';
import { CallbackCapacityError } from './callback.errors.js';
import type {
  CallbackPreparation,
  PreparedCallback,
} from './callback.types.js';
import {
  findPreparedCallback,
  persistPreparedCallback,
  readCallbackOwner,
} from './prepare.repository.js';

export async function prepareCallbacks(
  client: PoolClient,
  input: CallbackPreparation,
): Promise<readonly PreparedCallback[]> {
  await lockCapabilityExecution(client, input);
  await assertCapabilityExecution(client, input);
  if (input.previewRunId !== undefined) throw new CallbackPreviewRefusedError();
  const owner = await readCallbackOwner(client, input);
  if (owner === undefined)
    throw new Error('The callback execution scope is unavailable.');
  const iteration = owner.branch_context.iterationPath ?? [];
  const scopeHash = callbackScopeHash(iteration);
  await lockWorkspaceExecutionCounter(drizzle(client), input.workspaceId);
  const allowance = await readPendingTaskAllowance(client, input.workspaceId);
  let count = allowance.count;
  const result: PreparedCallback[] = [];
  for (const target of input.targets) {
    const found = await findPreparedCallback(
      client,
      input,
      target.nodeId,
      scopeHash,
    );
    const identity = {
      id: found?.id ?? generatePersistedId(),
      workspaceId: input.workspaceId,
      runId: input.runId,
      nodeId: target.nodeId,
      scopeHash,
    };
    if (found !== undefined) {
      result.push({
        ...identity,
        id: found.id,
        keyVersion: found.callback_key_version,
        tokenHash: found.callback_token_hash,
        config: decodeStoredValue(() =>
          callbackWaitConfigSchema.parse(found.config),
        ),
      });
      continue;
    }
    if (!hasPendingTaskCapacity({ ...allowance, count }))
      throw new CallbackCapacityError();
    count++;
    const id = identity.id,
      tokenHash = input.tokenHash(identity);
    await persistPreparedCallback(client, {
      input,
      target,
      iteration,
      scopeHash,
      id,
      tokenHash,
    });
    result.push({
      ...identity,
      id,
      keyVersion: input.keyVersion,
      tokenHash,
      config: target.config,
    });
  }
  await assertCapabilityExecution(client, input);
  return result;
}
