import type { ReactNode } from 'react';
import { InboxIcon, MailIcon, MailXIcon, SparkleIcon } from 'lucide-react';
import type { NoticePreferencesResponse } from '@pertexo/contracts';
import { cn } from '@/lib/utils';
import { describeSchedule } from '../../model/email-schedule';

/**
 * Where a notice goes, drawn as a thread: it lands in your Inbox every time,
 * then reaches your email on the schedule in effect, or stops there when
 * email is off or the server can't send it.
 */
export function NotificationRoute({
  snapshot,
}: Readonly<{ snapshot: NoticePreferencesResponse }>) {
  const emailing = snapshot.emailAvailable && snapshot.effective.mode !== 'off';
  return (
    <figure
      aria-label="Where your notices go"
      className="flex flex-col gap-3 rounded-xl border border-surface-ink/7 bg-surface-ink/[0.02] p-5 sm:flex-row sm:items-center sm:gap-0"
    >
      <Stop
        icon={<SparkleIcon aria-hidden="true" className="size-4" />}
        title="Something happens"
        detail="A run fails, a request waits, you're mentioned"
      />
      <Thread lit />
      <Stop
        icon={<InboxIcon aria-hidden="true" className="size-4" />}
        title="Your Inbox"
        detail="Always, as it happens"
        tone="action"
      />
      <Thread lit={emailing} />
      <Stop
        icon={
          emailing ? (
            <MailIcon aria-hidden="true" className="size-4" />
          ) : (
            <MailXIcon aria-hidden="true" className="size-4" />
          )
        }
        title="Your email"
        detail={
          !snapshot.emailAvailable
            ? 'Unavailable on this server'
            : describeSchedule(snapshot.effective)
        }
        tone={emailing ? 'action' : 'muted'}
      />
    </figure>
  );
}

function Stop({
  icon,
  title,
  detail,
  tone = 'plain',
}: Readonly<{
  icon: ReactNode;
  title: string;
  detail: string;
  tone?: 'plain' | 'action' | 'muted';
}>) {
  return (
    <div className="flex min-w-0 items-center gap-3 sm:flex-col sm:items-center sm:text-center">
      <span
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-full border',
          tone === 'action' &&
            'border-action/50 bg-action/8 text-accent-foreground shadow-[0_0_0_4px_color-mix(in_srgb,var(--action)_8%,transparent)]',
          tone === 'muted' && 'border-border text-subtle-foreground',
          tone === 'plain' && 'border-surface-ink/12 text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 sm:max-w-40">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

/** The thread between two stops: lit where notices travel, dashed where not. */
function Thread({ lit }: Readonly<{ lit: boolean }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'ml-[1.125rem] h-5 w-px sm:mx-3 sm:mb-8 sm:h-px sm:w-auto sm:min-w-8 sm:flex-1',
        lit
          ? 'bg-action/50'
          : 'border-l border-dashed border-surface-ink/15 bg-transparent sm:border-t sm:border-l-0',
      )}
    />
  );
}
