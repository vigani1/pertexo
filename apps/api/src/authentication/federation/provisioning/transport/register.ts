import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DirectoryError,
  DIRECTORY_LIMITS,
  type DirectoryPrincipal,
  type DirectoryStore,
} from '@pertexo/database/tenant-access';
import {
  AbuseRateLimitPolicy,
  type RateLimitEndpointClass,
  type RateLimitSubject,
} from '@pertexo/rate-limit';
import type { RateLimitConsumer } from '../../../../platform/rate-limit/admission.js';
import { dispatchDirectoryRequest } from './dispatch.js';
import { directoryFailure, sendDirectoryError } from './errors.js';

const parameters = z.object({
  organizationId: z.uuid(),
  '*': z.string().max(2048),
});
const policy = new AbuseRateLimitPolicy();
export function registerDirectoryTransport(
  fastify: FastifyInstance,
  input: Readonly<{
    store: DirectoryStore;
    rateLimitConsumer: RateLimitConsumer;
    publicOrigin: string;
  }>,
): void {
  fastify.register((scoped, _options, done) => {
    const jsonParser = scoped.getDefaultJsonParser('error', 'error');
    scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser<string>(
      ['application/scim+json', 'application/json'],
      { parseAs: 'string', bodyLimit: DIRECTORY_LIMITS.requestBytes },
      (request, body, done) => {
        if (request.method === 'DELETE' && body === '') {
          done(null, undefined);
          return;
        }
        return jsonParser(request, body, done);
      },
    );
    scoped.setErrorHandler((error, _request, reply) => {
      directoryFailure(reply, error);
    });
    const principals = new WeakMap<
      FastifyRequest,
      Readonly<{ principal: DirectoryPrincipal; path: string }>
    >();
    async function admit(
      endpoint: RateLimitEndpointClass,
      subject: RateLimitSubject,
      reply: Parameters<typeof sendDirectoryError>[0],
    ): Promise<boolean> {
      try {
        const result = await input.rateLimitConsumer.consume(
          policy.evaluate(endpoint, subject),
        );
        if (result.allowed) return true;
        reply.header(
          'retry-after',
          String(Math.max(1, result.retryAfterSeconds)),
        );
        sendDirectoryError(
          reply,
          429,
          'Too many provisioning requests. Retry after the indicated delay.',
        );
      } catch {
        reply.header('retry-after', '1');
        sendDirectoryError(
          reply,
          503,
          'Provisioning admission is temporarily unavailable.',
        );
      }
      return false;
    }
    scoped.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/v1/auth/federation/scim/:organizationId/v2/*',
      bodyLimit: DIRECTORY_LIMITS.requestBytes,
      config: { rateLimit: 'directory_provisioning' },
      onRequest: async (request, reply) => {
        reply
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer');
        if (
          !(await admit(
            'automation_authentication',
            { clientAddress: request.ip },
            reply,
          ))
        )
          return;
        const parsed = parameters.safeParse(request.params),
          authorization = request.headers.authorization;
        const match =
          typeof authorization === 'string'
            ? /^Bearer ([A-Za-z0-9_-]{43})$/iu.exec(authorization)
            : null;
        if (!parsed.success || match?.[1] === undefined)
          throw new DirectoryError('unauthorized');
        const principal = await input.store.authenticate(
          parsed.data.organizationId,
          createHash('sha256').update(match[1]).digest('hex'),
        );
        if (
          !(await admit(
            'directory_provisioning',
            { workspaceId: principal.controlWorkspaceId },
            reply,
          ))
        )
          return;
        if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
          const mediaType = request.headers['content-type']
            ?.split(';')[0]
            ?.trim()
            .toLowerCase();
          if (
            mediaType !== 'application/scim+json' &&
            mediaType !== 'application/json'
          ) {
            sendDirectoryError(
              reply,
              415,
              'Use application/scim+json or application/json.',
            );
            return;
          }
        }
        principals.set(request, { principal, path: parsed.data['*'] });
      },
      handler: async (request, reply) => {
        const context = principals.get(request);
        if (context === undefined) throw new DirectoryError('unauthorized');
        await dispatchDirectoryRequest(request, reply, {
          ...context,
          store: input.store,
          publicOrigin: new URL(input.publicOrigin).origin,
        });
      },
    });
    done();
  });
}
