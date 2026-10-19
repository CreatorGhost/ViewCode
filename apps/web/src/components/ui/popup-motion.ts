// Tooltips, popovers, menus and preview cards arrive in 120ms, rising 2px as they fade in, and
// leave in 100ms, dropping 2px as they fade out. Each popup lists `translate` and `opacity` in
// its own transition. Reduced motion keeps the fade and drops the movement.
export const POPUP_MOTION_CLASS =
  "duration-(--dur-tip-in) ease-out-soft data-ending-style:duration-(--dur-tip-out) data-starting-style:opacity-0 data-ending-style:opacity-0 motion-safe:data-starting-style:translate-y-0.5 motion-safe:data-ending-style:translate-y-0.5";
