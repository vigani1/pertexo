import type { FastifyReply } from 'fastify';

/**
 * Hands the raw response to a server-sent event stream: private, never
 * cached or buffered by a proxy, and flushed so the client sees it open.
 */
export function prepareSseResponse(reply: FastifyReply): void {
  reply.raw.statusCode = 200;
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader(
    'Cache-Control',
    'private, no-cache, no-store, must-revalidate, max-age=0',
  );
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.hijack();
  reply.raw.flushHeaders();
}
