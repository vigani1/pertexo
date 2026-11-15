import type { PoolClient } from 'pg';
import type {
  WorkflowInputCaseMetadata,
  Scope,
  CaseTransaction,
  CreateInputCaseInput,
  DeleteInputCaseInput,
  UpdateInputCaseInput,
  WorkflowInputCaseResult,
} from '../workflow-input-case.types.js';
import {
  WorkflowInputCaseLimitError,
  WorkflowInputCaseRevisionConflictError,
} from '../workflow-input-case.errors.js';
import { lockCase, readCaseQuota } from '../metadata.repository.js';
import { caseQuotaRefusal } from '../case-quota.js';
import { utf8ByteLength, canonicalJson } from '@pertexo/workflow-model';
import { lockArtifactReferences } from '../../../artifacts/references/lock-references.js';
import { generatePersistedId } from '@pertexo/database/platform';
import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';
import { payload } from '../input-case-storage.js';
import { runCaseCommand } from './run-case-command.js';
import {
  insertCase,
  markCaseDeleted,
  readCaseExpectations,
  readVersionChecksum,
  saveCaseRevision,
} from './mutations.repository.js';

export async function createInputCase(
  transact: CaseTransaction,
  input: CreateInputCaseInput,
): Promise<WorkflowInputCaseResult> {
  const name = input.name;

  const json = payload(input.input);
  const expectations =
    input.expectations === undefined ? null : canonicalJson(input.expectations);
  const caseId = generatePersistedId();
  return runCaseCommand(transact, input, {
    kind: 'create',
    caseId,
    intent: {
      workflowVersionId: input.workflowVersionId,
      name,
      input: JSON.parse(json.text),
      ...(input.expectations === undefined
        ? {}
        : { expectations: input.expectations }),
    },
    work: async (client) => {
      const versionChecksum = await readVersionChecksum(client, input);
      if (versionChecksum === undefined)
        throw new WorkflowNotFoundError('Workflow version is not visible');
      await requireCaseQuota(
        client,
        input,
        json.bytes + (expectations === null ? 0 : utf8ByteLength(expectations)),
        { create: true },
      );
      await lockArtifactReferences(
        client,
        input.workspaceId,
        input.input,
        input.actorId,
      );
      await insertCase(client, input, {
        caseId,
        versionChecksum,
        json,
        expectations,
      });
      return { caseId, revision: 1 };
    },
  });
}

export async function updateInputCase(
  transact: CaseTransaction,
  input: UpdateInputCaseInput,
): Promise<WorkflowInputCaseResult> {
  const name = input.name;
  const json = payload(input.input);
  return runCaseCommand(transact, input, {
    kind: 'update',
    caseId: input.caseId,
    intent: {
      caseId: input.caseId,
      expectedRevision: input.expectedRevision,
      name,
      input: JSON.parse(json.text),
      ...(input.expectations === undefined
        ? {}
        : { expectations: input.expectations }),
    },
    work: async (client) => {
      const item = await requireLockedCase(client, input);
      const previous = await readCaseExpectations(client, input, item.revision);
      const expectations =
        input.expectations === undefined
          ? (previous ?? null)
          : canonicalJson(input.expectations);
      const bytes =
        json.bytes + (expectations === null ? 0 : utf8ByteLength(expectations));
      await requireCaseQuota(client, input, bytes, { create: false });
      await lockArtifactReferences(
        client,
        input.workspaceId,
        input.input,
        input.actorId,
      );
      const revision = item.revision + 1;
      await saveCaseRevision(client, input, {
        revision,
        json,
        bytes,
        expectations,
      });
      return { caseId: input.caseId, revision };
    },
  });
}

export async function deleteInputCase(
  transact: CaseTransaction,
  input: DeleteInputCaseInput,
): Promise<WorkflowInputCaseResult> {
  return runCaseCommand(transact, input, {
    kind: 'delete',
    caseId: input.caseId,
    intent: { caseId: input.caseId, expectedRevision: input.expectedRevision },
    work: async (client) => {
      const item = await requireLockedCase(client, input);
      const revision = item.revision + 1;
      await markCaseDeleted(client, input, revision);
      return { caseId: input.caseId, revision };
    },
  });
}

async function requireCaseQuota(
  client: PoolClient,
  input: Scope,
  bytes: number,
  options: Readonly<{ create: boolean }>,
): Promise<void> {
  const quota = await readCaseQuota(client, input);
  if (!quota) throw new Error('Case quota authority unavailable');
  const refusal = caseQuotaRefusal(quota, bytes, options);
  if (refusal !== undefined) throw new WorkflowInputCaseLimitError(refusal);
}

/** The case at the revision the caller saw, locked for its change. */
async function requireLockedCase(
  client: PoolClient,
  input: Scope & { caseId: string; expectedRevision: number },
): Promise<WorkflowInputCaseMetadata> {
  const item = await lockCase(client, input);
  if (!item) throw new WorkflowNotFoundError('Run-input case is not visible');
  if (item.revision !== input.expectedRevision)
    throw new WorkflowInputCaseRevisionConflictError(item.revision);
  return item;
}
