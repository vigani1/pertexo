import { decodeStoredValue } from '../../../shared/stored-values.js';
import { z } from 'zod';
import {
  requiresFormAdmissionCheck,
  formAdmissionRequirement,
  capturedFormReplayMatches,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import type { StoredExecutionValue } from '@pertexo/database/schema';
import { RunRequiresFormError } from './run-admission.errors.js';
import {
  readFormReplaySource,
  readVersionNodeDefinitions,
} from './form-admission.repository.js';

/** A replay may repeat a captured submission, never invent its server-owned actor or time. */
export async function requireFormAdmission(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    triggerType: string;
    workflowId: string;
    workflowVersionId: string;
    replaySourceRunId?: string | undefined;
  }>,
  value: StoredExecutionValue | undefined,
): Promise<void> {
  if (!requiresFormAdmissionCheck(input.triggerType)) return;
  const definitions = await readVersionNodeDefinitions(transaction, input);
  const entries = decodeStoredValue(() =>
    z
      .array(z.object({ key: z.string(), version: z.number().int() }).strict())
      .parse(definitions),
  );
  const requirement = formAdmissionRequirement(entries, input.triggerType);
  if (requirement === 'allow') return;
  if (requirement === 'refuse') throw new RunRequiresFormError();
  const original = await readFormReplaySource(
    transaction,
    input.replaySourceRunId,
  );
  const matches = capturedFormReplayMatches(
    original === undefined
      ? undefined
      : {
          workflowVersionId: original.workflow_version_id,
          inputRef: original.input_ref,
        },
    input.workflowVersionId,
    value,
  );
  if (!matches) throw new RunRequiresFormError();
}
