(function(){
  // Register the service worker so the site can be installed as an app.
  // Resolved relative to this script's own location (same trick
  // live-data.js uses for status.json) so it still finds sw.js and gets
  // the right scope whether this is served from the custom domain's true
  // root or previewed from GitHub's own /blackwire-gaming/ subfolder.
  if('serviceWorker' in navigator){
    var swUrl = new URL('sw.js', document.currentScript.src).href;
    navigator.serviceWorker.register(swUrl).catch(function(){
      // offline install just won't be available -- nothing else breaks
    });
  }

  // every node powers on as you scroll to it, instead of sitting there fully lit from load
  var targets = document.querySelectorAll('.spine-head, .branch-panel, .manifesto, .ticker-frame, .kit, .reveal');
  targets.forEach(function(el){ el.classList.add('reveal-init'); });
  if('IntersectionObserver' in window){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(entry.isIntersecting){
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, {threshold:0.12, rootMargin:'0px 0px -60px 0px'});
    targets.forEach(function(el){ io.observe(el); });
  } else {
    targets.forEach(function(el){ el.classList.add('is-visible'); });
  }

  // a flashlight over the network — only where a real cursor is present
  var spot = document.getElementById('spotlight');
  if(spot && window.matchMedia && matchMedia('(pointer:fine)').matches){
    var raf = null;
    window.addEventListener('pointermove', function(e){
      spot.classList.add('is-active');
      if(raf) return;
      raf = requestAnimationFrame(function(){
        spot.style.setProperty('--x', e.clientX + 'px');
        spot.style.setProperty('--y', e.clientY + 'px');
        raf = null;
      });
    }, {passive:true});
    window.addEventListener('pointerleave', function(){ spot.classList.remove('is-active'); });
  }

  // the whole card is the click target — the visible link stays the accessible one
  document.querySelectorAll('.plate').forEach(function(card){
    var link = card.querySelector('.plate-link');
    if(!link) return;
    card.addEventListener('click', function(e){
      if(e.target.closest('a')) return;
      link.click();
    });
  });

  // mobile menu toggle — nav links used to just disappear under 720px
  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if(toggle && links){
    toggle.addEventListener('click', function(){
      var open = links.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.querySelectorAll('a').forEach(function(a){
      a.addEventListener('click', function(){
        links.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // mark the current nav link so people can see where they are
  var here = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('nav a[href]').forEach(function(a){
    var target = a.getAttribute('href').split('/').pop();
    if(target === here || (here === '' && target === 'index.html')){
      a.classList.add('is-current');
    }
  });
})();

/* Donate nav button - injected into the header next to Sign In, same
   reasoning as the two footer-link blocks above: one place to maintain
   instead of nine HTML files. Skipped on the donate page itself since a
   link to the page you're already on doesn't help anyone. */
(function(){
  if(location.pathname.split('/').pop() === 'donate.html') return;
  var signin = document.querySelector('header nav .signin');
  if(!signin || document.querySelector('.nav-donate')) return;
  var a = document.createElement('a');
  a.href = 'donate.html';
  a.className = 'nav-donate';
  a.textContent = 'Donate';
  signin.parentNode.insertBefore(a, signin);
})();

/* Merch button - the Fourthwall store at shop.blackwiregaming.com, added to
   the header beside Donate (same outlined style) and to every footer.
   Opens in a new tab so people don't lose their place on the site. */
(function(){
  var SHOP = 'https://shop.blackwiregaming.com';
  var signin = document.querySelector('header nav .signin');
  if(signin && !document.querySelector('.nav-merch')){
    var a = document.createElement('a');
    a.href = SHOP;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'nav-donate nav-merch';
    a.textContent = 'Merch';
    var donate = document.querySelector('header nav .nav-donate:not(.nav-merch)');
    signin.parentNode.insertBefore(a, donate || signin);
  }
  /* On phones the header only has room for Donate + Sign In, so the header
     button hides and a Merch entry shows inside the menu instead. */
  var links = document.getElementById('navLinks');
  if(links && !links.querySelector('.merch-menu-link')){
    var m = document.createElement('a');
    m.href = SHOP;
    m.target = '_blank';
    m.rel = 'noopener';
    m.className = 'merch-menu-link';
    m.textContent = 'Merch';
    links.appendChild(m);
  }
  if(!document.getElementById('merch-style')){
    var st = document.createElement('style');
    st.id = 'merch-style';
    st.textContent = '@media (max-width:560px){header nav .nav-merch{display:none !important;}}' +
                     '@media (min-width:561px){.nav-links a.merch-menu-link{display:none !important;}}';
    document.head.appendChild(st);
  }
  var foot = document.querySelector('.foot-links');
  if(foot && !foot.querySelector('a[data-merch]')){
    var f = document.createElement('a');
    f.href = SHOP;
    f.target = '_blank';
    f.rel = 'noopener';
    f.setAttribute('data-merch', '');
    f.textContent = 'Merch';
    foot.appendChild(f);
  }
})();

/* Donate link - same idea as the Staff link below: injected into every
   page's footer from here instead of pasted into every HTML file. */
(function(){
  var foot = document.querySelector('.foot-links');
  if(!foot || foot.querySelector('a[href="donate.html"]')) return;
  var a = document.createElement('a');
  a.href = 'donate.html';
  a.textContent = 'Donate';
  foot.appendChild(a);
})();

/* Discord + Facebook links - the two places the community lives, added to
   every page's footer from here (same pattern as Donate and Staff). */
(function(){
  var foot = document.querySelector('.foot-links');
  if(!foot || foot.querySelector('a[data-social]')) return;
  /* inserted at the front one by one, so listed last-first: Discord ends up first.
     Nov 2026: added the YouTube channel and the BlackWire Mods Discord. */
  [['YouTube', 'https://www.youtube.com/@OfficialBlackWireGaming'], ['Facebook', 'https://www.facebook.com/blackwiregaming'],
   ['Mods Discord', 'https://discord.gg/FNnNEa8A6S'], ['Discord', 'https://discord.gg/blackwire']].forEach(function(l){
    var a = document.createElement('a');
    a.href = l[1];
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('data-social', l[0].toLowerCase());
    a.textContent = l[0];
    foot.insertBefore(a, foot.firstChild);
  });
})();

/* Staff link - drops the admin panel into the footer of every page, so it
   lives in one place instead of being pasted into nine HTML files. */
(function(){
  var foot = document.querySelector('.foot-links');
  if(!foot || foot.querySelector('a[href="/admin"]')) return;
  var a = document.createElement('a');
  a.href = '/admin';
  a.rel = 'nofollow';
  a.textContent = 'Staff';
  foot.appendChild(a);
})();

/* Wall link - the network board at wall.html, injected into the nav
   the same way Donate is, so it lives in one place. */
(function(){
  if(location.pathname.split('/').pop() === 'wall.html') return;
  var links = document.getElementById('navLinks');
  if(!links || links.querySelector('a[href="wall.html"]')) return;
  var a = document.createElement('a');
  a.href = 'wall.html';
  a.textContent = 'Wall';
  links.appendChild(a);
})();
