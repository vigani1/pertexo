import { utf8ByteLength } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { lockArtifactReferences } from '../../../artifacts/references/repository.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowInputCasePayloads,
  workflowInputCases,
  workflowVersions,
} from '@pertexo/database/schema';

import { canonicalJson } from '@pertexo/workflow-model';

import { generatePersistedId } from '@pertexo/database/platform';

import { WorkflowNotFoundError } from '../../workflows/errors.js';
import type {
  CaseTransaction,
  WorkflowInputCaseDatabase,
} from '../contract.js';
import { payload } from '../input.js';
import { lockedCase, quota } from '../metadata.queries.js';
import { mutate } from './receipt.repository.js';

export async function createInputCase(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['createCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['createCase']> {
  const name = input.name;

  const json = payload(input.input);
  const expectations =
    input.expectations === undefined ? null : canonicalJson(input.expectations);
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
      const db = drizzle(client);
      const [version] = await db
        .select({ checksum: workflowVersions.checksum })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workspaceId, input.workspaceId),
            eq(workflowVersions.workflowId, input.workflowId),
            eq(workflowVersions.id, input.workflowVersionId),
          ),
        )
        .catch(rethrowQueryFailure);
      if (!version)
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
      await db
        .insert(workflowInputCases)
        .values({
          id: caseId,
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          workflowVersionId: input.workflowVersionId,
          versionChecksum: version.checksum,
          name,
        })
        .catch(rethrowQueryFailure);
      await db
        .insert(workflowInputCasePayloads)
        .values({
          workspaceId: input.workspaceId,
          caseId,
          revision: 1,
          input: json.text,
          canonicalBytes:
            json.bytes +
            (expectations === null ? 0 : utf8ByteLength(expectations)),
          expectations,
        })
        .catch(rethrowQueryFailure);
      return { caseId, revision: 1 };
    },
  });
}

export async function updateInputCase(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['updateCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['updateCase']> {
  const name = input.name;
  const json = payload(input.input);
  return mutate(transact, input, {
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
      const item = await lockedCase(client, input);
      const db = drizzle(client);
      const [previous] = await db
        .select({ expectations: workflowInputCasePayloads.expectations })
        .from(workflowInputCasePayloads)
        .where(
          and(
            eq(workflowInputCasePayloads.workspaceId, input.workspaceId),
            eq(workflowInputCasePayloads.caseId, input.caseId),
            eq(workflowInputCasePayloads.revision, item.revision),
          ),
        )
        .catch(rethrowQueryFailure);
      const expectations =
        input.expectations === undefined
          ? (previous?.expectations ?? null)
          : canonicalJson(input.expectations);
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
      await db
        .insert(workflowInputCasePayloads)
        .values({
          workspaceId: input.workspaceId,
          caseId: input.caseId,
          revision,
          input: json.text,
          canonicalBytes: bytes,
          expectations,
        })
        .catch(rethrowQueryFailure);
      await db
        .update(workflowInputCases)
        .set({ name, revision, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(workflowInputCases.workspaceId, input.workspaceId),
            eq(workflowInputCases.id, input.caseId),
          ),
        )
        .catch(rethrowQueryFailure);
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
    caseId: input.caseId,
    intent: { caseId: input.caseId, expectedRevision: input.expectedRevision },
    work: async (client) => {
      const item = await lockedCase(client, input);
      const revision = item.revision + 1;
      await drizzle(client)
        .update(workflowInputCases)
        .set({
          deletedAt: sql`clock_timestamp()`,
          revision,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(workflowInputCases.workspaceId, input.workspaceId),
            eq(workflowInputCases.id, input.caseId),
          ),
        )
        .catch(rethrowQueryFailure);
      return { caseId: input.caseId, revision };
    },
  });
}
