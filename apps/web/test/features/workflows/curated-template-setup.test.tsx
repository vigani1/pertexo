import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import {
  CURATED_WORKFLOW_TEMPLATES,
  verifyCuratedTemplateManifest,
} from '@pertexo/templates';
import {
  configureTemplate,
  templateOrigin,
  templateUnavailableReasons,
} from '@/features/workflows/model/templates/curated-setup';
import { WorkflowImportDialog } from '@/features/workflows/components/portability/workflow-import-dialog';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { mockServer } from '../../support/mock-server';
import {
  api,
  catalogDefinition,
  catalogOf,
  discoveryHandlers,
  userId,
  versionId,
  workspaceWith,
} from './list/fixtures';

const first = CURATED_WORKFLOW_TEMPLATES[0];
const controlled = CURATED_WORKFLOW_TEMPLATES[2];
if (first === undefined || controlled === undefined)
  throw new Error('Missing reviewed fixtures');
const fingerprint = `wf-compat:v1:sha256:${'a'.repeat(64)}`;

function supportedCatalog() {
  const requirements = new Map(
    CURATED_WORKFLOW_TEMPLATES.flatMap(
      (template) => template.manifest.requirements.definitions,
    ).map((definition) => [definition.key, definition]),
  );
  return catalogOf(
    [...requirements.values()].map((requirement) => ({
      ...catalogDefinition(requirement.key, 'logic'),
      definition: { key: requirement.key, version: requirement.version },
      configVersion: requirement.configVersion,
    })),
  );
}

function mount() {
  mockServer.use(...discoveryHandlers());
  mockServer.use(
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json(supportedCatalog()),
    ),
  );
  const onClose = vi.fn();
  const props = {
    apiClient: createApiClient({
      fetch: testFetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
    userId,
    workspace: accessibleWorkspaceSchema.parse(
      workspaceWith(['workflow:create', 'connection:read']),
    ),
    onClose,
    onCreated: vi.fn(),
    templatesEnabled: true,
  };
  function Session() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button
          onClick={() => {
            setOpen(true);
          }}
        >
          Resume import session
        </button>
        <WorkflowImportDialog
          {...props}
          open={open}
          onClose={() => {
            setOpen(false);
          }}
        />
      </>
    );
  }
  const result = renderInRouter(<Session />);
  return { ...result, props, event: userEvent.setup() };
}

