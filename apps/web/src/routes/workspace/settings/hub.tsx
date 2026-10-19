import { Outlet } from '@tanstack/react-router';
import { SettingsRail } from '@/features/workspaces/public';
import { useWorkspaceScope } from '../shell/use-workspace-scope';

/** Every Settings page beside one rail that stays put while you move between them. */
export function SettingsHubRoute() {
  const { workspace } = useWorkspaceScope();
  return (
    // The rail stands beside the page whenever the page has room for both,
    // whatever the window: the spine and the in-app browser take their share.
    <div className="@container">
      <div className="flex flex-col gap-6 @3xl:grid @3xl:grid-cols-[10.5rem_minmax(0,1fr)] @3xl:gap-x-10 @5xl:gap-x-12">
        <SettingsRail workspace={workspace} />
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
