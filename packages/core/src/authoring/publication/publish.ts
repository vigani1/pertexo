import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { recordPromotedPublication } from '../promotion/provenance.repository.js';
import { PublicationReviewError } from '../reviews/publication-review.errors.js';
import { requiresPublishApproval } from '../reviews/requests.repository.js';

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
} from '../workflows/representation/workflow-representations.repository.js';
import { readVersionRow } from '../workflows/commands/version-sources.repository.js';

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
import {
  findRetainedVersion,
  insertNextVersion,
} from './versions.repository.js';

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
  const row = await readVersionRow(client, {
    workspaceId: input.workspaceId,
    workflowId,
    versionId,
  });
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
  const workflow = { workspaceId: input.workspaceId, workflowId };
  const retained = await findRetainedVersion(
    client,
    workflow,
    publication.checksum,
    (row) =>
      sameWorkflowNotes(projectVersion(row).graphJson, publication.graph),
  );
  const reused = retained !== undefined;
  const versionRow =
    retained ??
    (await insertNextVersion(client, workflow, publication, input.actorId));
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
  if (await requiresPublishApproval(client, input.workspaceId))
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
