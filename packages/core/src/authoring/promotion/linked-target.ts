import type { WorkspaceScopeRunner } from '@pertexo/database/primitives';
import { WorkflowPromotionError } from './workflow-promotion.errors.js';
import type { PromotionScope } from './workflow-promotion.types.js';
import {
  readPromotionLink,
  lockPromotionWorkspaces,
  readWorkspaceNaming,
} from './authority.repository.js';
import { requirePromotionAuthority } from './require-authority.js';

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
    const row = await readWorkspaceNaming(client, input.workspaceId);
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
      const row = await readWorkspaceNaming(client, targetWorkspaceId);
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
