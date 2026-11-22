export class McpToolUnavailableError extends Error {
  override readonly name = 'McpToolUnavailableError';
  public constructor() {
    super('The workflow tool is unavailable.');
  }
}
