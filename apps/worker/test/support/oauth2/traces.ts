import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type TraceCollector = Readonly<{
  origin: string;
  received: () => string;
  close: () => Promise<void>;
}>;

/** Exports spans soon after they end, rather than after the usual five seconds. */
export const TRACE_ENVIRONMENT = Object.freeze({
  OTEL_BSP_SCHEDULE_DELAY: '200',
});

/** Anything the services export as a trace ends up here, whole. */
export async function startTraceCollector(): Promise<TraceCollector> {
  const chunks: string[] = [];
  const server: Server = createServer((request, response) => {
    request.setEncoding('latin1');
    request.on('data', (chunk: string) => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    received: () => chunks.join(''),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
