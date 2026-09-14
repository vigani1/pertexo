import { spawn } from 'node:child_process';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

function signalProcessTree(child, signal) {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function parseDuration(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1)
    throw new TypeError(`${label} must be a positive safe integer`);
  return selected;
}

export async function runBoundedChildProcess(command, args, options = {}) {
  const timeoutMs = parseDuration(options.timeoutMs, 10_000, 'timeoutMs');
  const killGraceMs = parseDuration(options.killGraceMs, 250, 'killGraceMs');
  return new Promise((resolve, reject) => {
    let closedResult;
    let killCompleted = false;
    let stderr = '';
    let stdout = '';
    let spawnError;
    let timedOut = false;
    let killTimer;
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      encoding: undefined,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        signalProcessTree(child, 'SIGTERM');
      } catch (error) {
        reject(error);
        return;
      }
      killTimer = setTimeout(() => {
        try {
          signalProcessTree(child, 'SIGKILL');
          killCompleted = true;
          if (closedResult !== undefined) resolve(Object.freeze(closedResult));
        } catch (error) {
          reject(error);
        }
      }, killGraceMs);
    }, timeoutMs);
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      closedResult = {
        signal,
        spawnError,
        status,
        stderr,
        stdout,
        timedOut,
      };
      if (timedOut && !killCompleted) return;
      clearTimeout(killTimer);
      resolve(Object.freeze(closedResult));
    });
  });
}

export function describeBoundedChildFailure(label, result, timeoutMs) {
  if (result.spawnError !== undefined)
    return `${label} could not start (${result.spawnError instanceof Error ? result.spawnError.message : String(result.spawnError)})`;
  if (result.timedOut)
    return `${label} timed out after ${String(timeoutMs)}ms and was reaped (${result.signal === null ? `status ${String(result.status)}` : `signal ${result.signal}`})`;
  return `${label} failed (${result.signal === null ? `status ${String(result.status)}` : `signal ${result.signal}`})`;
}
