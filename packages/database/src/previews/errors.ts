export class PreviewDeliveryMismatchError extends Error {
  public override readonly name = 'PreviewDeliveryMismatchError';
  public constructor() {
    super('Preview delivery does not match its durable outbox aggregate');
  }
}

export class PreviewAttemptStateError extends Error {
  public readonly code: string;
  public constructor(code: string) {
    super(`Preview attempt cannot continue: ${code}`);
    this.code = code;
    this.name = 'PreviewAttemptStateError';
  }
}

export class PreviewIdempotencyConflictError extends Error {
  public override readonly name = 'PreviewIdempotencyConflictError';
  public constructor() {
    super('request.idempotency_conflict');
  }
}

export class PreviewAcceptanceCorruptError extends Error {
  public override readonly name = 'PreviewAcceptanceCorruptError';
  public constructor() {
    super('Persisted preview acceptance is incomplete or invalid');
  }
}

export class PreviewAdmissionDeniedError extends Error {
  public override readonly name = 'PreviewAdmissionDeniedError';
  public constructor(reason: 'actor' | 'deadline' | 'draft' | 'retention') {
    super(`preview.${reason}_denied`);
  }
}

export class PriorPreviewInputUnavailableError extends Error {
  public override readonly name = 'PriorPreviewInputUnavailableError';
  public constructor() {
    super('preview.input_unavailable');
  }
}
