import { QueryView } from '@/components/patterns/states/query-view';
import { useQuery } from '@tanstack/react-query';
import { SettingRow, SettingsGroup } from '@/components/patterns/settings/row';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { notificationPreferencesQueryOptions } from '../data/notice-preferences.queries';
import { NotificationScheduleEditor } from '../components/preferences/schedule-editor';
import { NotificationRoute } from '../components/preferences/route';
import {
  describePersonalChoice,
  describeSchedule,
} from '../model/email-schedule';
import { whoCan } from '@/features/workspaces/public';
import { sentenceStart } from '@/lib/format/sentence';
export function NotificationPreferencesPage({
  scope,
  paused = false,
}: {
  scope: WorkspaceApiScope;
  /** A suspended workspace shows the choices but can't change them. */
  paused?: boolean;
}) {
  const query = useQuery(notificationPreferencesQueryOptions(scope));
  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <PageHeader>
        <PageHeaderTitle>Notifications</PageHeaderTitle>
      </PageHeader>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Choose how often email reaches you. Your Inbox always has everything;
        alerts sent to Slack or a shared address are set up in Alerts.
      </p>
      <QueryView query={query} resource="Notification choices">
        {(data) => (
          <>
            {data.emailUnavailableReason === null ? null : (
              <Notice>{data.emailUnavailableReason}</Notice>
            )}
            <NotificationRoute snapshot={data} />
            <SettingsGroup title="Email delivery">
              <SettingRow
                title="Your email"
                description={describePersonalChoice(data)}
              >
                {paused ? null : (
                  <NotificationScheduleEditor
                    scope={scope}
                    snapshot={data}
                    target="personal"
                  />
                )}
                <p className="text-meta text-muted-foreground">
                  Immediate messages are grouped within a minute. Hourly digests
                  arrive at the next hour; daily ones in your time zone. New
                  changes only.
                </p>
              </SettingRow>
              <SettingRow
                title="Workspace default"
                description={`Members get: ${describeSchedule(data.defaults).toLowerCase()}, unless they choose their own.`}
              >
                {data.canManageDefaults && !paused ? (
                  <NotificationScheduleEditor
                    scope={scope}
                    snapshot={data}
                    target="defaults"
                  />
                ) : null}
                <p className="text-meta text-muted-foreground">{`${sentenceStart(whoCan('notification:manage_defaults'))} set it for everyone who hasn't chosen.`}</p>
              </SettingRow>
            </SettingsGroup>
          </>
        )}
      </QueryView>
    </div>
  );
}
