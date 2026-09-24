import { workspaceInvitationCreateRequestSchema } from '@pertexo/contracts/schemas/identity-workspace';

export const MAX_INVITES_AT_ONCE = 20;

export type AbsorbedAddresses = Readonly<{
  emails: readonly string[];
  /** Text that isn't an address yet; it stays in the input to fix. */
  rest: string;
  error: string | undefined;
}>;

function isAddress(value: string): boolean {
  return workspaceInvitationCreateRequestSchema.shape.email.safeParse(value)
    .success;
}

/** Moves every address in `text` into the list; returns what's left. */
export function absorbAddresses(
  emails: readonly string[],
  text: string,
): AbsorbedAddresses {
  const next = [...emails];
  const rejected: string[] = [];
  let error: string | undefined;
  for (const token of text.split(/[\s,;]+/u).filter(Boolean)) {
    if (!isAddress(token)) {
      rejected.push(token);
      error ??= `“${token}” isn’t a complete email address, like name@company.com.`;
    } else if (
      next.some((email) => email.toLowerCase() === token.toLowerCase())
    ) {
      continue;
    } else if (next.length >= MAX_INVITES_AT_ONCE) {
      rejected.push(token);
      error ??= `Invite up to ${String(MAX_INVITES_AT_ONCE)} people at a time.`;
    } else next.push(token);
  }
  return { emails: next, rest: rejected.join(', '), error };
}
