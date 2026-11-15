export class WorkerEnvironmentValueError extends TypeError {
  public override readonly name = 'WorkerEnvironmentValueError';
}

export class WorkerConfigurationError extends Error {
  public override readonly name = 'WorkerConfigurationError';
}
