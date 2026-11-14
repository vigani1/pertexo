/** A stored executable's control metadata doesn't have the compiled shape. */
export class ExecutableControlGraphInvalidError extends TypeError {
  public override readonly name = 'ExecutableControlGraphInvalidError';
}

/** A stored executable nests more nodes than any compiled graph can hold. */
export class ExecutableControlGraphTooLargeError extends RangeError {
  public override readonly name = 'ExecutableControlGraphTooLargeError';
}
