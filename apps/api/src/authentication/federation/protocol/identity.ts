import { userDisplayNameSchema } from '@pertexo/contracts';
import { canonicalEmail } from '@pertexo/workflow-model';
import { z } from 'zod';

import { FederationProofError } from './failure.js';

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
  const name = userDisplayNameSchema.safeParse(nameClaim),
    parsedSubject = subject.safeParse(subjectClaim),
    parsedEmail = email.safeParse(emailClaim);
  if (!parsedSubject.success || !parsedEmail.success)
    throw new FederationProofError(
      'identity_claims',
      'Organization identity claims are invalid',
    );
  return {
    subject: parsedSubject.data,
    email: parsedEmail.data,
    displayName: name.success ? name.data : 'Pertexo member',
  };
}
