import type { DatabasePoolRole } from './policy.js';

/**
 * A fresh connection already carried app.* settings, so every transaction on
 * the pool would inherit them. Platform and multi-workspace transactions set
 * no tenant context of their own, so they would run inside it.
 */
export class InheritedSessionContextError extends Error {
  public override readonly name = 'InheritedSessionContextError';

  public constructor(
    public readonly role: DatabasePoolRole,
    public readonly settings: readonly string[],
  ) {
    super(
      `PostgreSQL ${role} pool refused: a fresh connection already carries ${settings.join(', ')}. ` +
        'Remove it from PGOPTIONS, the connection string options, or the role or database defaults.',
    );
  }
}
