import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { apiProblemSchema } from '@pertexo/contracts';
import { FormResponse } from '@/features/forms/components/response';
import type { FormUploadTarget } from '@/features/forms/data/uploads.api';
import { ApiError } from '@/lib/api/error';
import { fields, file, storeAccepts, target, stubWebCrypto } from './fixture';

stubWebCrypto();

function uploadRefusal(code: string, detail: string): ApiError {
  return new ApiError({
    kind: 'problem',
    message: 'refused',
    status: 429,
    problem: apiProblemSchema.parse({
      type: `urn:pertexo:problem:${code}`,
      title: 'Upload refused',
      status: 429,
      code,
      detail,
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
  });
}

it('tells a responder over the per-response cap to reload, with no Retry', async () => {
  storeAccepts();
  const begin = vi
    .fn<FormUploadTarget['begin']>()
    .mockRejectedValue(
      uploadRefusal(
        'form.upload_limit',
        'This response has started too many uploads. Reload the form to start again.',
      ),
    );
  render(
    <FormResponse
      fields={fields}
      uploads={target({ begin })}
      onSubmit={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText('Invoice'), file('a.pdf'));
  const rows = await screen.findByRole('list', { name: 'Invoice files' });
  expect(
    await within(rows).findByText(/Reload the form to start again\./u),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Retry a.pdf' }),
  ).not.toBeInTheDocument();
});

// web-app-13: a busy public upload allowance is temporary, so the row offers Retry.
it.fails(
  'lets a responder retry a file once a busy upload allowance frees up',
  async () => {
    storeAccepts();
    const begin = vi
      .fn<FormUploadTarget['begin']>()
      .mockRejectedValueOnce(
        uploadRefusal(
          'form.upload_busy',
          'This form is receiving a lot of files right now. Try again in a few minutes.',
        ),
      )
      .mockImplementation(target().begin);
    render(
      <FormResponse
        fields={fields}
        uploads={target({ begin })}
        onSubmit={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('Invoice'), file('a.pdf'));
    const rows = await screen.findByRole('list', { name: 'Invoice files' });
    expect(
      await within(rows).findByText(/Try again in a few minutes\./u),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry a.pdf' }));
    await screen.findByText('a.pdf attached.');
  },
);
