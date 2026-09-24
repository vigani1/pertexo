import { KeyboardIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import { Kbd } from '@/components/ui/kbd';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';

const shortcuts: readonly Readonly<{
  keys: readonly string[];
  action: string;
}>[] = [
  { keys: ['/'], action: 'Add a step' },
  { keys: ['⌘', 'B'], action: 'Show or hide the step list' },
  { keys: ['⌘', 'Z'], action: 'Undo' },
  { keys: ['⇧', '⌘', 'Z'], action: 'Redo' },
  { keys: ['⌘', 'D'], action: 'Duplicate selected steps' },
  { keys: ['⌫'], action: 'Delete what’s selected on the canvas' },
  { keys: ['⌘', '↵'], action: 'Test the selected step' },
  { keys: ['⌘', 'S'], action: 'Save now' },
  { keys: ['?'], action: 'Show these shortcuts' },
];

/** The "?" cheat sheet. Shortcuts never fire while you type in a field. */
export function ShortcutSheet({
  open,
  onOpenChange,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label="Keyboard shortcuts"
        className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
      >
        <KeyboardIcon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
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
        <p className="mt-3 text-xs text-subtle-foreground">
          On Windows and Linux, use Ctrl for ⌘.
        </p>
      </PopoverContent>
    </Popover>
  );
}
