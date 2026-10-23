import type { Queue } from 'bullmq';

import { PROOF_OPERATION_TIMEOUT_MS } from './environment.js';

export async function withDeadline<T>(
  operation: Promise<T>,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} exceeded its proof deadline`));
    }, PROOF_OPERATION_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(
          error instanceof Error
            ? error
            : new Error(`${label} failed`, { cause: error }),
        );
      },
    );
  });
}

export async function waitForJob(
  queue: Queue,
  outboxId: string,
): Promise<void> {
  const expectedJobId = `outbox-${outboxId}`;
  const deadline = Date.now() + PROOF_OPERATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await queue.getJob(expectedJobId)) !== undefined) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20);
      timer.unref();
    });
  }
  throw new Error(`queue job ${expectedJobId} exceeded its proof deadline`);
}
