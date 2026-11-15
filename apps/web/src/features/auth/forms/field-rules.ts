import { EMAIL_ADDRESS_LIMITS, PASSWORD_LIMITS } from '@pertexo/workflow-model';
import { formatCount } from '@/lib/format/count';

// Input feedback rules shared by the sign-in family and account forms. Each
// names the field, says what's wrong and how to fix it.

const MAXIMUM_PASSWORD_LENGTH = PASSWORD_LIMITS.maximumCharacters;
/** Used until the server's capabilities say otherwise. */
export const DEFAULT_MINIMUM_PASSWORD_LENGTH =
  PASSWORD_LIMITS.minimumCharacters;

/**
 * An address for an existing account (sign-in, reset, resend), which may be
 * as long as the stored column, like the server's lookups.
 */
export function emailProblem(value: string): string | undefined {
  return addressProblem(value, EMAIL_ADDRESS_LIMITS.storedAddressCharacters);
}

/** A newly entered address (sign-up, email change), held to RFC 5321. */
export function newEmailProblem(value: string): string | undefined {
  return addressProblem(value, EMAIL_ADDRESS_LIMITS.newAddressCharacters);
}

function addressProblem(value: string, maximum: number): string | undefined {
  const email = value.trim();
  if (email.length === 0) return 'Enter your email address.';
  if (email.length > maximum)
    return `An email address can be up to ${formatCount(maximum, 'character')}.`;
  const at = email.indexOf('@');
  if (at < 1 || at === email.length - 1)
    return 'Enter an email address, like you@company.com.';
  const domain = email.slice(at + 1);
  if (!domain.includes('.') || domain.endsWith('.'))
    return 'That’s missing the end of the domain, like .com or .dev.';
  return undefined;
}

export function requiredPasswordProblem(value: string): string | undefined {
  return value.length === 0 ? 'Enter your password.' : undefined;
}

/** For a confirmation, where "your password" alone is ambiguous. */
export function currentPasswordProblem(value: string): string | undefined {
  return value.length === 0 ? 'Enter your current password.' : undefined;
}

export function newPasswordProblem(
  value: string,
  minimumLength: number,
): string | undefined {
  if (value.length < minimumLength)
    return `Use at least ${formatCount(minimumLength, 'character')}.`;
  if (value.length > MAXIMUM_PASSWORD_LENGTH)
    return `Use ${formatCount(MAXIMUM_PASSWORD_LENGTH, 'character')} or fewer.`;
  return undefined;
}

export function confirmationProblem(
  value: string,
  password: string,
): string | undefined {
  if (value.length === 0) return 'Type the new password again.';
  return value === password ? undefined : 'The passwords don’t match.';
}
