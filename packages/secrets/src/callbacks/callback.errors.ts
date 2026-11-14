/** The callback key or web origin settings can't sign or verify callbacks. */
export class CallbackKeyConfigurationError extends Error {
  public override readonly name = 'CallbackKeyConfigurationError';
}
