import { describe, expect, it } from 'vitest';

import { createWorkflowExecutionResultIdentityV1 } from '../src/execution/workflow-execution-result-identity.js';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '../src/execution/workflow-execution-value-contract.js';
import {
  WORKSPACE_ID,
  RUN_ID,
  VERSION_ID,
  OUTBOX_EVENT_ID,
  ATTEMPT_ID,
} from './support/node-attempt-handler.fixture.js';

function literalInput() {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workflowVersionId: VERSION_ID,
    delivery: {
      outboxEventId: OUTBOX_EVENT_ID,
      payloadChecksum: 'a'.repeat(64),
    },
    expectedRevision: 4,
    resultRevision: 5,
    resultSelector: { kind: 'literal', value: { name: 'literal' } },
    sources: [],
    value: {
      sha256: 'b'.repeat(64),
      byteLength: 18,
      mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
    },
  };
}

function selectedInput() {
  return {
    ...literalInput(),
    resultSelector: {
      kind: 'expression',
      language: 'jsonata',
      policyVersion: 1,
      expression: 'nodeOutputs',
    },
    sources: [
      {
        invocationKey: 'physical',
        output: { kind: 'inline', attemptId: ATTEMPT_ID },
      },
      {
        invocationKey: 'call',
        output: {
          kind: 'workflow_call',
          invocationKey: 'call',
          childRunId: '99999999-9999-4999-8999-999999999999',
        },
      },
    ],
  };
}

