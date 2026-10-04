import { Worker } from 'node:worker_threads';
import {
  AuthoringValidationUnavailableError,
  type AuthoringWorkerReply,
  type CallableTargetJobSlot,
  type CallableTargetWorkerAdapter,
} from '@pertexo/workflow-model/authoring-validation';
import { WorkflowEngineError } from '../errors.js';
import {
  assessmentRecord,
  CALLABLE_TARGET_ASSESSMENT_PURPOSE,
  invalidAssessment,
  parseCallableTargetAssessmentReport,
  parseCallableTargetAssessmentSnapshot,
  type CallableTargetAssessmentReport,
  type CallableTargetAssessmentSnapshot,
} from './callable-target-assessment-contracts.js';

/** The only production worker path is a compiled engine-owned entrypoint. */
export function createCallableTargetWorkerAdapter(): CallableTargetWorkerAdapter {
  const adapter: CallableTargetWorkerAdapter = {
    purpose: CALLABLE_TARGET_ASSESSMENT_PURPOSE,
    spawn: (resourceLimits) =>
      new Worker(
        new URL(
          import.meta.url.endsWith('.ts')
            ? '../../dist/compilation/callable-target-assessment-worker.js'
            : './callable-target-assessment-worker.js',
          import.meta.url,
        ),
        { resourceLimits },
      ),
    prepare: (input: unknown) => {
      const payload = parseCallableTargetAssessmentSnapshot(input);
      return { payload, bytes: Buffer.byteLength(JSON.stringify(payload)) };
    },
    decodeReply: (input: unknown): AuthoringWorkerReply => {
      if (input === null || typeof input !== 'object') invalidAssessment();
      const kind = Object.getOwnPropertyDescriptor(input, 'kind');
      if (kind === undefined || !('value' in kind)) invalidAssessment();
      if (kind.value === 'ready') {
        const fields = assessmentRecord(input, ['kind', 'purpose', 'version']);
        if (
          fields.purpose !== CALLABLE_TARGET_ASSESSMENT_PURPOSE ||
          fields.version !== 1
        )
          invalidAssessment();
        return { kind: 'ready' };
      }
      const keys =
        kind.value === 'started'
          ? ['kind', 'id']
          : kind.value === 'result'
            ? ['kind', 'id', 'report']
            : ['kind', 'id', 'reason'];
      const fields = assessmentRecord(input, keys);
      if (
        typeof fields.id !== 'number' ||
        !Number.isSafeInteger(fields.id) ||
        fields.id < 1
      )
        invalidAssessment();
      if (kind.value === 'started') return { kind: 'started', id: fields.id };
      if (kind.value === 'result')
        return { kind: 'result', id: fields.id, report: fields.report };
      if (
        kind.value !== 'unavailable' ||
        (fields.reason !== 'report_limit' && fields.reason !== 'worker_failed')
      )
        invalidAssessment();
      return { kind: 'unavailable', id: fields.id, reason: fields.reason };
    },
    validateResult: (report: unknown, prepared: unknown) =>
      parseCallableTargetAssessmentReport(
        report,
        parseCallableTargetAssessmentSnapshot(prepared),
      ),
  };
  return Object.freeze(adapter);
}

export function createCallableTargetAssessor(
  slot: CallableTargetJobSlot | undefined,
): {
  assess(
    snapshot: CallableTargetAssessmentSnapshot,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CallableTargetAssessmentReport>;
} {
  return Object.freeze({
    assess: async (
      input: CallableTargetAssessmentSnapshot,
      options?: { readonly signal?: AbortSignal },
    ) => {
      options?.signal?.throwIfAborted();
      if (slot === undefined)
        throw new AuthoringValidationUnavailableError('not_configured');
      const snapshot = parseCallableTargetAssessmentSnapshot(input);
      const report = parseCallableTargetAssessmentReport(
        await slot.assess(snapshot, options),
        snapshot,
      );
      if (report.status === 'operational_failure')
        throw new WorkflowEngineError(
          'executable_invalid',
          `Callable target assessment failed: ${report.reason}.`,
        );
      return report;
    },
  });
}
