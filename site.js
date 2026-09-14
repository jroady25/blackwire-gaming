(function(){
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