describe('Curated template setup in the existing import session', () => {
  it('retires a pending file read when selecting an example and ignores the late old file', async () => {
    let release: (bytes: ArrayBuffer) => void = () => undefined;
    const held = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    const file = new File(['pending'], 'old.json', {
      type: 'application/json',
    });
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(held);
    mockServer.use(
      http.post(`${api}/workflows/import/preview`, () =>
        HttpResponse.json({
          manifestDigest: 'b'.repeat(64),
          compatibilityFingerprint: fingerprint,
          compatible: true,
          issues: [],
          truncated: false,
          connectionSlots: [],
        }),
      ),
    );
    const { event } = mount();
    await event.upload(
      await screen.findByLabelText('Workflow JSON file'),
      file,
    );
    await screen.findByText('Reading workflow file…');
    const choose = await screen.findByRole('button', {
      name: `Set up ${first.title}`,
    });
    await waitFor(() => expect(choose).toBeEnabled());
    await event.click(choose);
    expect(
      screen.queryByText('Reading workflow file…'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Preview import' }),
    ).toBeEnabled();
    await act(async () => {
      release(
        new TextEncoder().encode(JSON.stringify(controlled.manifest)).buffer,
      );
      await held;
    });
    expect(screen.getByLabelText('New workflow name')).toHaveValue(first.title);
    expect(screen.queryByLabelText('HTTPS endpoint')).not.toBeInTheDocument();
    await event.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText(/Compatible with this workspace/u);
  });
  it('rejects unavailable exact catalog pins', () => {
    expect(templateUnavailableReasons(first, catalogOf([]))).toContain(
      'core.webhook@1 is missing from the current catalog.',
    );
    expect(templateUnavailableReasons(first, supportedCatalog())).toEqual([]);
  });

  it('changes only reviewed literals, preserves graph identity and verifies the historical basis', () => {
    const original = JSON.stringify(controlled.manifest);
    const configured = configureTemplate(controlled, [
      'https://controlled.example.test/result',
      'C123',
    ]);
    expect(configured).toBeDefined();
    if (configured === undefined)
      throw new Error('Expected valid configured manifest');
    expect(
      verifyCuratedTemplateManifest(configured, templateOrigin(controlled)).ok,
    ).toBe(true);
    expect(configured.graph.nodes.map((node) => node.id)).toEqual(
      controlled.manifest.graph.nodes.map((node) => node.id),
    );
    expect(JSON.stringify(controlled.manifest)).toBe(original);
    expect(
      configureTemplate(controlled, [
        'https://example.test/?token=secret',
        'C123',
      ]),
    ).toBeUndefined();
    expect(
      configureTemplate(controlled, ['https://example.test/', 'channel-name']),
    ).toBeUndefined();
  });

  it('requires explicit endpoint, channel and destination bindings before previewing the effectful example', async () => {
    const { event } = mount();
    const choose = await screen.findByRole('button', {
      name: `Set up ${controlled.title}`,
    });
    await waitFor(() => expect(choose).toBeEnabled());
    await event.click(choose);
    expect(screen.getByLabelText('HTTPS endpoint')).toHaveValue('');
    expect(screen.getByLabelText('HTTPS endpoint')).toHaveAccessibleDescription(
      'Curated setup requires lowercase https://, a lowercase ASCII DNS host and an explicit /path. No ports or credentials; use uppercase %HH escapes.',
    );
    expect(screen.getByLabelText('Slack channel ID')).toHaveValue('');
    expect(
      screen.getByRole('button', { name: 'Preview import' }),
    ).toBeDisabled();
    await event.type(
      screen.getByLabelText('HTTPS endpoint'),
      'https://example.test/result',
    );
    await event.type(screen.getByLabelText('Slack channel ID'), 'C123');
    expect(
      screen.getByRole('button', { name: 'Preview import' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Complete imported graph')).toHaveTextContent(
      'https://example.test/result',
    );
    expect(screen.getByLabelText('Complete imported graph')).toHaveTextContent(
      'C123',
    );
  });

  it('invalidates real preview on edits and freezes origin/body/key through dismissed uncertain recovery', async () => {
    const previews: unknown[] = [];
    const attempts: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflows/import/preview`, async ({ request }) => {
        previews.push(await request.json());
        return HttpResponse.json({
          manifestDigest: 'b'.repeat(64),
          compatibilityFingerprint: fingerprint,
          compatible: true,
          issues: [],
          truncated: false,
          connectionSlots: [],
        });
      }),
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
    const { event } = mount();
    const choose = await screen.findByRole('button', {
      name: `Set up ${first.title}`,
    });
    await waitFor(() => expect(choose).toBeEnabled());
    await event.click(choose);
    await event.click(screen.getByRole('button', { name: 'Preview import' }));
    await waitFor(() => {
      expect(previews).toHaveLength(1);
    });
    await screen.findByText(/Compatible with this workspace/u);
    await event.type(screen.getByLabelText('New workflow name'), ' edited');
    expect(
      screen.queryByText(/Compatible with this workspace/u),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    ).toBeDisabled();
    await event.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText(/Compatible with this workspace/u);
    await event.click(
      screen.getByRole('button', { name: 'Import unpublished draft' }),
    );
    await screen.findByRole('button', { name: 'Retry exact import' });
    await event.click(screen.getByRole('button', { name: 'Close' }));
    await event.click(
      screen.getByRole('button', { name: 'Resume import session' }),
    );
    await event.click(
      await screen.findByRole('button', { name: 'Retry exact import' }),
    );
    await screen.findByRole('button', { name: 'Open imported workflow' });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]?.body).toMatchObject({
      templateOrigin: templateOrigin(first),
      manifest: first.manifest,
    });
    expect(previews[0]).toMatchObject({
      templateOrigin: templateOrigin(first),
    });
    await event.click(
      screen.getByRole('button', { name: 'Start another import' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('New workflow name')).toHaveValue(''),
    );
    expect(
      screen.queryByText(/Historical origin records/u),
    ).not.toBeInTheDocument();
    expect(attempts).toHaveLength(2);
  });
});
