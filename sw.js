const CACHE='ct-campeador-pwa-v3-14';
const SHELL=[
  '/ct-campeador-liga/',
  '/ct-campeador-liga/manifest.webmanifest',
  '/ct-campeador-liga/icon-192.png',
  '/ct-campeador-liga/icon-512.png',
  '/ct-campeador-liga/apple-touch-icon.png'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin) return;

  if(req.mode==='navigate'){
    event.respondWith(
      fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(CACHE).then(c=>c.put('/ct-campeador-liga/',copy)).catch(()=>{});
        return res;
      }).catch(()=>caches.match('/ct-campeador-liga/'))
    );
    return;
  }

  if(/\.(png|webmanifest|ico)$/i.test(url.pathname)){
    event.respondWith(
      caches.match(req).then(hit=>hit||fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});
        return res;
      }))
    );
  }
});
