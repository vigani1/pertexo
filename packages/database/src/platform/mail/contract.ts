export type SystemMailPurpose =
  | 'workspace_notice'
  | 'two_factor_disabled'
  | 'recovery_code_sign_in'
  | 'verification'
  | 'password_reset'
  | 'email_change_confirmation';

export type SealedSystemMailPayload = Readonly<{
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: string;
}>;

export interface SystemMailEnqueueStore {
  enqueue(input: SystemMailInput): Promise<void>;
  close(): Promise<void>;
}

export type SystemMailDeliveryClaim = Readonly<{
  id: string;
  purpose: SystemMailPurpose;
  expiresAt: Date;
  attemptCount: number;
  recoveredUnknown: boolean;
  leaseGeneration: number;
  leaseToken: string;
  sealedPayload: SealedSystemMailPayload;
}>;

export interface SystemMailDeliveryStore {
  claim(
    input: Readonly<{ workerId: string; limit: number }>,
  ): Promise<readonly SystemMailDeliveryClaim[]>;
  settle(
    input: Readonly<{
      id: string;
      leaseToken: string;
      leaseGeneration: number;
      outcome: 'submitted' | 'failed' | 'retry' | 'reconciliation_required';
      providerReference?: string;
      failureCode?: string;
      retryAt?: Date;
    }>,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export type SystemMailInput = Readonly<{
  id: string;
  purpose: SystemMailPurpose;
  expiresAt: Date;
  sealedPayload: SealedSystemMailPayload;
}>;
