export class UnknownQueueJobError extends Error {
  public override readonly name = 'UnknownQueueJobError';

  public constructor(jobName: unknown) {
    super(`Unknown queue job name: ${String(jobName)}`);
  }
}
