/**
 * The one form an email address is compared and stored in. Equal under this
 * rule means the same person, for invitations, sign-in and account linking.
 */
export function canonicalEmail(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}
