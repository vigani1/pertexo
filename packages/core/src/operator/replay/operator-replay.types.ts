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
