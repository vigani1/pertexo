import { expect, it } from 'vitest';
import {
  apiTokenInfoResponseSchema,
  apiTokenRevokeRequestSchema,
  workflowDraftQuerySchema,
  nativeAuthenticationAcknowledgmentSchema,
  nativeRegistrationResponseSchema,
  nativeSignInResponseSchema,
} from '@pertexo/contracts';
import { jsonSchema } from '@pertexo/contracts/server';

it('exports native acknowledgment projections that reject unsupported success and preserve challenge variants', () => {
  expect(nativeAuthenticationAcknowledgmentSchema.safeParse({}).success).toBe(
    false,
  );
  expect(
    nativeAuthenticationAcknowledgmentSchema.parse({ status: true }),
  ).toEqual({ status: true });
  expect(nativeRegistrationResponseSchema.parse({ user: null })).toEqual({
    user: null,
  });
  expect(nativeSignInResponseSchema.parse({ twoFactorRedirect: true })).toEqual(
    { twoFactorRedirect: true },
  );
  expect(nativeSignInResponseSchema.safeParse({}).success).toBe(false);
});

it('exports response-aware JSON Schema without relaxing request schemas', () => {
  expect(
    jsonSchema(apiTokenInfoResponseSchema, 'output').additionalProperties,
  ).toBe(true);
  expect(
    jsonSchema(apiTokenRevokeRequestSchema, 'input').additionalProperties,
  ).toBe(false);
  expect(workflowDraftQuerySchema.parse({ include: 'graphDigest' })).toEqual({
    include: 'graphDigest',
  });
  expect(
    workflowDraftQuerySchema.safeParse({
      include: 'graphDigest',
      futureInput: true,
    }).success,
  ).toBe(false);
});
