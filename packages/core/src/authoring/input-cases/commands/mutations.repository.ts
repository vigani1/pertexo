import type { PoolClient } from 'pg';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowInputCasePayloads,
  workflowInputCases,
  workflowVersions,
} from '@pertexo/database/schema';
import type {
  CreateInputCaseInput,
  DeleteInputCaseInput,
  UpdateInputCaseInput,
} from '../workflow-input-case.types.js';

export async function readVersionChecksum(
  client: PoolClient,
  input: CreateInputCaseInput,
): Promise<string | undefined> {
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
  return version?.checksum;
}

/** Adds the case at revision 1 with its first payload. */
export async function insertCase(
  client: PoolClient,
  input: CreateInputCaseInput,
  stored: Readonly<{
    caseId: string;
    versionChecksum: string;
    json: Readonly<{ text: string; bytes: number }>;
    expectations: string | null;
  }>,
): Promise<void> {
  const { caseId, json, expectations } = stored;
  const name = input.name;
  const db = drizzle(client);
  await db
    .insert(workflowInputCases)
    .values({
      id: caseId,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
      versionChecksum: stored.versionChecksum,
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
        json.bytes + (expectations === null ? 0 : utf8ByteLength(expectations)),
      expectations,
    })
    .catch(rethrowQueryFailure);
}

export async function readCaseExpectations(
  client: PoolClient,
  input: UpdateInputCaseInput,
  revision: number,
): Promise<string | null | undefined> {
  const db = drizzle(client);
  const [previous] = await db
    .select({ expectations: workflowInputCasePayloads.expectations })
    .from(workflowInputCasePayloads)
    .where(
      and(
        eq(workflowInputCasePayloads.workspaceId, input.workspaceId),
        eq(workflowInputCasePayloads.caseId, input.caseId),
        eq(workflowInputCasePayloads.revision, revision),
      ),
    )
    .catch(rethrowQueryFailure);
  return previous?.expectations;
}

/** Stores the next payload revision and points the case at it. */
export async function saveCaseRevision(
  client: PoolClient,
  input: UpdateInputCaseInput,
  stored: Readonly<{
    revision: number;
    json: Readonly<{ text: string; bytes: number }>;
    bytes: number;
    expectations: string | null;
  }>,
): Promise<void> {
  const { revision, json, bytes, expectations } = stored;
  const name = input.name;
  const db = drizzle(client);
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
}

export async function markCaseDeleted(
  client: PoolClient,
  input: DeleteInputCaseInput,
  revision: number,
): Promise<void> {
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
}
