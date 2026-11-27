import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/class-names';
import { Row, RowList } from '@/components/patterns/lists/row';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';

/**
 * A group of settings under one rule heading, one row each. Plain sections
 * with normal fields: no boxes, no choices inside sentences.
 */
export function SettingsGroup({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode }>) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col">
      <RuleHeading id={headingId}>{title}</RuleHeading>
      <RowList aria-labelledby={headingId} className="mt-1">
        {children}
      </RowList>
    </section>
  );
}

/**
 * One setting in a group, or a standalone setting with its own rule heading.
 * The action sits beside its name when there is room, above the editor.
 */
export function SettingRow({
  title,
  description,
  action,
  children,
  layout = 'row',
  className,
}: Readonly<{
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  layout?: 'row' | 'section';
  className?: string;
}>) {
  const headingId = useId();
  const standalone = layout === 'section';
  const section = (
    <section
      aria-labelledby={headingId}
      className={cn(
        'grid min-w-0 items-start gap-x-4 gap-y-1',
        action === undefined
          ? 'grid-cols-1'
          : 'grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto]',
        standalone && 'py-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {standalone ? (
          <RuleHeading id={headingId}>{title}</RuleHeading>
        ) : (
          <h3
            id={headingId}
            className="text-lead font-semibold wrap-break-word"
          >
            {title}
          </h3>
        )}
        {description === undefined ? null : (
          <div className="text-meta text-muted-foreground">{description}</div>
        )}
      </div>
      {action === undefined ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
          {action}
        </div>
      )}
      {children === undefined ? null : (
        <div className="col-span-full flex min-w-0 flex-col gap-4 pt-2">
          {children}
        </div>
      )}
    </section>
  );
  return standalone ? (
    section
  ) : (
    <Row lift="none" className="py-4">
      {section}
    </Row>
  );
}
