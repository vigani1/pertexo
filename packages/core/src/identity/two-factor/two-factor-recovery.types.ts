export type RecoveryUser = Readonly<{ email: string; displayName: string }>;

export type TwoFactorRecoveryResult = Readonly<{
  status: 'disabled' | 'already_off' | 'not_found';
  email: string;
}>;
