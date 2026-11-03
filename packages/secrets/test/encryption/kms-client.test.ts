import { createServer } from 'node:http';
import { once } from 'node:events';
import { GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { afterEach, expect, it, vi } from 'vitest';
import { createBoundedKmsClient } from '../../src/encryption/kms-client.js';
import { createAwsConnectionEnvelopeEncryption } from '../../src/server.js';

afterEach(() => vi.unstubAllEnvs());

async function endpoint(
  answer: (target: string) => { status: number; body: object },
) {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic-access');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  const requests: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const target = String(request.headers['x-amz-target']);
      requests.push(target);
      const result = answer(target);
      response.writeHead(result.status, {
        'content-type': 'application/x-amz-json-1.1',
      });
      response.end(JSON.stringify(result.body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('KMS endpoint missing');
  return {
    requests,
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      ),
  };
}

it('bounds real SDK retries when KMS remains unavailable', async () => {
  const service = await endpoint(() => ({
    status: 500,
    body: { __type: 'KMSInternalException', message: 'synthetic unavailable' },
  }));
  const client = createBoundedKmsClient({
    region: 'us-east-1',
    endpoint: service.url,
  });
  try {
    await expect(
      client.send(
        new GenerateDataKeyCommand({ KeyId: 'alias/test', KeySpec: 'AES_256' }),
      ),
    ).rejects.toMatchObject({ name: 'KMSInternalException' });
    expect(service.requests).toEqual([
      'TrentService.GenerateDataKey',
      'TrentService.GenerateDataKey',
    ]);
  } finally {
    client.destroy();
    await service.close();
  }
});

it('round trips a connection envelope through the real SDK transport and releases its sockets', async () => {
  const key = Buffer.alloc(32, 5).toString('base64');
  const service = await endpoint(() => ({
    status: 200,
    body: {
      Plaintext: key,
      CiphertextBlob: Buffer.from('wrapped-key').toString('base64'),
      KeyId: 'alias/test',
    },
  }));
  const runtime = createAwsConnectionEnvelopeEncryption({
    region: 'us-east-1',
    keyReference: 'alias/test',
    endpoint: service.url,
  });
  try {
    const context = {
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      secretVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    };
    const plaintext = Buffer.from('connection secret');
    const sealed = await runtime.encryption.seal(plaintext, context);
    expect(
      Buffer.from(await runtime.encryption.open(sealed, context)).toString(),
    ).toBe('connection secret');
    expect(service.requests).toEqual([
      'TrentService.GenerateDataKey',
      'TrentService.Decrypt',
    ]);
  } finally {
    runtime.close();
    await service.close();
  }
});

it('cancels a real SDK request while KMS holds its response', async () => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic-access');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-secret');
  let arrived: () => void = () => undefined;
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = createServer((request) => {
    request.resume();
    arrived();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('KMS endpoint missing');
  const client = createBoundedKmsClient({
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${String(address.port)}`,
  });
  const controller = new AbortController();
  const result = client.send(
    new GenerateDataKeyCommand({ KeyId: 'alias/test', KeySpec: 'AES_256' }),
    { abortSignal: controller.signal },
  );
  try {
    await requested;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

it('times out an unresponsive KMS endpoint within the configured two-attempt request budget', async () => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic-access');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-secret');
  let requests = 0;
  const server = createServer((request) => {
    request.resume();
    requests += 1;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('KMS endpoint missing');
  const client = createBoundedKmsClient({
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${String(address.port)}`,
  });
  const started = performance.now();
  try {
    await expect(
      client.send(
        new GenerateDataKeyCommand({ KeyId: 'alias/test', KeySpec: 'AES_256' }),
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(requests).toBe(2);
    expect(performance.now() - started).toBeLessThan(25_000);
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
}, 30_000);
