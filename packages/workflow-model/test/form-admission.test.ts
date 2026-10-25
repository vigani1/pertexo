import { expect, it } from 'vitest';
import {
  requiresFormAdmissionCheck,
  formAdmissionRequirement,
  capturedFormReplayMatches,
} from '../src/triggers/forms/admission.js';

it('requires an exact captured replay for form versions while allowing other workflows', () => {
  for (const triggerType of [
    'webhook',
    'schedule',
    'workflow_call',
    'workflow_error',
    'form',
    'test',
  ]) {
    expect(requiresFormAdmissionCheck(triggerType)).toBe(false);
    expect(
      formAdmissionRequirement([{ key: 'core.form', version: 1 }], triggerType),
    ).toBe('allow');
  }
  for (const triggerType of ['manual', 'api', 'replay']) {
    expect(requiresFormAdmissionCheck(triggerType)).toBe(true);
    expect(
      formAdmissionRequirement(
        [{ key: 'core.manual', version: 1 }],
        triggerType,
      ),
    ).toBe('allow');
    expect(
      formAdmissionRequirement([{ key: 'core.form', version: 1 }], triggerType),
    ).toBe(triggerType === 'replay' ? 'match_source' : 'refuse');
  }
  expect(
    formAdmissionRequirement([{ key: 'core.form', version: 2 }], 'manual'),
  ).toBe('allow');
});

it('refuses changed version, missing input, altered actor or altered submission time', () => {
  const value = {
    kind: 'inline',
    value: {
      submittedBy: 'member',
      submittedAt: '2026-10-25T10:00:00Z',
      values: { name: 'same' },
    },
  };
  const source = { workflowVersionId: 'version', inputRef: value };
  expect(capturedFormReplayMatches(source, 'version', value)).toBe(true);
  expect(capturedFormReplayMatches(source, 'other-version', value)).toBe(false);
  expect(capturedFormReplayMatches(undefined, 'version', value)).toBe(false);
  expect(capturedFormReplayMatches(source, 'version', undefined)).toBe(false);
  for (const changed of [
    { submittedBy: 'other' },
    { submittedAt: '2026-10-25T11:00:00Z' },
  ]) {
    expect(
      capturedFormReplayMatches(source, 'version', {
        ...value,
        value: { ...value.value, ...changed },
      }),
    ).toBe(false);
  }
  expect(
    capturedFormReplayMatches(source, 'version', {
      value: {
        values: { name: 'same' },
        submittedAt: value.value.submittedAt,
        submittedBy: 'member',
      },
      kind: 'inline',
    }),
  ).toBe(true);
});
