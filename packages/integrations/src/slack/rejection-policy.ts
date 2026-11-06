/** One provider-owned table for parsed rejection certainty, health and safe guidance. */
export const SLACK_REJECTIONS = Object.freeze({
  account_inactive: {
    kind: 'failed',
    errorKind: 'authentication',
    code: 'slack.account_inactive',
    sentence: 'Slack’s bot account is inactive.',
    advice: 'Restore the Slack account, then reconnect this connection.',
    fix: 'reconnect',
    health: {
      kind: 'reauthorization_required',
      reasonCode: 'connection.slack_account_inactive',
    },
  },
  invalid_auth: {
    kind: 'failed',
    errorKind: 'authentication',
    code: 'slack.invalid_auth',
    sentence: 'Slack rejected the bot token.',
    advice: 'Reconnect the Slack connection.',
    fix: 'reconnect',
  },
  not_authed: {
    kind: 'failed',
    errorKind: 'authentication',
    code: 'slack.not_authed',
    sentence: 'Slack received no valid bot authentication.',
    advice: 'Reconnect the Slack connection.',
    fix: 'reconnect',
  },
  token_revoked: {
    kind: 'failed',
    errorKind: 'authentication',
    code: 'slack.token_revoked',
    sentence: 'The Slack bot token was revoked.',
    advice: 'Reconnect the Slack connection.',
    fix: 'reconnect',
    health: {
      kind: 'reauthorization_required',
      reasonCode: 'connection.slack_token_revoked',
    },
  },
  token_expired: {
    kind: 'failed',
    errorKind: 'authentication',
    code: 'slack.token_expired',
    sentence: 'The Slack bot token expired.',
    advice: 'Reconnect the Slack connection.',
    fix: 'reconnect',
    health: {
      kind: 'reauthorization_required',
      reasonCode: 'connection.slack_token_expired',
    },
  },
  channel_not_found: {
    kind: 'failed',
    errorKind: 'provider',
    code: 'slack.channel_not_found',
    sentence: 'Slack could not find the requested channel.',
    advice: 'Check the channel ID and the bot’s access to that channel.',
  },
  is_archived: {
    kind: 'failed',
    errorKind: 'provider',
    code: 'slack.is_archived',
    sentence: 'The Slack channel is archived.',
    advice: 'Choose an active channel or unarchive it before trying again.',
  },
  missing_scope: {
    kind: 'failed',
    errorKind: 'provider',
    code: 'slack.missing_scope',
    sentence: 'The Slack bot lacks a required scope.',
    advice: 'Add the required chat:write scope to the Slack app and reconnect.',
  },
  msg_too_long: {
    kind: 'failed',
    errorKind: 'provider',
    code: 'slack.msg_too_long',
    sentence: 'Slack refused the message because it was too long.',
    advice: 'Shorten the message and try again.',
  },
  no_permission: {
    kind: 'failed',
    errorKind: 'provider',
    code: 'slack.no_permission',
    sentence: 'The Slack bot does not have permission to send this message.',
    advice: 'Review the app’s scopes and channel permissions.',
  },
  no_text: {
    kind: 'failed',
    errorKind: 'provider',
    code: 'slack.no_text',
    sentence: 'Slack received no message text.',
    advice: 'Map nonempty message text into this step.',
  },
  not_in_channel: {
    kind: 'failed',
    errorKind: 'provider',
    code: 'slack.not_in_channel',
    sentence: 'The Slack bot is not a member of the channel.',
    advice: 'Invite the bot to the channel before trying again.',
  },
  service_unavailable: {
    kind: 'retry',
    errorKind: 'provider',
    code: 'slack.service_unavailable',
    sentence: 'Slack is temporarily unavailable.',
    advice: 'Wait for Slack to recover before trying again.',
  },
} as const);

export function slackRejection(error: string) {
  return Object.hasOwn(SLACK_REJECTIONS, error)
    ? SLACK_REJECTIONS[error as keyof typeof SLACK_REJECTIONS]
    : undefined;
}
