import type { PoolClient } from 'pg';
import { rolesForCapability } from '../../tenant-access/policy.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import type {
  PublicationReviewStore,
  ReviewDependencies,
  ReviewScope,
} from './contract.js';
import { readReviewDetail, readReviewSummary } from './read.js';
import { requestPublicationReview } from './request.js';
import { decidePublicationReview } from './decide.js';

export function createPublicationReviewStore(
  dependencies: ReviewDependencies,
): PublicationReviewStore {
  const transact = <T>(
    input: ReviewScope,
    capability: 'workflow:read' | 'workflow:publish' | 'governance:manage',
    exclusive: boolean,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    dependencies.transact(
      input.workspaceId,
      input.actorId,
      async (client) => {
        if (exclusive)
          await client.query(
            'select id from app.workspaces where id=$1 for update',
            [input.workspaceId],
          );
        await lockWorkflowAuthoringAuthority(
          client,
          input.workspaceId,
          input.actorId,
          rolesForCapability(capability),
        );
        return work(client);
      },
      input.signal,
    );
  const lockWorkflow = async (
    client: PoolClient,
    input: ReviewScope,
    identity: { workflowId: string } | { reviewId: string },
    write: boolean,
  ) => {
    const predicate =
      'workflowId' in identity
        ? 'id=$2'
        : 'id=(select workflow_id from app.workflow_publication_requests where workspace_id=$1 and id=$2)';
    const found = await client.query(
      `select id from app.workflows where workspace_id=$1 and ${predicate} ${write ? 'for update' : 'for share'}`,
      [
        input.workspaceId,
        'workflowId' in identity ? identity.workflowId : identity.reviewId,
      ],
    );
    if (found.rowCount !== 1)
      throw new WorkflowNotFoundError('Workflow is not visible');
  };
  return {
    overview: (input) =>
      transact(input, 'workflow:read', false, async (client) => {
        await lockWorkflow(client, input, input, false);
        const policy = (
          await client.query<{ require_publish_approval: boolean }>(
            'select require_publish_approval from app.workspaces where id=$1',
            [input.workspaceId],
          )
        ).rows[0];
        const latest = (
          await client.query<{ id: string }>(
            'select id from app.workflow_publication_requests where workspace_id=$1 and workflow_id=$2 order by created_at desc,id desc limit 1',
            [input.workspaceId, input.workflowId],
          )
        ).rows[0];
        return {
          required: policy?.require_publish_approval === true,
          request:
            latest === undefined
              ? null
              : await readReviewSummary(client, dependencies, {
                  ...input,
                  reviewId: latest.id,
                }),
        };
      }),
    read: (input) =>
      transact(input, 'workflow:read', false, async (client) => {
        await lockWorkflow(client, input, input, false);
        return readReviewDetail(client, dependencies, input);
      }),
    request: (input) =>
      transact(input, 'workflow:publish', true, async (client) => {
        await lockWorkflow(client, input, input, true);
        return requestPublicationReview(client, dependencies, input);
      }),
    decide: (input) =>
      transact(input, 'governance:manage', false, async (client) => {
        await lockWorkflow(client, input, input, true);
        return decidePublicationReview(client, dependencies, input);
      }),
  };
}
