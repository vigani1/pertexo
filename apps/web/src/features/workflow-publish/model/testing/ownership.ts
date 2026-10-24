/** An absent or aborted owner cannot receive a late command result. */
export function commandIsLive(
  controller: AbortController | undefined,
): boolean {
  return controller !== undefined && !controller.signal.aborted;
}
