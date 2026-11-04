/** Credential matching is separate: both discovery and locked admission use this standing. */
export function publicFormIsAvailable(
  standing: Readonly<{
    access: string;
    workspaceStatus: string;
  }>,
): boolean {
  return standing.access === 'public' && standing.workspaceStatus === 'active';
}
