import { flushSync } from 'react-dom';

/** The control that takes focus for a part: its field name, or Add text part when none is left. */
export function formPartFocusId(nodeId: string, inputKey: string | undefined) {
  return inputKey === undefined
    ? `${nodeId}-add-text-part`
    : `${nodeId}-${inputKey}-name`;
}

/**
 * Applies a change to the form parts and moves focus in the same task. A
 * focus move left for a later frame lands wherever people are by then: on a
 * busy phone that frame can come after they have tapped into another field,
 * and what they type goes into the part's name instead.
 */
export function changeAndFocusFormPart(change: () => void, focusId: string) {
  flushSync(change);
  document.getElementById(focusId)?.focus();
}
