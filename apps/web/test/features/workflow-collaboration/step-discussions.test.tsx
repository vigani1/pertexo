import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { findCanvas } from '../../support/fixtures/editor-actions';
import {
  bodyStepDefinition,
  forEachDefinition,
  orderLoopGraph,
} from '../../support/fixtures/for-each';
import {
  editorHandlers,
  editorPath,
  workflowApi,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

function thread(id: string, stepId: string | null) {
  return {
    id,
    workflowId: '00000000-0000-4000-8000-0000000000aa',
    stepId,
    stepLabel: stepId,
    status: 'open',
    revision: 1,
    createdBy: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    commentCount: 1,
    preview: 'Should this retry?',
  };
}

it('marks a step with the open discussions about it', async () => {
  mockServer.use(
    ...editorHandlers(() => undefined, {
      graph: orderLoopGraph(),
      definitions: [forEachDefinition, bodyStepDefinition],
    }),
    http.get(`${workflowApi}/comments`, () =>
      HttpResponse.json({
        items: [
          thread('10000000-0000-4000-8000-000000000001', 'loop'),
          thread('10000000-0000-4000-8000-000000000002', 'loop'),
          thread('10000000-0000-4000-8000-000000000003', null),
        ],
        nextCursor: null,
      }),
    ),
  );
  renderApp(editorPath);
  await findCanvas();
  // The canvas hides nodes until React Flow measures them, as in other card tests.
  expect(await screen.findByText('2 open discussions')).toBeInTheDocument();
});
