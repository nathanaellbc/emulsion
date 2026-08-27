import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles/tokens.css';
import './styles/app.css';

/**
 * Publish the real glass height as --app-height. The shell takes this rather
 * than trusting CSS viewport units: iOS's standalone web view has a long
 * standing defect where the reported viewport comes up short of the screen on
 * launch (the bottom safe-area region is excluded) — and in the worst builds
 * every in-page metric inherits it and never corrects, so even measuring
 * window.innerHeight publishes the shortfall and the black band under the
 * home indicator stays. In a home-screen web app the only metric that never
 * shrinks with the web view's chrome is the screen itself, so standalone
 * takes window.screen.height; a browser tab keeps window.innerHeight (the
 * screen there includes the URL bar, which must stay clear). Re-read after
 * the first frames and whenever the app is backgrounded, foregrounded or
 * rotated. It does not shrink when the keyboard opens, so the shell never
 * jumps under it.
 */
const publishAppHeight = () => {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  document.documentElement.style.setProperty(
    '--app-height',
    `${standalone ? window.screen.height : window.innerHeight}px`,
  );
};
publishAppHeight();
requestAnimationFrame(() => requestAnimationFrame(publishAppHeight));
window.addEventListener('resize', publishAppHeight);
window.addEventListener('orientationchange', publishAppHeight);
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
