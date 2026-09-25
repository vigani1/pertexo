import { slackChannelLookupIdSchema } from '@pertexo/contracts/schemas/connections';
import type { WorkflowNode } from './graph-scopes';
import type { FieldParseResult } from './inspector-draft';

// The Slack step posts to the channel in its `channelId` input (ADR 023),
// through the bot token of its `slack_bot_token` connection. Setup edits
// that input as a typed channel ID; its name is only ever a display hint.

const SLACK_STEP_KEY = 'slack.send_message';
const CHANNEL_INPUT = 'channelId';
export const SLACK_CONNECTION = 'slack_bot_token';

type InputMappings = WorkflowNode['inputMappings'];

/** Where the step's channel comes from. */
export type StepChannel =
  | Readonly<{ kind: 'typed'; channelId: string | undefined }>
  | Readonly<{ kind: 'mapped' }>;

export function isSlackStep(node: Pick<WorkflowNode, 'definition'>): boolean {
  return node.definition.key === SLACK_STEP_KEY;
}

/**
 * A typed channel ID (or none yet), or a channel that another source
 * provides: a step's output, the run input or an expression.
 */
export function stepChannel(
  node: Pick<WorkflowNode, 'inputMappings'>,
): StepChannel {
  const source = node.inputMappings[CHANNEL_INPUT];
  if (source === undefined) return { kind: 'typed', channelId: undefined };
  return source.kind === 'literal' && typeof source.value === 'string'
    ? { kind: 'typed', channelId: source.value }
    : { kind: 'mapped' };
}

/** A channel ID as people type it: "C0123ABCD", "#C0123ABCD" or nothing. */
export function parseChannelId(
  text: string,
): FieldParseResult<string | undefined> {
  const value = text.trim().replace(/^#/u, '');
  if (value === '') return { ok: true, value: undefined };
  return slackChannelLookupIdSchema.safeParse(value).success
    ? { ok: true, value }
    : {
        ok: false,
        error:
          'Channel IDs start with C, G or D followed by capital letters and numbers, like C0123456789.',
      };
}

/** The step's inputs with its channel set to `channelId`, or cleared. */
export function withChannelId(
  inputMappings: InputMappings,
  channelId: string | undefined,
): InputMappings {
  if (channelId !== undefined)
    return {
      ...inputMappings,
      [CHANNEL_INPUT]: { kind: 'literal', value: channelId },
    };
  return Object.fromEntries(
    Object.entries(inputMappings).filter(([key]) => key !== CHANNEL_INPUT),
  );
}
