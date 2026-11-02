import type { Redis } from 'ioredis';

export class RedisRunEventSubscribeError extends Error {
  public override readonly name = 'RedisRunEventSubscribeError';
  public constructor(public readonly reason: 'aborted' | 'timeout') {
    super(
      reason === 'aborted'
        ? 'Run event subscription was aborted'
        : 'Redis run event operation timed out',
    );
  }
}

export async function subscribeWithBounds(
  redis: Redis,
  channel: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new RedisRunEventSubscribeError('aborted');
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      redis.subscribe(channel).then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new RedisRunEventSubscribeError('timeout'));
        }, timeoutMs);
        onAbort = () => {
          reject(new RedisRunEventSubscribeError('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

export async function raceAbort(
  work: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(new RedisRunEventSubscribeError('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
