import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { reviewMoveAudience } from '../../sharing/audience.queries.js';

import { runOrganizationCommand } from '../../run-command.js';

import {
  checkOrganizationReplay,
  organizeWorkflow,
} from '../../placement.repository.js';
import type { createOrganizationSession } from '../../session.js';
import type { WorkflowFolderStore } from '../contract.js';
import { placementResult } from '../input.js';

export function reviewFolderMove(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderStore['reviewMove']>[0],
): ReturnType<WorkflowFolderStore['reviewMove']> {
  return session.read(
    input,
    'workflow:update',
    ACTIVE_WORKSPACE_STATUSES,
    async (client, scope) => {
      return reviewMoveAudience(client, scope, input.request);
    },
  );
}

export async function placeWorkflow(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderStore['placeWorkflow']>[0],
): ReturnType<WorkflowFolderStore['placeWorkflow']> {
  const workflowId = input.workflowId;
  const request = {
    folderId: input.folderId,
    ...(input.audienceReview === undefined
      ? {}
      : {
          audienceReview: input.audienceReview,
        }),
    expectedOrganizationRevision: input.expectedOrganizationRevision,
  };
  return session.command(input, 'workflow:update', async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      operation: 'folder.place',
      target: workflowId,
      idempotencyKey: input.idempotencyKey,
      request,
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
