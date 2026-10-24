import { reviewMoveAudience } from '../../sharing/audience.queries.js';

import { lockWorkflowAuthoringAuthority } from '../../../workflows/authority.js';
import { runOrganizationCommand } from '../../commands.repository.js';

import {
  checkOrganizationReplay,
  organizeWorkflow,
} from '../../placement.repository.js';
import type { createOrganizationSession } from '../../session.js';
import type { WorkflowFolderDatabase } from '../contract.js';
import { uuid, revision, placementResult } from '../input.js';

import { EDITORS } from './receipt.js';

export function reviewFolderMove(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['reviewMove']>[0],
): ReturnType<WorkflowFolderDatabase['reviewMove']> {
  return session.transact(input, async (client, scope) => {
    await lockWorkflowAuthoringAuthority(client, scope.workspaceId, {
      actorId: scope.actorId,
      roles: EDITORS,
    });
    return reviewMoveAudience(client, scope, input.request);
  });
}

export async function placeWorkflow(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['placeWorkflow']>[0],
): ReturnType<WorkflowFolderDatabase['placeWorkflow']> {
  const workflowId = uuid.parse(input.workflowId);
  const request = {
    folderId: uuid.nullable().parse(input.folderId),
    ...(input.audienceReview === undefined
      ? {}
      : {
          audienceReview: input.audienceReview,
        }),
    expectedOrganizationRevision: revision.parse(
      input.expectedOrganizationRevision,
    ),
  };
  return session.transact(input, async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      operation: 'folder.place',
      target: workflowId,
      idempotencyKey: input.idempotencyKey,
      request,
      roles: EDITORS,
      replay: () =>
        checkOrganizationReplay(client, scope, {
          workflowId,
          kind: 'move',
          destinationFolderId: request.folderId,
        }),
      apply: async () => {
        const organizationRevision = await organizeWorkflow(client, scope, {
          workflowId,
          change: {
            kind: 'move',
            folderId: request.folderId,
            ...(request.audienceReview === undefined
              ? {}
              : { audienceReview: request.audienceReview }),
          },
          expectedOrganizationRevision: request.expectedOrganizationRevision,
        });
        return {
          result: {
            workflowId,
            organizationRevision,
            folderId: request.folderId,
          },
          audit: {
            action: 'workflow.organization.move',
            targetId: workflowId,
            metadata: {
              organizationRevision,
              audienceReviewed: request.audienceReview?.acknowledge ?? false,
            },
          },
        };
      },
    });
    return Object.freeze({ ...placementResult.parse(result), replayed });
  });
}
