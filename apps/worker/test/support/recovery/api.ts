import { randomUUID } from 'node:crypto';

export type ApiResponse = Readonly<{
  etag: string | null;
  json: unknown;
  status: number;
}>;

const PASSWORD = 'Recovery-test-Pw-1234';
const PUBLISH_ATTEMPTS = 10;

const idOf = (value: unknown, key: string): string => {
  const record = value as Record<string, { id?: string } | string | undefined>;
  const direct = record.id;
  if (typeof direct === 'string') return direct;
  const nested = record[key];
  if (typeof nested === 'object' && typeof nested.id === 'string')
    return nested.id;
  throw new Error(`Response has no ${key} id: ${JSON.stringify(value)}`);
};

/** One signed-in browser session against the real API process. */
export class ApiClient {
  private readonly cookies = new Map<string, string>();

  public constructor(
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}

  public async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<ApiResponse> {
    const cookie = [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    const csrf = this.cookies.get('pertexo_csrf');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        origin: this.webOrigin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie === '' ? {} : { cookie }),
        ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const split = pair.indexOf('=');
      this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const text = await response.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // Not every response is JSON; the status tells the caller what happened.
    }
    return {
      etag: response.headers.get('etag'),
      json,
      status: response.status,
    };
  }

  public async signUp(email: string): Promise<void> {
    await this.expect(
      201,
      200,
    )(
      this.call('POST', '/v1/auth/sign-up/email', {
        email,
        password: PASSWORD,
        name: 'Recovery test',
      }),
    );
  }

  public async signIn(email: string): Promise<void> {
    await this.expect(200)(
      this.call('POST', '/v1/auth/sign-in/email', {
        email,
        password: PASSWORD,
      }),
    );
  }

  public async createWorkspace(name: string): Promise<string> {
    const created = await this.expect(
      200,
      201,
    )(
      this.call(
        'POST',
        '/v1/workspaces',
        { name, slug: `${name}-${randomUUID().slice(0, 8)}` },
        { 'idempotency-key': randomUUID() },
      ),
    );
    return idOf(created.json, 'workspace');
  }

  /** Creates, saves and publishes a workflow; returns its id. */
  public async publish(
    workspaceId: string,
    name: string,
    graph: unknown,
  ): Promise<string> {
    const root = `/v1/workspaces/${workspaceId}/workflows`;
    const created = await this.expect(
      200,
      201,
    )(this.call('POST', root, { name }, { 'idempotency-key': randomUUID() }));
    const workflowId = idOf(created.json, 'workflow');
    const draft = await this.expect(200)(
      this.call('GET', `${root}/${workflowId}/draft`),
    );
    const saved = await this.expect(200)(
      this.call(
        'PUT',
        `${root}/${workflowId}/draft`,
        { graph },
        { 'if-match': draft.etag ?? '' },
      ),
    );
    // Validation answers 503 when its worker thread is starved on a loaded host,
    // and its problem detail asks the caller to retry.
    for (let attempt = 1; ; attempt += 1) {
      const published = await this.call(
        'POST',
        `${root}/${workflowId}/publish`,
        undefined,
        { 'if-match': saved.etag ?? '', 'idempotency-key': randomUUID() },
      );
      if (published.status !== 503 || attempt === PUBLISH_ATTEMPTS) {
        await this.expect(200, 201)(Promise.resolve(published));
        return workflowId;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  public async startRun(
    workspaceId: string,
    workflowId: string,
  ): Promise<string> {
    const started = await this.expect(
      200,
      201,
      202,
    )(
      this.call(
        'POST',
        `/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
        { input: {} },
        { 'idempotency-key': randomUUID() },
      ),
    );
    return idOf(started.json, 'run');
  }

  public async cancelRun(
    workspaceId: string,
    runId: string,
  ): Promise<ApiResponse> {
    return this.call(
      'POST',
      `/v1/workspaces/${workspaceId}/runs/${runId}/cancel`,
      {},
      { 'idempotency-key': randomUUID() },
    );
  }

  public async readRun(
    workspaceId: string,
    runId: string,
  ): Promise<Record<string, unknown>> {
    const read = await this.expect(200)(
      this.call('GET', `/v1/workspaces/${workspaceId}/runs/${runId}`),
    );
    const body = read.json as { run?: Record<string, unknown> };
    return body.run ?? (read.json as Record<string, unknown>);
  }

  public async createSlackConnection(
    workspaceId: string,
    botToken: string,
  ): Promise<string> {
    const created = await this.expect(201)(
      this.call(
        'POST',
        `/v1/workspaces/${workspaceId}/connections`,
        {
          providerKey: 'slack',
          name: `Slack ${randomUUID().slice(0, 8)}`,
          credential: { type: 'slack_bot_token', botToken },
        },
        { 'idempotency-key': randomUUID() },
      ),
    );
    return idOf(created.json, 'connection');
  }

  /** Sends this workflow's failure alerts to a Slack channel. */
  public async alertToSlack(
    workspaceId: string,
    workflowId: string,
    connectionId: string,
    channelId: string,
  ): Promise<void> {
    const destination = await this.expect(201)(
      this.call(
        'POST',
        `/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        { kind: 'slack', connectionId, channelId },
        { 'idempotency-key': randomUUID() },
      ),
    );
    await this.expect(204)(
      this.call(
        'PUT',
        `/v1/workspaces/${workspaceId}/workflows/${workflowId}/failure-notification-policy`,
        { destinationId: idOf(destination.json, 'destination') },
        { 'idempotency-key': randomUUID() },
      ),
    );
  }

  public async setErrorWorkflow(
    workspaceId: string,
    workflowId: string,
    targetWorkflowId: string,
  ): Promise<void> {
    const path = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/error-workflow`;
    const current = await this.expect(200)(this.call('GET', path));
    const { revision } = current.json as { revision: number };
    await this.expect(200)(
      this.call(
        'PUT',
        path,
        { targetWorkflowId, expectedRevision: revision },
        { 'idempotency-key': randomUUID() },
      ),
    );
  }

  public async invite(workspaceId: string, email: string): Promise<string> {
    const invited = await this.expect(202)(
      this.call(
        'POST',
        `/v1/workspaces/${workspaceId}/invitations`,
        { email, role: 'viewer' },
        { 'idempotency-key': randomUUID() },
      ),
    );
    return idOf(invited.json, 'invitation');
  }

  private expect(...statuses: readonly number[]) {
    return async (pending: Promise<ApiResponse>): Promise<ApiResponse> => {
      const response = await pending;
      if (!statuses.includes(response.status))
        throw new Error(
          `API answered ${String(response.status)}: ${JSON.stringify(response.json).slice(0, 400)}`,
        );
      return response;
    };
  }
}
