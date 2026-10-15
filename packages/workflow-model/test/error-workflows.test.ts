import { describe, expect, it } from 'vitest';
import { workflowErrorInputSchema } from '../src/error-workflows/contract.js';
import { isWorkflowErrorTarget } from '../src/error-workflows/target.js';

const uuid = '12345678-1234-4234-8234-123456789abc';
const summary = {
  workflow: { id: uuid, versionId: uuid, name: 'Invoice' },
  run: { id: uuid, url: `/w/${uuid}/runs/${uuid}`, status: 'failed' },
  failedStep: { id: 'http' },
  error: { code: 'execution.failed', message: 'The workflow failed.' },
};
describe('safe error workflow input', () => {
  it('accepts only the documented summary and relative application run link', () => {
    expect(workflowErrorInputSchema.parse(summary)).toEqual(summary);
    expect(
      workflowErrorInputSchema.safeParse({
        ...summary,
        run: { ...summary.run, url: 'https://service.test/?token=secret' },
      }).success,
    ).toBe(false);
  });
  it.each([
    { ...summary, input: { password: 'secret' } },
    {
      ...summary,
      error: {
        code: 'execution.failed',
        message: 'Authorization Bearer secret',
      },
    },
    { ...summary, error: { ...summary.error, stack: 'provider secret' } },
    { ...summary, run: { ...summary.run, output: 'secret' } },
    { ...summary, failedStep: { id: 'http', input: 'secret' } },
  ])(
    'rejects unapproved data instead of stripping and forwarding it',
    (candidate) => {
      expect(workflowErrorInputSchema.safeParse(candidate).success).toBe(false);
    },
  );
});
describe('error workflow target', () => {
  const node = (key: string, version = 1, disabled = false) => ({
    definition: { key, version },
    disabled,
  });
  it('accepts one enabled supported error trigger and ordinary actions', () => {
    expect(
      isWorkflowErrorTarget({
        nodes: [node('core.workflow_error'), node('core.set')],
      }),
    ).toBe(true);
  });
  it.each([
    undefined,
    {},
    { nodes: [] },
    { nodes: [node('core.workflow_error', 2)] },
    { nodes: [node('core.workflow_error', 1, true)] },
    { nodes: [node('core.workflow_error'), node('core.workflow_error')] },
    { nodes: [node('core.workflow_error'), node('core.manual')] },
  ])(
    'refuses unavailable, disabled, unsupported or ambiguous targets',
    (graph) => {
      expect(isWorkflowErrorTarget(graph)).toBe(false);
    },
  );
});
