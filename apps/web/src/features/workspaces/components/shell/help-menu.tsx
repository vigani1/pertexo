import { BookOpenIcon, CircleHelpIcon, ExternalLinkIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { GuideLink } from '@/components/patterns/guidance/guide-link';
import { HELP_LINKS } from '@/lib/help/guides';

const HELP = [
  { href: HELP_LINKS.firstWorkflow, label: 'Your first workflow' },
  { href: HELP_LINKS.allGuides, label: 'All guides' },
  { href: HELP_LINKS.glossary, label: 'Glossary' },
] as const;

/** Help on the spine: the public guides, each opening in a new tab. */
export function HelpMenu({ className }: Readonly<{ className: string }>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Help" className={className}>
        <CircleHelpIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Help</DropdownMenuLabel>
          {HELP.map((item) => (
            <DropdownMenuLinkItem
              key={item.href}
              render={
                <a href={item.href} target="_blank" rel="noopener noreferrer" />
              }
            >
              <BookOpenIcon aria-hidden="true" />
              {item.label}
              <ExternalLinkIcon
                aria-hidden="true"
                className="ml-auto text-subtle-foreground"
              />
              <span className="sr-only"> (opens in a new tab)</span>
            </DropdownMenuLinkItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same guides in the phone's More sheet. */
export function HelpLinks() {
  return (
    <section aria-label="Help" className="flex flex-col gap-2 px-2 py-1">
      {HELP.map((item) => (
        <GuideLink key={item.href} href={item.href}>
          {item.label}
        </GuideLink>
      ))}
    </section>
  );
}
