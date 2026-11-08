import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import {
  addStepButton,
  findCanvas,
} from '../../support/fixtures/editor-actions';
import {
  editorHandlers,
  editorPath,
  workflowApi,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

it('shows every safe draft-validation refusal and keeps the local step available for correction', async () => {
  mockServer.use(...editorHandlers(() => undefined));
  mockServer.use(
    http.get(`${workflowApi}/comments`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.put(`${workflowApi}/draft`, () =>
      HttpResponse.json(
        {
          type: 'urn:pertexo:problem:workflow.invalid',
          title: 'Invalid draft',
          status: 422,
          code: 'workflow.invalid',
          requestId: 'save-invalid',
          detail: 'PRIVATE_UNRECOGNIZED_DETAIL',
          errors: [
            {
              path: 'nodes.set.config.value',
              code: 'invalid_value',
              message: 'Choose a valid field value.',
            },
            {
              path: 'nodes.set.inputMappings.rate',
              code: 'missing_variable',
              message: 'Workspace variable RATE does not exist.',
            },
          ],
        },
        {
          status: 422,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
  );
  renderApp(editorPath);
  await findCanvas();
  await userEvent.setup().click(addStepButton(/Set fields/u));
  expect(
    await screen.findByText(
      'Choose a valid field value. Workspace variable RATE does not exist.',
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      'Correct the step setup to save your draft. Your changes are kept here.',
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Retry' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText('PRIVATE_UNRECOGNIZED_DETAIL'),
  ).not.toBeInTheDocument();
  const label = await screen.findByLabelText('Label');
  await userEvent.setup().clear(label);
  await userEvent.setup().type(label, 'Retained local step');
  expect(label).toHaveValue('Retained local step');
});
