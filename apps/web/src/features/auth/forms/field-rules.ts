// Input feedback rules shared by the sign-in family and account forms. Each
// names the field, says what's wrong and how to fix it.

const MAXIMUM_PASSWORD_LENGTH = 128;
/** Used until the server's capabilities say otherwise. */
export const DEFAULT_MINIMUM_PASSWORD_LENGTH = 12;

export function emailProblem(value: string): string | undefined {
  const email = value.trim();
  if (email.length === 0) return 'Enter your email address.';
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

export function newPasswordProblem(
  value: string,
  minimumLength: number,
): string | undefined {
  if (value.length < minimumLength)
    return `Use at least ${String(minimumLength)} characters.`;
  if (value.length > MAXIMUM_PASSWORD_LENGTH)
    return `Use ${String(MAXIMUM_PASSWORD_LENGTH)} characters or fewer.`;
  return undefined;
}

export function confirmationProblem(
  value: string,
  password: string,
): string | undefined {
  if (value.length === 0) return 'Type the new password again.';
  return value === password ? undefined : 'The passwords don’t match.';
}
