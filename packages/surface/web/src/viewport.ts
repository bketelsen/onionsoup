/**
 * Keeps the app the height of what the person can see. iOS Safari does not shrink the layout viewport when the
 * on-screen keyboard opens: it pans the visual viewport instead, which scrolls the header away and leaves the chat
 * composer under the keyboard. The app's root (app.css) follows --app-height, set here from the visual viewport,
 * and the page is held at the top so the composer sits right above the keyboard.
 */

/** Past this zoom the person is pinching to read something: leave the layout alone. */
export const VIEWPORT_LIMITS = { maxScale: 1.01 };

const HEIGHT_VARIABLE = '--app-height';

function followVisualViewport(viewport: VisualViewport) {
  if (viewport.scale > VIEWPORT_LIMITS.maxScale) return;
  document.documentElement.style.setProperty(HEIGHT_VARIABLE, `${Math.round(viewport.height)}px`);
  if (window.scrollY !== 0) window.scrollTo(0, 0);
}

/** Starts following the visual viewport; without the API, app.css falls back to 100dvh. */
export function trackViewportHeight() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const update = () => followVisualViewport(viewport);
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
}
