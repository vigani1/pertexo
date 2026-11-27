import { useState, type RefObject } from 'react';

/** Marks the command bar's assistant button, where focus returns on close. */
export const ASSISTANT_TRIGGER_ATTRIBUTE = 'data-assistant-trigger';

/**
 * Whether the assistant panel is open. Closing it gives focus back to the
 * command bar's assistant button, or to the canvas on a phone, where that
 * button is folded into ⋯.
 */
export function useAssistantOpening({
  onOpen,
  canvasRef,
}: Readonly<{
  onOpen: () => void;
  canvasRef: RefObject<HTMLDivElement | null>;
}>) {
  const [open, setOpen] = useState(false);
  const onOpenChange = (next: boolean) => {
    if (next) onOpen();
    setOpen(next);
  };
  return {
    open,
    /** What the command bar needs to open the panel. */
    chrome: { proposalOpen: open, onProposalOpenChange: onOpenChange },
    close: () => {
      setOpen(false);
      const trigger = document.querySelector<HTMLElement>(
        `[${ASSISTANT_TRIGGER_ATTRIBUTE}]`,
      );
      if (trigger !== null && trigger.getClientRects().length > 0)
        trigger.focus();
      else canvasRef.current?.focus();
    },
  } as const;
}
