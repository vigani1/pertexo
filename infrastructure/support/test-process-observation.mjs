import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitForFile(file, timeoutMillis = 5_000) {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}
