import { describe, expect, it } from 'vitest';
import { parseWorkerConfig } from '../src/config/worker-config.js';

const requiredEnvironment = {
  DATABASE_DISPATCHER_URL:
    'postgresql://dispatcher:secret@localhost:5432/pertexo',
  DATABASE_WORKER_URL: 'postgresql://worker:secret@localhost:5432/pertexo',
  REDIS_URL: 'redis://localhost:6379/0',
};

describe('coordinator native value-work configuration', () => {
  it('normalizes scalar policy input and still rejects non-scalar environment values', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
        WORKFLOW_NATIVE_VALUE_CONTROL_POLL_MILLIS: 300,
      }).coordinator.valueWorkPolicy.controlPollMillis,
    ).toBe(300);
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        WORKFLOW_NATIVE_VALUE_CONTROL_POLL_MILLIS: [300],
      }),
    ).toThrow('Invalid worker configuration');
  });
  it('preserves explicit accepted policy values rather than replacing them with defaults', () => {
    const config = parseWorkerConfig({
      ...requiredEnvironment,
      WORKFLOW_NATIVE_VALUE_CONTROL_POLL_MILLIS: '100',
      WORKFLOW_NATIVE_VALUE_CONTROL_READ_TIMEOUT_MILLIS: '5000',
      WORKFLOW_NATIVE_VALUE_OPERATION_TIMEOUT_MILLIS: '60000',
    });
    expect(config.coordinator.valueWorkPolicy).toEqual({
      controlPollMillis: 100,
      controlReadTimeoutMillis: 5000,
      operationTimeoutMillis: 60000,
    });
  });
  it.each([
    ['WORKFLOW_NATIVE_VALUE_CONTROL_POLL_MILLIS', '99'],
    ['WORKFLOW_NATIVE_VALUE_CONTROL_POLL_MILLIS', '1001'],
    ['WORKFLOW_NATIVE_VALUE_CONTROL_READ_TIMEOUT_MILLIS', '99'],
    ['WORKFLOW_NATIVE_VALUE_CONTROL_READ_TIMEOUT_MILLIS', '5001'],
    ['WORKFLOW_NATIVE_VALUE_OPERATION_TIMEOUT_MILLIS', '999'],
    ['WORKFLOW_NATIVE_VALUE_OPERATION_TIMEOUT_MILLIS', '60001'],
    ['WORKFLOW_NATIVE_VALUE_CONTROL_POLL_MILLIS', '250.5'],
    ['WORKFLOW_NATIVE_VALUE_CONTROL_READ_TIMEOUT_MILLIS', 'NaN'],
    ['WORKFLOW_NATIVE_VALUE_OPERATION_TIMEOUT_MILLIS', 'Infinity'],
    ['WORKFLOW_NATIVE_VALUE_OPERATION_TIMEOUT_MILLIS', ''],
  ])(
    'fails startup for invalid %s=%s even while native is off',
    (field, value) => {
      expect(() =>
        parseWorkerConfig({ ...requiredEnvironment, [field]: value }),
      ).toThrow('Invalid worker configuration');
    },
  );
  it('parses the accepted defaults into one frozen coordinator policy without enabling jobs', () => {
    const config = parseWorkerConfig(requiredEnvironment);
    expect(config.coordinator).toMatchObject({
      valueWorkPolicy: {
        controlPollMillis: 250,
        controlReadTimeoutMillis: 2_000,
        operationTimeoutMillis: 30_000,
      },
    });
    expect(Reflect.get(config.coordinator, 'valueWorkPolicy')).toSatisfy(
      Object.isFrozen,
    );
    expect(config.outboxDispatcher.enabledJobNames).toEqual([]);
  });
});
