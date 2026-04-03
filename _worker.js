/* ============================================
   RVSpot.net — Cloudflare Worker
   Handles /api/* routes; serves static assets for everything else.
   ============================================ */

const SUPABASE_URL     = 'https://uydiifdgjzylfxxaoznv.supabase.co';
const PRICE_PARK_PRO   = 'price_1THw7R1J9Y6gYEOf0uy5xzEj';
const PRICE_NOMAD_PRO  = 'price_1THw3g1J9Y6gYEOfGNjMp4ke';
const ALLOWED_PRICES   = new Set([PRICE_PARK_PRO, PRICE_NOMAD_PRO]);

const CORS = {
  'Access-Control-Allow-Origin':  'https://rvspot.net',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/create-checkout-session' && request.method === 'POST') {
      return handleCheckout(request, env);
    }

    if (url.pathname === '/api/stripe-webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    if (url.pathname === '/api/create-booking-session' && request.method === 'POST') {
      return handleBookingCheckout(request, env);
    }

    if (url.pathname === '/api/get-booking-session' && request.method === 'GET') {
      return handleGetBookingSession(request, env);
    }

    // Serve static assets for everything else
    return env.ASSETS.fetch(request);
  },
};

/* ─── Checkout session ──────────────────────────────────────── */

async function handleCheckout(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { priceId, userEmail, userId, planType } = body;

  if (!ALLOWED_PRICES.has(priceId) || !userEmail || !userId) {
    return json({ error: 'Missing or invalid parameters' }, 400);
  }

  const successPath = planType === 'park_pro'
    ? 'pages/operator-dashboard.html'
    : 'pages/user-dashboard.html';

  const cancelPath = planType === 'park_pro'
    ? 'pages/for-operators.html'
    : '';

  const params = new URLSearchParams({
    mode:                       'subscription',
    'payment_method_types[]':   'card',
    'line_items[0][price]':     priceId,
    'line_items[0][quantity]':  '1',
    success_url:                `https://rvspot.net/${successPath}?upgraded=1`,
    cancel_url:                 `https://rvspot.net/${cancelPath}`,
    customer_email:             userEmail,
    'metadata[user_id]':        userId,
    'metadata[plan_type]':      planType,
  });

  let stripeRes, session;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    session = await stripeRes.json();
  } catch {
    return json({ error: 'Failed to reach Stripe' }, 502);
  }

  if (!stripeRes.ok) {
    return json({ error: session.error?.message || 'Stripe error' }, 400);
  }

  return json({ url: session.url }, 200);
}

/* ─── Stripe webhook ────────────────────────────────────────── */

