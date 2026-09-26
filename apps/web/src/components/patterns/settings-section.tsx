import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A titled band of a settings page: the heading and a sentence on the left,
 * the content on the right. Flat page content; only dialogs and lenses float.
 * Workspace, workflow and account settings all read the same way.
 */
export function SettingsSection({
  title,
  description,
  action,
  className,
  children,
}: Readonly<{
  title: string;
  description?: ReactNode;
  /** One control for the whole section, under its sentence. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}>) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'grid gap-x-10 gap-y-5 border-t border-border py-8 first:border-t-0 first:pt-2 lg:grid-cols-[14rem_minmax(0,1fr)]',
        className,
      )}
    >
      <div className="flex flex-col items-start gap-3">
        <div>
          <h2 id={headingId} className="text-lg font-semibold">
            {title}
          </h2>
          {description === undefined ? null : (
            <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {action}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}
