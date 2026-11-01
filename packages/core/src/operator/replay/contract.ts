export class OperatorRunReplayMismatchError extends Error {
  public constructor() {
    super('Run replay delivery does not match its durable request');
    this.name = 'OperatorRunReplayMismatchError';
  }
}

export class OperatorRunReplayNotExecutableError extends Error {
  public constructor() {
    super('Run replay target is not executable by this worker');
    this.name = 'OperatorRunReplayNotExecutableError';
  }
}

export type ReplayDeliveryInput = Readonly<{
  commandId: string;
  delivery: Readonly<{ outboxEventId: string; payloadChecksum: string }>;
  workspaceId: string;
  signal?: AbortSignal | undefined;
}>;

export type FailReplayInput = Readonly<{
  commandId: string;
  safeErrorCode: string;
  workspaceId: string;
}>;
