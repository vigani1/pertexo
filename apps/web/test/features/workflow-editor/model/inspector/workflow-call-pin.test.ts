import { describe, expect, it } from 'vitest';
import {
  readCallPinText,
  parseCallPinText,
  callPinFieldErrors,
} from '@/features/workflow-editor/model/inspector/workflow-call-pin';
import { workflowCallPin } from '../../../../support/workflow-call-fixtures';

describe('native Call pin fields', () => {
  it('reads and applies the exact shared format without coercion or selecting latest', () => {
    expect(readCallPinText(workflowCallPin)).toEqual(workflowCallPin);
    expect(parseCallPinText(workflowCallPin)).toEqual({
      ok: true,
      value: workflowCallPin,
    });
    expect(callPinFieldErrors(workflowCallPin)).toEqual({});
  });
  it('models incomplete supported fields as local text, not a partial applied pin', () => {
    const text = readCallPinText({ workflowId: workflowCallPin.workflowId });
    expect(text).toMatchObject({
      versionId: '',
      checksum: '',
      callableContractIdentity: '',
    });
    expect(parseCallPinText(text ?? workflowCallPin).ok).toBe(false);
  });
  it('leaves unknown properties and non-string stored data to the lossless JSON editor', () => {
    expect(
      readCallPinText({ ...workflowCallPin, futureOption: true }),
    ).toBeUndefined();
    expect(
      readCallPinText({ ...workflowCallPin, versionId: 2 }),
    ).toBeUndefined();
  });
  it.each([
    ['workflowId', 'not-a-uuid'],
    ['versionId', 'latest'],
    ['checksum', `wf:v2:sha256:${'a'.repeat(64)}`],
    ['callableContractIdentity', `callable:v2:sha256:${'b'.repeat(64)}`],
  ] as const)('reports the invalid %s without applying it', (key, value) => {
    const text = { ...workflowCallPin, [key]: value };
    expect(parseCallPinText(text).ok).toBe(false);
    expect(callPinFieldErrors(text)).toHaveProperty(key);
  });
});
