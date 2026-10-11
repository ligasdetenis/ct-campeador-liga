const API_URL='https://ct-campeador-api.ligasdetenis.workers.dev/';
const APP_URL='https://ligasdetenis.github.io/ct-campeador-liga/';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let msg={title:'🎾 CT Campeador',body:'Hay novedades en la liga.',url:APP_URL};
    try{
      const r=await fetch(API_URL+'?pushMessage=1',{cache:'no-store'});
      if(r.ok) msg={...msg,...await r.json()};
    }catch(e){}
    await self.registration.showNotification(msg.title||'🎾 CT Campeador',{
      body:msg.body||'Hay novedades en la liga.',
      icon:'./icon-192.png',
      badge:'./icon-192.png',
      tag:'ct-campeador-disponibilidad',
      renotify:true,
      data:{url:msg.url||APP_URL}
    });
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=event.notification.data?.url||APP_URL;
  event.waitUntil((async()=>{
    const list=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of list){if('focus' in c){try{await c.navigate(target)}catch(e){} return c.focus();}}
    return self.clients.openWindow(target);
  })());
});
