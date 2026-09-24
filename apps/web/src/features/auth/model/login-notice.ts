import type { NoticeTone } from '@/components/ui/notice';
import type { StatusTone } from '@/components/ui/status';

/** What an email link or provider callback told the sign-in page. */
export type LoginLinkOutcome = Readonly<{
  emailChanged?: true;
  emailChangePending?: true;
  verificationInvalid?: true;
  linkReauthenticate?: true;
  migrationReauthenticate?: true;
  migrationFailed?: true;
  verified?: true;
  socialError?: true;
}>;

export type LoginNotice = Readonly<{
  tone: NoticeTone;
  /** A more specific thread than the tone's own, e.g. waiting. */
  glyph?: Extract<StatusTone, 'waiting'>;
  text: string;
  /** An expired verification link can ask for a fresh one. */
  offersNewVerificationLink?: true;
}>;

/** The one status line the sign-in lens shows for a returning link. */
export function loginNoticeFrom(
  outcome: LoginLinkOutcome,
): LoginNotice | undefined {
  if (outcome.emailChanged === true)
    return {
      tone: 'success',
      text: 'Your email changed. Sign in with your new address.',
    };
  if (outcome.emailChangePending === true)
    return {
      tone: 'info',
      glyph: 'waiting',
      text: 'Old address confirmed. Check your new address for the final verification link.',
    };
  if (outcome.verificationInvalid === true)
    return {
      tone: 'destructive',
      text: 'That verification link is invalid, expired, or already used.',
      offersNewVerificationLink: true,
    };
  if (outcome.linkReauthenticate === true)
    return {
      tone: 'warning',
      text: 'Sign in again, then check your sign-in methods. A link that already finished isn’t repeated.',
    };
  if (outcome.migrationReauthenticate === true)
    return {
      tone: 'warning',
      text: 'Sign in with your new method, then check your workspaces.',
    };
  if (outcome.migrationFailed === true)
    return {
      tone: 'destructive',
      text: 'Account recovery didn’t finish and no access moved. Start again, or ask your Pertexo operator to review your account.',
    };
  if (outcome.verified === true)
    return { tone: 'success', text: 'Email verified. You can sign in now.' };
  if (outcome.socialError === true)
    return {
      tone: 'destructive',
      text: 'Sign-in with that provider didn’t finish. Try again, or use another method.',
    };
  return undefined;
}
