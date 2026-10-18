import { Outlet } from '@tanstack/react-router';
import { SettingsRail } from '@/features/workspaces/public';
import { useWorkspaceScope } from '../shell/use-workspace-scope';

/** Every Settings page beside one rail that stays put while you move between them. */
export function SettingsHubRoute() {
  const { workspace } = useWorkspaceScope();
  return (
    <div className="flex flex-col gap-6 xl:grid xl:grid-cols-[10.5rem_minmax(0,1fr)] xl:gap-x-12">
      <SettingsRail workspace={workspace} />
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
