import { fork } from 'node:child_process';
import { z } from 'zod';
import { fixture } from '../../calls/fixtures.js';

export async function startCallbackReceiver() {
  const child = fork(
    new URL(
      '../../../../../api/test/webhooks/callbacks/receiver.fixture.ts',
      import.meta.url,
    ),
    [],
    {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        CALLBACK_FIXTURE_DATABASE_URL: fixture.databaseUrl(fixture.apiUrl),
        CALLBACK_FIXTURE_REDIS_URL: fixture.redisUrl,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let errors = '';
  child.stderr?.on('data', (data: Buffer) => {
    errors = (errors + data.toString()).slice(-8192);
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM') resolve();
      else reject(new Error(`Callback receiver exited: ${errors}`));
    });
    child.once('error', reject);
  });
  // Observe immediately, including failures before the readiness message.
  void closed.catch(() => undefined);
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Callback receiver did not become ready.'));
      }, 10_000);
      child.on('message', (message: unknown) => {
        const ready = z.object({ origin: z.url() }).safeParse(message);
        if (ready.success) {
          clearTimeout(timer);
          resolve(ready.data.origin);
        }
      });
      void closed.then(
        () => {
          clearTimeout(timer);
          reject(new Error('Callback receiver closed before readiness.'));
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(new Error('Callback receiver failed.', { cause: error }));
        },
      );
    });
    return {
      origin,
      async close() {
        child.kill('SIGTERM');
        await closed;
      },
    };
  } catch (error) {
    child.kill('SIGTERM');
    await closed;
    throw error;
  }
}
