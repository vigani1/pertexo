import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

export const model = 'local-extraction-model';
export const key = 'fake-editor-model-key';
export const baseUrl = 'https://model.provider.test/v1';

export async function openModelProvider(
  scriptedResponses?: readonly unknown[],
) {
  const port = process.env.PERTEXO_LIVE_PROVIDER_PORT;
  if (port === undefined) throw new Error('Use the owned product fixture');
  const probes: string[] = [];
  const calls: unknown[] = [];
  let refuse = false;
  let answer: unknown = { order: 'order-17' };
  const server = createServer((request, response) => {
    void respond(request, response).catch(() => {
      response.writeHead(500).end('{}');
    });
  });

  async function respond(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401).end('{}');
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      probes.push(request.url);
      response.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end('{}');
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    calls.push(JSON.parse(body) as unknown);
    const scripted = scriptedResponses?.[calls.length - 1];
    if (scriptedResponses !== undefined) {
      if (scripted === undefined) response.writeHead(500).end('{}');
      else response.end(JSON.stringify(scripted));
      return;
    }
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: refuse ? 'content_filter' : 'stop',
            message: { content: JSON.stringify(answer) },
          },
        ],
        usage: { prompt_tokens: 23, completion_tokens: refuse ? null : 7 },
      }),
    );
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), '127.0.0.1', resolve);
  });
  return {
    calls,
    probes,
    answerWith(value: unknown) {
      answer = value;
    },
    refuse() {
      refuse = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
