/** A failed publication either tries again or, for a row that can never publish, ends. */
export type ReleaseInput = Readonly<{
  id: string;
  leaseToken: string;
  errorCode: string;
}> &
  (
    | Readonly<{ disposition: 'retry'; retryAt: Date }>
    | Readonly<{ disposition: 'fail' }>
  );

export interface ClaimInput {
  enabledJobNames: string[];
  leaseDurationMillis: number;
  leaseOwner: string;
  leaseToken: string;
  limit: number;
}
