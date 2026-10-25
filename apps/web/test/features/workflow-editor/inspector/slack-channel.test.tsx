import { parseChannelId } from '@/features/workflow-editor/model/inspector/slack-channel';
import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  findCanvas,
  pressSave,
} from '../../../support/fixtures/editor-actions';
import { notFoundProblem } from '../../../support/fixtures/run';
import {
  slackChannelLookup,
  slackConnection,
} from '../../../support/fixtures/slack-channels';
import {
  api,
  editorHandlers,
  editorPath,
  setDefinition,
  workspace,
  workspaceId,
} from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';

type InputMappings = WorkflowGraphContract['nodes'][number]['inputMappings'];

const connectionId = '44444444-4444-4444-8444-444444444444';
const workspaceApi = `${api}/workspaces/${workspaceId}`;

const slackDefinition = {
  ...setDefinition,
  definition: { key: 'slack.send_message', version: 1 },
  family: 'action',
  configSchema: {
    type: 'object',
    properties: { timeoutMillis: { type: 'integer', title: 'Timeout' } },
  },
  connectionRequirements: ['slack_bot_token'],
  credentialRequirements: ['slack_bot_token'],
} satisfies NodeDefinitionCatalogItem;

function slackGraph(
  inputMappings: InputMappings,
  connectionRefs: Readonly<Record<string, string>> = {
    slack_bot_token: connectionId,
  },
): WorkflowGraphContract {
  return {
    nodes: [
      {
        id: 'post',
        label: 'Tell ops',
        definition: { key: 'slack.send_message', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings,
        connectionRefs,
      },
    ],
    edges: [],
    settings: {},
  };
}

async function openSlackStep(
  graph: WorkflowGraphContract,
  capabilities: readonly string[] = [
    ...workspace.capabilities,
    'connection:use',
  ],
) {
  const saved: { graph?: WorkflowGraphContract } = {};
  const lookups: string[] = [];
  mockServer.use(
    ...editorHandlers(
      (_request, body) => {
        saved.graph = body.graph;
      },
      { graph, definitions: [slackDefinition], capabilities },
    ),
    http.get(`${workspaceApi}/connections`, () =>
      HttpResponse.json({
        items: [slackConnection(workspaceId, connectionId)],
        nextCursor: null,
      }),
    ),
    slackChannelLookup(
      workspaceApi,
      {
        C0123456789: { name: 'ops-alerts' },
        C0404: { reason: 'missing_scope' },
      },
      lookups,
    ),
  );
  renderApp(editorPath);
  fireEvent.click((await findCanvas()).getByText('Tell ops'));
  const field = await screen.findByLabelText('Channel ID');
  return { field, saved, lookups, event: userEvent.setup() };
}

describe('Slack channel IDs as people type them', () => {
  it('accepts channel IDs, with or without #, and clears on empty', () => {
    expect(parseChannelId(' #C0123ABC ')).toEqual({
      ok: true,
      value: 'C0123ABC',
    });
    expect(parseChannelId('')).toEqual({ ok: true, value: undefined });
    expect(parseChannelId('ops-alerts')).toMatchObject({ ok: false });
  });
});

describe('the Slack step’s channel in Setup', { timeout: 30_000 }, () => {
  it('shows the channel’s name beside its ID once it resolves', async () => {
    const { field, lookups } = await openSlackStep(
      slackGraph({ channelId: { kind: 'literal', value: 'C0123456789' } }),
    );
    expect(field).toHaveValue('C0123456789');
    const name = document.getElementById(`${field.id}-name`);
    await waitFor(() => {
      expect(name).toHaveTextContent('#ops-alerts');
    });
    expect(field).toHaveAccessibleDescription(/#ops-alerts/u);
    expect(lookups).toEqual(['C0123456789']);
  });

  it('applies a typed ID, looks it up after the field is left, and says why a name is missing', async () => {
    const { field, saved, lookups, event } = await openSlackStep(
      slackGraph({ channelId: { kind: 'literal', value: 'C0123456789' } }),
    );
    await event.clear(field);
    await event.type(field, 'ops');
    // Typing says nothing yet; leaving the field does.
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(field);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Channel IDs start with C, G or D/u,
    );
    await event.clear(field);
    await event.type(field, '#C0404');
    await event.tab();
    expect(
      await screen.findByText(
        /Showing the channel ID\. The Slack app needs the channels:read scope/u,
      ),
    ).toBeVisible();
    // Nothing was looked up while typing.
    expect(lookups.filter((ids) => ids !== 'C0123456789')).toEqual(['C0404']);
    pressSave();
    await waitFor(() => {
      expect(saved.graph?.nodes[0]?.inputMappings).toEqual({
        channelId: { kind: 'literal', value: 'C0404' },
      });
    });
  });

  it('asks for a connection before it can show a name', async () => {
    const { lookups } = await openSlackStep(
      slackGraph({ channelId: { kind: 'literal', value: 'C0123456789' } }, {}),
    );
    expect(
      screen.getByText(
        'Choose a Slack connection above to show this channel’s name.',
      ),
    ).toBeVisible();
    expect(lookups).toEqual([]);
  });

  it.each(['passed', 'rejected', 'revoked-after-test'] as const)(
    'returns the %s setup-test health when selecting a newly added Slack connection',
    async (result) => {
      const passed = result !== 'rejected';
      let createdHere = false;
      const createdId = '55555555-5555-4555-8555-555555555555';
      const created = slackConnection(
        workspaceId,
        createdId,
        'Control Operations Slack',
      );
      const tested = passed
        ? created
        : {
            ...created,
            status: 'reauthorization_required' as const,
            health: {
              ...created.health,
              lastTestedAt: '2026-10-11T10:00:00.000Z',
              lastErrorCode: 'connection.credential_rejected',
            },
          };
      const { saved, event } = await openSlackStep(
        slackGraph(
          { channelId: { kind: 'literal', value: 'C0123456789' } },
          {},
        ),
        [...workspace.capabilities, 'connection:use', 'connection:manage'],
      );
      mockServer.use(
        http.post(`${workspaceApi}/connections`, () => {
          createdHere = true;
          return HttpResponse.json(created, { status: 201 });
        }),
        ...(result === 'revoked-after-test'
          ? [
              http.get(`${workspaceApi}/connections`, () =>
                HttpResponse.json({
                  items: [
                    slackConnection(workspaceId, connectionId),
                    ...(createdHere ? [{ ...created, status: 'revoked' }] : []),
                  ],
                  nextCursor: null,
                }),
              ),
            ]
          : []),
        http.post(`${workspaceApi}/connections/${createdId}/test`, () =>
          HttpResponse.json({
            connection: tested,
            outcome: passed
              ? { ok: true, httpStatus: 200, errorCode: null }
              : {
                  ok: false,
                  httpStatus: 401,
                  errorCode: 'connection.credential_rejected',
                },
          }),
        ),
      );
      await event.click(
        screen.getByRole('button', { name: 'New Slack connection' }),
      );
      const lens = within(await screen.findByRole('dialog'));
      expect(lens.getByText('Connect Slack')).toBeVisible();
      await event.type(
        lens.getByLabelText('Slack bot token'),
        'xoxb-1234567890-secret',
      );
      await event.click(lens.getByRole('button', { name: 'Continue' }));
      await event.click(lens.getByRole('button', { name: 'Save and test' }));
      expect(
        await lens.findByText(
          passed ? 'Slack accepted the token.' : 'Slack rejected the token.',
        ),
      ).toBeVisible();
      await event.click(lens.getByRole('button', { name: 'Done' }));

      expect(
        await screen.findByText(
          passed
            ? 'Connected Control Operations Slack'
            : 'Saved Control Operations Slack',
        ),
      ).toBeVisible();
      expect(screen.queryByText('Connect Slack')).toBeNull();
      await waitFor(() => {
        expect(screen.getByLabelText('Slack connection')).toHaveTextContent(
          result === 'passed'
            ? 'Control Operations Slack'
            : 'A connection that’s no longer active',
        );
      });
      pressSave();
      await waitFor(() => {
        expect(saved.graph?.nodes[0]?.connectionRefs).toEqual({
          slack_bot_token: createdId,
        });
      });
    },
  );

  it('offers no connection in place while connections are unavailable', async () => {
    const lookups: string[] = [];
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: slackGraph({
          channelId: { kind: 'literal', value: 'C0123456789' },
        }),
        definitions: [slackDefinition],
        capabilities: [
          ...workspace.capabilities,
          'connection:use',
          'connection:manage',
        ],
      }),
      slackChannelLookup(
        workspaceApi,
        { C0123456789: { name: 'ops-alerts' } },
        lookups,
      ),
    );
    // A local API without connection encryption has no connection routes.
    mockServer.use(http.get(`${workspaceApi}/connections`, notFoundProblem));
    renderApp(editorPath);
    fireEvent.click((await findCanvas()).getByText('Tell ops'));

    expect(await screen.findByLabelText('Slack connection')).toBeVisible();
    expect(await screen.findByLabelText('Channel ID')).toHaveValue(
      'C0123456789',
    );
    expect(
      screen.queryByRole('button', { name: 'New Slack connection' }),
    ).toBeNull();
    expect(lookups).toEqual([]);
  });

  it('leaves a channel from another source to the Inputs tab', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: slackGraph({
          channelId: { kind: 'run_input', path: '$.channel' },
        }),
        definitions: [slackDefinition],
      }),
    );
    renderApp(editorPath);
    fireEvent.click((await findCanvas()).getByText('Tell ops'));
    const setup = await screen.findByRole('tabpanel', { name: 'Setup' });
    expect(
      within(setup).getByText(/comes from another source on the Inputs tab/u),
    ).toBeVisible();
    expect(within(setup).queryByLabelText('Channel ID')).toBeNull();
  });
});
