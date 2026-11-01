import type { PreparedFormEvent } from './contract.js';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  findCommandResult,
  withTenantScopedReadClient,
} from '@pertexo/database/primitives';
import { formSubmissionIdentity } from './submit.repository.js';
import type { Pool } from 'pg';
import {
  formFileUploads,
  parseFormValues,
  FormValuesInvalidError,
} from '@pertexo/workflow-model';
import { authorizeForm, readFormVersion } from './records.queries.js';
import type { FormStore, PublicFormGrant } from './contract.js';
import { resolveFormFiles } from '../../artifacts/form-uploads/resolve.queries.js';

import type { createEventCoordinationPreparation } from '../coordination/prepare.js';
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
      let uploadIds: readonly string[];
      try {
        const parsed = parseFormValues(loaded.form.fields, input.values);
        uploadIds = formFileUploads(loaded.form.fields, parsed).flatMap(
          (entry) => entry.uploadIds,
        );
        values = await resolveFormFiles(
          client,
          {
            workspaceId: input.workspaceId,
            workflowId: input.workflowId,
            workflowVersionId: loaded.version.id,
            taskId: null,
            capabilityHash: grant?.capabilityHash ?? null,
            uploadedBy: grant === undefined ? (input.actorId ?? null) : null,
            session: input.uploadSession,
          },
          loaded.form.fields,
          parsed,
        );
      } catch (error) {
        if (error instanceof FormValuesInvalidError)
          return { versionId: loaded.version.id, error };
        throw error;
      }
      const at = (
        await drizzle(client)
          .execute<{ now: string }>(sql`select clock_timestamp() now`)
          .catch(rethrowQueryFailure)
      ).rows[0]?.now;
      if (at === undefined) throw new Error('Form admission clock missing');
      return {
        versionId: loaded.version.id,
        policy: loaded.form.coordination,
        uploadIds,
        input: {
          values,
          submittedBy: input.actorId ?? null,
          submittedAt: new Date(at).toISOString(),
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
    uploadIds: candidate.uploadIds,
    ...(coordination === undefined ? {} : { coordination }),
  };
}
