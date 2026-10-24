import { useNavigate, useSearch } from '@tanstack/react-router';
import { InboxPage, InboxViews } from '@/features/inbox/page.public';
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
            ...(search.filter === undefined ? {} : { filter: search.filter }),
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
            ...(filter === 'unread' ? { filter } : {}),
          },
        })
      }
    />
  );
}
