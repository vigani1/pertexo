import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function assertOrganizationPreviewPortVacant(port: number) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', () => {
      reject(new Error('Owned preview port occupied'));
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

export async function waitForOwnedOrganizationPreview(
  child: Pick<ChildProcess, 'exitCode' | 'signalCode'>,
  origin: string,
  timeoutMillis = 15_000,
) {
  const deadline = Date.now() + timeoutMillis;
  const assertAlive = () => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Owned organization preview exited');
  };
  for (;;) {
    assertAlive();
    let ready = false;
    try {
      ready = (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      // Startup only; response content and origins are never disclosed.
    }
    assertAlive();
    if (ready) return;
    if (Date.now() >= deadline)
      throw new Error('Owned organization preview startup deadline');
    await delay(50);
  }
}

export async function closeOrganizationBrowserBarriers(
  barriers: readonly Readonly<{ close(): Promise<void> }>[],
) {
  const closures = await Promise.allSettled(
    barriers.toReversed().map((barrier) => barrier.close()),
  );
  if (closures.some((closure) => closure.status === 'rejected'))
    throw new Error('Owned browser process proof failed; preserve fixture');
}
