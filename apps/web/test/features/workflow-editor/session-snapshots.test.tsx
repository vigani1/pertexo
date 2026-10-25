import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { findCanvas, pressSave } from '../../support/fixtures/editor-actions';
import { graphWithNumericConfig } from '../../support/fixtures/editor-graph';
import {
  api,
  editorHandlers,
  editorPath,
  numericDefinition,
  userId,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

describe('editor session snapshots', { timeout: 30_000 }, () => {
  it('reads refreshed catalog fields without replacing the edited draft or selection', async () => {
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        {
          graph: graphWithNumericConfig({
            count: 4,
            requiredCount: 1,
            value: 'kept',
          }),
          definitions: [numericDefinition],
        },
      ),
    );
    const { apiClient, queryClient } = renderApp(editorPath);
    const user = userEvent.setup();
    const canvas = await findCanvas();
    fireEvent.click(canvas.getByText('Numbers'));
    await user.clear(screen.getByLabelText('Label'));
    await user.type(screen.getByLabelText('Label'), 'Kept draft label');
    await user.clear(screen.getByLabelText('Count'));
    await user.type(screen.getByLabelText('Count'), '9');
    mockServer.use(
      http.get(`${api}/node-definitions`, () =>
        HttpResponse.json({
          items: [
            {
              ...numericDefinition,
              configSchema: {
                ...numericDefinition.configSchema,
                properties: {
                  ...numericDefinition.configSchema.properties,
                  count: { type: 'number', title: 'Current count' },
                },
              },
            },
          ],
        }),
      ),
    );
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: authoringCatalogQueryOptions(apiClient, userId).queryKey,
      });
    });
    expect(await screen.findByLabelText('Current count')).toHaveValue('9');
    expect(screen.getByLabelText('Label')).toHaveValue('Kept draft label');
    expect(canvas.getByText('Kept draft label')).toBeInTheDocument();
    expect(screen.getByLabelText('Value')).toHaveValue('kept');
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes[0]?.label).toBe('Kept draft label');
      expect(saved?.nodes[0]?.config.count).toBe(9);
    });
  });
});
