import type { ReactNode } from 'react';
import { Disclosure } from '@/components/ui/disclosure';

/** The current value, its inline editor, and optional explanatory rules. */
export function SettingDetails({
  summary,
  rules,
  editor,
}: Readonly<{
  summary: ReactNode;
  rules?: ReactNode;
  editor?: ReactNode;
}>) {
  return (
    <div className="flex min-w-0 max-w-xl flex-col gap-3">
      <p className="text-sm leading-relaxed text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
        {summary}
      </p>
      {editor}
      {rules === undefined ? null : (
        <Disclosure
          summary="How this works"
          className="text-xs text-muted-foreground"
          appearance={{ size: 'xs' }}
        >
          <div className="mt-2 flex max-w-lg flex-col gap-1.5 leading-relaxed">
            {rules}
          </div>
        </Disclosure>
      )}
    </div>
  );
}
