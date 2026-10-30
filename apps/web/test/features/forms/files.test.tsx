import { useState } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  formFieldSchema,
  formFieldsSchema,
  type FormField,
} from '@pertexo/workflow-model';
import { apiProblemSchema } from '@pertexo/contracts';
import { FormResponse } from '@/features/forms/components/response';
import { FormFieldsEditor } from '@/features/forms/components/field-editor';
import type { FormUploadTarget } from '@/features/forms/data/uploads.api';
import { ApiError } from '@/lib/api/error';
import { mockServer } from '../../support/mock-server';

const store =
  'https://objects.example.test/form-upload?X-Amz-Signature=synthetic';
const fields = formFieldsSchema.parse([
  {
    id: 'invoice-field',
    name: 'invoice',
    label: 'Invoice',
    type: 'file',
    accept: ['documents'],
    maxFiles: 2,
  },
]);

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function file(name: string, content = '%PDF-1.7\n', size?: number): File {
  // Undici needs Node’s native Blob; the DOM-only properties are unused here.
  return new NodeFile(
    [size === undefined ? content : new Uint8Array(size)],
    name,
  ) as unknown as File;
}

function target(
  overrides: Partial<Pick<FormUploadTarget, 'begin' | 'finalize'>> = {},
) {
  let next = 0;
  const begin = vi.fn<FormUploadTarget['begin']>((request) => {
    next += 1;
    return Promise.resolve({
      upload: {
        id: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`,
        filename: request.filename,
        byteLength: request.byteLength,
        mediaType: 'application/pdf',
        status: 'pending' as const,
        expiresAt: '2026-10-26T12:15:00.000Z',
      },
      transfer: {
        method: 'PUT' as const,
        url: store,
        headers: { 'content-type': 'application/pdf' },
        expiresAt: '2026-10-26T12:15:00.000Z',
        expiresInSeconds: 900,
      },
      replayed: false,
    });
  });
  const finalize = vi.fn<FormUploadTarget['finalize']>((uploadId) =>
    Promise.resolve({
      id: uploadId,
      filename: 'invoice.pdf',
      byteLength: 9,
      mediaType: 'application/pdf',
      status: 'available' as const,
      expiresAt: '2026-10-27T12:00:00.000Z',
    }),
  );
  return {
    session: 'S'.repeat(43),
    begin: overrides.begin ?? begin,
    finalize: overrides.finalize ?? finalize,
    calls: { begin, finalize },
  };
}

function storeAccepts(onPut: () => Promise<void> = () => Promise.resolve()) {
  const puts = vi.fn();
  mockServer.use(
    http.put(store, async ({ request }) => {
      puts(request.credentials);
      await onPut();
      return new HttpResponse(null, { status: 200 });
    }),
  );
  return puts;
}

it('attaches a file through the response’s upload and sends only its upload ID', async () => {
  const puts = storeAccepts();
  const uploads = target();
  const send = vi.fn().mockResolvedValue(undefined);
  render(<FormResponse fields={fields} uploads={uploads} onSubmit={send} />);
  const user = userEvent.setup();
  const zone = screen.getByLabelText('Invoice');
  expect(zone).toHaveAccessibleDescription(
    /PDF, Word, text · up to 5 MB each · 2 files/u,
  );
  await user.upload(zone, file('invoice.pdf'));
  const row = await screen.findByRole('listitem');
  await within(row).findByText(/Attached/u);
  expect(screen.getByText('invoice.pdf attached.')).toBeInTheDocument();
  expect(uploads.calls.begin).toHaveBeenCalledWith(
    {
      fieldId: 'invoice-field',
      filename: 'invoice.pdf',
      byteLength: 9,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
    },
    expect.any(String),
    expect.any(AbortSignal),
  );
  expect(puts).toHaveBeenCalledExactlyOnceWith('omit');
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith({
      invoice: ['00000000-0000-4000-8000-000000000001'],
    });
  });
});

it('holds the response until uploads finish and says why', async () => {
  let release: () => void = () => undefined;
  storeAccepts(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const send = vi.fn().mockResolvedValue(undefined);
  render(<FormResponse fields={fields} uploads={target()} onSubmit={send} />);
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText('Invoice'), file('invoice.pdf'));
  await screen.findByText(/Sending/u);
  const submit = screen.getByRole('button', { name: 'Send response' });
  expect(submit).toBeDisabled();
  expect(submit).toHaveAccessibleDescription(
    'Waiting for files to finish uploading.',
  );
  release();
  await screen.findByText(/Attached/u);
  expect(submit).toBeEnabled();
});

it('refuses a file the question does not take before uploading, in plain words', async () => {
  const uploads = target();
  render(<FormResponse fields={fields} uploads={uploads} onSubmit={vi.fn()} />);
  const user = userEvent.setup({ applyAccept: false });
  await user.upload(screen.getByLabelText('Invoice'), [
    file('setup.exe'),
    file('scan.pdf', '', 12 * 1_048_576),
  ]);
  const rows = await screen.findByRole('list', { name: 'Invoice files' });
  expect(
    within(rows).getByText(/This field accepts PDF, Word and text files\./u),
  ).toBeVisible();
  expect(
    within(rows).getByText(/This file is 12 MB; the limit is 5 MB\./u),
  ).toBeVisible();
  expect(uploads.calls.begin).not.toHaveBeenCalled();
  // Refused files don't take a place; the response still needs one.
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  expect(await screen.findByText('Attach at least one file.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Remove setup.exe' }));
  expect(screen.queryByText('setup.exe')).not.toBeInTheDocument();
});

it('shows the server’s refusal on the row and lets a temporary failure retry', async () => {
  storeAccepts();
  const refused = new ApiError({
    kind: 'problem',
    message: 'refused',
    status: 415,
    problem: {
      type: 'urn:pertexo:problem:form.file_type_not_allowed',
      title: 'File type not allowed',
      status: 415,
      code: 'form.file_type_not_allowed',
      detail:
        'This file’s contents don’t match its .pdf name. Choose the original file.',
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  });
  const finalize = vi
    .fn<FormUploadTarget['finalize']>()
    .mockRejectedValueOnce(refused)
    .mockRejectedValueOnce(new ApiError({ kind: 'network', message: 'lost' }))
    .mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      filename: 'b.pdf',
      byteLength: 9,
      mediaType: 'application/pdf',
      status: 'available',
      expiresAt: '2026-10-27T12:00:00.000Z',
    });
  render(
    <FormResponse
      fields={fields}
      uploads={target({ finalize })}
      onSubmit={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText('Invoice'), file('a.pdf'));
  const rows = await screen.findByRole('list', { name: 'Invoice files' });
  expect(
    await within(rows).findByText(/contents don’t match its \.pdf name/u),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Retry a.pdf' }),
  ).not.toBeInTheDocument();
  await user.upload(screen.getByLabelText('Invoice'), file('b.pdf'));
  await within(rows).findByText(/Check your connection and retry/u);
  await user.click(screen.getByRole('button', { name: 'Retry b.pdf' }));
  await screen.findByText('b.pdf attached.');
});

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

it('takes only as many files as the question allows', async () => {
  storeAccepts();
  render(
    <FormResponse fields={fields} uploads={target()} onSubmit={vi.fn()} />,
  );
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText('Invoice'), [
    file('one.pdf'),
    file('two.pdf'),
    file('three.pdf'),
  ]);
  expect(
    await screen.findByText(
      'One file was left out: this question takes up to 2.',
    ),
  ).toBeVisible();
  await screen.findByText('All 2 files attached');
  expect(screen.getByLabelText('Invoice')).toBeDisabled();
});

it('counts files from both of two quick drops', async () => {
  storeAccepts();
  render(
    <FormResponse fields={fields} uploads={target()} onSubmit={vi.fn()} />,
  );
  const zone = screen.getByLabelText('Invoice').closest('[data-slot]');
  if (zone === null) throw new Error('No drop zone');
  // Both drops land before React renders the first one.
  act(() => {
    fireEvent.drop(zone, {
      dataTransfer: { files: [file('one.pdf'), file('two.pdf')] },
    });
    fireEvent.drop(zone, { dataTransfer: { files: [file('three.pdf')] } });
  });
  expect(
    within(screen.getByRole('list', { name: 'Invoice files' }))
      .getAllByRole('listitem')
      .map((row) => within(row).getByText(/\.pdf$/u).textContent),
  ).toEqual(['one.pdf', 'two.pdf']);
  expect(
    screen.getByText('One file was left out: this question takes up to 2.'),
  ).toBeVisible();
  await screen.findByText('All 2 files attached');
});

it('keeps focus in the field when a file is removed', async () => {
  storeAccepts();
  render(
    <FormResponse fields={fields} uploads={target()} onSubmit={vi.fn()} />,
  );
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText('Invoice'), [
    file('one.pdf'),
    file('two.pdf'),
  ]);
  await screen.findByText('All 2 files attached');
  await user.click(screen.getByRole('button', { name: 'Remove one.pdf' }));
  expect(screen.getByRole('button', { name: 'Remove two.pdf' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(screen.getByLabelText('Invoice')).toHaveFocus();
});

it('announces an attached file once', async () => {
  storeAccepts();
  const single = formFieldsSchema.parse([{ ...fields[0], maxFiles: 1 }]);
  const { container } = render(
    <FormResponse fields={single} uploads={target()} onSubmit={vi.fn()} />,
  );
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText('Invoice'), file('invoice.pdf'));
  await screen.findByText('File attached');
  const announced = [...container.querySelectorAll('[aria-live]')]
    .map((region) => region.textContent.trim())
    .filter((text) => text !== '');
  expect(announced).toEqual(['invoice.pdf attached.']);
});

function Editor({ initial }: Readonly<{ initial: FormField }>) {
  const [list, setList] = useState<readonly FormField[]>([initial]);
  return (
    <>
      <FormFieldsEditor fields={list} onChange={setList} />
      <output data-testid="saved">{JSON.stringify(list[0])}</output>
    </>
  );
}

it('sets a file question’s kinds, count and size with tactile controls', async () => {
  render(
    <Editor
      initial={formFieldSchema.parse({
        id: 'answer',
        name: 'answer',
        label: 'Answer',
        type: 'text',
      })}
    />,
  );
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Type'), 'file');
  const saved = () =>
    JSON.parse(screen.getByTestId('saved').textContent) as Record<
      string,
      unknown
    >;
  expect(saved()).toMatchObject({
    type: 'file',
    accept: ['documents'],
    maxFiles: 1,
    maxBytes: 5_242_880,
  });
  const accepts = screen.getByRole('group', { name: 'Accepts' });
  // The last chosen kind can't be turned off.
  await user.click(within(accepts).getByRole('button', { name: 'Documents' }));
  expect(saved()).toMatchObject({ accept: ['documents'] });
  await user.click(within(accepts).getByRole('button', { name: 'Images' }));
  expect(saved()).toMatchObject({ accept: ['documents', 'images'] });
  const count = screen.getByRole('group', { name: 'Files per response' });
  expect(
    within(count).getByRole('button', { name: 'Fewer files' }),
  ).toBeDisabled();
  await user.click(within(count).getByRole('button', { name: 'More files' }));
  await user.click(within(count).getByRole('button', { name: 'More files' }));
  expect(within(count).getByText('Up to 3 files')).toBeVisible();
  const size = screen.getByRole('slider', { name: 'Largest file' });
  expect(size).toHaveAttribute('aria-valuetext', '5 MB');
  fireEvent.change(size, { target: { value: '7' } });
  expect(saved()).toMatchObject({ maxFiles: 3, maxBytes: 7 * 1_048_576 });
});
