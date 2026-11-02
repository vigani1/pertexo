import { readFolderScope } from '../../shared/facts.queries.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaces,
  workflows,
  workflowPublicationRequests,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type {
  PublicationReview,
  PublicationReviewDetail,
  PublicationReviewOverview,
} from '@pertexo/contracts';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type Role,
} from '@pertexo/workflow-model';
import type { AuthoringAccess } from '../workflows/access.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import type {
  DecideReviewInput,
  ReadReviewInput,
  RequestReviewInput,
  ReviewDependencies,
  ReviewOverviewInput,
  ReviewScope,
} from './contract.js';
import { readReviewDetail, readReviewSummary } from './read.queries.js';
import { requestPublicationReview } from './request.js';
import { decidePublicationReview } from './decide.js';

export type PublicationReviewStore = ReturnType<
  typeof createPublicationReviewStore
>;

/**
 * Reading took the share locks by hand, so it stays `change`. Requesting a review
 * runs one at a time per workspace: `exclusive`, the order it took by hand. It
 * touches one workspace and locks no user for update, which is what makes that safe.
 */
export function createPublicationReviewStore(
  access: AuthoringAccess,
  dependencies: ReviewDependencies,
) {
  const browse = <T>(
    input: ReviewScope,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ) =>
    access.member(
      input,
      {
        mode: 'change',
        capability: 'workflow:read',
        statuses: BROWSABLE_WORKSPACE_STATUSES,
      },
      work,
    );
  return Object.freeze({
    overview: (
      input: ReviewOverviewInput,
    ): Promise<PublicationReviewOverview> =>
      browse(input, async (client, role) => {
        await lockWorkflow(client, input, input, { write: false, role });
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
      }),
    read: (input: ReadReviewInput): Promise<PublicationReviewDetail> =>
      browse(input, async (client, role) => {
        await lockWorkflow(client, input, input, { write: false, role });
        return readReviewDetail(client, dependencies, input);
      }),
    request: (input: RequestReviewInput): Promise<PublicationReview> =>
      access.member(
        input,
        {
          mode: 'exclusive',
          capability: 'workflow:publish',
          statuses: ACTIVE_WORKSPACE_STATUSES,
        },
        async (client, role) => {
          await lockWorkflow(client, input, input, { write: true, role });
          return requestPublicationReview(client, dependencies, input);
        },
      ),
    decide: (input: DecideReviewInput): Promise<PublicationReview> =>
      access.member(
        input,
        {
          mode: 'change',
          capability: 'governance:manage',
          statuses: ACTIVE_WORKSPACE_STATUSES,
        },
        async (client, role) => {
          await lockWorkflow(client, input, input, { write: true, role });
          return decidePublicationReview(client, dependencies, input);
        },
      ),
  });
}

async function lockWorkflow(
  client: PoolClient,
  input: ReviewScope,
  identity: { workflowId: string } | { reviewId: string },
  { write, role }: Readonly<{ write: boolean; role: Role }>,
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
  const scope = await readFolderScope(client, input, role);
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
