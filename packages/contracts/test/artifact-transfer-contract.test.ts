import { describe, expect, it } from 'vitest';
import {
  artifactTransferOpenApiDocument,
  artifactDownloadResponseSchema,
  artifactFinalizeRequestSchema,
  artifactMetadataResponseSchema,
  artifactUploadRequestSchema,
  artifactUploadResponseSchema,
} from '../src/artifact-transfer.js';

const metadata = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  byteLength: 5,
  mediaType: 'text/plain',
  sha256: 'a'.repeat(64),
  status: 'pending',
  createdAt: '2026-09-06T10:00:00.000Z',
  expiresAt: '2026-09-06T10:15:00.000Z',
};
const request = {
  byteLength: metadata.byteLength,
  mediaType: metadata.mediaType,
  sha256: metadata.sha256,
};

describe('artifact transfer public contract', () => {
  it('accepts only declared immutable upload metadata and a strict empty finalize request', () => {
    expect(artifactUploadRequestSchema.parse(request)).toEqual(request);
    for (const extra of [
      { storageKey: 'arbitrary' },
      { workspaceId: metadata.workspaceId },
      { artifactId: metadata.id },
      { purpose: 'preview' },
      { filename: '../../secret' },
      { expiresAt: metadata.expiresAt },
    ]) {
      expect(
        artifactUploadRequestSchema.safeParse({ ...request, ...extra }).success,
      ).toBe(false);
    }
    for (const byteLength of [-1, 1.5, 5 * 1024 * 1024 * 1024 + 1, '5']) {
      expect(
        artifactUploadRequestSchema.safeParse({ ...request, byteLength })
          .success,
      ).toBe(false);
    }
    expect(
      artifactUploadRequestSchema.safeParse({
        ...request,
        mediaType: 'text/plain\r\nHost:evil',
      }).success,
    ).toBe(false);
    expect(
      artifactUploadRequestSchema.safeParse({
        ...request,
        sha256: 'A'.repeat(64),
      }).success,
    ).toBe(false);
    expect(artifactFinalizeRequestSchema.parse({})).toEqual({});
    expect(artifactFinalizeRequestSchema.safeParse(request).success).toBe(
      false,
    );
  });

  it('exposes safe metadata and bounded capabilities without internal ownership or keys', () => {
    expect(artifactMetadataResponseSchema.parse(metadata)).toEqual(metadata);
    expect(
      artifactMetadataResponseSchema.safeParse({
        ...metadata,
        storageKey: 'workspaces/secret',
      }).success,
    ).toBe(false);
    const download = {
      method: 'GET',
      url: 'https://objects.example.test/signed',
      expiresAt: metadata.expiresAt,
      expiresInSeconds: 60,
    };
    expect(artifactDownloadResponseSchema.safeParse(download).success).toBe(
      true,
    );
    expect(
      artifactDownloadResponseSchema.safeParse({
        ...download,
        expiresInSeconds: 901,
      }).success,
    ).toBe(false);
    expect(
      artifactUploadResponseSchema.safeParse({
        artifact: metadata,
        replayed: false,
        upload: {
          ...download,
          method: 'PUT',
          headers: { 'if-none-match': '*' },
        },
      }).success,
    ).toBe(true);
  });

  it('documents session, CSRF, begin idempotency and no-store for all four routes', () => {
    const paths = artifactTransferOpenApiDocument.paths;
    expect(Object.keys(paths)).toHaveLength(4);
    for (const [path, item] of Object.entries(paths)) {
      const operation = 'post' in item ? item.post : item.get;
      expect(operation.security).toEqual([{ cookieSession: [] }]);
      const names = operation.parameters.map(({ name }) => name);
      expect(names).toContain('workspaceId');
      if ('post' in item) expect(names).toContain('x-csrf-token');
      expect(names.includes('Idempotency-Key')).toBe(path.endsWith('/uploads'));
      const response =
        '201' in operation.responses
          ? operation.responses['201']
          : operation.responses['200'];
      expect(response.headers['Cache-Control'].schema.const).toBe('no-store');
    }
  });

  it('never models an available artifact or missing pending deadline with a PUT capability', () => {
    const response = {
      artifact: metadata,
      replayed: true,
      upload: {
        method: 'PUT',
        url: 'https://objects.example.test/signed',
        headers: { 'if-none-match': '*' },
        expiresAt: metadata.expiresAt,
        expiresInSeconds: 60,
      },
    };
    expect(artifactUploadResponseSchema.safeParse(response).success).toBe(true);
    for (const changes of [{ status: 'available' }, { expiresAt: null }]) {
      expect(
        artifactUploadResponseSchema.safeParse({
          ...response,
          artifact: { ...metadata, ...changes },
        }).success,
      ).toBe(false);
    }
  });
});
