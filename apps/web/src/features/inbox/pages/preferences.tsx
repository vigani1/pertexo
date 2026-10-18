import { useQuery } from '@tanstack/react-query';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { SettingsSection } from '@/components/patterns/settings-section';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { notificationPreferencesQueryOptions } from '../data/preferences.queries';
import { NotificationScheduleEditor } from '../components/preferences/schedule-editor';
export function NotificationPreferencesPage({
  scope,
}: {
  scope: WorkspaceApiScope;
}) {
  const query = useQuery(notificationPreferencesQueryOptions(scope));
  const data = query.data;
  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <PageHeader>
        <PageHeaderTitle>Notifications</PageHeaderTitle>
      </PageHeader>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Choose how often email reaches you. Your Inbox always has everything;
        alerts sent to Slack or a shared address are set up in Alerts.
      </p>
      {query.isError ? (
        <Notice
          tone="warning"
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
          Notification choices could not be refreshed.
        </Notice>
      ) : null}
      {data === undefined ? (
        query.isPending ? (
          <p role="status">Loading notification choices…</p>
        ) : null
      ) : (
        <>
          {data.emailUnavailableReason === null ? null : (
            <Notice>{data.emailUnavailableReason}</Notice>
          )}
          <SettingsSection
            title="Your email"
            description="Immediate messages are grouped within a minute. Hourly digests arrive at the next hour; daily digests use your selected time zone. New changes only."
          >
            <NotificationScheduleEditor
              scope={scope}
              snapshot={data}
              target="personal"
            />
          </SettingsSection>
          <SettingsSection
            title="Workspace default"
            description="Members inherit this schedule unless they choose their own. Owners and admins can change it."
          >
            {data.canManageDefaults ? (
              <NotificationScheduleEditor
                scope={scope}
                snapshot={data}
                target="defaults"
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {data.defaults.mode === 'off'
                  ? 'Email is off by default.'
                  : `Default: ${data.defaults.mode}${data.defaults.mode === 'daily' ? ` at ${String(data.defaults.hour)}:00 (${data.defaults.timeZone})` : ''}.`}
              </p>
            )}
          </SettingsSection>
        </>
      )}
    </div>
  );
}
