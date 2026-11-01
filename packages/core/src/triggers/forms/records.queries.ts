import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowForms,
  workflows,
  workflowVersions,
  workspaces,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  rolesForCapability,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/workflow-model';
import { authorizeWorkflowResource } from '../../tenant-access/resources/authority.js';
import { readFormDefinition } from './definition.js';
import type { PoolClient } from 'pg';
import { FormUnavailableError } from './errors.js';
import type { FormScope, PublicFormGrant } from './contract.js';

export async function authorizeForm(
  client: PoolClient,
  input: FormScope,
  {
    grant,
    write,
    manage = false,
    browsing = false,
  }: Readonly<{
    grant: PublicFormGrant | undefined;
    write: boolean;
    manage?: boolean | undefined;
    browsing?: boolean | undefined;
  }>,
): Promise<void> {
  if (grant !== undefined) {
    if (
      input.workspaceId !== grant.workspaceId ||
      input.workflowId !== grant.workflowId
    )
      throw new FormUnavailableError();
    const query = drizzle(client)
      .select({ one: sql`1` })
      .from(workflowForms)
      .where(
        and(
          eq(workflowForms.workspaceId, input.workspaceId),
          eq(workflowForms.workflowId, input.workflowId),
          eq(workflowForms.publicId, grant.publicId),
          eq(workflowForms.access, 'public'),
          eq(workflowForms.capabilityHash, grant.capabilityHash),
          eq(workflowForms.nodeId, grant.nodeId),
        ),
      );
    const current = await (write ? query.for('share') : query).catch(
      rethrowQueryFailure,
    );
    if (current.length !== 1) throw new FormUnavailableError();
  } else {
    if (input.actorId === undefined) throw new FormUnavailableError();
    if (
      !(await authorizeWorkflowResource(
        client,
        { ...input, actorId: input.actorId },
        {
          capability: manage && write ? 'workflow:update' : 'workflow:read',
          locking: write,
          browsing,
          roles: rolesForCapability(
            manage ? 'workflow:update' : 'workspace:read',
          ),
        },
      ))
    )
      throw new FormUnavailableError();
  }
}
export async function readFormVersion(
  client: PoolClient,
  input: FormScope,
  locking: 'read' | 'share' | 'update',
  {
    allowPaused = false,
    browsing = false,
  }: Readonly<{
    allowPaused?: boolean | undefined;
    browsing?: boolean | undefined;
  }> = {},
) {
  // Lock before reading the version: a locked join waiting on a concurrent
  // publication re-checks against the old version row and finds no form.
  const db = drizzle(client);
  const workflow = alias(workflows, 'workflow');
  const query = db
    .select({ publishedVersionId: workflow.publishedVersionId })
    .from(workflow)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, workflow.workspaceId),
        inArray(
          workspaces.status,
          browsing ? BROWSABLE_WORKSPACE_STATUSES : ['active'],
        ),
      ),
    )
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
