export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_LIMITS = {
  urlCharacters: 2_048,
  toolNameCharacters: 128,
  cursorCharacters: 2_048,
  sessionCharacters: 512,
  pages: 8,
  tools: 100,
  events: 128,
  contentBlocks: 64,
  timeoutMillis: 20_000,
  requestBytes: 256 * 1_024,
  responseBytes: 128 * 1_024,
} as const;
