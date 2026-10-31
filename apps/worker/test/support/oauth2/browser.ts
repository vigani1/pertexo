import { ApiClient, type ApiResponse } from '../recovery/api.js';

export type BrowserResponse = ApiResponse & Readonly<{ headers: Headers }>;

/** What a top-level navigation answers, with its redirect not followed. */
export type Navigation = Readonly<{
  headers: Headers;
  location: string | null;
  status: number;
}>;

/**
 * One person's browser against the real API: it keeps cookies the way a browser
 * does and can arrive from another site. Its client address keeps its rate limits
 * apart from every other browser's, because they are real and counted per address.
 */
export class OAuth2Browser extends ApiClient {
  private readonly jar = new Map<string, string>();

  public constructor(
    baseUrl: string,
    webOrigin: string,
    private readonly clientAddress: string,
  ) {
    super(baseUrl, webOrigin);
  }

  public override async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<BrowserResponse> {
    const cookie = this.cookieHeader(() => true);
    const csrf = this.jar.get('pertexo_csrf');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        origin: this.webOrigin,
        'x-forwarded-for': this.clientAddress,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie === '' ? {} : { cookie }),
        ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    this.keepCookies(response.headers);
    const text = await response.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // Not every response is JSON; the status tells the caller what happened.
    }
    return {
      etag: response.headers.get('etag'),
      headers: response.headers,
      json,
      status: response.status,
    };
  }

  /**
   * Arriving from another site: no Origin or CSRF header, and only the cookies a
   * cross-site navigation carries to this path, chosen by the caller.
   */
  public async navigate(
    pathAndQuery: string,
    sendCookie: (name: string) => boolean,
    signal?: AbortSignal,
  ): Promise<Navigation> {
    const cookie = this.cookieHeader(sendCookie);
    const response = await fetch(`${this.baseUrl}${pathAndQuery}`, {
      redirect: 'manual',
      headers: {
        'x-forwarded-for': this.clientAddress,
        ...(cookie === '' ? {} : { cookie }),
      },
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    this.keepCookies(response.headers);
    await response.body?.cancel();
    return {
      headers: response.headers,
      location: response.headers.get('location'),
      status: response.status,
    };
  }

  public cookieValue(name: string): string | undefined {
    return this.jar.get(name);
  }

  public setCookie(name: string, value: string): void {
    this.jar.set(name, value);
  }

  private cookieHeader(send: (name: string) => boolean): string {
    return [...this.jar]
      .filter(([name]) => send(name))
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  private keepCookies(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const split = pair.indexOf('=');
      const name = pair.slice(0, split);
      const value = pair.slice(split + 1);
      // A browser drops a cookie cleared with no value or a lifetime of zero.
      if (value === '' || /;\s*max-age=0\b/iu.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
}
