import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import { workflowVersions, workspaces } from '@pertexo/database/schema';
import { recordPromotedPublication } from '../promotion/provenance.repository.js';
import { PublicationReviewError } from '../reviews/publication-review.errors.js';

import { sameWorkflowNotes } from '@pertexo/workflow-model';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { CommandIdentity } from '@pertexo/database/primitives';
import { credentialCommandScope } from '@pertexo/database/platform';
import {
  lockActiveWorkflow,
  lockDraft,
} from '../workflows/commands/locks.repository.js';
import type { AuthoringCatalogs } from '../workflows/catalogs.js';

import type {
  PublishWorkflowInput,
  PublishWorkflowResult,
} from '../workflows/workflow-commands.types.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflows/workflow-authoring.errors.js';
import type { WorkflowVersionRecord } from '../workflows/representation/workflow-record.types.js';
import {
  projectDraft,
  projectVersion,
  versionProjection,
} from '../workflows/representation/workflow-representations.repository.js';

import type {
  CompiledPublication,
  PublicationCandidateInput,
  PublicationClaim,
} from './workflow-publication.types.js';
import { decodeStoredReceipt } from '../../shared/receipts.js';
import { publicationReceipt } from './publication-state.schemas.js';
import { compilePublicationGraph } from './compile-publication.js';
import {
  finalizePublication,
  persistPublicationProjections,
} from './projections.repository.js';

type PublicationReceipt = z.output<typeof publicationReceipt>;

async function claimPublication(
  client: PoolClient,
  input: PublishWorkflowInput,
): Promise<PublicationClaim> {
  const workflowId = input.workflowId;
  const command: CommandIdentity = {
    workspaceId: input.workspaceId,
    operation: 'workflow.publish',
    scope: credentialCommandScope(
      `${input.actorId}:${workflowId}`,
      input.commandCredentialId,
    ),
    idempotencyKey: input.idempotencyKey,
  };
  const stored = await claimCommand<PublicationReceipt>(client, {
    ...command,
    request: input.requestHash,
    resourceId: workflowId,
  });
  if (stored === null)
    return Object.freeze({ command, replay: null, workflowId });
  const { versionId, reused } = decodeStoredReceipt(publicationReceipt, stored);
  const [row] = await drizzle(client)
    .select(versionProjection)
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, input.workspaceId),
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.id, versionId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow version is not visible');
  return Object.freeze({
    command,
    replay: Object.freeze({
      version: projectVersion(row),
      reused,
      replayed: true,
    }),
    workflowId,
  });
}

async function lockAndCompilePublication(
  client: PoolClient,
  input: PublicationCandidateInput,
  workflowId: string,
  variant: AuthoringCatalogs,
): Promise<CompiledPublication> {
  await lockActiveWorkflow(client, { ...input, workflowId });
  const draftRow = await lockDraft(client, { ...input, workflowId });
  if (draftRow === undefined)
    throw new Error('Workflow is missing its required draft');
  const draft = projectDraft(draftRow, variant.definitionCatalog);
  const currentEtag = workflowDraftRepresentationTag({
    workflowId,
    revision: draft.revision,
    graph: draft.graphJson,
    compatibilityFingerprint: workflowCompatibilityReport(
      draft.graphJson,
      variant.definitionCatalog,
    ).fingerprint,
  });
  if (currentEtag !== input.representationTag)
    throw new WorkflowRevisionConflictError(draft.revision, currentEtag);
  const inspected = await compilePublicationGraph(
    client,
    input,
    draft.graphJson,
    variant,
  );
  if (inspected.kind === 'refused') throw inspected.error;
  return inspected.publication;
}

