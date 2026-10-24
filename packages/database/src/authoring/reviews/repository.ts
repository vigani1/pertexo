import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import { workflowScopeSql } from '../../tenant-access/resources/scope.queries.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaces } from '../../schema/foundation.js';
import { workflows } from '../../schema/authoring/workflows.js';
import { workflowPublicationRequests } from '../../schema/authoring/publication-requests.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
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
          await drizzle(client)
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, input.workspaceId))
            .for('update')
            .catch(rethrowQueryFailure);
        await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles: rolesForCapability(capability),
        });
        return work(client);
      },
      input.signal,
    );
  return {
    overview: (input) =>
      transact(input, 'workflow:read', {
        exclusive: false,
        work: async (client) => {
          await lockWorkflow(client, input, input, { write: false });
          const db = drizzle(client);
          const [policy] = await db
            .select({
              requirePublishApproval: workspaces.requirePublishApproval,
            })
            .from(workspaces)
            .where(eq(workspaces.id, input.workspaceId))
            .catch(rethrowQueryFailure);
          const [latest] = await db
            .select({ id: workflowPublicationRequests.id })
            .from(workflowPublicationRequests)
            .where(
              and(
                eq(workflowPublicationRequests.workspaceId, input.workspaceId),
                eq(workflowPublicationRequests.workflowId, input.workflowId),
              ),
            )
            .orderBy(
              desc(workflowPublicationRequests.createdAt),
              desc(workflowPublicationRequests.id),
            )
            .limit(1)
            .catch(rethrowQueryFailure);
          return {
            required: policy?.requirePublishApproval ?? false,
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

async function lockWorkflow(
  client: PoolClient,
  input: ReviewScope,
  identity: { workflowId: string } | { reviewId: string },
  { write }: Readonly<{ write: boolean }>,
): Promise<void> {
  const db = drizzle(client);
  const reviewed = db
    .select({ workflowId: workflowPublicationRequests.workflowId })
    .from(workflowPublicationRequests)
    .where(
      and(
        eq(workflowPublicationRequests.workspaceId, input.workspaceId),
        eq(
          workflowPublicationRequests.id,
          'reviewId' in identity ? identity.reviewId : sql`null`,
        ),
      ),
    );
  const predicate =
    'workflowId' in identity
      ? eq(workflows.id, identity.workflowId)
      : eq(workflows.id, sql`(${reviewed})`);
  const scope = await readFolderScope(client, input);
  const found = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        predicate,
        workflowScopeSql(
          scope,
          sql`${workflows.id}`,
          write ? 'workflow:publish' : 'workflow:read',
        ),
      ),
    )
    .for(write ? 'update' : 'share')
    .catch(rethrowQueryFailure);
  if (found.length !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
}
