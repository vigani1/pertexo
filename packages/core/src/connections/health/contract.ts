export type ConnectionHealthApplicationResult = Readonly<{
  kind: 'applied' | 'stale' | 'duplicate';
}>;

export type ApplyConnectionHealthObservationInput = Readonly<{
  workspaceId: string;
  observationId: string;
  delivery: Readonly<{ outboxEventId: string; payloadChecksum: string }>;
  signal?: AbortSignal;
}>;
