import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function startCuratedCutoverApi(artifact, apiUrl, redisUrl) {
  const child = fork(
    fileURLToPath(
      new URL('./curated-cutover-api-process.mjs', import.meta.url),
    ),
    [artifact.source, apiUrl, redisUrl],
    { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const diagnostics = [];
  child.stdout.on('data', (chunk) => diagnostics.push(chunk));
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  let closed = false;
  const pending = new Map();
  let resolveListening, rejectListening;
  const listening = new Promise((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      closed = true;
      resolve({ code, signal });
      rejectListening(
        new Error(
          `Owned API exited before listening: ${Buffer.concat(diagnostics).toString('utf8').slice(-3000)}`,
        ),
      );
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Owned API process exited'));
      }
      pending.clear();
    }),
  );
  child.on('message', (message) => {
    if (message.phase === 'listening') resolveListening(message);
    else if (message.phase === 'startup-failed')
      rejectListening(new Error(`Owned API startup failed: ${message.error}`));
    else if (pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message.result);
    }
  });
  function control(operation, extra = {}) {
    if (closed)
      return Promise.reject(new Error('Owned API process already closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Owned API ${operation} control timed out`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, operation, ...extra });
    });
  }
  async function waitExit(milliseconds) {
    let exitTimer;
    try {
      return await Promise.race([
        exited,
        new Promise((_, reject) => {
          exitTimer = setTimeout(
            () => reject(new Error('Owned API exit deadline exceeded')),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(exitTimer);
    }
  }
  async function terminateOwned() {
    if (closed) return;
    child.kill('SIGTERM');
    try {
      await waitExit(5000);
    } catch {
      child.kill('SIGKILL');
      await waitExit(5000);
    }
  }
  let timer;
  try {
    const ready = await Promise.race([
      listening,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned API startup exceeded30s')),
          30_000,
        );
      }),
    ]);
    return {
      ...ready,
      control,
      async close() {
        if (closed) return;
        try {
          await control('close');
          const result = await waitExit(10000);
          if (result.code !== 0)
            throw new Error(`Owned API exit was ${String(result.code)}`);
        } catch (error) {
          await terminateOwned();
          throw error;
        }
      },
    };
  } catch (error) {
    await terminateOwned();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
