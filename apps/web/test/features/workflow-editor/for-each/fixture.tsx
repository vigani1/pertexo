import type { WorkflowGraphContract } from '@pertexo/contracts';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { findCanvas } from '../../../support/fixtures/editor-actions';
import {
  bodyStepDefinition,
  forEachDefinition,
} from '../../../support/fixtures/for-each';
import {
  editorHandlers,
  editorPath,
} from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';
export const definitions = [forEachDefinition, bodyStepDefinition];

export async function openEditor(
  graph: WorkflowGraphContract,
  options: Readonly<{
    strict?: boolean;
    capabilities?: readonly string[];
  }> = {},
) {
  const saved: { graph?: WorkflowGraphContract } = {};
  mockServer.use(
    ...editorHandlers(
      (_request, body) => {
        saved.graph = body.graph;
      },
      { graph, definitions, ...options },
    ),
  );
  renderApp(editorPath, options);
  const canvas = await findCanvas();
  return { canvas, saved, event: userEvent.setup() };
}

export function openByKeyboard(card: HTMLElement) {
  const node = card.closest<HTMLElement>('.react-flow__node');
  if (node === null) throw new Error('The card is not a canvas node');
  node.focus();
  fireEvent.keyDown(node, { key: 'Enter' });
  return node;
}

export function savedBody(saved: { graph?: WorkflowGraphContract }) {
  return saved.graph?.nodes.find((node) => node.id === 'loop')?.structured
    ?.body;
}
