export function authenticationMailAssociatedData(
  purpose: string,
  id: string,
  expiresAt: Date,
): string {
  return `pertexo/authentication-mail/${purpose}/${id}/${expiresAt.toISOString()}`;
}
