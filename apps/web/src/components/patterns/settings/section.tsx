import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/class-names';

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
      className={cn('grid min-w-0 gap-y-4 py-5 first:pt-2', className)}
    >
      <div className="flex flex-col gap-3">
        <div>
          <RuleHeading id={headingId}>{title}</RuleHeading>
          {description === undefined ? null : (
            <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {action === undefined ? null : (
          <div className="self-start">{action}</div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}
