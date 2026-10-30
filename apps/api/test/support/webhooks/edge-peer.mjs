import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise production authentication/routing; storage and admission are isolated peers.
export async function startWebhookPeer(transport) {
  const require = createRequire(resolve('apps/api/package.json'));
  const { NestFactory } = require('@nestjs/core');
  const { FastifyAdapter } = require('@nestjs/platform-fastify');
  const api = (path) =>
    import(pathToFileURL(resolve('apps/api/dist', path)).href);
  const { registerWebhookIngress, createWebhookPreflight } = await api(
    'webhooks/ingress/register.js',
  );
  const { WebhookPreflightController } = await api(
    'webhooks/authentication/preflight.controller.js',
  );
  const { WEBHOOK_PREFLIGHT } = await api('webhooks/tokens.js');
  const { RateLimitModule } = await api('platform/rate-limit/module.js');
  const adapter = new FastifyAdapter();
  const server = adapter.getInstance();
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const secret = Buffer.alloc(32, 4);
  const database = {
    async resolveVerification(keyHash) {
      const signed = keyHash === hash('a'.repeat(43));
      if (!signed && keyHash !== hash('b'.repeat(43))) return null;
      return {
        endpointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        endpointKeyHash: keyHash,
        workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        triggerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        nodeId: 'webhook',
        databaseTime: new Date(),
        authentication: signed
          ? { mode: 'signed', allowedOrigins: [] }
          : { mode: 'secret_url', allowedOrigins: ['https://caller.example'] },
        currentSecret: { id: '11111111-1111-4111-8111-111111111111' },
      };
    },
    consumeIngressLimit: () => Promise.resolve(),
    async acceptVerifiedDelivery() {
      return { runId: '99999999-9999-4999-8999-999999999999', replayed: false };
    },
    recordRejectedDelivery: () => Promise.resolve(),
    async readResponse() {
      return { state: 'pending' };
    },
  };
  const dependencies = {
    database,
    encryption: { open: async () => Buffer.from(secret) },
    checkpointFactory: () => {
      throw new Error('Transport peer must not execute work');
    },
    logger: {
      debug: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
      info: () => undefined,
      trace: () => undefined,
      warn: () => undefined,
    },
  };
  registerWebhookIngress(server, dependencies);
  server.register((scope, _options, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer' },
      (_request, body, parsed) => parsed(null, body),
    );
    scope.all('/v1/*', (request, reply) => {
      reply.hijack();
      transport(request.raw, reply.raw, request.body);
    });
    done();
  });
  // Nest requires a module class token.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class ProbeModule {}
  const application = await NestFactory.create(
    {
      module: ProbeModule,
      imports: [
        RateLimitModule.register({
          consume: async () => ({ allowed: true }),
          acquireExclusiveSlot: async () => null,
          close: async () => undefined,
        }),
      ],
      controllers: [WebhookPreflightController],
      providers: [
        {
          provide: WEBHOOK_PREFLIGHT,
          useValue: createWebhookPreflight(dependencies),
        },
      ],
    },
    adapter,
    { logger: false, bodyParser: false },
  );
  process.once('SIGTERM', () => {
    void application.close();
  });
  await application.listen(3000, '0.0.0.0');
}
