export class NoticeConflictError extends Error {
  override readonly name = 'NoticeConflictError';
  constructor() {
    super('Notification settings changed. Reload and try again.');
  }
}

export class NoticeUnavailableError extends Error {
  override readonly name = 'NoticeUnavailableError';
}
