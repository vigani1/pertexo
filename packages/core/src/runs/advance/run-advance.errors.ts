/** A callable run's result could not be read from its retained outputs. */
export class RunResultUnavailableError extends Error {
  override readonly name = 'RunResultUnavailableError';
}
