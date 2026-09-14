import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';

import {
  describeBoundedChildFailure,
  runBoundedChildProcess,
} from '../bounded-child-process.mjs';

function positiveDuration(value, label) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function cleanupFailure(results, message) {
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (errors.length === 0) return undefined;
  if (errors.length === 1)
    return errors[0] instanceof Error
      ? errors[0]
      : new Error(message, { cause: errors[0] });
  return new AggregateError(errors, message);
}

export function preserveSmokeFailureDuringCleanup(primary, cleanupResults) {
  const cleanupError = cleanupFailure(
    cleanupResults,
    'Rendered-task smoke cleanup failed',
  );
  if (cleanupError === undefined) return;
  if (primary.failed)
    throw new AggregateError(
      [primary.error, cleanupError],
      'Rendered-task smoke failed and cleanup was incomplete',
    );
  throw cleanupError;
}

export async function runSmokeCommand(command, args, options) {
  const result = await runBoundedChildProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  if (
    result.spawnError !== undefined ||
    result.timedOut ||
    result.signal !== null ||
    result.status !== 0
  )
    throw new Error(
      describeBoundedChildFailure(options.label, result, options.timeoutMs),
    );
  return result;
}

async function runCleanups(cleanups, primary) {
  const results = await Promise.allSettled(
    cleanups.map((cleanup) => cleanup()),
  );
  preserveSmokeFailureDuringCleanup(primary, results);
}

export async function acquireOwnedResource({
  acquire,
  acquireDirectory,
  removeDirectory,
}) {
  const directory = await acquireDirectory();
  const cleanups = [() => removeDirectory(directory)];
  let closed = false;
  const owner = Object.freeze({
    directory,
    registerCleanup(cleanup) {
      if (typeof cleanup !== 'function')
        throw new TypeError('owned resource cleanup must be a function');
      cleanups.unshift(cleanup);
    },
  });
  try {
    const value = await acquire(owner);
    return Object.freeze({
      value,
      async close() {
        if (closed) return;
        await runCleanups(cleanups, { error: undefined, failed: false });
        closed = true;
      },
    });
  } catch (error) {
    await runCleanups(cleanups, { error, failed: true });
    throw error;
  }
}

export function createContainerOwner(runDocker) {
  if (typeof runDocker !== 'function')
    throw new TypeError('container owner requires a Docker adapter');
  const containerIds = new Set();
  return Object.freeze({
    async createAndStart(createArguments) {
      const nameIndex = createArguments.indexOf('--name');
      const recoveryName =
        nameIndex === -1 ? undefined : createArguments[nameIndex + 1];
      let created;
      try {
        created = await runDocker(['create', ...createArguments]);
      } catch (error) {
        throw new Error(
          `Docker create did not confirm ownership${typeof recoveryName === 'string' ? `; inspect the exact run name ${recoveryName} before manual removal` : ''}`,
          { cause: error },
        );
      }
      const containerId = created.stdout.trim();
      if (!/^[a-f0-9]{12,64}$/u.test(containerId))
        throw new Error(
          `Docker create did not return one container ID${typeof recoveryName === 'string' ? `; inspect the exact run name ${recoveryName} before manual removal` : ''}`,
        );
      containerIds.add(containerId);
      await runDocker(['start', containerId]);
      return containerId;
    },
    async close() {
      const owned = [...containerIds];
      const results = await Promise.allSettled(
        owned.map((containerId) =>
          runDocker(['rm', '--force', containerId]).then(() => {
            containerIds.delete(containerId);
          }),
        ),
      );
      const error = cleanupFailure(results, 'Owned container cleanup failed');
      if (error !== undefined) throw error;
    },
    ownedContainerIds() {
      return Object.freeze([...containerIds]);
    },
  });
}

export async function readApiReadiness(fetchAdapter, url, timeoutMs) {
  positiveDuration(timeoutMs, 'readiness request timeout');
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('readiness request timed out')),
    timeoutMs,
  );
  try {
    const response = await fetchAdapter(url, { signal: controller.signal });
    if (response.status !== 200) return false;
    return (await response.text()) === '{"status":"ready"}';
  } catch (error) {
    if (controller.signal.aborted) return false;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function renderedHealthCommand(
  healthCheck,
  expectedHealthCheck,
  containerId,
) {
  if (
    !Array.isArray(healthCheck) ||
    healthCheck.length !== 2 ||
    healthCheck[0] !== 'CMD-SHELL' ||
    typeof healthCheck[1] !== 'string' ||
    healthCheck[1].length === 0 ||
    JSON.stringify(healthCheck) !== JSON.stringify(expectedHealthCheck)
  )
    throw new Error(
      'rendered worker health check differs from the full manifest command',
    );
  if (
    typeof containerId !== 'string' ||
    !/^[a-f0-9]{12,64}$/u.test(containerId)
  )
    throw new Error(
      'rendered worker health check requires an owned container ID',
    );
  return ['exec', containerId, '/bin/sh', '-c', healthCheck[1]];
}

export function smokeRunIdentifier(uuid = randomUUID()) {
  if (typeof uuid !== 'string' || !/^[a-f0-9-]{32,36}$/u.test(uuid))
    throw new Error('smoke run identifier requires a UUID');
  return uuid.replaceAll('-', '');
}

export function credentialUrl({
  hostname,
  password,
  pathname,
  port,
  protocol,
  username,
}) {
  const url = new URL(`${protocol}://placeholder.invalid`);
  url.hostname = hostname;
  url.port = String(port);
  url.pathname = pathname;
  url.username = username;
  url.password = password;
  return url.toString();
}

export async function closeServerResources(server, sockets, requests) {
  for (const request of requests) request.destroy();
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}
