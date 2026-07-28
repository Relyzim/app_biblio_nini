/* ══════════════════════════════════════════════════════════════════
   Biblio-ninoush — Service Worker
   • Cache l'appli pour un fonctionnement 100% hors-ligne
   • Met en cache les couvertures au fil de l'eau (elles restent
     dispo sans réseau une fois vues)
   Pense à incrémenter APP_VERSION à chaque mise à jour de l'appli.
   ══════════════════════════════════════════════════════════════════ */

const APP_VERSION = 'v13.21';
const SHELL_CACHE = 'biblio-shell-' + APP_VERSION;
const COVER_CACHE = 'biblio-covers-' + APP_VERSION;

// Fichiers de base à mettre en cache dès l'installation
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

// Domaines dont on met les images en cache (couvertures de livres)
const COVER_HOSTS = [
  'covers.openlibrary.org',
  'books.google.com',
  'books.googleusercontent.com',
  'lh3.googleusercontent.com'
];

// ── INSTALLATION ────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // on n'échoue pas si un asset manque
  );
});

// ── ACTIVATION : purge des anciens caches ───────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== COVER_CACHE)
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Permet à la page de forcer la mise à jour du SW
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// ── STRATÉGIES DE RÉCUPÉRATION ──────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 1) Couvertures : cache d'abord, réseau sinon (et on garde en cache)
  if (COVER_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirstCover(req));
    return;
  }

  // 2) Les autres appels d'API (recherche de livres) : réseau direct,
  //    on ne les met pas en cache (résultats changeants)
  if (url.hostname === 'www.googleapis.com' || url.hostname === 'openlibrary.org') {
    return; // laisse le navigateur gérer normalement
  }

  // 3) Navigation / app shell : réseau d'abord, repli cache (hors-ligne)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // 4) Reste des ressources same-origin : cache d'abord
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetchAndStore(req, SHELL_CACHE))
    );
  }
});

function cacheFirstCover(req) {
  return caches.open(COVER_CACHE).then(cache =>
    cache.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        // on ne met en cache que les vraies images valides
        if (res && res.ok && (res.type === 'basic' || res.type === 'cors' || res.type === 'opaque')) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      }).catch(() => hit || Response.error());
    })
  );
}

function fetchAndStore(req, cacheName) {
  return fetch(req).then(res => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(cacheName).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(req));
}
