import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMillis: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('integration operation timed out'));
    }, timeoutMillis);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(
          error instanceof Error ? error : new Error('integration failed'),
        );
      },
    );
  });
}

export function openHttpEventStream(
  port: number,
  path: string,
  cookie: string,
  lastEventId: number,
): Readonly<{
  request: ClientRequest;
  started: Promise<void>;
  closed: Promise<void>;
}> {
  const started = Promise.withResolvers<undefined>();
  const closed = Promise.withResolvers<undefined>();
  let response: IncomingMessage | undefined;
  const request = httpRequest({
    host: '127.0.0.1',
    port,
    path,
    headers: {
      accept: 'text/event-stream',
      cookie,
      'last-event-id': String(lastEventId),
    },
  });
  request.once('error', (error) => {
    if (response === undefined) started.reject(error);
    closed.resolve(undefined);
  });
  request.once('response', (incoming) => {
    response = incoming;
    if (incoming.statusCode !== 200) {
      started.reject(
        new Error(
          `SSE request failed before opening: ${String(incoming.statusCode)}`,
        ),
      );
    } else {
      started.resolve(undefined);
    }
    const resolveClosed = (): void => {
      closed.resolve(undefined);
    };
    incoming.once('aborted', resolveClosed);
    incoming.once('close', resolveClosed);
    incoming.once('end', resolveClosed);
    incoming.once('error', resolveClosed);
    incoming.resume();
  });
  request.end();
  return { request, started: started.promise, closed: closed.promise };
}
