export type OAuth2Step = Readonly<{
  connectionId?: string;
  method: 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT';
  url: string;
  headers?: Readonly<Record<string, string>>;
  pagination?: Readonly<Record<string, unknown>>;
  /** Fewer attempts and a short delay keep a retried step's test quick. */
  retry?: Readonly<{ maximumAttempts: number; delayMillis: number }>;
  timeoutMillis?: number;
}>;

const hasBody = (method: OAuth2Step['method']): boolean =>
  method === 'PATCH' || method === 'POST' || method === 'PUT';

/** Manual start, then one HTTP Request called `call` using this connection. */
export function httpStepGraph(step: OAuth2Step) {
  return {
    settings: {},
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'call',
        label: 'call',
        definition: { key: 'http.request', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {
          method: step.method,
          url: step.url,
          headers: {
            ...(hasBody(step.method)
              ? { 'content-type': 'application/json' }
              : {}),
            ...step.headers,
          },
          timeoutMillis: step.timeoutMillis ?? 30_000,
          maxRedirects: 0,
          maxResponseBytes: 4_096,
          inlineResponseBytes: 4_096,
          ...(step.pagination === undefined
            ? {}
            : { pagination: step.pagination }),
        },
        inputMappings: hasBody(step.method)
          ? {
              body: {
                kind: 'literal',
                value: { encoding: 'utf8', value: '{"marker":"oauth2"}' },
              },
            }
          : {},
        connectionRefs:
          step.connectionId === undefined
            ? {}
            : { http_headers: step.connectionId },
        ...(step.retry === undefined ? {} : { retry: step.retry }),
      },
    ],
    edges: [
      {
        id: 'e0',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'call', port: 'in' },
      },
    ],
  };
}