async function persistVersion(
  client: PoolClient,
  input: PublicationCandidateInput,
  workflowId: string,
  publication: CompiledPublication,
): Promise<Readonly<{ reused: boolean; version: WorkflowVersionRecord }>> {
  const db = drizzle(client);
  const scope = and(
    eq(workflowVersions.workspaceId, input.workspaceId),
    eq(workflowVersions.workflowId, workflowId),
  );
  // Newest-first pages preserve the most recent match without retaining the full history.
  const pageSize = 16;
  let beforeVersion: number | undefined;
  let versionRow: Parameters<typeof projectVersion>[0] | undefined;
  for (;;) {
    const retained = await db
      .select(versionProjection)
      .from(workflowVersions)
      .where(
        and(
          scope,
          eq(workflowVersions.checksum, publication.checksum),
          beforeVersion === undefined
            ? undefined
            : lt(workflowVersions.versionNumber, beforeVersion),
        ),
      )
      .orderBy(desc(workflowVersions.versionNumber))
      .limit(pageSize)
      .catch(rethrowQueryFailure);
    versionRow = retained.find((row) =>
      sameWorkflowNotes(projectVersion(row).graphJson, publication.graph),
    );
    if (versionRow !== undefined || retained.length < pageSize) break;
    beforeVersion = retained.at(-1)?.versionNumber;
  }
  const reused = versionRow !== undefined;
  if (!reused) {
    const inserted = await db
      .insert(workflowVersions)
      .select(
        db
          .select({
            id: sql<string>`${publication.versionId}::uuid`.as('id'),
            workspaceId: sql<string>`${input.workspaceId}::uuid`.as(
              'workspace_id',
            ),
            workflowId: sql<string>`${workflowId}::uuid`.as('workflow_id'),
            versionNumber:
              sql<number>`coalesce(max(${workflowVersions.versionNumber}),0)+1`.as(
                'version_number',
              ),
            graphJson:
              sql<unknown>`${JSON.stringify(publication.graph)}::json`.as(
                'graph_json',
              ),
            checksum: sql<string>`${publication.checksum}::varchar`.as(
              'checksum',
            ),
            executableJson:
              sql<unknown>`${JSON.stringify(publication.executable.executableJson)}::json`.as(
                'executable_json',
              ),
            publishedBy: sql<string>`${input.actorId}::uuid`.as('published_by'),
            publishedAt: sql<Date>`clock_timestamp()`.as('published_at'),
          })
          .from(workflowVersions)
          .where(scope),
      )
      .returning(versionProjection)
      .catch(rethrowQueryFailure);
    versionRow = inserted[0];
  }
  if (versionRow === undefined)
    throw new Error('Workflow publication returned no version');
  const version = projectVersion(versionRow);
  return Object.freeze({ reused, version });
}

/** One publication transaction core; only authoring command owners may call it. */
export async function publishWorkflowCandidate(
  client: PoolClient,
  input: PublicationCandidateInput,
  catalogs: AuthoringCatalogs,
): Promise<PublishWorkflowResult> {
  const workflowId = input.workflowId;
  const publication = await lockAndCompilePublication(
    client,
    input,
    workflowId,
    catalogs,
  );
  const { reused, version } = await persistVersion(
    client,
    input,
    workflowId,
    publication,
  );
  await persistPublicationProjections(client, input, {
    workflowId,
    publication,
    version,
  });
  await recordPromotedPublication(client, version);
  await finalizePublication(client, input, {
    workflowId,
    version,
    reused,
  });
  return Object.freeze({ replayed: false, reused, version });
}

export async function publishWorkflowDirectly(
  client: PoolClient,
  input: PublicationCandidateInput,
  catalogs: AuthoringCatalogs,
): Promise<PublishWorkflowResult> {
  const [policy] = await drizzle(client)
    .select({ requirePublishApproval: workspaces.requirePublishApproval })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .catch(rethrowQueryFailure);
  if (policy?.requirePublishApproval ?? false)
    throw new PublicationReviewError(
      'required',
      'This workspace requires publication review. Request approval for the saved draft.',
    );
  return publishWorkflowCandidate(client, input, catalogs);
}

/** A command's own door: an exact retry replays, anything else publishes directly. */
export async function publishWorkflow(
  client: PoolClient,
  input: PublishWorkflowInput,
  catalogs: AuthoringCatalogs,
): Promise<PublishWorkflowResult> {
  const claim = await claimPublication(client, input);
  if (claim.replay !== null) return claim.replay;
  const result = await publishWorkflowDirectly(client, input, catalogs);
  await completeCommand(client, claim.command, {
    versionId: result.version.id,
    reused: result.reused,
  });
  return result;
}
