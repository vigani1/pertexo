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
