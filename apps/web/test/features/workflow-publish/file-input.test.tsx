import { webcrypto } from 'node:crypto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FilePropertyUpload } from '@/features/workflow-publish/components/run-submission/file-input';
import { mockServer } from '../../support/mock-server';
import { file, scope, setup } from '../artifacts/upload.fixture';

const workflowId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function open(input: string) {
  setup();
  const change = vi.fn();
  render(
    <FilePropertyUpload
      scope={scope}
      workflowId={workflowId}
      versionId={versionId}
      input={input}
      disabled={false}
      onChange={change}
    />,
  );
  const event = userEvent.setup();
  await event.click(screen.getByRole('button', { name: 'Upload file' }));
  await event.upload(screen.getByLabelText('File', { exact: true }), file());
  await screen.findByText('File ready');
  return { event, change };
}

it('preserves scalar run input instead of coercing it to an object', async () => {
  const { event, change } = await open('42');
  await event.click(screen.getByRole('button', { name: 'Use file' }));
  await screen.findByText(/must be a JSON object/u);
  expect(change).not.toHaveBeenCalled();
});

it('requires explicit confirmation before replacing an existing input property', async () => {
  const { event, change } = await open('{"file":"keep me","other":true}');
  await event.click(screen.getByRole('button', { name: 'Use file' }));
  await screen.findByText(/already exists. Confirm replacement/u);
  expect(change).not.toHaveBeenCalled();
});

it('keeps input unchanged when the published contract cannot be read', async () => {
  mockServer.use(
    http.get(
      `http://pertexo.test/v1/workspaces/${scope.workspaceId}/workflows/${workflowId}/versions`,
      () => HttpResponse.error(),
    ),
  );
  const { event, change } = await open('{}');
  await event.click(screen.getByRole('button', { name: 'Use file' }));
  await screen.findByText(/workflow input could not be checked/u);
  expect(change).not.toHaveBeenCalled();
});

function version(callable = false, wait?: Promise<void>) {
  mockServer.use(
    http.get(
      `http://pertexo.test/v1/workspaces/${scope.workspaceId}/workflows/${workflowId}/versions`,
      async () => {
        await wait;
        return HttpResponse.json({
          items: [
            {
              id: versionId,
              workflowId,
              versionNumber: 1,
              publishedAt: '2026-10-14T12:00:00.000Z',
              checksum: `wf:sha256:${'a'.repeat(64)}`,
              graphDigest: 'f'.repeat(64),
              graph: {
                nodes: [],
                edges: [],
                settings: {},
                ...(callable
                  ? {
                      callable: {
                        input: {
                          type: 'object',
                          properties: [
                            {
                              name: 'file',
                              required: true,
                              valueType: { type: 'string' },
                            },
                          ],
                        },
                        resultType: { type: 'null' },
                        result: { kind: 'literal', value: null },
                      },
                    }
                  : {}),
              },
            },
          ],
          nextCursor: null,
        });
      },
    ),
  );
}

it('inserts a finalized descriptor without losing other input properties', async () => {
  version();
  const { event, change } = await open('{"other":true}');
  await event.click(screen.getByRole('button', { name: 'Use file' }));
  await waitFor(() => {
    expect(change).toHaveBeenCalledTimes(1);
  });
  expect(JSON.parse(change.mock.calls[0]?.[0] as string)).toMatchObject({
    other: true,
    file: { kind: 'artifact', byteLength: 4 },
  });
});

it('checks the exact published contract and leaves incompatible input intact', async () => {
  version(true);
  const { event, change } = await open('{}');
  await event.click(screen.getByRole('button', { name: 'Use file' }));
  await screen.findByText(/does not match the published workflow contract/u);
  expect(change).not.toHaveBeenCalled();
});

it('locks destination consent during the contract check and cancels late insertion', async () => {
  let finish: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  version(false, wait);
  const { event, change } = await open('{}');
  await event.click(screen.getByRole('button', { name: 'Use file' }));
  await waitFor(() => {
    expect(
      screen.getByLabelText('Input property', { exact: true }),
    ).toBeDisabled();
  });
  expect(screen.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true');
  await event.click(screen.getByRole('button', { name: 'Cancel' }));
  finish?.();
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  expect(change).not.toHaveBeenCalled();
});

it('explains an expired finalization and keeps the workflow file input unchanged', async () => {
  setup();
  mockServer.use(
    http.post(
      'http://pertexo.test/v1/workspaces/:workspaceId/artifacts/:artifactId/finalize',
      () =>
        HttpResponse.json(
          {
            type: 'urn:pertexo:problem:artifact.upload_unavailable',
            title: 'Upload no longer available',
            status: 404,
            code: 'artifact.upload_unavailable',
            detail:
              'This upload expired or is no longer available. Upload the file again.',
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
          {
            status: 404,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    ),
  );
  const change = vi.fn();
  render(
    <FilePropertyUpload
      scope={scope}
      workflowId={workflowId}
      versionId={versionId}
      input="{}"
      disabled={false}
      onChange={change}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Upload file' }));
  await user.upload(screen.getByLabelText('File', { exact: true }), file());
  expect(
    await screen.findByText(
      'This upload expired or is no longer available. Upload the file again.',
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Check and retry same file' }),
  ).not.toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
});
