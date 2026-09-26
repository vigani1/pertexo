import { CircleHelpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Status, type StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';

export type GuideEntry = Readonly<{
  label: string;
  meaning: string;
  /** Shown as the status itself, in its colour, when it is one. */
  tone?: StatusTone;
}>;

export type GuideSection = Readonly<{
  title: string;
  entries: readonly GuideEntry[];
}>;

/**
 * "What these mean": every status and term a page uses, each in one plain
 * sentence, one tap away instead of spread across tooltips.
 */
export function StatusGuide({
  title = 'What these mean',
  sections,
  className,
}: Readonly<{
  title?: string;
  sections: readonly GuideSection[];
  className?: string;
}>) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={cn(
              'font-sans text-subtle-foreground hover:text-foreground',
              className,
            )}
          />
        }
      >
        <CircleHelpIcon aria-hidden="true" />
        {title}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(27rem,calc(100vw-2rem))] p-5"
      >
        <PopoverTitle className="text-sm">{title}</PopoverTitle>
        {sections.map((section) => (
          <section key={section.title} className="mt-4">
            <h3 className="font-sans text-xs font-semibold text-subtle-foreground">
              {section.title}
            </h3>
            <dl className="mt-2 flex flex-col gap-2.5">
              {section.entries.map((entry) => (
                <div
                  key={entry.label}
                  className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:items-baseline sm:gap-3"
                >
                  <dt className="text-[0.8rem] font-medium">
                    {entry.tone === undefined ? (
                      entry.label
                    ) : (
                      <Status tone={entry.tone}>{entry.label}</Status>
                    )}
                  </dt>
                  <dd className="text-[0.8rem] leading-relaxed text-muted-foreground">
                    {entry.meaning}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </PopoverContent>
    </Popover>
  );
}
