// Shared look for every floating popup (menus, selects, popovers, tooltips):
// a lens that scales from its anchor. Base UI exposes the transition states.
export const popupSurface =
  'lens origin-(--transform-origin) rounded-md text-popover-foreground outline-none transition-[opacity,transform] duration-150 ease-unspool data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none';
