import { QueryView } from '@/components/patterns/states/query-view';
import { useQuery } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { Notice } from '@/components/ui/notice';
import { notificationPreferencesQueryOptions } from '../data/preferences.queries';
import { NotificationScheduleEditor } from '../components/preferences/schedule-editor';
import { NotificationRoute } from '../components/preferences/route';
import {
  describePersonalChoice,
  describeSchedule,
} from '../model/email-schedule';
import { whoCan } from '@/features/workspaces/roles.public';
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
            <div className="grid gap-4 lg:grid-cols-2">
              <ScheduleCard
                title="Your email"
                current={describePersonalChoice(data)}
                note="Immediate messages are grouped within a minute. Hourly digests arrive at the next hour; daily ones in your time zone. New changes only."
              >
                {paused ? null : (
                  <NotificationScheduleEditor
                    scope={scope}
                    snapshot={data}
                    target="personal"
                  />
                )}
              </ScheduleCard>
              <ScheduleCard
                title="Workspace default"
                current={`Members get: ${describeSchedule(data.defaults).toLowerCase()}, unless they choose their own.`}
                note={`${sentenceStart(whoCan('notification:manage_defaults'))} set it for everyone who hasn't chosen.`}
              >
                {data.canManageDefaults && !paused ? (
                  <NotificationScheduleEditor
                    scope={scope}
                    snapshot={data}
                    target="defaults"
                  />
                ) : null}
              </ScheduleCard>
            </div>
          </>
        )}
      </QueryView>
    </div>
  );
}

/**
 * One schedule as a card: its current value as a sentence first, then the
 * controls that change it, and a short note on how it behaves.
 */
function ScheduleCard({
  title,
  current,
  note,
  children,
}: Readonly<{
  title: string;
  current: string;
  note: string;
  children: ReactNode;
}>) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-xl border border-surface-ink/7 bg-surface-ink/[0.015] p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="font-semibold">
          {title}
        </h2>
        <p className="text-sm text-foreground/85">{current}</p>
      </div>
      {children}
      <p className="mt-auto text-xs leading-relaxed text-subtle-foreground">
        {note}
      </p>
    </section>
  );
}