describe('pure native result identity V1 (not authority)', () => {
  it('rejects duplicate scoped sources and a logical child result attributed to a different invocation', () => {
    const source = {
      invocationKey: 'call',
      output: {
        kind: 'workflow_call',
        invocationKey: 'other',
        childRunId: RUN_ID,
      },
    };
    expect(() =>
      createWorkflowExecutionResultIdentityV1({
        ...selectedInput(),
        sources: [source],
      }),
    ).toThrow();
    const physical = {
      invocationKey: 'physical',
      output: { kind: 'inline', attemptId: ATTEMPT_ID },
    };
    expect(() =>
      createWorkflowExecutionResultIdentityV1({
        ...selectedInput(),
        sources: [physical, physical],
      }),
    ).toThrow();
  });
  it('binds the ordered physical/logical source selection without sorting or treating a child result as an attempt', () => {
    const input = selectedInput();
    const identity = createWorkflowExecutionResultIdentityV1(input);
    expect(
      createWorkflowExecutionResultIdentityV1({
        ...input,
        sources: [...input.sources].reverse(),
      }),
    ).not.toBe(identity);
    expect(
      createWorkflowExecutionResultIdentityV1({
        ...input,
        sources: [
          input.sources[0],
          {
            invocationKey: 'call',
            output: { kind: 'inline', attemptId: ATTEMPT_ID },
          },
        ],
      }),
    ).not.toBe(identity);
    expect(
      createWorkflowExecutionResultIdentityV1({
        ...input,
        sources: [
          input.sources[0],
          {
            invocationKey: 'call',
            output: { kind: 'artifact', artifactId: RUN_ID },
          },
        ],
      }),
    ).not.toBe(identity);
  });
  it.each([
    { workspaceId: RUN_ID },
    { runId: WORKSPACE_ID },
    { workflowVersionId: WORKSPACE_ID },
    {
      delivery: {
        outboxEventId: WORKSPACE_ID,
        payloadChecksum: 'a'.repeat(64),
      },
    },
    {
      delivery: {
        outboxEventId: OUTBOX_EVENT_ID,
        payloadChecksum: 'c'.repeat(64),
      },
    },
    { expectedRevision: 5, resultRevision: 6 },
    { resultSelector: { kind: 'run_input', path: '$' } },
    {
      value: {
        sha256: 'c'.repeat(64),
        byteLength: 18,
        mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
      },
    },
    {
      value: {
        sha256: 'b'.repeat(64),
        byteLength: 19,
        mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
      },
    },
  ])(
    'binds every actual scope/delivery/revision/selector/value metadata field %j',
    (patch) => {
      expect(
        createWorkflowExecutionResultIdentityV1({
          ...literalInput(),
          ...patch,
        }),
      ).not.toBe(createWorkflowExecutionResultIdentityV1(literalInput()));
    },
  );
  it('accepts at most 1,000 descriptors and rejects the next before producing an identity', () => {
    const sources = Array.from({ length: 1_000 }, (_, index) => ({
      invocationKey: `source-${String(index)}`,
      output: { kind: 'inline', attemptId: ATTEMPT_ID },
    }));
    expect(
      createWorkflowExecutionResultIdentityV1({ ...selectedInput(), sources }),
    ).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      createWorkflowExecutionResultIdentityV1({
        ...selectedInput(),
        sources: [
          ...sources,
          {
            invocationKey: 'excess',
            output: { kind: 'inline', attemptId: ATTEMPT_ID },
          },
        ],
      }),
    ).toThrow();
  });
  it('applies the 1 MiB encoder bound to the whole V1 record including its fixed fields', () => {
    // The independent literal fixture is 638 UTF8 bytes with a seven-byte name.
    const name = 'x'.repeat(1_048_576 - (638 - 7));
    const input = {
      ...literalInput(),
      resultSelector: { kind: 'literal', value: { name } },
    };
    expect(createWorkflowExecutionResultIdentityV1(input)).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(() =>
      createWorkflowExecutionResultIdentityV1({
        ...input,
        resultSelector: { kind: 'literal', value: { name: `${name}x` } },
      }),
    ).toThrow();
  });
  it.each([
    { traceparent: 'not-in-the-identity-record' },
    { preparedAt: '2026-10-03T00:00:00Z' },
    { plan: { events: [] } },
    { slot: 'physical_output' },
    { schemaVersion: 2 },
    {
      value: {
        ...literalInput().value,
        payload: { runtime: 'must-not-be-copied' },
      },
    },
    {
      sources: [
        {
          invocationKey: 'physical',
          output: { kind: 'inline', attemptId: ATTEMPT_ID },
          snapshot: { value: 'must-not-be-copied' },
        },
      ],
    },
  ])(
    'rejects extra payload/clock/trace/plan fields instead of silently persisting them %j',
    (patch) => {
      expect(() =>
        createWorkflowExecutionResultIdentityV1({
          ...literalInput(),
          ...patch,
        }),
      ).toThrow();
    },
  );
  it('uses the existing persisted encoder spelling for key ordering and normalized negative zero', () => {
    const a = {
      ...literalInput(),
      resultSelector: {
        kind: 'literal',
        value: { '2': 'two', '10': 'ten', n: -0 },
      },
    };
    const b = {
      ...literalInput(),
      resultSelector: {
        value: { n: 0, '10': 'ten', '2': 'two' },
        kind: 'literal',
      },
    };
    expect(createWorkflowExecutionResultIdentityV1(a)).toBe(
      createWorkflowExecutionResultIdentityV1(b),
    );
  });
  it.each([
    { kind: 'inline', attemptId: RUN_ID },
    { kind: 'workflow_call', invocationKey: 'physical', childRunId: RUN_ID },
  ])(
    'binds the exact physical attempt or logical child identity %j',
    (output) => {
      const input = selectedInput();
      expect(
        createWorkflowExecutionResultIdentityV1({
          ...input,
          sources: [{ invocationKey: 'physical', output }, input.sources[1]],
        }),
      ).not.toBe(createWorkflowExecutionResultIdentityV1(input));
    },
  );
  it('rejects a fabricated attempt on a logical child-result descriptor', () => {
    const input = selectedInput();
    expect(() =>
      createWorkflowExecutionResultIdentityV1({
        ...input,
        sources: [
          {
            invocationKey: 'call',
            output: {
              kind: 'workflow_call',
              invocationKey: 'call',
              childRunId: RUN_ID,
              attemptId: ATTEMPT_ID,
            },
          },
        ],
      }),
    ).toThrow();
  });
  it.each([
    { workspaceId: 'not-a-workspace' },
    { expectedRevision: -1 },
    { expectedRevision: 4.5 },
    { value: { ...literalInput().value, byteLength: 0 } },
    { value: { ...literalInput().value, byteLength: 1_048_577 } },
    { value: { ...literalInput().value, sha256: 'B'.repeat(64) } },
    { value: { ...literalInput().value, mediaType: 'application/json' } },
  ])('refuses inadmissible bounded producer metadata %j', (patch) => {
    expect(() =>
      createWorkflowExecutionResultIdentityV1({ ...literalInput(), ...patch }),
    ).toThrow();
  });
  it('rejects hostile property access before schema parsing without invoking a getter', () => {
    let accessed = false;
    const input = Object.defineProperty(literalInput(), 'runId', {
      get: () => {
        accessed = true;
        return RUN_ID;
      },
      enumerable: true,
    });
    expect(() => createWorkflowExecutionResultIdentityV1(input)).toThrow();
    expect(accessed).toBe(false);
  });
  it('requires the recorded result revision to be the next revision, not a creation or arbitrary future revision', () => {
    expect(() =>
      createWorkflowExecutionResultIdentityV1({
        ...literalInput(),
        resultRevision: 4,
      }),
    ).toThrow();
    expect(() =>
      createWorkflowExecutionResultIdentityV1({
        ...literalInput(),
        resultRevision: 6,
      }),
    ).toThrow();
  });
  it('refuses a record missing its actual pre-CAS revision rather than hashing an incomplete label', () => {
    const { expectedRevision: _expectedRevision, ...incomplete } =
      literalInput();
    expect(() => createWorkflowExecutionResultIdentityV1(incomplete)).toThrow();
  });
  it('binds a literal result to the accepted metadata record without requiring any source', () => {
    // Independently specified UTF8 metadata record, including V1/slot constants.
    expect(createWorkflowExecutionResultIdentityV1(literalInput())).toBe(
      '64bb0f31e00e6401ec212bf030e0fbf1cdf8d4e9ff68d22fde7c2b9dda029f35',
    );
  });
});
