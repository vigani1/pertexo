import { once } from 'node:events';
import { createServer } from 'node:http';
import { SLACK_API_ENDPOINTS } from '@pertexo/integrations/server';
import { slackBotToken } from './agent.fixture.js';

export async function fakeAgentSlack(dropResponse: boolean) {
  const calls: unknown[] = [];
  const server = createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== new URL(SLACK_API_ENDPOINTS.sendMessage).pathname ||
      request.headers.authorization !== `Bearer ${slackBotToken}`
    ) {
      response.writeHead(403).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      calls.push(JSON.parse(body) as unknown);
      if (dropResponse) response.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing fake Slack server address');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    calls,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    },
  };
}
