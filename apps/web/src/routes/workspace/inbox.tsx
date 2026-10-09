import { useNavigate, useSearch } from '@tanstack/react-router';
import { InboxPage } from '@/features/inbox/inbox-page.public';
import { useWorkspaceScope } from './shell/use-workspace-scope';

export function InboxRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const search = useSearch({ from: '/w/$workspaceId/shell/inbox' });
  const navigate = useNavigate({ from: '/w/$workspaceId/inbox' });
  return (
    <InboxPage
      key={`${user.id}:${workspace.id}`}
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      filter={search.filter ?? 'all'}
      onFilterChange={(filter) =>
        void navigate({ search: filter === 'unread' ? { filter } : {} })
      }
    />
  );
}
