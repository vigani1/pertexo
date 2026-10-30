import { describe, expect, it } from 'vitest';
import { NodeExecutionAbortedError } from '@pertexo/node-sdk/server';
import {
  CORE_VALIDATE_DEFINITION,
  CORE_VALIDATE_EXECUTOR,
  CORE_VALIDATE_ISSUE_MESSAGES,
  CORE_VALIDATE_OUTPUT_SCHEMA,
  evaluateCoreValidate,
} from '../../src/index.js';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from '../../src/server.js';
import { registry, config } from '../support/validate.js';
describe('core.validate registry execution', () => {
  it('preserves cancellation and configuration errors at the executor ABI boundary', async () => {
    const executor = CORE_NODE_EXECUTOR_REGISTRATIONS.find(
      ({ executor }) => executor.key === CORE_VALIDATE_EXECUTOR.key,
    );
    if (executor === undefined)
      throw new Error('Validate executor is not registered');
    await expect(
      registry.execute({
        definition: CORE_VALIDATE_DEFINITION,
        executor: CORE_VALIDATE_EXECUTOR,
        config: { rules: [] },
        input: {},
        connectionRefs: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'invalid_config' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      executor.execute({
        config: config([{ id: 'valid', path: '$' }]),
        input: {},
        connectionRefs: {},
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(NodeExecutionAbortedError);
  });
  it('matches the pure preview result through the public runtime registry', async () => {
    const parsed = config([
      { id: 'name', path: '$.name', required: true, type: 'string' },
      { id: 'count', path: '$.count', type: 'number', minimum: 2 },
    ]);
    const input = { name: 'preview/runtime', count: 1 };
    const expected = evaluateCoreValidate(parsed, input);
    await expect(
      registry.execute({
        config: parsed,
        definition: CORE_VALIDATE_DEFINITION,
        executor: CORE_VALIDATE_EXECUTOR,
        input,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: expected });
  });

  it('does not run a canceled invocation and uses no dispatch runtime', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      registry.execute({
        config: config([{ id: 'value', path: '$.value' }]),
        definition: CORE_VALIDATE_DEFINITION,
        executor: CORE_VALIDATE_EXECUTOR,
        input: { value: true },
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(NodeExecutionAbortedError);
  });

  it('rejects inconsistent runtime output contracts', () => {
    expect(
      CORE_VALIDATE_OUTPUT_SCHEMA.safeParse({
        valid: false,
        issues: [],
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      CORE_VALIDATE_OUTPUT_SCHEMA.safeParse({
        valid: true,
        issues: [
          {
            ruleId: 'value',
            path: '$.value',
            code: 'required',
            message: CORE_VALIDATE_ISSUE_MESSAGES.required,
          },
        ],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      CORE_VALIDATE_OUTPUT_SCHEMA.safeParse({
        valid: false,
        issues: [
          {
            ruleId: 'value',
            path: '$.value',
            code: 'required',
            message: CORE_VALIDATE_ISSUE_MESSAGES.required,
          },
          {
            ruleId: 'value',
            path: '$.value',
            code: 'required',
            message: CORE_VALIDATE_ISSUE_MESSAGES.required,
          },
        ],
        truncated: false,
      }).success,
    ).toBe(false);
  });
});
