import { http, HttpResponse } from 'msw';
import { File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, vi } from 'vitest';
import { formFieldsSchema } from '@pertexo/workflow-model';
import type { FormUploadTarget } from '@/features/forms/data/uploads.api';
import { mockServer } from '../../../support/mock-server';

export const store =
  'https://objects.example.test/form-upload?X-Amz-Signature=synthetic';
export const fields = formFieldsSchema.parse([
  {
    id: 'invoice-field',
    name: 'invoice',
    label: 'Invoice',
    type: 'file',
    accept: ['documents'],
    maxFiles: 2,
  },
]);

/** Uploads hash files with Node's Web Crypto. */
export function stubWebCrypto() {
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

export function file(
  name: string,
  content = '%PDF-1.7\n',
  size?: number,
): File {
  // Undici needs Node’s native Blob; the DOM-only properties are unused here.
  return new NodeFile(
    [size === undefined ? content : new Uint8Array(size)],
    name,
  ) as unknown as File;
}

export function target(
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

export function storeAccepts(
  onPut: () => Promise<void> = () => Promise.resolve(),
) {
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
