import { describe, expect, it } from 'vitest';
import type { WorkflowCallIntent } from '@pertexo/workflow-engine';
import {
  callInputMatches,
  callInputRefusal,
} from '../../../src/runs/calls/call-intent.js';
import { prepareStoredExecutionValue } from '../../../src/shared/stored-execution.js';

const inline = prepareStoredExecutionValue({ kind: 'inline', value: { a: 1 } });
const artifact = prepareStoredExecutionValue({
  kind: 'artifact',
  artifactId: '00000000-0000-4000-8000-000000000001',
});
const intent = (input: WorkflowCallIntent['input']) =>
  ({ input }) as WorkflowCallIntent;

describe('workflow call intent rules', () => {
  it('matches an inline input only to the attempt it was planned from', () => {
    const planned = intent({ kind: 'inline', attemptId: 'attempt-1' });
    expect(callInputMatches(planned, 'attempt-1', inline)).toBe(true);
    expect(callInputMatches(planned, 'attempt-2', inline)).toBe(false);
    expect(callInputMatches(planned, 'attempt-1', artifact)).toBe(false);
  });

  it('matches an artifact input only to the same artifact', () => {
    const planned = intent({
      kind: 'artifact',
      artifactId: '00000000-0000-4000-8000-000000000001',
    });
    expect(callInputMatches(planned, 'any', artifact)).toBe(true);
    expect(callInputMatches(planned, 'any', inline)).toBe(false);
    expect(
      callInputMatches(
        intent({
          kind: 'artifact',
          artifactId: '00000000-0000-4000-8000-000000000002',
        }),
        'any',
        artifact,
      ),
    ).toBe(false);
  });

  it('refuses an artifact input and accepts a small inline input', () => {
    expect(callInputRefusal(artifact)).toBe('call_input_artifact_unsupported');
    expect(callInputRefusal(inline)).toBeUndefined();
  });
});
