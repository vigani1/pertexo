const RUN_EVENT_MESSAGES = {
  'invalid-json': 'A run event contained invalid JSON.',
  'metadata-mismatch': 'A run event ID or type did not match its payload.',
  'sequence-gap': 'The run event stream skipped an event.',
};

export class RunEventError extends Error {
  constructor(
    readonly kind: keyof typeof RUN_EVENT_MESSAGES,
    options?: ErrorOptions,
  ) {
    super(RUN_EVENT_MESSAGES[kind], options);
    this.name = 'RunEventError';
  }
}
