/* ============================================
   RVSpot.net — Shared JavaScript
   app.js — utilities, navigation, UI helpers
   ============================================ */

'use strict';

/* ─── Navigation active state ─── */
function setActiveNav() {
  const page = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === page);
  });
}

/* ─── Mobile menu toggle ─── */
function initMobileMenu() {
  const toggle = document.getElementById('mobileMenuToggle');
  const menu   = document.getElementById('mobileMenu');
  if (!toggle || !menu) return;
  toggle.addEventListener('click', () => {
    menu.classList.toggle('open');
    toggle.setAttribute('aria-expanded', menu.classList.contains('open'));
  });
}

/* ─── Tab system ─── */
function initTabs(containerSel) {
  const containers = document.querySelectorAll(containerSel || '[data-tabs]');
  containers.forEach(container => {
    const buttons = container.querySelectorAll('.tab-btn');
    const panels  = container.querySelectorAll('.tab-panel');
    buttons.forEach((btn, i) => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        if (panels[i]) panels[i].classList.add('active');
      });
    });
    // activate first
    if (buttons[0]) buttons[0].classList.add('active');
    if (panels[0])  panels[0].classList.add('active');
  });
}

/* ─── Star rating input ─── */
function initStarRating(containerSel) {
  document.querySelectorAll(containerSel || '.star-rating-input').forEach(container => {
    const stars = container.querySelectorAll('.star');
    let current = 0;
    const input = container.nextElementSibling;

    stars.forEach((star, i) => {
      star.addEventListener('mouseenter', () => highlightStars(i));
      star.addEventListener('mouseleave', () => highlightStars(current - 1));
      star.addEventListener('click', () => {
        current = i + 1;
        highlightStars(i);
        if (input && input.type === 'hidden') input.value = current;
      });
    });

    function highlightStars(idx) {
      stars.forEach((s, j) => s.classList.toggle('filled', j <= idx));
    }
  });
}

/* ─── Modal system ─── */
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) { modal.classList.add('open'); document.body.style.overflow = 'hidden'; }
}
function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) { modal.classList.remove('open'); document.body.style.overflow = ''; }
}
function initModals() {
  document.querySelectorAll('[data-modal-open]').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.dataset.modalOpen));
  });
  document.querySelectorAll('[data-modal-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modalClose));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });
}

