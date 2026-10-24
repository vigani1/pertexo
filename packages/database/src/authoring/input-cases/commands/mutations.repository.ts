import { utf8ByteLength } from '@pertexo/workflow-model';
import { lockArtifactReferences } from '../../../artifacts/references/repository.js';

import { z } from 'zod';
import {
  canonicalJson,
  workflowTestExpectationsSchema,
} from '@pertexo/workflow-model';

import { generatePersistedId } from '../../../platform/persisted-id.js';

import { WorkflowNotFoundError } from '../../workflows/errors.js';
import {
  type WorkflowInputCaseDatabase,
  payload,
  type CaseTransaction,
} from '../contract.js';
import { quota, lockedCase } from '../records.js';
import { mutate } from './receipt.js';

export async function createInputCase(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['createCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['createCase']> {
  const name = z.string().trim().min(1).max(128).parse(input.name);
  z.uuid().parse(input.workflowVersionId);
  const json = payload(input.input);
  const expectations =
    input.expectations === undefined
      ? null
      : canonicalJson(workflowTestExpectationsSchema.parse(input.expectations));
  const caseId = generatePersistedId();
  return mutate(transact, input, {
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
      const version = await client.query<{ checksum: string }>(
        'select checksum from app.workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',
        [input.workspaceId, input.workflowId, input.workflowVersionId],
      );
      if (!version.rows[0])
        throw new WorkflowNotFoundError('Workflow version is not visible');
      await quota(
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
      await client.query(
        'insert into app.workflow_input_cases(id,workspace_id,workflow_id,workflow_version_id,version_checksum,name) values($1,$2,$3,$4,$5,$6)',
        [
          caseId,
          input.workspaceId,
          input.workflowId,
          input.workflowVersionId,
          version.rows[0].checksum,
          name,
        ],
      );
      await client.query(
        'insert into app.workflow_input_case_payloads(workspace_id,case_id,revision,input,canonical_bytes,expectations) values($1,$2,1,$3,$4,$5)',
        [
          input.workspaceId,
          caseId,
          json.text,
          json.bytes +
            (expectations === null ? 0 : utf8ByteLength(expectations)),
          expectations,
        ],
      );
      return { caseId, revision: 1 };
    },
  });
}

export async function updateInputCase(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['updateCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['updateCase']> {
  const name = z.string().trim().min(1).max(128).parse(input.name);
  const json = payload(input.input);
  return mutate(transact, input, {
    kind: 'update',
    caseId: z.uuid().parse(input.caseId),
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
      const item = await lockedCase(client, input);
      const previous = await client.query<{ expectations: string | null }>(
        'select expectations from app.workflow_input_case_payloads where workspace_id=$1 and case_id=$2 and revision=$3',
        [input.workspaceId, input.caseId, item.revision],
      );
      const expectations =
        input.expectations === undefined
          ? (previous.rows[0]?.expectations ?? null)
          : canonicalJson(
              workflowTestExpectationsSchema.parse(input.expectations),
            );
      const bytes =
        json.bytes + (expectations === null ? 0 : utf8ByteLength(expectations));
      await quota(client, input, bytes, { create: false });
      await lockArtifactReferences(
        client,
        input.workspaceId,
        input.input,
        input.actorId,
      );
      const revision = item.revision + 1;
      await client.query(
        'insert into app.workflow_input_case_payloads(workspace_id,case_id,revision,input,canonical_bytes,expectations) values($1,$2,$3,$4,$5,$6)',
        [
          input.workspaceId,
          input.caseId,
          revision,
          json.text,
          bytes,
          expectations,
        ],
      );
      await client.query(
        'update app.workflow_input_cases set name=$1,revision=$2,updated_at=clock_timestamp() where workspace_id=$3 and id=$4',
        [name, revision, input.workspaceId, input.caseId],
      );
      return { caseId: input.caseId, revision };
    },
  });
}

export async function deleteInputCase(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['deleteCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['deleteCase']> {
  return mutate(transact, input, {
    kind: 'delete',
    caseId: z.uuid().parse(input.caseId),
    intent: { caseId: input.caseId, expectedRevision: input.expectedRevision },
    work: async (client) => {
      const item = await lockedCase(client, input);
      const revision = item.revision + 1;
      await client.query(
        'update app.workflow_input_cases set deleted_at=clock_timestamp(),revision=$1,updated_at=clock_timestamp() where workspace_id=$2 and id=$3',
        [revision, input.workspaceId, input.caseId],
      );
      return { caseId: input.caseId, revision };
    },
  });
}
