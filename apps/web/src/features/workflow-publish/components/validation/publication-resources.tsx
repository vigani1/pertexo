import { Link } from '@tanstack/react-router';

/** Resource findings cannot be repaired by editing a step's JSON alone. */
export function PublicationResources({
  workspaceId,
}: Readonly<{ workspaceId: string }>) {
  return (
    <nav
      aria-label="Workspace resources"
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm"
    >
      <span className="text-muted-foreground">Review workspace resources:</span>
      <Link
        to="/w/$workspaceId/settings/variables"
        params={{ workspaceId }}
        className="inline-flex items-center rounded-sm text-action underline underline-offset-2 focus-ring pointer-coarse:min-h-11"
      >
        Variables
      </Link>
      <Link
        to="/w/$workspaceId/connections"
        params={{ workspaceId }}
        className="inline-flex items-center rounded-sm text-action underline underline-offset-2 focus-ring pointer-coarse:min-h-11"
      >
        Connections
      </Link>
    </nav>
  );
}
