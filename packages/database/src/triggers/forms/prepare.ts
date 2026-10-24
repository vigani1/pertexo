import { findCommandResult } from '../../platform/idempotency/repository.js';
import { formSubmissionIdentity } from './submit.js';
import type { Pool } from 'pg';
import {
  parseFormValues,
  FormValuesInvalidError,
} from '@pertexo/workflow-model';
import { withTenantScopedReadClient } from '../../tenant-access/transactions.js';
import { authorizeForm, readFormVersion } from './read.js';
import type { FormStore, PublicFormGrant } from './contract.js';
import type { PreparedEventCoordination } from '../coordination/contract.js';
import type { createEventCoordinationPreparation } from '../coordination/prepare.js';
export type PreparedFormEvent =
  | Readonly<{ versionId: string; error: FormValuesInvalidError }>
  | Readonly<{
      versionId: string;
      input: Readonly<{
        values: ReturnType<typeof parseFormValues>;
        submittedBy: string | null;
        submittedAt: string;
      }>;
      coordination?: PreparedEventCoordination;
    }>;
/** Read an authorized immutable candidate; expression work holds no admission locks. */
export async function prepareFormEvent(
  pool: Pool,
  input: Parameters<FormStore['submit']>[0],
  grant: PublicFormGrant | undefined,
  preparation: ReturnType<typeof createEventCoordinationPreparation>,
): Promise<PreparedFormEvent | undefined> {
  const candidate = await withTenantScopedReadClient(
    pool,
    {
      workspaceId: input.workspaceId,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    },
    async (client) => {
      await authorizeForm(client, input, { grant, write: false });
      const { identity, command } = formSubmissionIdentity(input);
      if (
        (await findCommandResult(client, {
          ...command,
          requestHash: identity.requestHash,
        })) !== null
      )
        return undefined;
      const loaded = await readFormVersion(client, input, 'read');
      if (grant !== undefined && grant.nodeId !== loaded.nodeId)
        return undefined;
      if (loaded.version.id !== input.versionId) return undefined;
      let values: ReturnType<typeof parseFormValues>;
      try {
        values = parseFormValues(loaded.form.fields, input.values);
      } catch (error) {
        if (error instanceof FormValuesInvalidError)
          return { versionId: loaded.version.id, error };
        throw error;
      }
      const at = (
        await client.query<{ now: Date }>('select clock_timestamp() now')
      ).rows[0]?.now;
      if (at === undefined) throw new Error('Form admission clock missing');
      return {
        versionId: loaded.version.id,
        policy: loaded.form.coordination,
        input: {
          values,
          submittedBy: input.actorId ?? null,
          submittedAt: at.toISOString(),
        },
      };
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
  if (candidate === undefined || 'error' in candidate) return candidate;
  const coordination = await preparation.prepare(
    candidate.policy,
    candidate.input,
    input.signal,
  );
  return {
    versionId: candidate.versionId,
    input: candidate.input,
    ...(coordination === undefined ? {} : { coordination }),
  };
}
