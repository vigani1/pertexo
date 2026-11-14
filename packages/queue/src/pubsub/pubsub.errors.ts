export class RunEventNotificationConfigurationError extends Error {
  public override readonly name = 'RunEventNotificationConfigurationError';
}

export class RunEventNotificationPublishError extends Error {
  public override readonly name = 'RunEventNotificationPublishError';
}

export class WorkspaceInboxHintConfigurationError extends Error {
  public override readonly name = 'WorkspaceInboxHintConfigurationError';
}

export class WorkspaceInboxHintPublishError extends Error {
  public override readonly name = 'WorkspaceInboxHintPublishError';
}
