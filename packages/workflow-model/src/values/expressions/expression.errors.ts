/** The data offered to an expression isn't a context it may read. */
export class ExpressionContextInvalidError extends TypeError {
  public override readonly name = 'ExpressionContextInvalidError';
  public constructor() {
    super('invalid expression context');
  }
}
