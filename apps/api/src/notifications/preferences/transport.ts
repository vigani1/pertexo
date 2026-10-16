import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { FastifyAdapter } from '@nestjs/platform-fastify';

const path = '/v1/notifications/unsubscribe/one-click';
const maximumBytes = 8192;
const formType = 'application/x-www-form-urlencoded';
const multipartType = 'multipart/form-data';

/** The URL capability authorizes opt-out; mail-client form contents are ignored. */
export function registerNoticeUnsubscribeTransport(
  adapter: FastifyAdapter,
): void {
  adapter.registerParserMiddleware('', false);
  const instance = adapter.getInstance();
  // Better Auth already forwards raw bytes to its own form reader. Retaining
  // them here also avoids decoding forms that the opt-out command never uses.
  instance.removeContentTypeParser(formType);
  adapter.useBodyParser(formType, false);
  adapter.useBodyParser(
    multipartType,
    false,
    { bodyLimit: maximumBytes },
    (request, body, done) => {
      if (request.method !== 'POST' || request.routeOptions.url !== path) {
        done(new UnsupportedMediaTypeException());
        return;
      }
      done(null, body);
    },
  );
  instance.addHook('onRequest', (request, _reply, done) => {
    if (
      request.method === 'POST' &&
      request.routeOptions.url === path &&
      ![formType, multipartType].includes(
        (request.headers['content-type'] ?? '')
          .split(';', 1)[0]
          ?.trim()
          .toLowerCase() ?? '',
      )
    ) {
      done(new UnsupportedMediaTypeException());
      return;
    }
    done();
  });
  instance.addHook('onRoute', (route) => {
    if (route.method === 'POST' && route.url === path)
      route.bodyLimit = maximumBytes;
  });
  instance.addHook('onSend', (request, reply, payload, done) => {
    if (request.routeOptions.url === path) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
    }
    done(null, payload);
  });
}
