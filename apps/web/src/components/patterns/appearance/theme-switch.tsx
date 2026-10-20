import { MoonIcon, SunIcon } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { setAppearance, useAppearance } from '@/lib/appearance/use-choice';

// The chrome flips between light and dark in one press, like most apps'
// sidebars. Following the device stays in Account → Appearance.
function useNextTheme() {
  const { theme } = useAppearance();
  const next = theme === 'dark' ? 'light' : 'dark';
  return {
    next,
    label: next === 'light' ? 'Switch to light theme' : 'Switch to dark theme',
    icon:
      next === 'light' ? (
        <SunIcon aria-hidden="true" />
      ) : (
        <MoonIcon aria-hidden="true" />
      ),
    switchTheme: () => {
      setAppearance(next);
    },
  } as const;
}

/** An icon button for a rail, named by what it does. */
export function ThemeSwitchButton({
  className,
}: Readonly<{ className?: string }>) {
  const { label, icon, switchTheme } = useNextTheme();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className={className}
            onClick={switchTheme}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** A labelled row for a menu or sheet. */
export function ThemeSwitchRow({
  className,
}: Readonly<{ className?: string }>) {
  const { next, icon, switchTheme } = useNextTheme();
  return (
    <button type="button" className={className} onClick={switchTheme}>
      {icon}
      {next === 'light' ? 'Light theme' : 'Dark theme'}
    </button>
  );
}
