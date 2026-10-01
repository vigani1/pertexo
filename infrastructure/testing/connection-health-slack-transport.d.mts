/** Test-only controlled transport; no application export. */
export function createConnectionHealthSlackTransport(controlOrigin: string): {
  execute(
    request: Readonly<{
      url: string;
      headers?: Readonly<Record<string, string>>;
      timeoutMillis: number;
      signal?: AbortSignal;
      beforeDispatch?: () => Promise<void>;
    }>,
  ): Promise<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
    bodyEncoding: 'utf8';
    finalUrl: string;
    redirectCount: number;
  }>;
};
