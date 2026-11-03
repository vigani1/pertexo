import type { ApiProblemIssue } from '@pertexo/contracts';

/** A resource operation must not disclose its workspace's authorization state. */
export class HiddenResourceError extends Error {
  public override readonly name = 'HiddenResourceError';
}

/** The message is supplied by the request boundary, never a provider failure. */
export class InvalidRequestError extends Error {
  public override readonly name = 'InvalidRequestError';
}

export class WorkflowTestPreparationError extends Error {
  public override readonly name = 'WorkflowTestPreparationError';

  public constructor(
    message: string,
    public readonly issues?: readonly ApiProblemIssue[],
  ) {
    super(message);
  }
}

export class FormAdmissionError extends Error {
  public override readonly name = 'FormAdmissionError';

  public constructor(
    public readonly reason: 'queue_full' | 'workspace_closed',
    public readonly retryAfterSeconds?: number,
  ) {
    super('Form submission could not be admitted');
  }
}
