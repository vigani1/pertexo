import type { PoolClient } from 'pg';
import type { WorkspaceScopeRunner } from '../../tenant-access/transactions.js';
import {
  rolesForCapability,
  type AuthorizationCapability,
} from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowPromotionError, type PromotionScope } from './contract.js';

export type PromotionLink = Readonly<{
  revision: number;
  targetWorkspaceId: string | null;
}>;
export async function readPromotionLink(
  client: PoolClient,
  workspaceId: string,
): Promise<PromotionLink> {
  const row = (
    await client.query<{
      revision: number;
      target_workspace_id: string | null;
    }>(
      'select revision,target_workspace_id from app.workspace_promotion_targets where workspace_id=$1',
      [workspaceId],
    )
  ).rows[0];
  return {
    revision: row?.revision ?? 0,
    targetWorkspaceId: row?.target_workspace_id ?? null,
  };
}
export function requirePromotionAuthority(
  client: PoolClient,
  input: PromotionScope,
  capability: AuthorizationCapability = 'workflow:update',
) {
  return lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    roles: rolesForCapability(capability),
  });
}
/** Both directions acquire workspace locks in the same order before membership or workflow locks. */
export async function lockPromotionWorkspaces(
  inWorkspace: WorkspaceScopeRunner,
  input: PromotionScope,
  targetWorkspaceId: string | null,
): Promise<void> {
  for (const workspaceId of [
    ...new Set([
      input.workspaceId,
      ...(targetWorkspaceId === null ? [] : [targetWorkspaceId]),
    ]),
  ].sort()) {
    await inWorkspace(
      { workspaceId, actorId: input.actorId },
      async (client) => {
        await client.query(
          'select id from app.workspaces where id=$1 for update',
          [workspaceId],
        );
      },
    );
  }
}
export async function linkedPromotionTarget(
  inWorkspace: WorkspaceScopeRunner,
  input: PromotionScope,
) {
  const scope = { workspaceId: input.workspaceId, actorId: input.actorId };
  const initial = await inWorkspace(scope, (client) =>
    readPromotionLink(client, input.workspaceId),
  );
  await lockPromotionWorkspaces(inWorkspace, input, initial.targetWorkspaceId);
  const source = await inWorkspace(scope, async (client) => {
    await requirePromotionAuthority(client, input);
    const link = await readPromotionLink(client, input.workspaceId);
    if (
      link.revision !== initial.revision ||
      link.targetWorkspaceId !== initial.targetWorkspaceId
    )
      throw new WorkflowPromotionError(
        'stale',
        'The promotion target changed. Review again.',
      );
    const row = (
      await client.query<{ name: string }>(
        'select name from app.workspaces where id=$1',
        [input.workspaceId],
      )
    ).rows[0];
    if (row === undefined)
      throw new WorkflowPromotionError(
        'unavailable',
        'The source workspace is unavailable.',
      );
    return { ...link, name: row.name };
  });
  if (source.targetWorkspaceId === null)
    throw new WorkflowPromotionError(
      'unavailable',
      'Choose a promotion target in this workspace first.',
    );
  if (source.targetWorkspaceId === input.workspaceId)
    throw new WorkflowPromotionError(
      'incompatible',
      'Choose another workspace as the promotion target.',
    );
  const targetWorkspaceId = source.targetWorkspaceId;
  const target = await inWorkspace(
    { workspaceId: targetWorkspaceId, actorId: input.actorId },
    async (client) => {
      await requirePromotionAuthority(client, {
        ...input,
        workspaceId: targetWorkspaceId,
      });
      const row = (
        await client.query<{ name: string; require_publish_approval: boolean }>(
          'select name,require_publish_approval from app.workspaces where id=$1',
          [targetWorkspaceId],
        )
      ).rows[0];
      if (row === undefined)
        throw new WorkflowPromotionError(
          'unavailable',
          'The target workspace is unavailable.',
        );
      return {
        workspaceId: targetWorkspaceId,
        name: row.name,
        requireApproval: row.require_publish_approval,
      };
    },
  );
  return { source, target };
}
