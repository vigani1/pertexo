import { useState } from 'react';
import { Field, FieldDescription, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  channelKey,
  describeChannel,
  useSlackChannelNames,
} from '@/features/failure-notifications/channel-names.public';
import type { ApiClient } from '@/lib/api/client';
import { fieldControlId, type NodeFormApi } from '../../model/node-form';
import type { WorkflowNode } from '../../model/graph-scopes';
import {
  parseChannelId,
  SLACK_CONNECTION,
  stepChannel,
  withChannelId,
} from '../../model/slack-channel';
import { useLiveField } from '../../use-live-field';

/** Who looks channel names up, and whether their role lets them. */
export type ChannelLookupScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  /** Looking names up uses the connection, so it needs `connection:use`. */
  enabled: boolean;
}>;

const CHANNEL_FIELD = 'channelId';

/**
 * The Slack step's channel in Setup: its ID, applied as you type, with the
 * channel's `#name` beside it once the chosen connection can look it up
 * (ADR 046), or the reason it can't. A channel another source provides is
 * edited on the Inputs tab instead.
 */
export function SlackChannelField({
  node,
  form,
  lookup,
}: Readonly<{
  node: WorkflowNode;
  form: NodeFormApi;
  lookup: ChannelLookupScope;
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
    <ChannelIdField
      channelId={channel.channelId}
      connectionId={node.connectionRefs[SLACK_CONNECTION]}
      form={form}
      lookup={lookup}
    />
  );
}

function ChannelIdField({
  channelId,
  connectionId,
  form,
  lookup,
}: Readonly<{
  channelId: string | undefined;
  connectionId: string | undefined;
  form: NodeFormApi;
  lookup: ChannelLookupScope;
}>) {
  const id = fieldControlId(form.nodeId, CHANNEL_FIELD);
  const nameId = `${id}-name`;
  // Names are looked up once people leave the field, not per keystroke:
  // the lookup shares the connection test's rate limit.
  const [editing, setEditing] = useState(false);
  const live = useLiveField<string | undefined>({
    value: channelId,
    format: (value) => value ?? '',
    parse: parseChannelId,
    commit: (value) => {
      form.commit(
        (node) => ({
          inputMappings: withChannelId(node.inputMappings, value),
        }),
        `${form.nodeId}:channel`,
      );
    },
    onScratchChange: (scratch) => {
      form.reportScratch(CHANNEL_FIELD, scratch);
    },
  });
  const channel =
    editing || channelId === undefined || connectionId === undefined
      ? undefined
      : { connectionId, channelId };
  const names = useSlackChannelNames({
    ...lookup,
    channels: channel === undefined ? [] : [channel],
  });
  const name =
    channel === undefined
      ? undefined
      : names.get(channelKey(channel.connectionId, channel.channelId));
  const shown =
    channel === undefined
      ? undefined
      : describeChannel(channel.channelId, name);
  const pending = lookup.enabled && channel !== undefined && name === undefined;
  return (
    <LabelledField
      id={id}
      label="Channel ID"
      description="The channel the message is posted to, like C0123456789. Find it in the channel’s details in Slack."
      error={live.error}
      describedBy={nameId}
      feedback={
        <ChannelNote
          note={shown?.note}
          needsConnection={
            channelId !== undefined && connectionId === undefined && !editing
          }
        />
      }
    >
      {(control) => (
        <div className="flex items-center gap-2">
          <Input
            {...control}
            name="slackChannelId"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 font-mono"
            value={live.text}
            disabled={!form.editable}
            onBlur={() => {
              setEditing(false);
              live.blur();
            }}
            onChange={(event) => {
              // Only a changed value waits for the field to be left; a
              // focused but unchanged channel keeps showing its name.
              setEditing(true);
              live.change(event.currentTarget.value);
            }}
          />
          <span
            id={nameId}
            aria-live="polite"
            className="max-w-[45%] shrink-0 truncate font-mono text-xs text-muted-foreground"
          >
            {name?.status === 'resolved' ? (
              <span className="text-foreground">{shown?.target}</span>
            ) : pending ? (
              'Looking up…'
            ) : null}
          </span>
        </div>
      )}
    </LabelledField>
  );
}

function ChannelNote({
  note,
  needsConnection,
}: Readonly<{ note: string | undefined; needsConnection: boolean }>) {
  if (needsConnection)
    return (
      <p className="text-xs text-muted-foreground">
        Choose a Slack connection above to show this channel’s name.
      </p>
    );
  return note === undefined ? null : (
    <p className="text-xs text-muted-foreground">{note}</p>
  );
}
