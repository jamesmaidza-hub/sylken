// Keeps the till page and its script available when the shop's internet is down.
// Network first, so a till always gets the newest version when it can; the cache is the fallback.
const CACHE = 'sylken-till-v1'
const SHELL = ['/till/', '/till/app.js']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    for (const url of SHELL) {
      try {
        const res = await fetch(url, { credentials: 'same-origin' })
        if (res.ok && !res.redirected) await c.put(url, res)
      } catch {}
    }
  }).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(url.pathname)) return
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request)
      if (res.ok && !res.redirected) (await caches.open(CACHE)).put(url.pathname, res.clone())
      return res
    } catch {
      return (await caches.match(url.pathname)) || Response.error()
    }
  })())
})
