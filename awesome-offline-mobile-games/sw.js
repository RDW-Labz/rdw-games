/* Offline cache for the whole collection.
 *
 * Lives at the REPO ROOT on purpose: a service worker can only intercept requests
 * inside its own scope, and the games live in /games/. A worker at /shell/sw.js
 * would cover the launcher but leave every game uncached and unplayable offline.
 * Registered from shell/app.js as '../sw.js', which gives it the '/' scope.
 *
 * Cache-first: once installed, the collection opens with the radio off. Bump CACHE
 * whenever a game or the shell changes. */
// Bump this whenever ASSETS can grow — the file list is built at runtime, so adding a
// vendored asset does not by itself change sw.js, and an installed worker would never refetch.
// v7: the six upstream clones left the shipped catalog — the grid is originals + hybrids only.
// v8: Cinderhold and Wardenmarch join — two new hybrids on Flare, DCSS and Wesnoth donors.
var CACHE = 'aomg-v16';

// The vendored upstream payload (sprites, audio, content tables) declares its own file
// list, so the cache learns about it from the bundle instead of a hand-kept duplicate.
try { importScripts('./vendor/vendor.js'); } catch (e) { /* bundle missing: ship without it */ }
var VENDOR_ASSETS = (self.AOMG_VENDOR && self.AOMG_VENDOR.assets) || [];
var ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './shell/index.html',
  './shell/styles.css',
  './shell/app.js',
  './shell/lib/gamekit.js',
  './shell/lib/catalog.data.js',
  './shell/assets/icon.svg',
  './shell/assets/icon-maskable.svg',
  './catalog/games.json',
  './games/vaultbreak/index.html',
  './games/vaultbreak/js/main.js',
  './games/tessera/index.html',
  './games/tessera/js/main.js',
  './games/ember-drift/index.html',
  './games/ember-drift/js/main.js',
  './games/rift-nine/index.html',
  './games/rift-nine/js/main.js',
  './games/siegehaus/index.html',
  './games/siegehaus/js/main.js',
  './games/charterline/index.html',
  './games/charterline/js/main.js',
  './games/nulltrace/index.html',
  './games/nulltrace/js/main.js',
  './games/lanternfall/index.html',
  './games/lanternfall/js/main.js',
  './games/cinderhold/index.html',
  './games/cinderhold/js/main.js',
  './games/wardenmarch/index.html',
  './games/wardenmarch/js/main.js',
  './games/stormforge/index.html',
  './games/stormforge/js/main.js',
  './games/stormforge/js/world.js',
  './games/stormforge/js/factory.js',
  './games/stormforge/js/combat.js',
  './games/stormforge/js/render.js',
  './games/stormforge/js/scene3d.js',
  './vendor/three/three.min.js',
  './vendor/vendor.js'
];
/* A card links to a directory (/games/wardenmarch/) and a cache only answers the exact URL it
 * stored, so each index.html is also stored under its directory form. Without this, an offline
 * tap on a card fell through to the launcher. */
ASSETS = ASSETS.concat(ASSETS.filter(function (u) { return /index\.html$/.test(u); })
  .map(function (u) { return u.replace(/index\.html$/, ''); }));

/* Art is deliberately NOT in the install list. The vendored payload is ~31 MB across 1,500
 * files; precaching it up front stalled the worker in "installing" for over a minute on a cold
 * profile, which means the PWA was not usable offline at all until it finished. The shell and
 * every game's entry scripts install in seconds, and the fetch handler below caches art the
 * first time it is actually drawn. */

/* Cloudflare Pages answers /games/x/index.html with a 308 to /games/x/, so almost every
 * precached entry arrives as a *redirected* Response. Handing a redirected Response back to a
 * navigation is a hard network error in Chrome — the page dies even though its bytes are on
 * disk. Rebuilding the body clears that flag while keeping status and headers. */
function plain(res) {
  if (!res || !res.redirected) return Promise.resolve(res);
  return res.arrayBuffer().then(function (buf) {
    var headers = new Headers();
    res.headers.forEach(function (v, k) { headers.set(k, v); });
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: headers });
  });
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Every entry is fetched with its own deadline. cache.add() has none: one stalled
      // response left the worker sitting in "installing" indefinitely, and a worker that never
      // activates is a PWA that does not work offline. A miss here is not fatal — the fetch
      // handler below fills it in on first use.
      return Promise.all(ASSETS.map(function (u) {
        var ctl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : null;
        return fetch(u, ctl ? { signal: ctl.signal, cache: 'reload' } : { cache: 'reload' })
          .then(function (res) {
            if (timer) clearTimeout(timer);
            if (res && res.ok) return plain(res).then(function (clean) { return c.put(u, clean); }).catch(function () { return null; });
            return null;
          })
          .catch(function () { if (timer) clearTimeout(timer); return null; });
      })).then(function () {
        /* Serving the shelf at "/" is right for the player, but the shell's own tags are relative
           ("app.js", "lib/gamekit.js"), and at "/" they would resolve to "/app.js" — a miss, and
           a launcher with no scripts. Cache one rewritten copy at the root instead. */
        return fetch('./shell/index.html', { cache: 'reload' }).then(function (r) { return r.text(); })
          .then(function (html) {
            var fixed = html.replace(/(src|href)="(?!https?:|\/|#)([^"]*)"/g, '$1="shell/$2"');
            return c.put('./', new Response(fixed, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
          }).catch(function () { return null; });
      });
    }).then(function () { return self.skipWaiting(); })  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch another origin
  if (url.pathname.indexOf('/api/') === 0) return;   // saves and catalog API stay live

  /* The launcher is reachable by three different URLs — /, /index.html and /shell/index.html —
     and a cache only answers the exact one it stored. Serve the shelf for all of them up front
     instead of hoping the miss path lands somewhere useful. */
  if (req.mode === 'navigate' && /^\/(index\.html)?$/.test(url.pathname)) {
    return e.respondWith(
      // '/shell/index.html' is 308'd to '/shell/' by Pages, so both keys are worth trying before
      // falling back to the redirect stub at the root.
      // './' is the root-rewritten shelf, so it is tried before the raw shell copy.
      caches.match('./').then(function (root) {
        return root || caches.match('./shell/index.html').then(function (h) {
          return h || caches.match('./shell/').then(function (d) {
            return d || caches.match('./index.html').then(function (i) { return i || fetch(req); });
          });
        });
      })
    );
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          plain(res.clone()).then(function (clean) {
            caches.open(CACHE).then(function (c) { c.put(req, clean); });
          }).catch(function () {});
        }
        return res;
      }).catch(function () {
        if (req.mode === 'navigate') {
          // A card links to a directory, and a cache only answers the URL it stored. Try the
          // directory's index.html before falling back to the launcher, so tapping a game
          // offline opens that game rather than the shelf.
          var dir = url.pathname.replace(/\/+$/, '') + '/index.html';
          return caches.match(dir).then(function (h) {
            return h || caches.match('./shell/index.html');
          });
        }
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
