import type { RefObject } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTitle } from '@/components/ui/popover';
import { shortcutKeys } from '@/lib/shortcut-keys';

const shortcuts: readonly Readonly<{
  keys: readonly string[];
  action: string;
}>[] = [
  { keys: ['/'], action: 'Add a step' },
  { keys: shortcutKeys('B'), action: 'Show or hide the step list' },
  { keys: shortcutKeys('Z'), action: 'Undo' },
  { keys: shortcutKeys('Z', { shift: true }), action: 'Redo' },
  { keys: shortcutKeys('D'), action: 'Duplicate selected steps' },
  { keys: ['⌫'], action: 'Delete what’s selected on the canvas' },
  { keys: shortcutKeys('↵'), action: 'Test the selected step' },
  { keys: shortcutKeys('S'), action: 'Save now' },
  { keys: ['?'], action: 'Show these shortcuts' },
];

/**
 * The "?" cheat sheet. Shortcuts never fire while you type in a field.
 * The sheet opens beside the workflow menu.
 */
export function ShortcutSheet({
  open,
  onOpenChange,
  fallbackAnchor,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fallbackAnchor?: RefObject<HTMLElement | null>;
}>) {
  const focusAnchor = () => fallbackAnchor?.current ?? undefined;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)]"
        anchor={() => focusAnchor() ?? null}
        finalFocus={focusAnchor}
      >
        <PopoverTitle>Keyboard shortcuts</PopoverTitle>
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          {shortcuts.map((shortcut) => (
            <div
              key={shortcut.action}
              className="flex items-center justify-between gap-3"
            >
              <dt className="text-muted-foreground">{shortcut.action}</dt>
              <dd className="flex gap-1">
                {shortcut.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
