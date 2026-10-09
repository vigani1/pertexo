import { createContext, use } from 'react';

/**
 * Opens the workspace shell's command palette. The shell route provides it;
 * page routes pass it to their feature as a plain callback, so features never
 * reach into the shell.
 */
export const CommandPaletteContext = createContext<(() => void) | null>(null);

export function useOpenCommandPalette(): () => void {
  const open = use(CommandPaletteContext);
  if (open === null)
    throw new Error(
      'useOpenCommandPalette must be used inside the workspace shell.',
    );
  return open;
}
