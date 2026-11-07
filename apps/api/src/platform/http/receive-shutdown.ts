import type { Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';

export function registerReceiveShutdown(
  fastify: FastifyInstance,
  timeoutMillis: number,
): void {
  const receiving = new Map<
    Socket,
    { request?: IncomingMessage; deadline: number }
  >();
  const server = fastify.server;
  server.on('connection', (socket) => {
    receiving.set(socket, { deadline: Date.now() + timeoutMillis });
    socket.prependListener('data', () => {
      if (receiving.get(socket)?.request?.complete)
        receiving.set(socket, {
          deadline: Date.now() + timeoutMillis,
        });
    });
    socket.once('close', () => receiving.delete(socket));
  });
  server.on('request', (request) => {
    const state = receiving.get(request.socket);
    if (state !== undefined) state.request = request;
  });
  fastify.addHook('preClose', (done) => {
    // Node stops receive-timeout checks during close; finished requests still drain.
    const timers: NodeJS.Timeout[] = [];
    for (const [socket, state] of receiving) {
      if (state.request?.complete) continue;
      const timer = setTimeout(
        () => {
          if (!receiving.get(socket)?.request?.complete) socket.destroy();
        },
        Math.max(0, state.deadline - Date.now()),
      );
      timer.unref();
      timers.push(timer);
    }
    server.once('close', () => {
      timers.forEach(clearTimeout);
    });
    done();
  });
}