async function handleWebhook(request, env) {
  const payload   = await request.text();
  const sigHeader = request.headers.get('stripe-signature');

  const valid = await verifySignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const event = JSON.parse(payload);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session  = event.data.object;
        const userId   = session.metadata?.user_id;
        const parkId   = session.metadata?.park_id;

        // Booking payment (one-time)
        if (parkId && userId) {
          await sbPost(env, '/rest/v1/bookings', {
            park_id:                  parkId,
            user_id:                  userId,
            check_in:                 session.metadata.check_in,
            check_out:                session.metadata.check_out,
            stay_type:                session.metadata.stay_type,
            base_amount:              parseFloat(session.metadata.base_amount),
            service_fee:              parseFloat(session.metadata.service_fee),
            tax_amount:               parseFloat(session.metadata.tax_amount),
            total_amount:             parseFloat(session.metadata.total_amount),
            stripe_payment_intent_id: session.payment_intent,
            status:                   'confirmed',
          }, 'resolution=merge-duplicates');
          break;
        }

        const planType = session.metadata?.plan_type;
        const subId    = session.subscription;
        if (!userId || !subId) break;

        const sub = await stripeGet(`/v1/subscriptions/${subId}`, env);
        const priceId     = sub.items?.data?.[0]?.price?.id;
        const periodEnd   = new Date(sub.current_period_end   * 1000).toISOString();
        const periodStart = new Date(sub.current_period_start * 1000).toISOString();

        await sbPost(env, '/rest/v1/subscriptions', {
          user_id:                userId,
          type:                   planType,
          stripe_subscription_id: subId,
          stripe_price_id:        priceId,
          status:                 'active',
          current_period_start:   periodStart,
          current_period_end:     periodEnd,
          cancel_at_period_end:   false,
        }, 'resolution=merge-duplicates');

        if (planType === 'nomad_pro') {
          await sbPatch(env, `/rest/v1/profiles?id=eq.${userId}`, {
            plan:               'nomad_pro',
            plan_expires_at:    periodEnd,
            stripe_customer_id: session.customer,
          });
        }

        if (planType === 'park_pro') {
          await sbPatch(env, `/rest/v1/parks?operator_id=eq.${userId}`, {
            plan:                   'pro',
            stripe_subscription_id: subId,
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub      = event.data.object;
        const isActive = sub.status === 'active' || sub.status === 'trialing';
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString();

        const [rec] = await sbGet(env,
          `/rest/v1/subscriptions?stripe_subscription_id=eq.${sub.id}&select=user_id,type`);
        if (!rec) break;

        await sbPatch(env, `/rest/v1/subscriptions?stripe_subscription_id=eq.${sub.id}`, {
          status:               sub.status,
          current_period_end:   periodEnd,
          cancel_at_period_end: sub.cancel_at_period_end,
        });

        if (rec.type === 'nomad_pro') {
          await sbPatch(env, `/rest/v1/profiles?id=eq.${rec.user_id}`, {
            plan:            isActive ? 'nomad_pro' : 'free',
            plan_expires_at: isActive ? periodEnd   : null,
          });
        }
        if (rec.type === 'park_pro') {
          await sbPatch(env, `/rest/v1/parks?operator_id=eq.${rec.user_id}`, {
            plan: isActive ? 'pro' : 'free',
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const [rec] = await sbGet(env,
          `/rest/v1/subscriptions?stripe_subscription_id=eq.${sub.id}&select=user_id,type`);
        if (!rec) break;

        await sbPatch(env, `/rest/v1/subscriptions?stripe_subscription_id=eq.${sub.id}`, {
          status: 'cancelled',
        });
        if (rec.type === 'nomad_pro') {
          await sbPatch(env, `/rest/v1/profiles?id=eq.${rec.user_id}`, {
            plan: 'free', plan_expires_at: null,
          });
        }
        if (rec.type === 'park_pro') {
          await sbPatch(env, `/rest/v1/parks?operator_id=eq.${rec.user_id}`, {
            plan: 'free', stripe_subscription_id: null,
          });
        }
        break;
      }
    }

    return json({ received: true }, 200);
  } catch (err) {
    console.error('Webhook error:', err);
    return new Response('Internal error', { status: 500 });
  }
}

/* ─── Booking checkout session ──────────────────────────────── */

async function handleBookingCheckout(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { parkId, parkName, userId, userEmail, checkIn, checkOut,
          stayType, baseAmount, serviceFee, taxAmount, totalAmount } = body;

  if (!parkId || !userId || !userEmail || !totalAmount) {
    return json({ error: 'Missing required parameters' }, 400);
  }

  const amountCents = Math.round(parseFloat(totalAmount) * 100);

  const params = new URLSearchParams({
    mode:                                              'payment',
    'payment_method_types[]':                         'card',
    'line_items[0][price_data][currency]':            'usd',
    'line_items[0][price_data][unit_amount]':         String(amountCents),
    'line_items[0][price_data][product_data][name]':  `${parkName} — ${stayType} stay`,
    'line_items[0][price_data][product_data][description]': `${checkIn} to ${checkOut}`,
    'line_items[0][quantity]':                        '1',
    success_url: `https://rvspot.net/pages/booking-confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `https://rvspot.net/park.html?id=${parkId}`,
    customer_email: userEmail,
    'metadata[user_id]':      userId,
    'metadata[park_id]':      parkId,
    'metadata[check_in]':     checkIn,
    'metadata[check_out]':    checkOut,
    'metadata[stay_type]':    stayType,
    'metadata[base_amount]':  String(baseAmount),
    'metadata[service_fee]':  String(serviceFee),
    'metadata[tax_amount]':   String(taxAmount),
    'metadata[total_amount]': String(totalAmount),
  });

  let stripeRes, session;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    session = await stripeRes.json();
  } catch {
    return json({ error: 'Failed to reach Stripe' }, 502);
  }

  if (!stripeRes.ok) {
    return json({ error: session.error?.message || 'Stripe error' }, 400);
  }

  return json({ url: session.url, sessionId: session.id }, 200);
}

/* ─── Get booking session (for confirmation page) ───────────── */

async function handleGetBookingSession(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId || !sessionId.startsWith('cs_')) {
    return json({ error: 'Invalid session ID' }, 400);
  }

  const stripeRes = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  const session = await stripeRes.json();
  if (!stripeRes.ok) return json({ error: 'Session not found' }, 404);

  return json({
    booking: {
      park_id:        session.metadata?.park_id,
      check_in:       session.metadata?.check_in,
      check_out:      session.metadata?.check_out,
      stay_type:      session.metadata?.stay_type,
      base_amount:    session.metadata?.base_amount,
      service_fee:    session.metadata?.service_fee,
      tax_amount:     session.metadata?.tax_amount,
      total_amount:   session.metadata?.total_amount,
      payment_intent: session.payment_intent,
      customer_email: session.customer_details?.email,
      payment_status: session.payment_status,
    }
  }, 200);
}

/* ─── Stripe helpers ────────────────────────────────────────── */

async function stripeGet(path, env) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  return res.json();
}

/* ─── Supabase helpers (service role) ──────────────────────── */

function sbHeaders(env) {
  return {
    apikey:          env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization:  `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function sbGet(env, path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, { headers: sbHeaders(env) });
  return res.json();
}

async function sbPost(env, path, data, prefer = '') {
  const headers = {
    ...sbHeaders(env),
    Prefer: prefer ? `return=minimal,${prefer}` : 'return=minimal',
  };
  return fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST', headers, body: JSON.stringify(data),
  });
}

async function sbPatch(env, path, data) {
  return fetch(`${SUPABASE_URL}${path}`, {
    method:  'PATCH',
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body:    JSON.stringify(data),
  });
}

/* ─── Stripe webhook signature verification ─────────────────── */

async function verifySignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  const parts   = sigHeader.split(',');
  const tsPart  = parts.find(p => p.startsWith('t='));
  const sigPart = parts.find(p => p.startsWith('v1='));
  if (!tsPart || !sigPart) return false;

  const ts   = tsPart.slice(2);
  const sig  = sigPart.slice(3);
  const data = `${ts}.${payload}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const computed    = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const computedHex = Array.from(new Uint8Array(computed))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  if (computedHex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

/* ─── Utility ───────────────────────────────────────────────── */

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
