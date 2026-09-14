/*
 * BlackWire service worker -- makes the site installable (PWA) and keeps
 * it usable if the connection drops, without ever getting between
 * live-data.js and a fresh status.json. That fetch already cache-busts
 * itself with a changing query string and sets {cache:'no-store'},
 * because live player counts are the one thing on this site that must
 * never be shown stale -- so this worker leaves any request carrying a
 * query string (that's every status.json request, and nothing else on
 * this site) completely untouched, same as if this worker weren't
 * installed at all.
 */
var CACHE = 'blackwire-shell-v1';

self.addEventListener('install', function(event){
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(key){
        return key === CACHE ? null : caches.delete(key);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  var url = new URL(req.url);

  if(req.method !== 'GET' || url.origin !== self.location.origin || url.search){
    return;
  }

  event.respondWith(
    fetch(req).then(function(res){
      var copy = res.clone();
      caches.open(CACHE).then(function(cache){ cache.put(req, copy); });
      return res;
    }).catch(function(){
      return caches.match(req).then(function(cached){
        return cached || caches.match(self.registration.scope + 'index.html');
      });
    })
  );
});
