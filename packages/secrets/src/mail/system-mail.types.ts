import type { SystemMailPurpose } from '@pertexo/database/schema';

export type { SystemMailPurpose };

import type { ApplicationSealedSecret } from '../encryption/application-secret-envelope.js';
export type SealedSystemMailPayload = ApplicationSealedSecret;

export type SystemMailInput = Readonly<{
  id: string;
  purpose: SystemMailPurpose;
  expiresAt: Date;
  sealedPayload: SealedSystemMailPayload;
}>;

export type SystemMailClaimRequest = Readonly<{
  workerId: string;
  limit: number;
}>;

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

/** Only a retry has a next attempt time, and a retry always has one. */
export type SystemMailSettlement = Readonly<{
  id: string;
  leaseToken: string;
  leaseGeneration: number;
  failureCode?: string;
}> &
  (
    | Readonly<{
        outcome: 'submitted' | 'failed' | 'reconciliation_required';
        providerReference?: string;
        retryAt?: undefined;
      }>
    | Readonly<{
        outcome: 'retry' | 'payload_unavailable';
        retryAt: Date;
        providerReference?: undefined;
      }>
  );
