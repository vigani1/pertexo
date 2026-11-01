import type { SystemMailInput } from '@pertexo/database/platform';

export type RecoveryUser = Readonly<{ email: string; displayName: string }>;

export type TwoFactorRecoveryResult = Readonly<{
  status: 'disabled' | 'already_off' | 'not_found';
  email: string;
}>;

export interface TwoFactorRecoveryStore {
  disable(
    email: string,
    prepareNotice: (user: RecoveryUser) => SystemMailInput | undefined,
  ): Promise<TwoFactorRecoveryResult>;
  close(): Promise<void>;
}
