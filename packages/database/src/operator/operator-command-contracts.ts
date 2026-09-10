export type GenericOperatorCommandResult = Readonly<{
  commandId: string;
  outcome: string;
  replayed: boolean;
  result: Readonly<Record<string, unknown>>;
  status: 'completed' | 'failed' | 'pending';
}>;

export interface OperatorCommandDatabaseOptions {
  readonly forbiddenRoles?: readonly string[];
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}
