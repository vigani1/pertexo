import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, vi } from 'vitest';
import type { WorkflowExpressionPolicyProjection } from '../../src/authoring/validation/contracts.js';
import { WorkflowAuthoringValidator } from '../../src/authoring/validation/validator.js';

export const policies: WorkflowExpressionPolicyProjection = {
  definitions: [
    {
      definition: { key: 'core.set', version: 1 },
      policyReferences: [{ key: 'jsonata.restricted', version: 1 }],
    },
    {
      definition: { key: 'core.foreach', version: 1 },
      policyReferences: [{ key: 'jsonata.restricted', version: 1 }],
    },
  ],
};
export const graph = (expression = 'runInput.amount > 5000') => ({
  nodes: [
    {
      id: 'step',
      definition: { key: 'core.set', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: { opaque: 'credential-must-not-leak' },
      connectionRefs: {},
      inputMappings: {
        result: {
          kind: 'expression',
          language: 'jsonata',
          expression,
        },
      },
    },
  ],
  edges: [],
  settings: {},
});
export const valid = {
  ok: true,
  issues: [],
  expandedInvocations: 1,
  worstCaseLoopIterations: 0,
};
export class ControlledWorker extends EventEmitter {
  messages: unknown[] = [];
  terminateCalls = 0;
  terminateMode: 'exit' | 'reject' | 'pending' | 'resolved_without_exit' =
    'exit';
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  terminate(): Promise<number> {
    this.terminateCalls += 1;
    if (this.terminateMode === 'reject')
      return Promise.reject(new Error('credential-must-not-leak'));
    if (this.terminateMode === 'pending') return new Promise(() => undefined);
    if (this.terminateMode === 'resolved_without_exit')
      return Promise.resolve(1);
    this.emit('exit', 1);
    return Promise.resolve(1);
  }
  asWorker(): Worker {
    return this as unknown as Worker;
  }
  succeed(): void {
    this.emit('message', { kind: 'ready' });
    const message = this.messages[0];
    if (message === null || typeof message !== 'object')
      throw new Error('Missing controlled batch');
    const id: unknown = Reflect.get(message, 'id');
    if (typeof id !== 'number') throw new Error('Missing batch identity');
    this.emit('message', { kind: 'started', id });
    this.emit('message', { kind: 'result', id, report: valid });
  }
}
const owners: WorkflowAuthoringValidator[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(owners.splice(0).map((owner) => owner.shutdown()));
  vi.restoreAllMocks();
});
export function createOwner(
  options: ConstructorParameters<typeof WorkflowAuthoringValidator>[0] = {},
) {
  const owner = new WorkflowAuthoringValidator(options);
  owners.push(owner);
  return owner;
}
export function controlled(
  options: ConstructorParameters<typeof WorkflowAuthoringValidator>[0] = {},
) {
  const workers: ControlledWorker[] = [];
  const owner = createOwner({
    ...options,
    maxActive: 1,
    workerFactory: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker.asWorker();
    },
  });
  return { owner, workers };
}
export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test resource');
  return value;
}
