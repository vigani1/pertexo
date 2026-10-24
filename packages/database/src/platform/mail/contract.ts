import type { z } from 'zod';

import type { purpose, sealedPayload } from './input.js';

export type SystemMailPurpose = z.infer<typeof purpose>;

export type SealedSystemMailPayload = z.infer<typeof sealedPayload>;

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
