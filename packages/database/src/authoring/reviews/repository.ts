import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../tenant-access/resources/scope.queries.js';
import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { rolesForCapability } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import type {
  PublicationReviewStore,
  ReviewDependencies,
  ReviewScope,
} from './contract.js';
import { readReviewDetail, readReviewSummary } from './read.queries.js';
import { requestPublicationReview } from './request.repository.js';
import { decidePublicationReview } from './decide.repository.js';

export function createPublicationReviewStore(
  dependencies: ReviewDependencies,
): PublicationReviewStore {
  const transact = <T>(
    input: ReviewScope,
    capability: 'workflow:read' | 'workflow:publish' | 'governance:manage',
    {
      exclusive,
      work,
    }: Readonly<{
      exclusive: boolean;
      work: (client: PoolClient) => Promise<T>;
    }>,
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
        await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles: rolesForCapability(capability),
        });
        return work(client);
      },
      input.signal,
    );
  const lockWorkflow = async (
    client: PoolClient,
    input: ReviewScope,
    identity: { workflowId: string } | { reviewId: string },
    { write }: Readonly<{ write: boolean }>,
  ) => {
    const predicate =
      'workflowId' in identity
        ? 'id=$2'
        : 'id=(select workflow_id from app.workflow_publication_requests where workspace_id=$1 and id=$2)';
    const parameters: unknown[] = [
      input.workspaceId,
      'workflowId' in identity ? identity.workflowId : identity.reviewId,
    ];
    const scope = await readFolderScope(client, input);
    const visible = bindResourcePredicate(
      workflowScopeSql(
        scope,
        sql`app.workflows.id`,
        write ? 'workflow:publish' : 'workflow:read',
      ),
      parameters,
    );
    const found = await client.query(
      `select id from app.workflows where workspace_id=$1 and ${predicate} and ${visible} ${write ? 'for update' : 'for share'}`,
      parameters,
    );
    if (found.rowCount !== 1)
      throw new WorkflowNotFoundError('Workflow is not visible');
  };
  return {
    overview: (input) =>
      transact(input, 'workflow:read', {
        exclusive: false,
        work: async (client) => {
          await lockWorkflow(client, input, input, { write: false });
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
            required: policy?.require_publish_approval ?? false,
            request:
              latest === undefined
                ? null
                : await readReviewSummary(client, dependencies, {
                    ...input,
                    reviewId: latest.id,
                  }),
          };
        },
      }),
    read: (input) =>
      transact(input, 'workflow:read', {
        exclusive: false,
        work: async (client) => {
          await lockWorkflow(client, input, input, { write: false });
          return readReviewDetail(client, dependencies, input);
        },
      }),
    request: (input) =>
      transact(input, 'workflow:publish', {
        exclusive: true,
        work: async (client) => {
          await lockWorkflow(client, input, input, { write: true });
          return requestPublicationReview(client, dependencies, input);
        },
      }),
    decide: (input) =>
      transact(input, 'governance:manage', {
        exclusive: false,
        work: async (client) => {
          await lockWorkflow(client, input, input, { write: true });
          return decidePublicationReview(client, dependencies, input);
        },
      }),
  };
}
