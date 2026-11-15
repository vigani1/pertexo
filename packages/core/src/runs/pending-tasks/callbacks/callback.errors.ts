export class CallbackCapacityError extends Error {
  override readonly name = 'CallbackCapacityError';
  constructor() {
    super(
      'This workspace has too many pending tasks. Wait for a task to finish before preparing another callback.',
    );
  }
}

export class CallbackResponseError extends Error {
  override readonly name = 'CallbackResponseError';
  constructor(readonly reason: 'resolved' | 'closed') {
    super('This callback cannot be accepted.');
  }
}

/** A preview's run is a rehearsal: it never hands out a live callback URL. */
export class CallbackPreviewRefusedError extends Error {
  override readonly name = 'CallbackPreviewRefusedError';
  constructor() {
    super('Previews cannot issue live callback URLs.');
  }
}
