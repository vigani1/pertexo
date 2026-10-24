import { vi } from 'vitest';
import type {
  WorkflowRunPersistence,
  WorkflowRunsDependencies,
} from '../../src/workflow-runs/index.js';

export function runPorts() {
  const persistence = {
    canRead: () => Promise.resolve(true),
    start: () => Promise.reject(new Error('not exercised')),
    recovery: () => Promise.reject(new Error('not exercised')),
    recover: () => Promise.reject(new Error('not exercised')),
    replay: () => Promise.reject(new Error('not exercised')),
    get: () => Promise.resolve(undefined),
    list: () => Promise.resolve({ items: [] }),
    statistics: () => Promise.reject(new Error('not exercised')),
    usageTrends: () => Promise.reject(new Error('not exercised')),
    usageCapacity: () => Promise.reject(new Error('not exercised')),
    cancel: () => Promise.reject(new Error('not exercised')),
    readVariables: () => Promise.resolve({ revision: 0, values: {} }),
    readInput: () => Promise.resolve(undefined),
    readNodeRunDiagnostics: () => Promise.resolve(undefined),
    readNodeRunOutput: () => Promise.resolve(undefined),
    readNodeRunInput: () => Promise.resolve(undefined),
    stepHealth: () => Promise.resolve(undefined),
    stepRuns: () => Promise.resolve(undefined),
  };
  const streamer = {
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }),
  };
  return {
    persistence,
    streamer,
    authorization: { findAccess: () => Promise.resolve(undefined) },
  } satisfies WorkflowRunsDependencies;
}

export function runPersistenceSpies() {
  return {
    canRead: () => Promise.resolve(true),
    readVariables: () => Promise.resolve({ revision: 0, values: {} }),
    readNodeRunDiagnostics: () => Promise.resolve(undefined),
    start: vi.fn<WorkflowRunPersistence['start']>(),
    replay: vi.fn<WorkflowRunPersistence['replay']>(),
    recovery: vi.fn<WorkflowRunPersistence['recovery']>(),
    recover: vi.fn<WorkflowRunPersistence['recover']>(),
    get: vi.fn<WorkflowRunPersistence['get']>(),
    list: vi.fn<WorkflowRunPersistence['list']>(),
    statistics: vi.fn<WorkflowRunPersistence['statistics']>(),
    usageCapacity: vi.fn<WorkflowRunPersistence['usageCapacity']>(),
    usageTrends: vi.fn<WorkflowRunPersistence['usageTrends']>(),
    cancel: vi.fn<WorkflowRunPersistence['cancel']>(),
    readInput: vi.fn<WorkflowRunPersistence['readInput']>(),
    readNodeRunOutput: vi.fn<WorkflowRunPersistence['readNodeRunOutput']>(),
    readNodeRunInput: vi.fn<WorkflowRunPersistence['readNodeRunInput']>(),
    stepHealth: vi.fn<WorkflowRunPersistence['stepHealth']>(),
    stepRuns: vi.fn<WorkflowRunPersistence['stepRuns']>(),
  } satisfies WorkflowRunPersistence;
}
