import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it, vi } from 'vitest';
import { findCanvas } from '../../../support/fixtures/editor-actions';
import { graphWithNumericConfig } from '../../../support/fixtures/editor-graph';
import {
  editorHandlers,
  editorPath,
  numericDefinition,
  versionBody,
  versionId,
  workflowApi,
  workflowSummaryHandler,
} from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';

it('keeps an open Run menu mounted and usable across background refetches', async () => {
  const graph = graphWithNumericConfig({ requiredCount: 1 });
  mockServer.use(
    ...editorHandlers(vi.fn(), { graph, definitions: [numericDefinition] }),
  );
  mockServer.use(
    workflowSummaryHandler('Order intake', versionId),
    http.get(`${workflowApi}/versions`, () =>
      HttpResponse.json({
        items: [versionBody(versionId, graph)],
        nextCursor: null,
      }),
    ),
  );
  const { queryClient } = renderApp(editorPath, { strict: true });
  const user = userEvent.setup();
  await findCanvas();
  const trigger = await screen.findByRole('button', { name: 'Run' });
  await waitFor(() => {
    expect(trigger).toBeEnabled();
  });
  await user.click(trigger);
  const item = await screen.findByRole('menuitem', { name: 'Run with input…' });
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    expect(item).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Run with input…' })).toBe(
      item,
    );
  }
  await user.click(item);
  expect(
    await screen.findByRole('dialog', { name: 'Run with input' }),
  ).toBeVisible();
});
