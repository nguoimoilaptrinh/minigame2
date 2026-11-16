// Service worker Hội Quán — app shell mở nhanh, nhưng luôn ưu tiên bản mới từ mạng.
const CACHE = 'hoiquan-v3.2-2';

const PRECACHE = [
  './',
  'index.html',
  'css/styles.css',
  'css/ww-views.css',
  'js/data.js',
  'js/audio.js',
  'js/network.js',
  'js/fx.js',
  'js/ww-views.js',
  'js/werewolf.js',
  'js/spy.js',
  'js/app.js',
  'manifest.webmanifest',
  'assets/icons/icon-180.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/roles/alpha_wolf.png',
  'assets/roles/civilian.png',
  'assets/roles/cupid.png',
  'assets/roles/elder.png',
  'assets/roles/guard.png',
  'assets/roles/hunter.png',
  'assets/roles/jester.png',
  'assets/roles/seer.png',
  'assets/roles/serial_killer.png',
  'assets/roles/spy.png',
  'assets/roles/villager.png',
  'assets/roles/werewolf.png',
  'assets/roles/witch.png',
  'assets/avatars/friend_1.jpg',
  'assets/avatars/friend_2.jpg',
  'assets/avatars/friend_3.jpg',
  'assets/avatars/friend_4.jpg',
  'assets/avatars/friend_5.jpg',
  'assets/avatars/friend_6.jpg',
  'assets/avatars/friend_7.jpg',
  'assets/avatars/friend_8.jpg'
];

const SWR_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const NETWORK_TIMEOUT = 3500;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(request, response) {
  if (!response || !(response.ok || response.type === 'opaque')) return;
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
}

function networkFirst(request, isNavigation) {
  return new Promise((resolve) => {
    let settled = false;
    const fallback = () =>
      caches
        .match(request, { ignoreSearch: true })
        .then((hit) => hit || (isNavigation ? caches.match('index.html', { ignoreSearch: true }) : null))
        .then((hit) => hit || caches.match('./', { ignoreSearch: true }));
    const finishWithCache = () => {
      if (settled) return;
      fallback().then((hit) => {
        if (settled) return;
        if (hit) {
          settled = true;
          resolve(hit);
        }
      });
    };
    const timer = setTimeout(finishWithCache, NETWORK_TIMEOUT);
    fetch(request, { cache: 'no-cache' })
      .then((res) => {
        clearTimeout(timer);
        if (settled) {
          putInCache(request, res);
          return;
        }
        settled = true;
        putInCache(request, res);
        resolve(res);
      })
      .catch(() => {
        clearTimeout(timer);
        if (settled) return;
        fallback().then((hit) => {
          if (settled) return;
          settled = true;
          resolve(hit || Response.error());
        });
      });
  });
}

function cacheFirstRefresh(request) {
  return caches.match(request, { ignoreSearch: true }).then((hit) => {
    const refresh = fetch(request, { cache: 'no-cache' })
      .then((res) => {
        putInCache(request, res);
        return res;
      })
      .catch(() => null);
    return hit || refresh.then((res) => res || Response.error());
  });
}

function staleWhileRevalidate(request) {
  return caches.match(request).then((hit) => {
    const refresh = fetch(request)
      .then((res) => {
        putInCache(request, res);
        return res;
      })
      .catch(() => null);
    return hit || refresh.then((res) => res || Response.error());
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin === self.location.origin) {
    const isNav = request.mode === 'navigate';
    if (isNav || /\.(html|js|css|webmanifest)$/i.test(url.pathname) || url.pathname.endsWith('/')) {
      event.respondWith(networkFirst(request, isNav));
      return;
    }
    if (request.destination === 'image' || /\.(png|jpe?g|webp|gif|svg|ico)$/i.test(url.pathname)) {
      event.respondWith(cacheFirstRefresh(request));
      return;
    }
    return;
  }

  if (SWR_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
  // Mọi thứ khác (TTS, MQTT, PeerJS...) đi thẳng ra mạng.
});
