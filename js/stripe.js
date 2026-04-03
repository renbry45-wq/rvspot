/* ============================================
   RVSpot.net — Stripe Checkout
   stripe.js
   ============================================ */

const PRICES = {
  park_pro:  'price_1THw7R1J9Y6gYEOf0uy5xzEj',
  nomad_pro: 'price_1THw3g1J9Y6gYEOfGNjMp4ke',
};

async function startCheckout(planType) {
  const priceId = PRICES[planType];
  if (!priceId) return;

  // Require login before checkout
  const sb = window._sb;
  if (!sb) {
    showToast('Please wait a moment and try again.', 'warning');
    return;
  }

  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    // Store intended plan so we can resume after login
    sessionStorage.setItem('rvspot_pending_plan', planType);
    openModal('loginModal');
    return;
  }

  // Disable button to prevent double-clicks
  const btn = document.querySelector(`[data-plan="${planType}"]`);
  const originalText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting to checkout…'; }

  try {
    const res = await fetch('/api/create-checkout-session', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        priceId,
        userEmail: user.email,
        userId:    user.id,
        planType,
      }),
    });

    const { url, error } = await res.json();
    if (error) throw new Error(error);
    window.location.href = url;

  } catch (err) {
    showToast(err.message || 'Payment error. Please try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

// After login, resume any pending checkout
document.addEventListener('DOMContentLoaded', () => {
  const pending = sessionStorage.getItem('rvspot_pending_plan');
  if (!pending) return;

  // Wait briefly for Supabase session to hydrate
  setTimeout(async () => {
    const sb = window._sb;
    if (!sb) return;
    const { data: { user } } = await sb.auth.getUser();
    if (user) {
      sessionStorage.removeItem('rvspot_pending_plan');
      startCheckout(pending);
    }
  }, 1500);
});
