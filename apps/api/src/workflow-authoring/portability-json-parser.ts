import { BadRequestException } from '@nestjs/common';
import type { FastifyAdapter } from '@nestjs/platform-fastify';
import { parsePortableJson } from '@pertexo/workflow-model/portability-contract';

const importPath = /^\/v1\/workspaces\/[^/]+\/workflows\/import(?:\/preview)?$/;
const portablePath =
  /^\/v1\/workspaces\/[^/]+\/workflows\/(?:import(?:\/preview)?|[^/]+\/export)$/;
const MAX_PORTABLE_BYTES = 2_097_152;

/** Preserve ordinary secure JSON parsing and byte ceilings; imports alone use the bounded lexer. */
export function registerWorkflowPortabilityJsonParser(
  adapter: FastifyAdapter,
): void {
  const instance = adapter.getInstance();
  adapter.registerParserMiddleware('', false);
  const { onProtoPoisoning, onConstructorPoisoning } = instance.initialConfig;
  const ordinaryParser = instance.getDefaultJsonParser(
    onProtoPoisoning ?? 'error',
    onConstructorPoisoning ?? 'error',
  );
  instance.removeContentTypeParser('application/json');
  adapter.useBodyParser(
    'application/json',
    false,
    { bodyLimit: instance.initialConfig.bodyLimit ?? 1_048_576 },
    (request, body, done) => {
      if (
        request.method !== 'POST' ||
        !importPath.test(request.routeOptions.url ?? '')
      ) {
        void ordinaryParser(request, body.toString('utf8'), done);
        return;
      }
      try {
        parsePortableJson(
          new TextDecoder('utf-8', { fatal: true }).decode(body),
        );
        // The bounded lexer has already rejected duplicate/deep input; retain
        // Fastify's established prototype/constructor poisoning policy too.
        void ordinaryParser(request, body.toString('utf8'), done);
      } catch {
        done(new BadRequestException('The portable JSON request is invalid.'));
      }
    },
  );
  instance.addHook('onRoute', (route) => {
    if (route.method === 'POST' && importPath.test(route.url))
      route.bodyLimit = MAX_PORTABLE_BYTES;
  });
  // Include denied, malformed and pre-handler failures, not just controller success.
  instance.addHook('onSend', (request, reply, payload, done) => {
    if (portablePath.test(request.routeOptions.url ?? ''))
      reply.header('Cache-Control', 'private, no-store');
    done(null, payload);
  });
}
