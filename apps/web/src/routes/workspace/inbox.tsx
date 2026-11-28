import { useNavigate, useSearch } from '@tanstack/react-router';
import { InboxPage } from '@/features/inbox/pages/inbox';
import { InboxViews } from '@/features/inbox/inbox-views.public';
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
      views={
        <InboxViews
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          current="notices"
        />
      }
      filter={search.filter ?? 'all'}
      {...(search.noticeKind === undefined
        ? {}
        : { noticeKind: search.noticeKind })}
      onNoticeKindChange={(noticeKind) =>
        void navigate({
          search: {
            filter: search.filter ?? 'all',
            ...(noticeKind === undefined ? {} : { noticeKind }),
          },
        })
      }
      onFilterChange={(filter) =>
        void navigate({
          search: {
            ...(search.noticeKind === undefined
              ? {}
              : { noticeKind: search.noticeKind }),
            filter,
          },
        })
      }
    />
  );
}
