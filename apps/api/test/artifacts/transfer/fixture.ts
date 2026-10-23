import { createHash, randomUUID } from 'node:crypto';
import {
  artifactUploadResponseSchema,
  type ArtifactUploadResponse,
} from '@pertexo/contracts';
import { describe, expect } from 'vitest';
import type { ZodType } from 'zod';

import {
  artifactTransferIntegrationEnabled,
  createArtifactTransferApiFixture,
  expectProblem,
  mutationHeaders,
  type ArtifactTransferApiFixture,
  type SessionCookies,
} from '../transfer.support.js';

export const integrationDescribe = artifactTransferIntegrationEnabled
  ? describe
  : describe.skip;

export function recordBenchmarkOperation(
  name: string,
  startedAt: number,
  population = 1,
): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION=${JSON.stringify({ name, startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population, boundary: `composed artifact ${name} request through response or stream completion` })}\n`,
  );
}

type UploadCapability = ArtifactUploadResponse['upload'];

type ProblemResponse = Parameters<typeof expectProblem>[0];

type RequestMetadata = ReturnType<typeof requestMetadata>;

type DenialCase = Readonly<{
  name: string;
  status: number;
  code: string;
  execute(
    fixture: ArtifactTransferApiFixture,
    metadata: RequestMetadata,
  ): Promise<ProblemResponse>;
}>;

export const denialCases: readonly DenialCase[] = [
  {
    name: 'unauthenticated upload',
    status: 401,
    code: 'auth.unauthenticated',
    execute: (fixture, metadata) =>
      fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        payload: metadata,
        headers: { 'idempotency-key': 'denial-unauthenticated' },
      }),
  },
  {
    name: 'missing CSRF token',
    status: 403,
    code: 'auth.forbidden',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        payload: metadata,
        headers: {
          cookie: owner.cookieHeader,
          'idempotency-key': 'denial-missing-csrf',
        },
      });
    },
  },
  {
    name: 'missing idempotency key',
    status: 400,
    code: 'request.invalid',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        payload: metadata,
        headers: { cookie: owner.cookieHeader, 'x-csrf-token': owner.csrf },
      });
    },
  },
  {
    name: 'comma-joined idempotency keys',
    status: 400,
    code: 'request.invalid',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        payload: metadata,
        headers: mutationHeaders(owner, 'denial-first,denial-second'),
      });
    },
  },
  {
    name: 'duplicate idempotency headers',
    status: 400,
    code: 'request.invalid',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        payload: metadata,
        headers: {
          cookie: owner.cookieHeader,
          'x-csrf-token': owner.csrf,
          'idempotency-key': ['denial-first', 'denial-second'],
        },
      });
    },
  },
  {
    name: 'client-selected storage key',
    status: 400,
    code: 'request.invalid',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        headers: mutationHeaders(owner, 'denial-malformed'),
        payload: { ...metadata, storageKey: 'client-chosen-key' },
      });
    },
  },
  {
    name: 'viewer upload',
    status: 404,
    code: 'resource.not_found',
    execute: async (fixture, metadata) => {
      const viewer = await fixture.login('viewer');
      return fixture.application.inject({
        method: 'POST',
        url: uploadUrl(fixture),
        headers: mutationHeaders(viewer, 'denial-viewer'),
        payload: metadata,
      });
    },
  },
  {
    name: 'cross-tenant upload',
    status: 404,
    code: 'resource.not_found',
    execute: async (fixture, metadata) => {
      const owner = await fixture.login('owner');
      return fixture.application.inject({
        method: 'POST',
        url: `/v1/workspaces/${fixture.otherWorkspaceId}/artifacts/uploads`,
        headers: mutationHeaders(owner, 'denial-wrong-tenant'),
        payload: metadata,
      });
    },
  },
  ...(['metadata', 'download', 'finalize'] as const).map(
    (operation): DenialCase => ({
      name: `cross-tenant ${operation}`,
      status: 404,
      code: 'resource.not_found',
      execute: async (fixture) => {
        const owner = await fixture.login('owner');
        const suffix = operation === 'metadata' ? '' : `/${operation}`;
        return fixture.application.inject({
          method: operation === 'finalize' ? 'POST' : 'GET',
          url: `/v1/workspaces/${fixture.otherWorkspaceId}/artifacts/${randomUUID()}${suffix}`,
          headers: mutationHeaders(owner, `denied-artifact-${operation}`),
          ...(operation === 'finalize' ? { payload: {} } : {}),
        });
      },
    }),
  ),
];

export function uploadUrl(fixture: ArtifactTransferApiFixture): string {
  return `/v1/workspaces/${fixture.workspaceId}/artifacts/uploads`;
}

export function requestMetadata(body: Uint8Array): Readonly<{
  byteLength: number;
  mediaType: string;
  sha256: string;
}> {
  return {
    byteLength: body.byteLength,
    mediaType: 'text/plain',
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

export async function begin(
  fixture: ArtifactTransferApiFixture,
  cookies: SessionCookies,
  metadata: Readonly<{
    byteLength: number;
    mediaType: string;
    sha256: string;
  }>,
): Promise<ArtifactUploadResponse> {
  const response = await fixture.application.inject({
    method: 'POST',
    url: `/v1/workspaces/${fixture.workspaceId}/artifacts/uploads`,
    headers: mutationHeaders(cookies, `begin-${randomUUID()}`),
    payload: metadata,
  });
  expect(response.statusCode, response.payload).toBe(201);
  return parseResponse(response, artifactUploadResponseSchema);
}

export async function signedPut(
  capability: UploadCapability,
  body: Uint8Array,
  headerChanges: Readonly<Record<string, string>> = {},
): Promise<Readonly<{ ok: boolean; status: number }>> {
  const response = await fetch(capability.url, {
    method: capability.method,
    body: new Uint8Array(body),
    headers: { ...capability.headers, ...headerChanges },
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  return { ok: response.ok, status: response.status };
}

export function parseResponse<T>(
  response: Readonly<{ json(): unknown }>,
  schema: ZodType<T>,
): T {
  return schema.parse(response.json());
}

export async function expectInvalidPutOrFinalization(
  fixture: ArtifactTransferApiFixture,
  owner: SessionCookies,
  uploadsUrl: string,
  artifactId: string,
  result: Readonly<{ ok: boolean; status: number }>,
  idempotencyKey: string,
): Promise<void> {
  if (!result.ok) {
    expect(result.status).toBeGreaterThanOrEqual(400);
    return;
  }

  // Some S3-compatible test services accept a changed signed header. In that
  // case the API's independent metadata/checksum verification must still
  // reject finalization and leave the reservation pending.
  const artifactsUrl = uploadsUrl.replace(/\/uploads$/u, '');
  const finalize = await fixture.application.inject({
    method: 'POST',
    url: `${artifactsUrl}/${artifactId}/finalize`,
    headers: mutationHeaders(owner, idempotencyKey),
    payload: {},
  });
  expectProblem(finalize, 409, 'artifact.conflict');
  expect((await fixture.readArtifact(artifactId))?.status).toBe('pending');
  await fixture.verificationStore.delete({
    artifactId,
    workspaceId: fixture.workspaceId,
  });
}

export let fixture!: ArtifactTransferApiFixture;

let closeFixture: (() => Promise<void>) | undefined;

export async function prepareAuthenticatedArtifactTransferHTTPFixture() {
  fixture = await createArtifactTransferApiFixture();
  closeFixture = fixture.close;
}

export async function closeAuthenticatedArtifactTransferHTTPFixture() {
  await closeFixture?.();
}
