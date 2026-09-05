import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  EMPTY_DEFINITION_CATALOG_V1,
  type workflowCompatibilityReport,
  type WorkflowDefinitionCatalogV1,
  type WorkflowGraph,
} from '@pertexo/workflow-model/graph';

import type { DatabaseConfig } from '../config.js';
import {
  lockExpectedCompatibilityReleaseWithClient,
  lockExpectedCompatibilityReleaseSetWithClient,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationHistory,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectation,
} from '../compatibility/compatibility-release.js';
import { WorkflowNotFoundError } from './workflow-authoring-errors.js';
import { createWorkflowPublisher } from './workflow-publication.js';
import { createWorkflowAuthoringReadStore } from './workflow-authoring-reads.js';
import { createWorkflowAuthoringDraftStore } from './workflow-authoring-drafts.js';
import {
  checksumSchema,
  mapDraft,
  mapVersion,
} from './workflow-authoring-rows.js';
import {
  acceptPreviewRun,
  readPreviewRun,
  type AcceptedPreviewRun,
  type AcceptPreviewRunInput,
  type PreviewRunRecord,
} from '../execution/preview-execution.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../tenant-access/workspace.js';

const uuidSchema = z.uuid();
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));

export {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from './workflow-authoring-errors.js';

export type WorkflowDefinitionPlacementIssue = Readonly<{
  code: 'definition_not_placeable';
  path: string;
  message: string;
}>;

export class WorkflowDefinitionPlacementError extends Error {
  public override readonly name = 'WorkflowDefinitionPlacementError';

  public constructor(
    public readonly issues: readonly WorkflowDefinitionPlacementIssue[],
  ) {
    super('Workflow draft adds a definition that is not placeable');
  }
}

export type WorkflowRecord = Readonly<{
  id: string;
  workspaceId: string;
  name: string;
  lifecycleStatus: 'active' | 'archived';
  activationStatus: 'inactive';
  publishedVersionId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type WorkflowDraftRecord = Readonly<{
  workflowId: string;
  workspaceId: string;
  revision: number;
  schemaVersion: number;
  graphJson: WorkflowGraph;
  compatibility: ReturnType<typeof workflowCompatibilityReport>;
  updatedBy: string;
  updatedAt: Date;
}>;

export type WorkflowVersionRecord = Readonly<{
  id: string;
  workspaceId: string;
  workflowId: string;
  versionNumber: number;
  schemaVersion: number;
  graphJson: WorkflowGraph;
  checksum: string;
  publishedBy: string;
  publishedAt: Date;
}>;

export type CreateWorkflowInput = Readonly<{
  id?: string;
  workspaceId: string;
  actorId: string;
  name: string;
  emptyGraph: unknown;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;

export type CreateWorkflowResult = Readonly<{
  workflowId: string;
  workflow: WorkflowRecord;
  draft: WorkflowDraftRecord;
}>;

export type SaveWorkflowDraftInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  expectedRevision: number;
  graphJson: unknown;
  requestId?: string;
  traceId?: string;
}>;

export type PublishWorkflowInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  representationTag: string;
  /** Canonical application request digest, including the original If-Match. */
  requestHash: string;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
  traceparent?: string;
}>;

export type ListWorkflowsInput = Readonly<{
  workspaceId: string;
  actorId: string;
  limit?: number;
  after?: Readonly<{ createdAt: Date; id: string }>;
}>;

export type WorkflowPage = Readonly<{
  items: readonly WorkflowRecord[];
  nextCursor?: Readonly<{ createdAt: Date; id: string }>;
}>;

export type ListWorkflowVersionsInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  limit?: number;
  beforeVersionNumber?: number;
}>;

export type WorkflowVersionPage = Readonly<{
  items: readonly WorkflowVersionRecord[];
  nextCursor?: Readonly<{ beforeVersionNumber: number }>;
}>;

export type PublishWorkflowResult = Readonly<{
  version: WorkflowVersionRecord;
  reused: boolean;
  replayed: boolean;
}>;

export { reconcileWorkflowTriggersPayload } from './workflow-publication.js';

export type WorkflowAuthoringDatabase = Readonly<{
  acceptPreview(
    input: AcceptPreviewRunInput & Readonly<{ workspaceId: string }>,
  ): Promise<AcceptedPreviewRun>;
  readPreview(
    input: Readonly<{
      workspaceId: string;
      actorUserId: string;
      previewRunId: string;
    }>,
  ): Promise<PreviewRunRecord | null>;
  createWorkflow(input: CreateWorkflowInput): Promise<CreateWorkflowResult>;
  listWorkflows(input: ListWorkflowsInput): Promise<WorkflowPage>;
  getDraft(
    workspaceId: string,
    workflowId: string,
    actorId: string,
  ): Promise<WorkflowDraftRecord | null>;
  getVersion(
    workspaceId: string,
    workflowId: string,
    versionId: string,
    actorId: string,
  ): Promise<WorkflowVersionRecord | null>;
  listVersions(input: ListWorkflowVersionsInput): Promise<WorkflowVersionPage>;
  saveDraft(input: SaveWorkflowDraftInput): Promise<WorkflowDraftRecord>;
  publishWorkflow(input: PublishWorkflowInput): Promise<PublishWorkflowResult>;
  close(): Promise<void>;
}>;

