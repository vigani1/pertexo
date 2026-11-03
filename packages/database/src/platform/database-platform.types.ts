export type DatabaseReadiness = Readonly<{
  migrationHead: string;
  postgresMajor: number;
  role: string;
}>;

/** What the database enforces per workspace; the webhook burst is passed per call. */
export type InstanceCapacity = Readonly<{
  activeRunLimit: number;
  queuedRunLimit: number;
  artifactCountLimit: number;
}>;
