import { Link } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import {
  SystemState,
  SystemStateActions,
  SystemStateArt,
  SystemStateDescription,
  SystemStateTitle,
} from '@/components/patterns/system-state';
import { LooseThread } from '@/components/patterns/thread-illustrations';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Kbd } from '@/components/ui/kbd';
import { useOpenCommandPalette } from './command-palette-context';
import { useWorkspaceScope } from './use-workspace-scope';
import { WorkspaceShellFrame } from './workspace-shell-route';
import { shortcut } from '@/lib/shortcut-keys';

/**
 * The shell route's not-found page: an address inside a workspace that leads
 * nowhere. The router renders it in place of the shell, so it brings the
 * shell back around itself and people can go home or search without
 * reloading.
 */
export function ShellNotFound() {
  return (
    <WorkspaceShellFrame>
      <PageNotFound />
    </WorkspaceShellFrame>
  );
}

function PageNotFound() {
  const { workspace } = useWorkspaceScope();
  const openSearch = useOpenCommandPalette();
  return (
    <SystemState>
      <SystemStateArt>
        <LooseThread />
      </SystemStateArt>
      <SystemStateTitle>This page doesn’t exist</SystemStateTitle>
      <SystemStateDescription>
        This address doesn’t lead anywhere in {workspace.name}. Go home, or
        search for what you were looking for.
      </SystemStateDescription>
      <SystemStateActions>
        <Link
          to="/w/$workspaceId"
          params={{ workspaceId: workspace.id }}
          className={buttonVariants({ variant: 'primary' })}
        >
          Go home
        </Link>
        <Button type="button" variant="outline" onClick={openSearch}>
          <SearchIcon aria-hidden="true" data-icon="inline-start" />
          Search
          <Kbd aria-hidden="true">{shortcut('K')}</Kbd>
        </Button>
      </SystemStateActions>
    </SystemState>
  );
}
