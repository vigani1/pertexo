export type NodeCallbackTarget = Readonly<{
  nodeId: string;
  timeoutSeconds: number;
  authentication: Readonly<{
    mode: 'signed' | 'secret_url' | 'header_secret';
    allowedOrigins: readonly string[];
    headerName?: string;
  }>;
}>;
export type NodeCallbackBindings = Readonly<
  Record<string, Readonly<{ url: string; secret?: string }>>
>;
export interface NodeCallbackRuntime {
  prepare(
    input: Readonly<{
      targets: readonly NodeCallbackTarget[];
      signal: AbortSignal;
    }>,
  ): Promise<NodeCallbackBindings>;
  sensitiveValues(): readonly string[];
}
