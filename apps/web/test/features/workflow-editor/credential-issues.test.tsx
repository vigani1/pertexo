import { editorConnectionsQueryOptions } from '@/features/connections/queries.public';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { findCanvas } from '../../support/fixtures/editor-actions';
import { slackConnection } from '../../support/fixtures/slack-channels';
import {
  api,
  editorHandlers,
  editorPath,
  etagA,
  setDefinition,
  userId,
  validHandler,
  workspaceId,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

const connectionId = '44444444-4444-4444-8444-444444444444';
const definition = {
  ...setDefinition,
  definition: { key: 'slack.send_message', version: 1 },
  connectionRequirements: ['slack_bot_token'],
};

describe('the editor issues chip’s credential readiness', () => {
  it.each(['missing', 'reauthorization_required', 'revoked'] as const)(
    'counts a %s connection, opens Setup, and clears after selecting or restoring an active credential',
    async (status) => {
      const graph = {
        nodes: [
          {
            id: 'post',
            label: 'Tell ops',
            definition: definition.definition,
            position: { x: 80, y: 80 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs:
              status === 'missing' ? {} : { slack_bot_token: connectionId },
          },
        ],
        edges: [],
        settings: {},
      };
      let current = {
        ...slackConnection(workspaceId, connectionId),
        status: status === 'missing' ? 'active' : status,
      };
      mockServer.use(
        ...editorHandlers(() => undefined, {
          graph,
          definitions: [definition],
        }),
      );
      mockServer.use(
        validHandler(undefined, etagA),
        http.get(`${api}/workspaces/${workspaceId}/connections`, () =>
          HttpResponse.json({ items: [current], nextCursor: null }),
        ),
      );
      const app = renderApp(editorPath, { strict: true });
      const event = userEvent.setup();
      await findCanvas();
      await event.click(
        await screen.findByRole('button', { name: '2 issues' }),
      );
      const fix = await screen.findByRole('button', {
        name: /Fix:.*(?:Slack|Ops bot)/u,
      });
      expect(fix).toHaveAccessibleName(
        {
          missing: 'Fix: Choose a Slack connection for this step.',
          revoked: 'Fix: Ops bot was revoked. Choose another Slack connection.',
          reauthorization_required:
            'Fix: Ops bot needs reauthorizing. Reconnect it or choose another Slack connection.',
        }[status],
      );
      await event.click(fix);
      const picker = await screen.findByLabelText('Slack connection');
      expect(picker).toBeVisible();
      if (status === 'missing') {
        await event.click(picker);
        await event.click(
          await screen.findByRole('option', { name: 'Ops bot' }),
        );
      } else {
        current = { ...current, status: 'active' };
        await app.queryClient.invalidateQueries({
          queryKey: editorConnectionsQueryOptions(
            app.apiClient,
            userId,
            workspaceId,
          ).queryKey,
        });
      }
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: '2 issues' })).toBeNull();
      });
      expect(
        await screen.findByRole('button', { name: '1 issue' }),
      ).toBeVisible();
    },
  );
});
