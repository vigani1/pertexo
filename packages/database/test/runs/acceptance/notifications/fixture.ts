export function hasPostgresConstraint(
  expected: string,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ('constraint' in current && current.constraint === expected)
        return true;
      current = current.cause;
    }
    return false;
  };
}
