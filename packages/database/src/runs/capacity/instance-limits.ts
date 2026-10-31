/** An instance's limits when its operator sets nothing, sized for a real server. */
export const DEFAULT_INSTANCE_LIMITS = Object.freeze({
  activeRunLimit: 20,
  queuedRunLimit: 10_000,
  artifactCountLimit: 10_000,
  webhookEndpointBurstLimit: 600,
});

/** What the database enforces per workspace; the webhook burst is passed per call. */
export type InstanceCapacity = Readonly<{
  activeRunLimit: number;
  queuedRunLimit: number;
  artifactCountLimit: number;
}>;