/* ─── Toast notifications ─── */
function showToast(message, type = 'success', duration = 3500) {
  const container = document.getElementById('toastContainer') || createToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${message}</span><button onclick="this.parentElement.remove()">✕</button>`;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, duration);
}
function createToastContainer() {
  const c = document.createElement('div');
  c.id = 'toastContainer';
  c.style.cssText = 'position:fixed;top:80px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
  document.body.appendChild(c);
  // inject toast styles
  const style = document.createElement('style');
  style.textContent = `
    .toast { background:var(--white); border-radius:var(--radius-md); padding:12px 16px;
      box-shadow:var(--shadow-lg); border-left:4px solid var(--green-600);
      display:flex; align-items:center; gap:12px; min-width:280px;
      font-size:14px; font-family:var(--font-body); transform:translateX(110%);
      transition:transform 0.3s ease; }
    .toast.show { transform:translateX(0); }
    .toast-success { border-left-color:var(--green-600); }
    .toast-error { border-left-color:#e53e3e; }
    .toast-warning { border-left-color:var(--amber-500); }
    .toast button { margin-left:auto; background:none; border:none; cursor:pointer; color:var(--slate-400); font-size:16px; }
  `;
  document.head.appendChild(style);
  return c;
}

/* ─── Filter chips ─── */
function initFilterChips() {
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
    });
  });
}

/* ─── Price range slider ─── */
function initRangeSlider(sliderId, displayId, prefix = '$', suffix = '') {
  const slider  = document.getElementById(sliderId);
  const display = document.getElementById(displayId);
  if (!slider || !display) return;
  function update() { display.textContent = prefix + Number(slider.value).toLocaleString() + suffix; }
  slider.addEventListener('input', update);
  update();
}

/* ─── Lazy image loading ─── */
function initLazyImages() {
  const imgs = document.querySelectorAll('img[data-src]');
  if (!('IntersectionObserver' in window)) {
    imgs.forEach(img => { img.src = img.dataset.src; });
    return;
  }
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.src = entry.target.dataset.src;
        obs.unobserve(entry.target);
      }
    });
  }, { rootMargin: '200px' });
  imgs.forEach(img => obs.observe(img));
}

/* ─── Smooth scroll to anchor ─── */
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  });
}

/* ─── Format helpers ─── */
const fmt = {
  currency: (n, decimals = 0) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
  number:   (n) => Number(n).toLocaleString('en-US'),
  date:     (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  stars:    (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n)),
};

/* ─── Local storage helpers ─── */
const storage = {
  get: (k) => { try { return JSON.parse(localStorage.getItem('rvspot_' + k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem('rvspot_' + k, JSON.stringify(v)); } catch {} },
  del: (k) => localStorage.removeItem('rvspot_' + k),
};

/* ─── Mock API (until Supabase is connected) ─── */
const mockParks = [
  { id: 1, name: 'Pineview Lake RV Resort', state: 'Texas', city: 'Austin', rating: 4.8, reviews: 124, price: 45, monthly: 650, wifi: true, longstay: true, pets: true, ev: false, type: 'Resort', img: null },
  { id: 2, name: 'Blue Ridge Mountain Camp', state: 'North Carolina', city: 'Asheville', rating: 4.6, reviews: 87, price: 38, monthly: 520, wifi: true, longstay: true, pets: true, ev: true, type: 'Campground', img: null },
  { id: 3, name: 'Sunbelt RV Community', state: 'Florida', city: 'Fort Myers', rating: 4.7, reviews: 203, price: 55, monthly: 780, wifi: true, longstay: true, pets: false, ev: true, type: 'Community', img: null },
  { id: 4, name: 'Pacific Coast Trailer Park', state: 'California', city: 'San Luis Obispo', rating: 4.4, reviews: 56, price: 65, monthly: 950, wifi: true, longstay: false, pets: true, ev: true, type: 'Park', img: null },
  { id: 5, name: 'Desert Rose RV Park', state: 'Arizona', city: 'Scottsdale', rating: 4.9, reviews: 312, price: 42, monthly: 580, wifi: true, longstay: true, pets: true, ev: false, type: 'Park', img: null },
  { id: 6, name: 'Great Plains Stopover', state: 'Oklahoma', city: 'Oklahoma City', rating: 4.2, reviews: 44, price: 28, monthly: 380, wifi: false, longstay: true, pets: true, ev: false, type: 'Park', img: null },
];

function getParkColor(idx) {
  const colors = ['#2a8f5e','#1565c0','#c2185b','#e65100','#6a1b9a','#2e7d32'];
  return colors[idx % colors.length];
}
function getParkInitial(name) { return name.charAt(0); }

/* ─── Initialize everything on DOM ready ─── */
document.addEventListener('DOMContentLoaded', () => {
  setActiveNav();
  initMobileMenu();
  initTabs();
  initStarRating();
  initModals();
  initFilterChips();
  initSmoothScroll();
  initLazyImages();
});
/* Supabase Auth */
const SUPABASE_URL='https://uydiifdgjzylfxxaoznv.supabase.co';
const SUPABASE_ANON_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5ZGlpZmRnanp5bGZ4eGFvem52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwOTMxNDMsImV4cCI6MjA5MDY2OTE0M30.McVsij-Z3m-rh9wjedwl5hM5fAaB5YDGYfHjsgxDfdE';
function getSupabase(){if(window.supabase&&window.supabase.createClient)return window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);return null;}
async function signInWithGoogle(){const sb=getSupabase();if(!sb){showToast('Loading...','warning');return;}const{error}=await sb.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin}});if(error)showToast(error.message,'error');}
async function signUpWithEmail(email,password,firstName,lastName,role){const sb=getSupabase();if(!sb)return;const{error}=await sb.auth.signUp({email,password,options:{data:{first_name:firstName,last_name:lastName,role:role||'traveler'}}});if(error){showToast(error.message,'error');return;}showToast('Check your email to confirm! 🏕','success');closeModal('signupModal');}
async function signInWithEmail(email,password){const sb=getSupabase();if(!sb)return;const{data,error}=await sb.auth.signInWithPassword({email,password});if(error){showToast(error.message,'error');return;}showToast('Welcome back! 🏕','success');closeModal('loginModal');}
