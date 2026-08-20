import { describe, expect, it, vi } from 'vitest';

import {
  createWorkflowAuthoringTelemetry,
  WORKFLOW_AUTHORING_OPERATION,
  type WorkflowAuthoringOperation,
  type WorkflowAuthoringSpan,
  type WorkflowAuthoringTracer,
} from '../../src/workflow-authoring/telemetry.js';

describe('workflow authoring telemetry', () => {
  it('records one fixed operation/outcome pair for success and failure without identifiers', async () => {
    const counterAdd = vi.fn();
    const histogramRecord = vi.fn();
    const counter = { add: counterAdd };
    const histogram = { record: histogramRecord };
    const spanSetAttribute = vi.fn();
    const span: WorkflowAuthoringSpan = {
      setAttribute: spanSetAttribute,
      end: vi.fn(),
    };
    const tracer: WorkflowAuthoringTracer = {
      startActiveSpan: async <T>(
        _name: `pertexo.workflow_authoring.${WorkflowAuthoringOperation}`,
        callback: (activeSpan: WorkflowAuthoringSpan) => Promise<T>,
      ): Promise<T> => await callback(span),
    };
    const telemetry = createWorkflowAuthoringTelemetry({
      meter: {
        createCounter: vi.fn().mockReturnValue(counter),
        createHistogram: vi.fn().mockReturnValue(histogram),
      },
      tracer,
      monotonicNow: (() => {
        let value = 1_000;
        return () => (value += 10);
      })(),
    });

    await telemetry.measure(WORKFLOW_AUTHORING_OPERATION.draftGet, () =>
      Promise.resolve('ok'),
    );
    await expect(
      telemetry.measure(WORKFLOW_AUTHORING_OPERATION.draftSave, () =>
        Promise.reject(new Error('expected')),
      ),
    ).rejects.toThrow('expected');

    expect(counterAdd).toHaveBeenCalledTimes(2);
    expect(counterAdd).toHaveBeenNthCalledWith(1, 1, {
      operation: WORKFLOW_AUTHORING_OPERATION.draftGet,
      outcome: 'succeeded',
    });
    expect(counterAdd).toHaveBeenNthCalledWith(2, 1, {
      operation: WORKFLOW_AUTHORING_OPERATION.draftSave,
      outcome: 'failed',
    });
    expect(counterAdd.mock.calls.flat()).not.toContain(actorId());
    expect(spanSetAttribute).toHaveBeenCalledWith(
      'operation',
      WORKFLOW_AUTHORING_OPERATION.draftGet,
    );
    expect(spanSetAttribute).toHaveBeenCalledWith('outcome', 'failed');
  });
});

function actorId(): string {
  return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
}
