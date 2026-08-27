import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles/tokens.css';
import './styles/app.css';

/**
 * Publish the real glass height as --app-height. The shell takes this rather
 * than trusting CSS viewport units: iOS's standalone web view has a long
 * standing defect where the reported viewport comes up short of the screen on
 * launch (the bottom safe-area region is excluded) and is corrected a beat
 * later, sometimes without a resize event — every CSS-only height (100vh,
 * 100dvh, inset stretch included) then leaves an unpainted black band under
 * the home indicator. window.innerHeight is re-read after the first frames
 * (the launch correction has usually landed by then) and whenever the app is
 * backgrounded, foregrounded or rotated. It does not shrink when the
 * keyboard opens, so the shell never jumps under it.
 */
const publishAppHeight = () => {
  document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
};
publishAppHeight();
requestAnimationFrame(() => requestAnimationFrame(publishAppHeight));
window.addEventListener('resize', publishAppHeight);
window.visualViewport?.addEventListener('resize', publishAppHeight);
document.addEventListener('visibilitychange', publishAppHeight);
window.addEventListener('pageshow', publishAppHeight);

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from the document');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
