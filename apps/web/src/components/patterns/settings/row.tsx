import { useId, type ReactNode } from 'react';
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
      <RowList className="mt-1">{children}</RowList>
    </section>
  );
}

/**
 * One setting in a group: its name and what it does on the left, one
 * control on the right, and its value or editor underneath.
 */
export function SettingRow({
  title,
  description,
  action,
  children,
}: Readonly<{
  title: string;
  description?: ReactNode;
  /** The one control that sits beside the name. */
  action?: ReactNode;
  children?: ReactNode;
}>) {
  const headingId = useId();
  return (
    <Row lift="none" className="py-4">
      <section
        aria-labelledby={headingId}
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={headingId} className="text-lead font-semibold">
            {title}
          </h3>
          {description === undefined ? null : (
            <div className="text-meta text-subtle-foreground">
              {description}
            </div>
          )}
        </div>
        <div className="flex justify-end">{action}</div>
        {children === undefined ? null : (
          <div className="col-span-full flex min-w-0 flex-col gap-4 pt-2">
            {children}
          </div>
        )}
      </section>
    </Row>
  );
}
