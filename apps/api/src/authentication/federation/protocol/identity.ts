import { userDisplayNameSchema } from '@pertexo/contracts';
import { canonicalEmail } from '@pertexo/workflow-model';
import { z } from 'zod';

const subject = z.string().min(1).max(255);
const email = z.string().transform(canonicalEmail).pipe(z.email().max(320));
export type OrganizationIdentity = Readonly<{
  subject: string;
  email: string;
  displayName: string;
}>;

/** Only verified protocol claims enter this boundary; provider tokens stay outside. */
export function organizationIdentity(
  subjectClaim: unknown,
  emailClaim: unknown,
  nameClaim: unknown,
): OrganizationIdentity {
  const name = userDisplayNameSchema.safeParse(nameClaim);
  return {
    subject: subject.parse(subjectClaim),
    email: email.parse(emailClaim),
    displayName: name.success ? name.data : 'Pertexo member',
  };
}
