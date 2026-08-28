/**
 * EMULSION's service worker — the offline half of the home-screen web app.
 *
 * This file is a template: the build plugin in `vite.config.ts` substitutes the
 * two `__TOKENS__` below with the build's cache version and the complete list
 * of files in `dist/` — the app shell, the hashed JS and CSS chunks, the
 * LibRaw wasm and its worker scripts, the print-stock LUTs and the icons — and
 * writes the result to `dist/sw.js`. Because the substituted list names every
 * hashed asset the build emitted, a cached app is never asked for a URL it has
 * not got: the whole film chain (decode, develop, print, grain, halation) runs
 * from the cache with the network gone. Recipes and preferences already live
 * in localStorage, which survives offline in a home-screen web app.
 *
 * Strategies:
 *   - navigations: network first (so updates arrive), cached shell offline;
 *   - everything else, GET, same origin: cache first — every asset URL the
 *     page can request is either content-hashed by the build or a static
 *     public file, so a cached hit is by construction the right answer, and a
 *     miss falls through to the network and back-fills the cache.
 *
 * The cache name carries the build version, so a new build installs into a
 * fresh cache and activation deletes every older one — there is never a mixed
 * generation of assets in play. Install caches file-by-file rather than
 * atomically: one flaky response during install degrades one asset to its
 * network path instead of leaving the whole app offline-incapable.
 */

/* eslint-disable no-restricted-globals */
const VERSION = '__CACHE_VERSION__';
const CACHE = `emulsion-${VERSION}`;
const PRECACHE = /** @type {string[]} */ (__PRECACHE_URLS__);
/** The document served for any navigation the network cannot reach. */
const SHELL = '/index.html';
/**
 * Vary is ignored on every match. The dev-style static server stamps
 * `Vary: Origin` on the assets, and Chromium honours it in the Cache API:
 * an install-time request and a later module-script request differ in that
 * header's presence, and the match returns nothing — the cache empties out
 * exactly when the network does. Every entry here is a same-origin static
 * file keyed by its full URL; per-header negotiation is meaningless for
 * them, and the mismatch must not be allowed to hide them.
 */
const MATCH_OPTS = { ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[sw] precache failed for ${url}:`, err);
          }),
        ),
      );
      // No skipWaiting: a waiting worker activates when the last old page
      // closes, on next launch. Taking over mid-session would delete the
      // cache generation the running page was precached from, and a lazy
      // chunk it had not imported yet would 404. An update is a restart's
      // business in an installed app.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('emulsion-') && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      // First install: the page that triggered it was not controlled when it
      // loaded. Claiming puts it under the worker at once — the precache
      // already holds everything it will ask for.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          const copy = res.clone();
          await caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          return res;
        } catch {
          return (
            (await caches.match(SHELL, MATCH_OPTS)) ??
            (await caches.match(request, MATCH_OPTS)) ??
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request, MATCH_OPTS);
      if (cached) return cached;
      try {
        const res = await fetch(request);
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return res;
      } catch {
        return Response.error();
      }
    })(),
  );
});
