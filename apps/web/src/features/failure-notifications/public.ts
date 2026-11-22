export { useAlertMembers } from './hooks/use-alert-members';
// Slack channel names (ADR 046) for other features: the one bounded lookup
// and how a name, or the honest reason it's missing, reads on screen.
export { useSlackChannelNames } from './hooks/use-slack-channel-names';
export {
  channelKey,
  channelName,
  slackChannelLookupRequest,
  describeChannel,
  destinationChannels,
  type ChannelNames,
} from './model/channel-names';
