import { readPortableWorkflowFile } from '@/features/workflows/model/portability';

import { workflowKeys } from '@/features/workflows/queries.public';

import { ApiError } from '@/lib/api/error';

import { workflowPortableManifestSchema } from '@pertexo/workflow-model';

import { screen, waitFor } from '@testing-library/react';

import { HttpResponse, http } from 'msw';

import { describe, expect, it, vi } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import {
  api,
  graphOf,
  problem,
  userId,
  versionId,
  workflowId,
  workspaceId,
} from '../list/fixtures';

import { manifest, openImport, prepareImport, preview } from './fixture';

describe('Portable workflow review and import', () => {
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
  it('round-trips a failure link and its safe source mapping through a portable file', async () => {
    const graph = graphOf([
      { id: 'source', key: 'core.set', x: 0 },
      { id: 'handler', key: 'core.set', x: 300 },
    ]);
    const handler = graph.nodes[1];
    if (handler === undefined) throw new Error('Handler fixture missing');
    handler.inputMappings = {
      failure: { kind: 'node_failure', nodeId: 'source', path: '$' },
    };
    graph.edges = [
      {
        id: 'failure',
        source: { nodeId: 'source', port: '__failure' },
        target: { nodeId: 'handler', port: 'in' },
      },
    ];
    const portable = workflowPortableManifestSchema.parse({
      ...manifest,
      graph,
      requirements: {
        definitions: [{ key: 'core.set', version: 1, configVersion: 1 }],
      },
    });
    await expect(
      readPortableWorkflowFile(
        new File([JSON.stringify(portable)], 'failure.json'),
      ),
    ).resolves.toEqual(portable);
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
    ).rejects.toThrow('This file isn’t valid JSON.');
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
});
