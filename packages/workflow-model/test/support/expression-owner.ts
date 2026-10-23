import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import { afterEach } from 'vitest';

import type { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';

export const evaluators: JsonataEvaluator[] = [];
afterEach(async () => {
  await Promise.all(evaluators.splice(0).map(async (e) => e.shutdown()));
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}
export class ControlledWorker extends EventEmitter {
  readonly termination = deferred<number>();
  terminateCalls = 0;
  postMessageCalls = 0;
  postMessage(): void {
    this.postMessageCalls += 1;
  }
  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return this.termination.promise.then((code) => {
      queueMicrotask(() => this.emit('exit', code));
      return code;
    });
  }
  asWorker(): Worker {
    return this as unknown as Worker;
  }
}
export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing test fixture');
  return value;
}
