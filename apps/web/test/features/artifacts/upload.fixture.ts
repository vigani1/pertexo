import { createApiClient } from '@/lib/api/client';
import { http, HttpResponse } from 'msw';
import { File as NodeFile } from 'node:buffer';
import { expect } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const artifactId = '55555555-5555-4555-8555-555555555555';
export const path = `http://pertexo.test/v1/workspaces/${workspaceId}/artifacts`;
const store = 'https://objects.example.test/input?X-Amz-Signature=synthetic';
export const scope = {
  apiClient: createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  }),
  userId: 'owner',
  workspaceId,
};
export const bytes = new Uint8Array([0, 255, 128, 13]);
const sha256 =
  'c8c26b651dbe99be5e3b2e8ae1db95b156ee60f993035661cc548a81cc6ea632';

export function file(size = bytes.length): File {
  // Undici needs Node’s native Blob; bridge the DOM-only directory property in this test seam.
  return /* Undici needs Node’s native Blob; only the DOM directory property is absent from this File. */ new NodeFile(
    [size === bytes.length ? bytes : new Uint8Array(size)],
    'opaque.bin',
  ) as unknown as File;
}
export function setup(
  options: {
    lostPut?: boolean;
    unavailable?: boolean;
    tooLarge?: boolean;
    lostBegin?: boolean;
    lostFinalize?: boolean;
    missingPut?: boolean;
  } = {},
) {
  const keys: (string | null)[] = [];
  let puts = 0;
  let finalizes = 0;
  let finalized = false;
  let digest = sha256;
  const metadata = (status: 'pending' | 'available') => ({
    id: artifactId,
    workspaceId,
    byteLength: bytes.length,
    mediaType: 'application/octet-stream',
    sha256: digest,
    status,
    createdAt: new Date().toISOString(),
    expiresAt:
      status === 'available'
        ? null
        : new Date(Date.now() + 900_000).toISOString(),
  });
  mockServer.use(
    http.post(`${path}/uploads`, async ({ request }) => {
      keys.push(request.headers.get('idempotency-key'));
      if (options.tooLarge)
        return HttpResponse.json(
          {
            type: 'urn:pertexo:problem:artifact.too_large',
            title: 'File too large',
            status: 413,
            code: 'artifact.too_large',
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
          {
            status: 413,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      if (options.unavailable)
        return HttpResponse.json(
          {
            type: 'urn:pertexo:problem:artifact.unavailable',
            title: 'Unavailable',
            status: 503,
            code: 'artifact.unavailable',
            detail: 'File storage is disabled on this server.',
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
          {
            status: 503,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      const body = (await request.json()) as { sha256: string };
      digest = body.sha256;
      if (options.lostBegin && keys.length === 1) return HttpResponse.error();
      return HttpResponse.json({
        artifact: metadata('pending'),
        upload: {
          method: 'PUT',
          url: store,
          headers: {
            'Content-Length': String(bytes.length),
            'Content-Type': 'application/octet-stream',
            'If-None-Match': '*',
          },
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          expiresInSeconds: 600,
        },
        replayed: keys.length > 1,
      });
    }),
    http.put('https://objects.example.test/input', async ({ request }) => {
      puts++;
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
      expect(request.credentials).toBe('omit');
      expect(request.redirect).toBe('error');
      expect(request.headers.has('cookie')).toBe(false);
      expect(request.headers.has('x-csrf-token')).toBe(false);
      expect(request.headers.has('content-length')).toBe(false);
      return (options.lostPut || options.missingPut) && puts === 1
        ? HttpResponse.error()
        : new HttpResponse(null);
    }),
    http.get(`${path}/${artifactId}`, () =>
      HttpResponse.json(metadata(finalized ? 'available' : 'pending')),
    ),
    http.post(`${path}/${artifactId}/finalize`, () => {
      finalizes++;
      if (options.missingPut && puts === 1)
        return HttpResponse.json(
          {
            type: 'urn:pertexo:problem:artifact.conflict',
            title: 'Conflict',
            status: 409,
            code: 'artifact.conflict',
            requestId: 'request-fixture',
          },
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      finalized = true;
      if (options.lostFinalize && finalizes === 1) return HttpResponse.error();
      return HttpResponse.json(metadata('available'));
    }),
  );
  return { keys, counts: () => ({ puts, finalizes }), metadata };
}
