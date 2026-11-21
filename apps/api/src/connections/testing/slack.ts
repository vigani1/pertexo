import { CONNECTION_TEST_TIMEOUT_MILLIS } from '@pertexo/contracts';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import type { ConnectionSlackClient } from '../ports.js';
import { slackTestOutcome } from './outcomes.js';

export async function testSlackConnection(
  client: Pick<ConnectionSlackClient, 'authTest' | 'sendMessage'>,
  botToken: string,
  {
    channelId,
    signal,
    beforeDispatch,
  }: Readonly<{
    channelId: string;
    signal: AbortSignal;
    beforeDispatch: () => Promise<void>;
  }>,
) {
  const call = {
    botToken,
    timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
    signal,
    beforeDispatch,
  };
  if (client.sendMessage === undefined)
    throw new ConnectionSecretEncryptionError();
  return slackTestOutcome(
    await client.sendMessage({
      ...call,
      channelId,
      text: 'This is a test of your Pertexo alert destination. No workflow failed.',
    }),
  );
}
