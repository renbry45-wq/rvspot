/* ============================================
   RVSpot.net — GA4 + Cookie Consent
   js/analytics.js

   Loads Google Analytics 4 only after the user
   accepts analytics cookies via the consent banner.
   GA4 Measurement ID: G-VDVBS131G7
   ============================================ */

const _GA4_ID = 'G-VDVBS131G7';

// ── GA4 loader (idempotent) ───────────────────────────────────────────────────
function loadGA4() {
  if (window._ga4Loaded) return;
  window._ga4Loaded = true;

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + _GA4_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', _GA4_ID);
}

// If user already accepted analytics cookies on a previous visit, load GA4 now
if (localStorage.getItem('cookieConsent') === 'all') {
  loadGA4();
}

// ── Cookie consent banner ─────────────────────────────────────────────────────
(function () {
  // Already decided — don't show the banner again
  if (localStorage.getItem('cookieConsent')) return;

  var css = document.createElement('style');
  css.textContent = [
    '#rvspot-cookie-banner{',
    '  position:fixed;bottom:0;left:0;right:0;z-index:9999;',
    '  background:#0f172a;color:#fff;',
    '  padding:16px 24px;',
    '  display:flex;align-items:center;gap:16px;flex-wrap:wrap;',
    '  font-family:"DM Sans",sans-serif;font-size:14px;line-height:1.6;',
    '  box-shadow:0 -4px 24px rgba(0,0,0,0.22);',
    '}',
    '#rvspot-cookie-banner p{margin:0;flex:1;min-width:220px;color:rgba(255,255,255,0.78);}',
    '#rvspot-cookie-banner .cc-actions{display:flex;gap:10px;flex-shrink:0;}',
    '#rvspot-cookie-banner .cc-accept{',
    '  background:#2a8f5e;color:#fff;border:none;border-radius:8px;',
    '  padding:9px 20px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;',
    '}',
    '#rvspot-cookie-banner .cc-essential{',
    '  background:transparent;color:rgba(255,255,255,0.7);',
    '  border:1px solid rgba(255,255,255,0.28);border-radius:8px;',
    '  padding:9px 20px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;',
    '}',
    '#rvspot-cookie-banner .cc-accept:hover{background:#22755a;}',
    '#rvspot-cookie-banner .cc-essential:hover{color:#fff;border-color:rgba(255,255,255,0.55);}',
  ].join('');
  document.head.appendChild(css);

  var banner = document.createElement('div');
  banner.id = 'rvspot-cookie-banner';
  banner.innerHTML = [
    '<p>We use essential cookies for the site to work and optional analytics cookies to improve your experience.</p>',
    '<div class="cc-actions">',
    '  <button class="cc-essential" id="rvspot-cc-essential">Essential only</button>',
    '  <button class="cc-accept"    id="rvspot-cc-accept">Accept all</button>',
    '</div>',
  ].join('');

  function mountBanner() { document.body.appendChild(banner); }
  if (document.body) { mountBanner(); }
  else { document.addEventListener('DOMContentLoaded', mountBanner); }

  // Use event delegation so clicks always register regardless of timing
  document.addEventListener('click', function (e) {
    if (e.target.id === 'rvspot-cc-accept') {
      localStorage.setItem('cookieConsent', 'all');
      banner.remove();
      loadGA4(); // load GA immediately, no page refresh needed
    } else if (e.target.id === 'rvspot-cc-essential') {
      localStorage.setItem('cookieConsent', 'essential');
      banner.remove();
    }
  });
}());
