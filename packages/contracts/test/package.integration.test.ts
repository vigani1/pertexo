import { expect, it } from 'vitest';
import {
  nativeAuthenticationAcknowledgmentSchema,
  nativeRegistrationResponseSchema,
  nativeSignInResponseSchema,
} from '@pertexo/contracts';

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
