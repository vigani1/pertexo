import { createServer, connect, type Server, type Socket } from 'node:net';

export type PostgresCommitAckProxy = Readonly<{
  activeSocketCount(): number;
  connectionCount(): number;
  droppedConnectionCount(): number;
  dropNextCommitAcknowledgement(): Promise<void>;
  close(): Promise<void>;
  url: string;
}>;

interface ConnectionState {
  backend: Buffer;
  frontend: Buffer;
  startupRemaining: number | undefined;
  suppressBackend: boolean;
}

function messageLength(buffer: Buffer, offset: number): number | undefined {
  if (buffer.length < offset + 5) return undefined;
  const length = buffer.readUInt32BE(offset + 1);
  if (length < 4) throw new Error('Invalid PostgreSQL protocol frame');
  return length + 1;
}

export async function createPostgresCommitAckProxy(
  upstreamUrl: string,
): Promise<PostgresCommitAckProxy> {
  const upstream = new URL(upstreamUrl);
  const sockets = new Set<Socket>();
  let connections = 0;
  let droppedConnections = 0;
  let dropArmed = false;
  let resolveDropped: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;

  const server: Server = createServer((downstream) => {
    connections += 1;
    const target = connect({
      host: upstream.hostname,
      port: Number(upstream.port || 5432),
    });
    sockets.add(downstream);
    sockets.add(target);
    const state: ConnectionState = {
      backend: Buffer.alloc(0),
      frontend: Buffer.alloc(0),
      startupRemaining: undefined,
      suppressBackend: false,
    };

    const forget = (socket: Socket): void => {
      sockets.delete(socket);
    };
    downstream.once('close', () => {
      forget(downstream);
    });
    target.once('close', () => {
      forget(target);
    });
    downstream.once('error', () => target.destroy());
    target.once('error', () => downstream.destroy());

    downstream.on('data', (chunk: Buffer) => {
      target.write(chunk);
      state.frontend = Buffer.concat([state.frontend, chunk]);
      if (state.startupRemaining === undefined) {
        if (state.frontend.length < 4) return;
        state.startupRemaining = state.frontend.readUInt32BE(0);
      }
      if (state.frontend.length < state.startupRemaining) return;
      state.frontend = state.frontend.subarray(state.startupRemaining);
      state.startupRemaining = 0;
      while (state.frontend.length > 0) {
        const length = messageLength(state.frontend, 0);
        if (length === undefined || state.frontend.length < length) return;
        const frame = state.frontend.subarray(0, length);
        state.frontend = state.frontend.subarray(length);
        if (
          dropArmed &&
          frame[0] === 'Q'.charCodeAt(0) &&
          frame.subarray(5, -1).toString('utf8').trim().toLowerCase() ===
            'commit'
        ) {
          dropArmed = false;
          state.suppressBackend = true;
        }
      }
    });

    target.on('data', (chunk: Buffer) => {
      if (!state.suppressBackend) {
        downstream.write(chunk);
        return;
      }
      state.backend = Buffer.concat([state.backend, chunk]);
      while (state.backend.length > 0) {
        const length = messageLength(state.backend, 0);
        if (length === undefined || state.backend.length < length) return;
        const type = state.backend[0];
        state.backend = state.backend.subarray(length);
        if (type !== 'Z'.charCodeAt(0)) continue;
        droppedConnections += 1;
        resolveDropped?.();
        resolveDropped = undefined;
        downstream.destroy();
        target.destroy();
        return;
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    throw new Error('PostgreSQL acknowledgement proxy did not bind TCP');
  }
  const proxyUrl = new URL(upstreamUrl);
  proxyUrl.hostname = '127.0.0.1';
  proxyUrl.port = String(address.port);

  return Object.freeze({
    activeSocketCount: () => sockets.size,
    connectionCount: () => connections,
    droppedConnectionCount: () => droppedConnections,
    dropNextCommitAcknowledgement: () => {
      if (dropArmed || resolveDropped !== undefined)
        throw new Error('PostgreSQL acknowledgement drop is already armed');
      dropArmed = true;
      return new Promise<void>((resolve) => {
        resolveDropped = resolve;
      });
    },
    close: async () => {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        const socketClosures = [...sockets].map(
          (socket) =>
            new Promise<void>((resolve) => socket.once('close', resolve)),
        );
        for (const socket of sockets) socket.destroy();
        await Promise.all(socketClosures);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
      })();
      return closePromise;
    },
    url: proxyUrl.toString(),
  });
}
