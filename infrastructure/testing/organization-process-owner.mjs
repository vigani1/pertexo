import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const unconfirmedChildren = new Set();

/** @typedef {{ phase: 'listening', pid: number, port: number } | { phase: 'refused', reason: 'migration-head-incompatible' | 'startup-failed' } | { id: string, result: {closed: true} | {status: 200 | 302 | 303} } | {id: string, failed: true}} OrganizationProcessReply */
/** @typedef {{id: string, operation: 'close'} | {id: string, operation: 'verify-email', email: string}} OrganizationProcessControl */

function confirmClosedGroup(child) {
  if (!child.pid) throw new Error('Unconfirmed process identity');
  try {
    process.kill(-child.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') {
      unconfirmedChildren.delete(child);
      return;
    }
    throw new Error('Unconfirmed process group shutdown');
  }
  throw new Error('Owned process group remains live: preserve resources');
}

export async function deadline(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startOrganizationApi(artifact, resources) {
  const child = fork(
    fileURLToPath(new URL('./organization-api-process.mjs', import.meta.url)),
    [artifact.source],
    {
      execArgv: [],
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        F07_PROCESS_API_URL: resources.apiUrl,
        F07_PROCESS_REDIS_URL: resources.redisUrl,
      },
    },
  );
  unconfirmedChildren.add(child);
  let exited = false;
  let readyResolve;
  let readyReject;
  const waiting = new Map();
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
      readyReject(new Error('Owned API exited before readiness'));
      for (const waiter of waiting.values())
        waiter.reject(new Error('Owned API exited'));
      waiting.clear();
    }),
  );
  child.on('error', () => readyReject(new Error('Owned API spawn failed')));
  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (
      message.phase === 'listening' &&
      message.pid === child.pid &&
      Number.isInteger(message.port) &&
      message.port > 0 &&
      message.port < 65536
    )
      readyResolve({
        phase: 'listening',
        pid: child.pid,
        url: `http://127.0.0.1:${message.port}`,
      });
    else if (
      message.phase === 'refused' &&
      ['migration-head-incompatible', 'startup-failed'].includes(message.reason)
    )
      readyResolve({ phase: 'refused', reason: message.reason });
    else if (typeof message.id === 'string' && waiting.has(message.id)) {
      const waiter = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.failed === true)
        waiter.reject(new Error('Owned API control failed'));
      else if (
        message.result?.closed === true ||
        [200, 302, 303].includes(message.result?.status)
      )
        waiter.resolve(message.result);
      else waiter.reject(new Error('Owned API control protocol invalid'));
    }
  });
  async function kill() {
    // Never signal a PID/group after reaping it: its numeric identity may be reused.
    if (!exited) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH')
          throw new Error('Owned process group kill failed');
      }
    }
    const result = await deadline(
      exit,
      10000,
      'Unconfirmed child exit: preserve owned resources',
    );
    confirmClosedGroup(child);
    return result;
  }
  async function control(operation, extra = {}) {
    if (exited) throw new Error('Owned API already exited');
    const id = randomUUID();
    try {
      return await deadline(
        new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          child.send({ id, operation, ...extra });
        }),
        10000,
        'Owned API control deadline',
      );
    } finally {
      waiting.delete(id);
    }
  }
  let state;
  try {
    state = await deadline(ready, 30000, 'Owned API readiness deadline');
  } catch (error) {
    await kill();
    throw error;
  }
  if (state.phase === 'refused') {
    await deadline(exit, 10000, 'Unconfirmed refusing child exit');
    confirmClosedGroup(child);
  }
  return {
    ...state,
    kill,
    control,
    async close() {
      if (exited) {
        confirmClosedGroup(child);
        return;
      }
      try {
        await control('close');
        await deadline(exit, 10000, 'Owned API close deadline');
        confirmClosedGroup(child);
      } catch (error) {
        await kill();
        throw error;
      }
    },
  };
}

// A failed process barrier must not be followed by DB drop or Redis lease purge.
export async function closeOrganizationQualification(
  processes,
  resources,
  artifacts,
) {
  await Promise.all(processes.map((owned) => owned.close()));
  if (unconfirmedChildren.size)
    throw new Error('Unconfirmed child shutdown: preserve owned resources');
  await resources?.close();
  await Promise.all(artifacts.map((artifact) => artifact.close()));
}
