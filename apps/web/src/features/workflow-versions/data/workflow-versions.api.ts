import {
  strongEtagSchema,
  workflowVersionRestoreRequestSchema,
  workflowVersionRestoreResponseSchema,
  workflowVersionReviewPageSchema,
  workflowVersionHistoryPageSchema,
} from '@pertexo/contracts';
import {
  decodeWorkflowDraftSnapshot,
  type WorkflowDraftSnapshot,
} from '@/features/workflow-drafts/public';
import type { ApiClient } from '@/lib/api/client';
import { collectPages } from '@/lib/api/pagination';

function versionsPath(workspaceId: string, workflowId: string) {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/versions` as const;
}

function versionsQuery(
  include: string,
  input: Readonly<{ after?: string; versionId?: string }>,
) {
  const query = new URLSearchParams({ limit: '25', include });
  if (input.after !== undefined) query.set('after', input.after);
  if (input.versionId !== undefined) query.set('versionId', input.versionId);
  return query.toString();
}

type VersionPageRequest = Readonly<{
  after?: string;
  versionId?: string;
  signal?: AbortSignal | undefined;
}>;

function readVersionsPage<Page>(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  {
    input,
    include,
    schema,
  }: Readonly<{
    input: VersionPageRequest;
    include: 'graphDigest' | 'graphDigest,publishedBy';
    schema: Readonly<{ parse: (value: unknown) => Page }>;
  }>,
) {
  return apiClient.request({
    path: `${versionsPath(workspaceId, workflowId)}?${versionsQuery(include, input)}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: { kind: 'json', decode: (value) => schema.parse(value) },
  });
}

export function getWorkflowVersionsPage(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: VersionPageRequest = {},
) {
  return readVersionsPage(apiClient, workspaceId, workflowId, {
    input,
    include: 'graphDigest',
    schema: workflowVersionReviewPageSchema,
  });
}

/** Every published version for callers that need the immutable graph. */
export function getAllWorkflowVersions(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
) {
  return collectVersions(
    (input) =>
      getWorkflowVersionsPage(apiClient, workspaceId, workflowId, input),
    signal,
  );
}

/** Every published version with the workspace-visible publisher. */
export function getWorkflowVersionHistory(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
) {
  return collectVersions(
    (input) =>
      readVersionsPage(apiClient, workspaceId, workflowId, {
        input,
        include: 'graphDigest,publishedBy',
        schema: workflowVersionHistoryPageSchema,
      }),
    signal,
  );
}

async function collectVersions<Item>(
  readPage: (
    input: VersionPageRequest,
  ) => Promise<{ items: Item[]; nextCursor: string | null }>,
  signal: AbortSignal | undefined,
) {
  const items = await collectPages(
    (after) => readPage({ ...(after === undefined ? {} : { after }), signal }),
    { read: 'Workflow version discovery', signal },
  );
  return { items: [...items], nextCursor: null };
}

export async function findWorkflowVersion({
  apiClient,
  workspaceId,
  workflowId,
  versionId,
  signal,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  versionId: string;
  signal?: AbortSignal | undefined;
}>) {
  const page = await getWorkflowVersionsPage(
    apiClient,
    workspaceId,
    workflowId,
    {
      versionId,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const version = page.items.find((item) => item.id === versionId);
  if (version === undefined)
    throw new Error('The published workflow version is unavailable.');
  return version;
}

export function restoreWorkflowVersion({
  apiClient,
  workspaceId,
  workflowId,
  versionId,
  etag,
  idempotencyKey,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  versionId: string;
  etag: string;
  idempotencyKey: string;
}>): Promise<
  WorkflowDraftSnapshot & Readonly<{ recoveryCopyId: string | null }>
> {
  return apiClient.request({
    path: `${versionsPath(workspaceId, workflowId)}/${encodeURIComponent(versionId)}/restore`,
    method: 'POST',
    headers: {
      'If-Match': strongEtagSchema.parse(etag),
      'Idempotency-Key': idempotencyKey,
    },
    body: workflowVersionRestoreRequestSchema.parse({}),
    response: {
      kind: 'json',
      decode: (value, metadata) => {
        const { recoveryCopyId, ...draft } =
          workflowVersionRestoreResponseSchema.parse(value);
        return {
          ...decodeWorkflowDraftSnapshot(draft, metadata.header('etag')),
          recoveryCopyId,
        };
      },
    },
  });
}
