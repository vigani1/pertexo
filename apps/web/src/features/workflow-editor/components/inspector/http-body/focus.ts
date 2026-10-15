export function focusFormPart(nodeId: string, inputKey: string | undefined) {
  requestAnimationFrame(() => {
    const id =
      inputKey === undefined
        ? `${nodeId}-add-text-part`
        : `${nodeId}-${inputKey}-name`;
    document.getElementById(id)?.focus();
  });
}
