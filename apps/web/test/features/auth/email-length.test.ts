import { expect, it } from 'vitest';
import {
  emailProblem,
  newEmailProblem,
} from '@/features/auth/forms/field-rules';

// RFC 5321's 254 characters for a new address; 320, the stored column, for
// an account that already exists, as the server checks them.
const address = (length: number) =>
  `${'a'.repeat(length - '@example.com'.length)}@example.com`;

it('refuses a new address over 254 characters and says the limit', () => {
  expect(newEmailProblem(address(254))).toBeUndefined();
  expect(newEmailProblem(address(255))).toBe(
    'An email address can be up to 254 characters.',
  );
});

it('still accepts an existing account’s longer address, up to 320 characters', () => {
  expect(emailProblem(address(300))).toBeUndefined();
  expect(emailProblem(address(321))).toBe(
    'An email address can be up to 320 characters.',
  );
});
