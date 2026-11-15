import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  workflowForms,
  workflows,
  workflowVersions,
  workspaces,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { FormScope, PublicFormGrant } from './form-admission.types.js';

/** The granted form's access and workspace status, share-locked when writing. */
export async function readGrantedFormStanding(
  client: PoolClient,
  input: FormScope,
  grant: PublicFormGrant,
  write: boolean,
) {
  const form = alias(workflowForms, 'form');
  const query = drizzle(client)
    .select({ access: form.access, workspaceStatus: workspaces.status })
    .from(form)
    .innerJoin(workspaces, eq(workspaces.id, form.workspaceId))
    .where(
      and(
        eq(form.workspaceId, input.workspaceId),
        eq(form.workflowId, input.workflowId),
        eq(form.publicId, grant.publicId),
        eq(form.capabilityHash, grant.capabilityHash),
        eq(form.nodeId, grant.nodeId),
      ),
    );
  const current = await (
    write ? query.for('share', { of: form }) : query
  ).catch(rethrowQueryFailure);
  return current[0];
}

/**
 * The active workflow's published version ID, locked unless only reading. Lock
 * before reading the version: a locked join waiting on a concurrent publication
 * re-checks against the old version row and finds no form.
 */
export async function lockPublishedVersionId(
  client: PoolClient,
  input: FormScope,
  locking: 'read' | 'share' | 'update',
  allowPaused: boolean,
): Promise<string | null | undefined> {
  const db = drizzle(client);
  const workflow = alias(workflows, 'workflow');
  const query = db
    .select({ publishedVersionId: workflow.publishedVersionId })
    .from(workflow)
    .where(
      and(
        eq(workflow.workspaceId, input.workspaceId),
        eq(workflow.id, input.workflowId),
        eq(workflow.lifecycleStatus, 'active'),
        sql`(${allowPaused}::boolean or ${workflow.triggerPauseState}='none')`,
      ),
    );
  const locked = await (
    locking === 'read' ? query : query.for(locking, { of: workflow })
  ).catch(rethrowQueryFailure);
  return locked[0]?.publishedVersionId;
}

export async function readPublishedVersion(
  client: PoolClient,
  input: FormScope,
  publishedVersionId: string,
) {
  const db = drizzle(client);
  const rows = await db
    .select({
      graphJson: workflowVersions.graphJson,
      version: {
        id: workflowVersions.id,
        workspaceId: workflowVersions.workspaceId,
        workflowId: workflowVersions.workflowId,
        versionNumber: workflowVersions.versionNumber,
        checksum: workflowVersions.checksum,
        executableJson: workflowVersions.executableJson,
      },
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, input.workspaceId),
        eq(workflowVersions.workflowId, input.workflowId),
        eq(workflowVersions.id, publishedVersionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return rows[0];
}

/** The graph a form was published in, as a replay after republication reads it. */
export async function readFormVersionGraph(
  db: Pick<NodePgDatabase, 'select'>,
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    versionId: string;
  }>,
): Promise<unknown> {
  const [row] = await db
    .select({ graphJson: workflowVersions.graphJson })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, input.workspaceId),
        eq(workflowVersions.workflowId, input.workflowId),
        eq(workflowVersions.id, input.versionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row?.graphJson;
}
