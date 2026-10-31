import type { NoticeTone } from '@/components/ui/notice';
import type { StatusTone } from '@/components/ui/status';

/** What an email link or provider callback told the sign-in page. */
export type LoginLinkOutcome = Readonly<{
  emailChanged?: true;
  emailChangePending?: true;
  verificationInvalid?: true;
  signUpClosed?: true;
  linkReauthenticate?: true;
  migrationReauthenticate?: true;
  migrationFailed?: true;
  verified?: true;
  socialError?: true;
  ssoError?: true;
}>;

export type LoginNotice = Readonly<{
  tone: NoticeTone;
  /** A more specific thread than the tone's own, e.g. waiting. */
  glyph?: Extract<StatusTone, 'waiting'>;
  text: string;
  /** An expired verification link can ask for a fresh one. */
  offersNewVerificationLink?: true;
}>;

/** In order of precedence: a link says one thing, and the first that applies wins. */
const NOTICES: readonly (readonly [keyof LoginLinkOutcome, LoginNotice])[] = [
  [
    'emailChanged',
    {
      tone: 'success',
      text: 'Your email changed. Sign in with your new address.',
    },
  ],
  [
    'emailChangePending',
    {
      tone: 'info',
      glyph: 'waiting',
      text: 'Old address confirmed. Check your new address for the final verification link.',
    },
  ],
  [
    'verificationInvalid',
    {
      tone: 'destructive',
      text: 'That verification link is invalid, expired, or already used.',
      offersNewVerificationLink: true,
    },
  ],
  [
    'signUpClosed',
    {
      tone: 'warning',
      text: 'New accounts here are by invitation, so yours wasn’t created. Ask someone in the workspace to invite this address, then open the link again.',
    },
  ],
  [
    'linkReauthenticate',
    {
      tone: 'warning',
      text: 'For your security, sign in again, then check your sign-in methods. If the new one is listed there, it’s already linked.',
    },
  ],
  [
    'migrationReauthenticate',
    {
      tone: 'warning',
      text: 'Sign in with your new method, then check your workspaces.',
    },
  ],
  [
    'migrationFailed',
    {
      tone: 'destructive',
      text: 'Account recovery didn’t finish and no access moved. Start again, or ask your Pertexo operator to review your account.',
    },
  ],
  [
    'verified',
    { tone: 'success', text: 'Email verified. You can sign in now.' },
  ],
  [
    'ssoError',
    {
      tone: 'warning',
      text: 'Organization sign-in did not finish. Try again, or contact your workspace owner. The recovery owner can still use their password.',
    },
  ],
  [
    'socialError',
    {
      tone: 'destructive',
      text: 'Sign-in with that provider didn’t finish. Try again, or use another method.',
    },
  ],
];

/** The one status line the sign-in lens shows for a returning link. */
export function loginNoticeFrom(
  outcome: LoginLinkOutcome,
): LoginNotice | undefined {
  return NOTICES.find(([flag]) => outcome[flag] ?? false)?.[1];
}
