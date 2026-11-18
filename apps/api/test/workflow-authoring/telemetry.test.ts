import { describe, expect, it } from 'vitest';

import {
  createWorkflowAuthoringTelemetry,
  WORKFLOW_AUTHORING_OPERATION,
} from '../../src/workflow-authoring/telemetry.js';

/**
 * What a real save, publish and failed save record runs through the HTTP API
 * in platform/observability/operation-telemetry.integration.test.ts, and a
 * broken tracer in @pertexo/observability's measurement test. This case stays
 * because the OpenTelemetry SDK never refuses to create an instrument on
 * demand; the meter is a stand-in for that outside library.
 */
describe('workflow authoring telemetry', () => {
  it('still runs the work when its instruments cannot be created', async () => {
    const telemetry = createWorkflowAuthoringTelemetry({
      meter: {
        createCounter: () => {
          throw new Error('meter unavailable');
        },
        createHistogram: () => {
          throw new Error('meter unavailable');
        },
      },
      tracer: {
        startActiveSpan: (_name, run) =>
          run({ setAttribute: () => undefined, end: () => undefined }),
      },
    });

    await expect(
      telemetry.measure(WORKFLOW_AUTHORING_OPERATION.create, () =>
        Promise.resolve('created'),
      ),
    ).resolves.toBe('created');
  });
});
