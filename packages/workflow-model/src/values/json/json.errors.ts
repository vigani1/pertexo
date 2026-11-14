export class InvalidJsonValueError extends TypeError {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'InvalidJsonValueError';
  }
}
