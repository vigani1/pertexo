import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { formConfigSchema } from '@pertexo/workflow-model';
import { FormPage } from '@/features/forms/pages/published-form';
import type { FormScope } from '@/features/forms/data/forms.api';
import { createApiClient } from '@/lib/api/client';
import { createQueryClient } from '@/app/query-client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
const publicId = '11111111-1111-4111-8111-111111111111',
  versionId = '22222222-2222-4222-8222-222222222222';
const path = `http://pertexo.test/v1/forms/${publicId}`;
const form = formConfigSchema.parse({
  fields: [
    {
      id: 'channels',
      name: 'channels',
      label: 'Channels',
      type: 'multi_select',
      options: ['Email', 'SMS', 'Chat'],
      minSelections: 2,
      maxSelections: 2,
    },
  ],
});
function mount() {
  const scope: FormScope = {
    apiClient: createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    }),
    target: {
      kind: 'public',
      publicId,
      capability: 'a'.repeat(43),
      authority: 'b'.repeat(64),
    },
  };
  const cache = createQueryClient();
  render(
    <QueryClientProvider client={cache}>
      <FormPage scope={scope} />
    </QueryClientProvider>,
  );
}

it('focuses an editable selected choice after the server rejects a full multiple-choice answer', async () => {
  mockServer.use(
    http.get(path, () => HttpResponse.json({ versionId, form })),
    http.post(`${path}/submit`, () =>
      HttpResponse.json(
        {
          type: 'urn:pertexo:problem:form.invalid',
          title: 'Check the form fields',
          status: 400,
          code: 'form.invalid',
          requestId: 'choice-refusal',
          errors: [
            {
              path: 'channels',
              code: 'invalid_value',
              message: 'Review the selected channels.',
            },
          ],
        },
        {
          status: 400,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
  );
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('checkbox', { name: 'SMS' }));
  await user.click(screen.getByRole('checkbox', { name: 'Chat' }));
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  expect(
    await screen.findByText('Review the selected channels.'),
  ).toBeVisible();
  expect(screen.getByRole('checkbox', { name: 'SMS' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Chat' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'SMS' })).toHaveFocus();
});
