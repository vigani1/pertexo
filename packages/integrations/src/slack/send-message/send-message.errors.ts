import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

export class SlackSendMessageExecutorError extends NodeExecutorFailure {
  public override readonly name = 'SlackSendMessageExecutorError';
}
