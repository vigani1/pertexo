export interface ReleaseInput {
  id: string;
  leaseToken: string;
  errorCode: string;
  maxAttempts: number;
  retryAt: Date;
}

export interface ClaimInput {
  enabledJobNames: string[];
  leaseDurationMillis: number;
  leaseOwner: string;
  leaseToken: string;
  limit: number;
  maxAttempts: number;
}
