import type { Server } from 'node:http';

export async function listenOnLoopback(server: Server): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      server.removeListener('error', onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once('error', onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Worker transport provider listen timed out'));
    }, 5_000);
    timer.unref();
    server.listen(0, '127.0.0.1', () => {
      cleanup();
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Worker transport provider did not bind to TCP');
  return address.port;
}

export async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