export type WorkflowAuthoringTestHooks = Readonly<{
  /** Integration-test synchronization seam after the durable release lock. */
  afterCompatibilityReleaseLock?: () => Promise<void>;
  /** Integration-test synchronization seam; runtime composition must omit it. */
  afterSaveCas?: () => Promise<void>;
  /** Integration-test synchronization/fault seam after both publish locks. */
  afterPublishDraftLock?: () => Promise<void>;
  afterPublishStep?: (
    step:
      | 'version'
      | 'integration_usage'
      | 'trigger_projection'
      | 'pointer'
      | 'outbox'
      | 'audit'
      | 'idempotency',
  ) => Promise<void>;
}>;

export type WorkflowAuthoringDatabaseOptions = Readonly<{
  compatibilityRelease?: CompatibilityReleaseExpectation;
  compatibilityReleaseVariants?: readonly WorkflowAuthoringCompatibilityVariant[];
  compatibilityReadinessReleases?: readonly CompatibilityReleaseExpectation[];
  definitionCatalog?: WorkflowDefinitionCatalogV1;
  placementDefinitionCatalog?: WorkflowDefinitionCatalogV1;
  runtime?: DatabaseRuntime;
  executableCompiler?: WorkflowExecutableCompiler;
  testHooks?: WorkflowAuthoringTestHooks;
}>;

type WorkflowAuthoringCompatibilityVariant = Readonly<{
  compatibilityRelease: CompatibilityReleaseExpectation;
  definitionCatalog: WorkflowDefinitionCatalogV1;
  placementDefinitionCatalog: WorkflowDefinitionCatalogV1;
  executableCompiler: WorkflowExecutableCompiler;
}>;

export type WorkflowExecutableCompiler = (graph: WorkflowGraph) => Readonly<{
  checksum: `wf:v2:sha256:${string}`;
  executableSchemaVersion: 2;
  executableJson: unknown;
  compatibilityReleaseEpoch: number;
  compatibilityReleaseFingerprint: string;
}>;

function definitionIdentityToken(
  definition: Readonly<{ key: string; version: number }>,
): string {
  return `${definition.key}\u0000${String(definition.version)}`;
}

type LocatedWorkflowNode = Readonly<{
  id: string;
  definition: Readonly<{ key: string; version: number }>;
  path: string;
}>;

function graphNodeLocations(
  graph: WorkflowGraph,
): readonly LocatedWorkflowNode[] {
  const result: LocatedWorkflowNode[] = [];
  const pending: Readonly<{ graph: WorkflowGraph; path: string }>[] = [
    { graph, path: '$' },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const node of current.graph.nodes) {
      const path = `${current.path}.nodes.${node.id}`;
      result.push(
        Object.freeze({ id: node.id, definition: node.definition, path }),
      );
      if (node.structured !== undefined) {
        pending.push({
          graph: node.structured.body,
          path: `${path}.structured.body`,
        });
      }
    }
  }
  return Object.freeze(result);
}

function nodeOccurrenceToken(node: LocatedWorkflowNode): string {
  return `${node.id}\u0000${definitionIdentityToken(node.definition)}`;
}

