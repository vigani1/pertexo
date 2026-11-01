import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowForms,
  workflows,
  workflowVersions,
  workspaces,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { rolesForCapability } from '@pertexo/workflow-model';
import { authorizeWorkflowResource } from '../../tenant-access/resources/authority.js';
import { readFormDefinition } from './definition.js';
import type { PoolClient } from 'pg';
import { FormUnavailableError } from './errors.js';
import type { FormScope, PublicFormGrant } from './contract.js';

/**
 * Who may read or submit a published form: someone with its current link, on an
 * active workspace, or a member. Submitting takes the admission lock before this
 * check, so it can't use the authority helper, whose share locks must come first.
 */
export async function authorizeForm(
  client: PoolClient,
  input: FormScope,
  {
    grant,
    write,
  }: Readonly<{ grant: PublicFormGrant | undefined; write: boolean }>,
): Promise<void> {
  if (grant !== undefined) {
    if (
      input.workspaceId !== grant.workspaceId ||
      input.workflowId !== grant.workflowId
    )
      throw new FormUnavailableError();
    const form = alias(workflowForms, 'form');
    const query = drizzle(client)
      .select({ one: sql`1` })
      .from(form)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, form.workspaceId),
          eq(workspaces.status, 'active'),
        ),
      )
      .where(
        and(
          eq(form.workspaceId, input.workspaceId),
          eq(form.workflowId, input.workflowId),
          eq(form.publicId, grant.publicId),
          eq(form.access, 'public'),
          eq(form.capabilityHash, grant.capabilityHash),
          eq(form.nodeId, grant.nodeId),
        ),
      );
    const current = await (
      write ? query.for('share', { of: form }) : query
    ).catch(rethrowQueryFailure);
    if (current.length !== 1) throw new FormUnavailableError();
  } else {
    if (input.actorId === undefined) throw new FormUnavailableError();
    if (
      !(await authorizeWorkflowResource(
        client,
        { ...input, actorId: input.actorId },
        {
          capability: 'workflow:read',
          locking: write,
          roles: rolesForCapability('workspace:read'),
        },
      ))
    )
      throw new FormUnavailableError();
  }
}
/** The caller has already decided who is asking and which workspace statuses count. */
export async function readFormVersion(
  client: PoolClient,
  input: FormScope,
  locking: 'read' | 'share' | 'update',
  { allowPaused = false }: Readonly<{ allowPaused?: boolean | undefined }> = {},
) {
  // Lock before reading the version: a locked join waiting on a concurrent
  // publication re-checks against the old version row and finds no form.
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
  const publishedVersionId = locked[0]?.publishedVersionId;
  if (publishedVersionId === undefined || publishedVersionId === null)
    throw new FormUnavailableError();
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
  const row = rows[0];
  if (row === undefined) throw new FormUnavailableError();
  return {
    version: Object.freeze(row.version),
    ...readFormDefinition(row.graphJson),
  };
}
