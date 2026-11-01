/** A value Insert data hands to the row or rule it was opened for. */
export type InsertedSource =
  | Readonly<{ kind: 'expression'; expression: string }>
  | Readonly<{ kind: 'workspace_variable'; name: string }>
  | Readonly<{ kind: 'node_failure'; nodeId: string; path: string }>
  | Readonly<{ kind: 'node_output'; nodeId: string; path: string }>
  | Readonly<{ kind: 'run_input'; path: string }>
  | Readonly<{ kind: 'structured_input'; port: string; path: string }>;
