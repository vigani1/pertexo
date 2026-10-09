import { HttpResponse, http } from 'msw';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowSummarySchema,
} from '@pertexo/contracts';
import {
  portableGraphDigest,
  workflowPortableManifestSchema,
  WORKFLOW_PORTABILITY_LIMITS,
} from '@pertexo/workflow-model';
import { WorkflowExportDialog } from '@/features/workflows/portability.public';
import { WorkflowImportDialog } from '@/features/workflows/components/portability/workflow-import-dialog';
import { createApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/api-error';
import {
  readPortableWorkflowFile,
  downloadPortableWorkflow,
} from '@/features/workflows/model/portability';
import { workflowKeys } from '@/features/workflows/queries.public';
import { mockServer } from '../../support/mock-server';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import {
  api,
  discoveryHandlers,
  draftBody,
  emptyGraph,
  etag,
  graphOf,
  summary,
  userId,
  workflowId,
  workspaceId,
  workspaceWith,
  versionId,
  problem,
} from './list/fixtures';

const fingerprint = `wf-compat:v1:sha256:${'a'.repeat(64)}`;
const manifest = {
  format: 'pertexo.workflow',
  formatVersion: 1,
  graph: emptyGraph,
  requirements: {
    definitions: [],
  },
  connectionSlots: [],
};
const preview = {
  manifestDigest: 'b'.repeat(64),
  compatibilityFingerprint: fingerprint,
  compatible: true,
  issues: [],
  truncated: false,
  connectionSlots: [],
};
const client = () =>
  createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
const workspace = () =>
  accessibleWorkspaceSchema.parse(
    workspaceWith(['workflow:create', 'connection:read']),
  );

function openImport() {
  mockServer.use(...discoveryHandlers());
  const onCreated = vi.fn();
  const result = renderInRouter(
    <WorkflowImportDialog
      apiClient={client()}
      userId={userId}
      workspace={workspace()}
      onClose={vi.fn()}
      onCreated={onCreated}
    />,
  );
  return { ...result, event: userEvent.setup(), onCreated };
}

async function prepareImport(event: ReturnType<typeof userEvent.setup>) {
  await event.upload(
    await screen.findByLabelText('Workflow JSON file'),
    new File([JSON.stringify(manifest)], 'workflow.json', {
      type: 'application/json',
    }),
  );
  await screen.findByLabelText('Complete imported graph');
  await event.type(
    screen.getByLabelText('New workflow name'),
    'Independent draft',
  );
  await event.click(screen.getByRole('button', { name: 'Preview import' }));
  await screen.findByText(/Compatible with this workspace/u);
}

describe('Portable workflow review and import', () => {
  it.each([403, 404])(
    'retains import intent after unrelated Inbox %i',
    async (status) => {
      const { event, queryClient } = openImport();
      await event.upload(
        await screen.findByLabelText('Workflow JSON file'),
        new File([JSON.stringify(manifest)], 'workflow.json', {
          type: 'application/json',
        }),
      );
      await screen.findByLabelText('Complete imported graph');
      await event.type(
        screen.getByLabelText('New workflow name'),
        'Independent draft',
      );
      await act(async () => {
        await queryClient
          .query({
            queryKey: [
              'identity',
              userId,
              'workspace',
              workspaceId,
              'inbox',
              'unread',
            ],
            queryFn: () =>
              Promise.reject(
                new ApiError({
                  kind: 'problem',
                  message: 'Inbox unavailable',
                  status,
                }),
              ),
            retry: false,
          })
          .catch(() => undefined);
      });
      await waitFor(() => {
        expect(screen.getByLabelText('New workflow name')).toHaveValue(
          'Independent draft',
        );
      });
      expect(
        screen.getByLabelText('Complete imported graph'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Access changed/u)).not.toBeInTheDocument();
    },
  );

  it('clears import intent on authentication loss observed by another feature', async () => {
    const { event, queryClient } = openImport();
    await event.type(
      await screen.findByLabelText('New workflow name'),
      'Private name',
    );
    await queryClient
      .query({
        queryKey: [
          'identity',
          userId,
          'workspace',
          workspaceId,
          'inbox',
          'unread',
        ],
        queryFn: () =>
          Promise.reject(
            new ApiError({
              kind: 'problem',
              message: 'Session expired',
              status: 401,
            }),
          ),
        retry: false,
      })
      .catch(() => undefined);
    await screen.findByText(/Access changed/u);
    expect(
      screen.queryByLabelText('New workflow name'),
    ).not.toBeInTheDocument();
  });

  it('shows full source configuration and requires the exact graph acknowledgement and draft ETag', async () => {
    const graph = graphOf([
      { id: 'source', key: 'core.manual', label: 'Private label', x: 0 },
    ]);
    const node = graph.nodes[0];
    if (node === undefined) throw new Error('Source node fixture missing');
    node.config = {
      privateLiteral: 'DO NOT SHARE',
      expression: '$lookup(private)',
    };
    const posted = vi.fn();
    mockServer.use(
      ...discoveryHandlers(),
      http.get(`${api}/workflows/${workflowId}/draft`, () =>
        HttpResponse.json(draftBody(workflowId, graph), { headers: { etag } }),
      ),
      http.post(
        `${api}/workflows/${workflowId}/export`,
        async ({ request }) => {
          posted(await request.json(), request.headers.get('if-match'));
          return HttpResponse.json(manifest);
        },
      ),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:test'),
        revokeObjectURL: vi.fn(),
      }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const event = userEvent.setup();
    renderInRouter(
      <WorkflowExportDialog
        apiClient={client()}
        userId={userId}
        workspace={workspace()}
        workflow={workflowSummarySchema.parse(summary(workflowId, 'Source'))}
        source={{ kind: 'draft' }}
        onClose={vi.fn()}
      />,
    );
    const review = await screen.findByLabelText('Complete saved source graph');
    expect(review).toHaveTextContent('DO NOT SHARE');
    expect(review).toHaveTextContent('$lookup(private)');
    expect(review).toHaveTextContent('Private label');
    const download = screen.getByRole('button', {
      name: 'Download workflow JSON',
    });
    expect(download).toBeDisabled();
    await event.click(screen.getByRole('checkbox'));
    await event.click(download);
    const reviewedGraphDigest = await portableGraphDigest(graph);
    await waitFor(() => {
      expect(posted).toHaveBeenCalledWith(
        { source: { kind: 'draft' }, reviewedGraphDigest },
        etag,
      );
    });
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    click.mockRestore();
  });

  it('invalidates the advisory preview when the name changes and never imports incompatibility', async () => {
    const posted = vi.fn();
    mockServer.use(
      http.post(`${api}/workflows/import/preview`, () =>
        HttpResponse.json(preview),
      ),
      http.post(`${api}/workflows/import`, () => {
        posted();
        return HttpResponse.json({ workflowId: versionId });
      }),
    );
    const { event } = openImport();
    await prepareImport(event);
    expect(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    ).toBeEnabled();
    await event.type(screen.getByLabelText('New workflow name'), ' changed');
    expect(
      screen.queryByText(/Compatible with this workspace/u),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    ).toBeDisabled();
    mockServer.use(
      http.post(`${api}/workflows/import/preview`, () =>
        HttpResponse.json({
          ...preview,
          compatible: false,
          issues: [
            {
              code: 'definition_missing',
              path: '/nodes/0',
              message: 'A required definition is unavailable.',
            },
          ],
        }),
      ),
    );
    await event.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText('A required definition is unavailable.');
    expect(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    ).toBeDisabled();
    expect(posted).not.toHaveBeenCalled();
  });

  it('manually retries exact body/key and opens a confirmed destination without another POST', async () => {
    const attempts: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/import/preview`, () =>
        HttpResponse.json(preview),
      ),
      http.post(`${api}/workflows/import`, async ({ request }) => {
        attempts.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        return attempts.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({ workflowId: versionId }, { status: 201 });
      }),
    );
    const { event, onCreated } = openImport();
    await prepareImport(event);
    await event.click(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    );
    const retry = await screen.findByRole('button', {
      name: 'Retry exact import',
    });
    expect(screen.getByLabelText('New workflow name')).toBeDisabled();
    expect(attempts).toHaveLength(1);
    await event.click(retry);
    await event.click(
      await screen.findByRole('button', { name: 'Open imported workflow' }),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(onCreated).toHaveBeenCalledWith(versionId);
  });

  it('clears payloads and fences held preview after observable access loss, while Cancel remains available', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = false;
    mockServer.use(
      http.post(`${api}/workflows/import/preview`, async () => {
        called = true;
        await held;
        return HttpResponse.json(preview);
      }),
    );
    const { event, queryClient } = openImport();
    await event.upload(
      await screen.findByLabelText('Workflow JSON file'),
      new File([JSON.stringify(manifest)], 'workflow.json', {
        type: 'application/json',
      }),
    );
    await screen.findByLabelText('Complete imported graph');
    await event.type(
      screen.getByLabelText('New workflow name'),
      'Sensitive name',
    );
    await event.click(screen.getByRole('button', { name: 'Preview import' }));
    await waitFor(() => {
      expect(called).toBe(true);
    });
    try {
      await queryClient.query({
        queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
        queryFn: () =>
          Promise.reject(
            new ApiError({ kind: 'problem', message: 'Denied', status: 403 }),
          ),
        retry: false,
      });
    } catch {
      /* Observable denial is the subject. */
    }
    await screen.findByText(/Access changed/u);
    release?.();
    expect(
      screen.queryByLabelText('Complete imported graph'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('New workflow name'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(
      screen.queryByText(/Compatible with this workspace/u),
    ).not.toBeInTheDocument();
  });

  it('requires a new preview after an ordinary conflict while retaining editable import intent', async () => {
    mockServer.use(
      http.post(`${api}/workflows/import/preview`, () =>
        HttpResponse.json(preview),
      ),
      http.post(`${api}/workflows/import`, () =>
        problem(409, 'request.idempotency_conflict'),
      ),
    );
    const { event } = openImport();
    await prepareImport(event);
    await event.click(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    );
    await screen.findByText(/already used with different details/u);
    expect(screen.getByLabelText('New workflow name')).toHaveValue(
      'Independent draft',
    );
    expect(screen.getByLabelText('New workflow name')).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    ).toBeDisabled();
  });

  it('unfreezes editable intent after a definite conflict on an exact uncertain retry', async () => {
    let calls = 0;
    mockServer.use(
      http.post(`${api}/workflows/import/preview`, () =>
        HttpResponse.json(preview),
      ),
      http.post(`${api}/workflows/import`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.error()
          : problem(409, 'request.idempotency_conflict');
      }),
    );
    const { event } = openImport();
    await prepareImport(event);
    await event.click(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    );
    await event.click(
      await screen.findByRole('button', { name: 'Retry exact import' }),
    );
    await screen.findByText(/already used with different details/u);
    expect(screen.getByLabelText('New workflow name')).toHaveValue(
      'Independent draft',
    );
    expect(screen.getByLabelText('New workflow name')).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Retry exact import' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    ).toBeDisabled();
    expect(calls).toBe(2);
  });

  it('rejects malformed UTF-8 instead of silently replacing a graph literal', async () => {
    const text = JSON.stringify({
      ...manifest,
      graph: graphOf([
        { id: 'source', key: 'core.manual', label: 'UTF8_SENTINEL', x: 0 },
      ]),
    });
    const [prefix, suffix] = text.split('UTF8_SENTINEL');
    if (prefix === undefined || suffix === undefined)
      throw new Error('UTF-8 fixture sentinel missing');
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(prefix),
      0xc3,
      0x28,
      ...new TextEncoder().encode(suffix),
    ]);
    await expect(
      readPortableWorkflowFile(new File([bytes], 'malformed.json')),
    ).rejects.toThrow('This is not a valid portable workflow file');
  });

  it('rejects local oversized bytes, duplicate keys and excessive raw nesting before schema admission', async () => {
    for (const content of [
      '{"format":"pertexo.workflow","format":"pertexo.workflow"}',
      '['.repeat(257) + '0' + ']'.repeat(257),
      ' '.repeat(2_097_153),
    ]) {
      await expect(
        readPortableWorkflowFile(new File([content], 'workflow.json')),
      ).rejects.toThrow();
    }
  });

  it('keeps downloads compact so pretty-print expansion cannot make a valid file unimportable', async () => {
    const graph = graphOf([{ id: 'source', key: 'core.manual', x: 0 }]);
    const node = graph.nodes[0];
    if (node === undefined) throw new Error('Source node fixture missing');
    node.config = Object.fromEntries(
      Array.from({ length: 100_000 }, (_, index) => [
        `a${index.toString(36)}`,
        0,
      ]),
    );
    const portable = workflowPortableManifestSchema.parse({
      ...manifest,
      graph,
      requirements: {
        ...manifest.requirements,
        definitions: [{ key: 'core.manual', version: 1, configVersion: 1 }],
      },
    });
    expect(
      new TextEncoder().encode(JSON.stringify(portable, null, 2)).byteLength,
    ).toBeGreaterThan(WORKFLOW_PORTABILITY_LIMITS.bytes);
    let downloaded: Blob | undefined;
    const oldCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob instanceof Blob) downloaded = blob;
      return 'blob:compact';
    };
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      downloadPortableWorkflow(portable);
      if (downloaded === undefined) throw new Error('Download blob missing');
      expect(downloaded.size).toBeLessThan(WORKFLOW_PORTABILITY_LIMITS.bytes);
      await expect(
        readPortableWorkflowFile(new File([downloaded], 'portable.json')),
      ).resolves.toEqual(portable);
    } finally {
      URL.createObjectURL = oldCreate;
      click.mockRestore();
    }
  });
});
