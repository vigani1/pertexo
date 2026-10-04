import { parentPort } from 'node:worker_threads';
import { AuthoringValidationUnavailableError } from '@pertexo/workflow-model/authoring-validation';
import { computeCallableTargetAssessment } from './callable-target-assessment-computation.js';
import {
  assessmentRecord,
  CALLABLE_TARGET_ASSESSMENT_LIMITS,
  CALLABLE_TARGET_ASSESSMENT_PURPOSE,
} from './callable-target-assessment-contracts.js';

const port = parentPort;
if (port === null)
  throw new Error('Callable target assessment requires a worker port');
port.postMessage({
  kind: 'ready',
  purpose: CALLABLE_TARGET_ASSESSMENT_PURPOSE,
  version: 1,
});
port.once('message', (input: unknown) => {
  const message = assessmentRecord(input, [
    'id',
    'purpose',
    'version',
    'workspaceId',
    'currentRelease',
    'entries',
  ]);
  if (
    typeof message.id !== 'number' ||
    !Number.isSafeInteger(message.id) ||
    message.id < 1
  )
    throw new Error('Invalid assessment job identity');
  const id = message.id;
  port.postMessage({ kind: 'started', id });
  try {
    const report = computeCallableTargetAssessment({
      purpose: message.purpose,
      version: message.version,
      workspaceId: message.workspaceId,
      currentRelease: message.currentRelease,
      entries: message.entries,
    });
    if (
      Buffer.byteLength(JSON.stringify(report)) >
      CALLABLE_TARGET_ASSESSMENT_LIMITS.reportBytes
    )
      throw new AuthoringValidationUnavailableError('report_limit');
    port.postMessage({ kind: 'result', id, report });
  } catch (error: unknown) {
    if (
      error instanceof AuthoringValidationUnavailableError &&
      error.reason === 'payload_limit'
    ) {
      // Aggregate budget exhaustion is a closed whole-operation report; unlike
      // operational corrupt-data failures it has a deliberate unavailable code.
      port.postMessage({
        kind: 'result',
        id,
        report: { status: 'budget_exhausted' },
      });
      return;
    }
    port.postMessage({
      kind: 'unavailable',
      id,
      reason:
        error instanceof AuthoringValidationUnavailableError &&
        error.reason === 'report_limit'
          ? 'report_limit'
          : 'worker_failed',
    });
  }
});
