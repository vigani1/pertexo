import { useId } from 'react';

/**
 * Initial focus may settle after someone has already chosen a control inside
 * the popup (a click or tap during its entrance); it then stays where they
 * put it. Dialogs and sheets share this so a drawer never steals the caret.
 */
export function usePopupFocus(id: string | undefined) {
  const generatedId = useId();
  const popupId = id ?? generatedId;
  const focusFirstUnlessChosen = () =>
    !(
      document.getElementById(popupId)?.contains(document.activeElement) ??
      false
    );
  return { popupId, focusFirstUnlessChosen };
}
