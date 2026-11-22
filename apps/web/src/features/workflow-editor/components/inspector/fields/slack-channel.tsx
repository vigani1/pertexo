import { Field, FieldDescription } from '@/components/ui/field';
import {
  channelName,
  describeChannel,
  slackChannelLookupRequest,
} from '@/features/failure-notifications/public';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import type { WorkflowNode } from '../../../model/graph/scopes';
import {
  parseChannelId,
  SLACK_CONNECTION,
  stepChannel,
  withChannelId,
} from '../../../model/inspector/slack-channel';
import { LookupValueField } from './lookup-value';

const FIELD = {
  key: 'channelId',
  name: 'slackChannelId',
  label: 'Channel ID',
  description:
    'The channel the message is posted to, like C0123456789. Find it in the channel’s details in Slack.',
  needsConnection:
    'Choose a Slack connection above to show this channel’s name.',
};

export function SlackChannelField({
  node,
  form,
  lookup,
}: Readonly<{
  node: WorkflowNode;
  form: NodeFormApi;
  lookup: NonNullable<NodeFormApi['lookup']>['scope'];
}>) {
  const channel = stepChannel(node);
  if (channel.kind === 'mapped')
    return (
      <Field>
        <p className="text-sm font-medium">Channel</p>
        <FieldDescription>
          This step’s channel comes from another source on the Inputs tab, so
          its name isn’t shown here.
        </FieldDescription>
      </Field>
    );
  return (
    <LookupValueField
      field={FIELD}
      value={channel.channelId}
      connectionId={node.connectionRefs[SLACK_CONNECTION]}
      scope={lookup}
      form={form}
      lookup={(value) => slackChannelLookupRequest([value])}
      parse={parseChannelId}
      commit={(value) => {
        form.commit(
          (current) => ({
            inputMappings: withChannelId(current.inputMappings, value),
          }),
          `${form.nodeId}:channel`,
        );
      }}
      describe={(value, item, failed) => {
        const name = item === undefined ? undefined : channelName(item);
        const { target, note } = describeChannel(
          value,
          failed && name === undefined
            ? { status: 'unresolved', reason: 'lookup_failed' }
            : name,
        );
        return {
          label: name?.status === 'resolved' ? target : undefined,
          note,
        };
      }}
    />
  );
}
