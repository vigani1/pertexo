// @vitest-environment node
import { expect, it } from 'vitest';
import { describeStepError } from '@/features/workflow-runs/model/step-inspection/error-copy';

it.each([
  [
    'http.response_encoding',
    /unsupported or invalid text encoding/u,
    /service.*encoding/u,
  ],
  [
    'http.response_redaction_limit',
    /credential masking work limit/u,
    /smaller.*response/u,
  ],
] as const)(
  'explains %s without blaming step setup',
  (code, reason, remedy) => {
    const shown = describeStepError(code);
    expect(shown.sentence).toMatch(reason);
    expect(shown.sentence).toContain('not kept');
    expect(shown.advice).toMatch(remedy);
    expect(shown.advice).not.toMatch(/setup|settings|Build/u);
  },
);

it.each([
  'http.response_encoding',
  'http.response_redaction_limit',
  'http.response_too_large',
])(
  'tells someone to check whether the action happened before replaying %s',
  (code) => {
    const shown = describeStepError(code);
    expect(shown.advice).toMatch(/check.*service.*before replay/iu);
    expect(shown.sentence).not.toMatch(/configuration|settings/iu);
  },
);