function countNodeOccurrences(
  nodes: readonly LocatedWorkflowNode[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const token = nodeOccurrenceToken(node);
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function requirePlaceableDefinitionAdditions(
  previous: WorkflowGraph,
  next: WorkflowGraph,
  placementCatalog: WorkflowDefinitionCatalogV1 | undefined,
): void {
  if (placementCatalog === undefined) return;
  const placeable = new Set(
    placementCatalog.definitions.map(definitionIdentityToken),
  );
  const previousNodes = graphNodeLocations(previous);
  const nextNodes = graphNodeLocations(next);
  const previousOccurrences = countNodeOccurrences(previousNodes);
  const nextOccurrences = countNodeOccurrences(nextNodes);
  const issues: WorkflowDefinitionPlacementIssue[] = [];
  for (const node of nextNodes) {
    const occurrence = nodeOccurrenceToken(node);
    if (
      previousOccurrences.get(occurrence) === 1 &&
      nextOccurrences.get(occurrence) === 1
    ) {
      continue;
    }
    if (placeable.has(definitionIdentityToken(node.definition))) continue;
    issues.push(
      Object.freeze({
        code: 'definition_not_placeable',
        path: `${node.path}.definition`,
        message: `Definition ${node.definition.key}@${String(node.definition.version)} cannot be newly placed in the current compatibility release.`,
      }),
    );
  }
  if (issues.length > 0)
    throw new WorkflowDefinitionPlacementError(Object.freeze(issues));
}

async function withAuthorTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
  actorIdInput: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantScopedClient(
    pool,
    {
      workspaceId: uuidSchema.parse(workspaceIdInput),
      actorId: uuidSchema.parse(actorIdInput),
    },
    operation,
  );
}

async function requireWorkspaceAuthor(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
     join app.workspaces workspace on workspace.id = membership.workspace_id
     where membership.workspace_id = $1 and membership.user_id = $2
       and membership.status = 'active' and membership.role in ('owner', 'admin', 'builder')
       and workspace.status = 'active'`,
    [workspaceId, actorId],
  );
  if (result.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
}

async function requireWorkspaceReader(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
     join app.workspaces workspace on workspace.id = membership.workspace_id
     where membership.workspace_id = $1 and membership.user_id = $2
       and membership.status = 'active' and workspace.status = 'active'`,
    [workspaceId, actorId],
  );
  if (result.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
}

function keyDigest(key: string): string {
  return createHash('sha256')
    .update(idempotencyKeySchema.parse(key))
    .digest('hex');
}

function durablePublishResult(
  value: unknown,
): Omit<PublishWorkflowResult, 'replayed'> {
  const parsed = z
    .object({
      version: z
        .object({
          id: z.uuid(),
          workspaceId: z.uuid(),
          workflowId: z.uuid(),
          versionNumber: z.number().int().positive(),
          schemaVersion: z.number().int().positive(),
          graphJson: z.unknown(),
          checksum: checksumSchema,
          publishedBy: z.uuid(),
          publishedAt: z.iso.datetime(),
        })
        .strict(),
      reused: z.boolean(),
    })
    .strict()
    .parse(value);
  const version = mapVersion({
    id: parsed.version.id,
    workspace_id: parsed.version.workspaceId,
    workflow_id: parsed.version.workflowId,
    version_number: parsed.version.versionNumber,
    schema_version: parsed.version.schemaVersion,
    graph_json: parsed.version.graphJson,
    checksum: parsed.version.checksum,
    published_by: parsed.version.publishedBy,
    published_at: parsed.version.publishedAt,
  });
  return Object.freeze({
    version,
    reused: parsed.reused,
  });
}

export function createWorkflowAuthoringDatabase(
  config: DatabaseConfig,
  options: WorkflowAuthoringDatabaseOptions = {},
): WorkflowAuthoringDatabase {
  if (
    options.compatibilityReleaseVariants !== undefined &&
    (options.compatibilityRelease !== undefined ||
      options.definitionCatalog !== undefined ||
      options.placementDefinitionCatalog !== undefined ||
      options.executableCompiler !== undefined)
  )
    throw new TypeError(
      'Compatibility release variants cannot be combined with singular publication options',
    );
  if (
    options.compatibilityReadinessReleases !== undefined &&
    options.compatibilityReleaseVariants === undefined
  )
    throw new TypeError(
      'Compatibility readiness releases require publication variants',
    );
  const defaultDefinitionCatalog =
    options.definitionCatalog ?? EMPTY_DEFINITION_CATALOG_V1;
  const compatibilityRelease =
    options.compatibilityRelease === undefined
      ? undefined
      : parseCompatibilityReleaseExpectation(options.compatibilityRelease);
  if (
    options.executableCompiler !== undefined &&
    (compatibilityRelease === undefined ||
      defaultDefinitionCatalog.releaseFingerprint !==
        compatibilityRelease.fingerprint)
  ) {
    throw new TypeError(
      'Executable workflow publication requires matching compatibility authority',
    );
  }
  if (
    options.placementDefinitionCatalog !== undefined &&
    (compatibilityRelease === undefined ||
      options.placementDefinitionCatalog.releaseFingerprint !==
        compatibilityRelease.fingerprint)
  ) {
    throw new TypeError(
      'Workflow placement requires matching compatibility authority',
    );
  }
  const compatibilityReleaseVariants = options.compatibilityReleaseVariants;
  const compatibilityVariants =
    compatibilityReleaseVariants === undefined
      ? undefined
      : Object.freeze(
          parseCompatibilityReleaseExpectationHistory(
            compatibilityReleaseVariants.map(
              ({ compatibilityRelease: release }) => release,
            ),
          ).map((release) => {
            const variant = compatibilityReleaseVariants.find(
              ({ compatibilityRelease: candidate }) =>
                candidate.epoch === release.epoch &&
                candidate.fingerprint === release.fingerprint &&
                candidate.catalogJson === release.catalogJson,
            );
            if (
              variant?.definitionCatalog.releaseFingerprint !==
                release.fingerprint ||
              variant.placementDefinitionCatalog.releaseFingerprint !==
                release.fingerprint
            )
              throw new TypeError(
                'Executable workflow publication requires matching compatibility variants',
              );
            return Object.freeze({
              compatibilityRelease: release,
              definitionCatalog: variant.definitionCatalog,
              placementDefinitionCatalog: variant.placementDefinitionCatalog,
              executableCompiler: variant.executableCompiler,
            });
          }),
        );
  const compatibilityReadinessReleases =
    options.compatibilityReadinessReleases === undefined
      ? undefined
      : parseCompatibilityReleaseExpectationSet(
          options.compatibilityReadinessReleases,
        );
  if (
    compatibilityVariants !== undefined &&
    compatibilityVariants.length > 2 &&
    compatibilityReadinessReleases === undefined
  )
    throw new TypeError(
      'Retained publication history requires bounded compatibility readiness releases',
    );
  if (
    compatibilityReadinessReleases?.some(
      (readiness) =>
        !compatibilityVariants?.some(
          ({ compatibilityRelease: variant }) =>
            variant.epoch === readiness.epoch &&
            variant.fingerprint === readiness.fingerprint &&
            variant.catalogJson === readiness.catalogJson,
        ),
    ) === true
  )
    throw new TypeError(
      'Compatibility readiness release is missing a publication variant',
    );
  const defaultVariant = Object.freeze({
    compatibilityRelease,
    definitionCatalog: defaultDefinitionCatalog,
    placementDefinitionCatalog: options.placementDefinitionCatalog,
    executableCompiler: options.executableCompiler,
  });
  const selectCompatibilityVariant = async (
    client: Pick<PoolClient, 'query'>,
  ): Promise<typeof defaultVariant> => {
    if (compatibilityVariants === undefined) {
      if (compatibilityRelease !== undefined)
        await lockExpectedCompatibilityReleaseWithClient(
          client,
          compatibilityRelease,
        );
      return defaultVariant;
    }
    const selected = await lockExpectedCompatibilityReleaseSetWithClient(
      client,
      compatibilityReadinessReleases ??
        compatibilityVariants.map(
          ({ compatibilityRelease: release }) => release,
        ),
    );
    const variant = compatibilityVariants.find(
      ({ compatibilityRelease: release }) =>
        release.epoch === selected.epoch &&
        release.fingerprint === selected.fingerprint &&
        release.catalogJson === selected.catalogJson,
    );
    if (variant === undefined)
      throw new Error('Locked compatibility release variant is unavailable');
    return variant;
  };
  // Runtime import is kept here so the public package remains straightforward to test.
  const lease = acquireDatabasePool(config, options.runtime);
  const { pool } = lease;
  const publishWorkflow = createWorkflowPublisher({
    durableResult: durablePublishResult,
    keyDigest,
    mapDraft,
    mapVersion,
    requireAuthor: requireWorkspaceAuthor,
    selectVariant: selectCompatibilityVariant,
    testHooks: options.testHooks,
    transact: (workspaceId, actorId, operation) =>
      withAuthorTransaction(pool, workspaceId, actorId, operation),
  });
  return Object.freeze({
    acceptPreview: async ({ workspaceId, ...input }) =>
      withWorkspaceTransaction(pool, workspaceId, (transaction) =>
        acceptPreviewRun(transaction, input),
      ),
    readPreview: async ({ workspaceId, ...input }) =>
      withWorkspaceTransaction(pool, workspaceId, (transaction) =>
        readPreviewRun(transaction, input),
      ),
    ...createWorkflowAuthoringDraftStore({
      keyDigest,
      requireAuthor: requireWorkspaceAuthor,
      requirePlaceable: requirePlaceableDefinitionAdditions,
      selectCatalogs: selectCompatibilityVariant,
      ...(options.testHooks === undefined
        ? {}
        : { testHooks: options.testHooks }),
      transact: (workspaceId, actorId, operation) =>
        withAuthorTransaction(pool, workspaceId, actorId, operation),
    }),
    ...createWorkflowAuthoringReadStore({
      requireReader: requireWorkspaceReader,
      selectDefinitionCatalog: async (client) =>
        (await selectCompatibilityVariant(client)).definitionCatalog,
      transact: (workspaceId, actorId, operation) =>
        withAuthorTransaction(pool, workspaceId, actorId, operation),
    }),
    publishWorkflow,
    close: () => lease.close(),
  });
}
