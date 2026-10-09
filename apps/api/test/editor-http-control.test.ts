import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createEditorHttpControl } from './support/editor-http-control.js';
import {
  httpEvidenceSchema,
  httpEffectsSchema,
  submittedHttpEvidenceIds,
  verifyHttpEvidence,
} from './support/editor-http-evidence.js';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close();
});

it('failed qualification retains only submitted IDs without a verified success or sensitive material', async () => {
  const secret = `Bearer ${randomUUID()}`;
  const submitted = {
    workspaceId: randomUUID(),
    workflowId: randomUUID(),
    workflowVersionId: randomUUID(),
    triggerId: randomUUID(),
    connectionId: randomUUID(),
    trueRunId: randomUUID(),
    falseRunId: randomUUID(),
    senderKey: randomUUID(),
    falseKey: randomUUID(),
    publishKey: randomUUID(),
    provisionKey: randomUUID(),
    webhookId: 'webhook',
    validateId: 'validate',
    mapId: 'map',
    conditionId: 'condition',
    httpId: 'http',
    authorization: secret,
    requestBody: secret,
  };
  const records = [
    { state: 'submitted/unverified', ids: submittedHttpEvidenceIds(submitted) },
  ];
  const database = new Pool({ host: '127.0.0.1', port: 1 });
  const query = vi.spyOn(database, 'query');
  try {
    // Invalid effect evidence rejects before SQL; no service connection opens.
    await expect(
      verifyHttpEvidence(database, submitted, {
        phase: 'controlled-http-effects',
        requests: 0,
        effects: 0,
        bodyHashes: [],
      }),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]?.ids ?? {}).sort()).toEqual([
      'connectionId',
      'falseRunId',
      'triggerId',
      'trueRunId',
      'workflowId',
      'workflowVersionId',
      'workspaceId',
    ]);
    expect(JSON.stringify(records).includes(secret)).toBe(false);
    expect(records.some(({ state }) => state === 'verified')).toBe(false);
  } finally {
    query.mockRestore();
    await database.end();
  }
});
async function controlFixture() {
  const credential = `Bearer ${randomUUID()}`;
  const database = vi.fn(() => {
    throw new Error(credential);
  });
  const control = createEditorHttpControl(
    database,
    credential,
    () => undefined,
  );
  control.setApiOrigin('http://127.0.0.1:1');
  const server = createServer((request, response) => {
    if (!control.handle(request, response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  disposers.push(async () => {
    await control.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Owned control listener unavailable');
  return {
    control,
    database,
    credential,
    origin: `http://127.0.0.1:${String(address.port)}`,
  };
}
it('private credentials are transient and disposal blocks further actions', async () => {
  const owned = await controlFixture();
  const read = await fetch(`${owned.origin}/http-credential`);
  expect(read.status).toBe(200);
  const value: unknown = await read.json();
  expect(
    typeof value === 'object' &&
      value !== null &&
      'authorizationValue' in value &&
      value.authorizationValue === owned.credential,
  ).toBe(true);
  await owned.control.close();
  const disposed = await fetch(`${owned.origin}/http-credential`);
  expect(disposed.status).toBe(400);
  expect(await disposed.text()).toBe('');
  expect(owned.database).not.toHaveBeenCalled();
});
it('invalid and database-failing sender setup cannot leak secrets or fake receipt success', async () => {
  const owned = await controlFixture();
  const invalid = await fetch(`${owned.origin}/http-invoke`, {
    method: 'POST',
    body: JSON.stringify({ signingSecret: owned.credential }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).toBe('');
  expect(owned.database).not.toHaveBeenCalled();
  expect(() => owned.control.readEvidence()).toThrow(
    'Owned HTTP evidence missing',
  );
  const failed = await controlFixture();
  const rejected = await fetch(`${failed.origin}/http-invoke`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: randomUUID(),
      workflowId: randomUUID(),
      workflowVersionId: randomUUID(),
      triggerId: randomUUID(),
      endpointKey: 'e'.repeat(43),
      signingSecret: 's'.repeat(43),
    }),
  });
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).toBe('');
  expect(failed.database).toHaveBeenCalledOnce();
  expect(() => failed.control.readEvidence()).toThrow(
    'Owned HTTP evidence missing',
  );
});
it('effect IPC and evidence reject credential fields rather than retaining arbitrary payloads', () => {
  expect(
    httpEffectsSchema.safeParse({
      phase: 'controlled-http-effects',
      requests: 1,
      effects: 1,
      bodyHashes: ['a'.repeat(64)],
    }).success,
  ).toBe(true);
  expect(
    httpEffectsSchema.safeParse({
      phase: 'controlled-http-effects',
      requests: 1,
      effects: 1,
      bodyHashes: ['a'.repeat(64)],
      authorization: 'secret',
    }).success,
  ).toBe(false);
  expect(
    httpEvidenceSchema.safeParse({
      endpointKey: 'secret',
      signingSecret: 'secret',
    }).success,
  ).toBe(false);
});
