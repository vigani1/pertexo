export type LeasedOutboxEvent = Readonly<{
  aggregateId: string;
  aggregateType: string;
  availableAt: Date;
  id: string;
  jobName: string;
  leaseExpiresAt: Date;
  leaseOwner: string;
  leaseToken: string;
  payload: unknown;
  payloadChecksum: string;
  publishAttempts: number;
  schemaVersion: number;
  workspaceId: string;
}>;
