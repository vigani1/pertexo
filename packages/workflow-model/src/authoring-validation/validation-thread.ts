import { parentPort } from 'node:worker_threads';
import type { WorkflowGraph } from '../graph/contract.js';
import {
  AuthoringValidationUnavailableError,
  type WorkflowExpressionPolicyProjection,
} from './contracts.js';
import { validateAuthoringBatch } from './validation.js';

const port = parentPort;
if (port === null)
  throw new Error('Authoring validator requires a worker port');
port.postMessage({ kind: 'ready' });
port.once(
  'message',
  (
    message: Readonly<{
      id: number;
      graph: WorkflowGraph;
      policies: WorkflowExpressionPolicyProjection;
    }>,
  ) => {
    port.postMessage({ kind: 'started', id: message.id });
    try {
      port.postMessage({
        kind: 'result',
        id: message.id,
        report: validateAuthoringBatch(message.graph, message.policies),
      });
    } catch (error: unknown) {
      port.postMessage({
        kind: 'unavailable',
        id: message.id,
        reason:
          error instanceof AuthoringValidationUnavailableError &&
          error.reason === 'report_limit'
            ? 'report_limit'
            : 'worker_failed',
      });
    }
  },
);
