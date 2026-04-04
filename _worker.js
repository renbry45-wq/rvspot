/* ============================================
   RVSpot.net — Cloudflare Worker
   Handles /api/* routes; serves static assets for everything else.

   Env vars required (Cloudflare Pages dashboard / .dev.vars locally):
     STRIPE_SECRET_KEY              — platform Stripe secret key
     STRIPE_WEBHOOK_SECRET          — platform webhook signing secret
     STRIPE_CONNECT_WEBHOOK_SECRET  — Connect webhook signing secret
       → Create a separate "Connect" webhook endpoint in Stripe Dashboard
         pointing to /api/stripe-connect-webhook, listening for account.updated
     SUPABASE_SERVICE_ROLE_KEY
     SUPABASE_JWT_SECRET            — from Supabase dashboard → Settings → API → JWT Secret
     RESEND_API_KEY
   ============================================ */

const SUPABASE_URL     = 'https://uydiifdgjzylfxxaoznv.supabase.co';
const PRICE_PARK_PRO   = 'price_1THw7R1J9Y6gYEOf0uy5xzEj';
const PRICE_NOMAD_PRO  = 'price_1THw3g1J9Y6gYEOfGNjMp4ke';
const ALLOWED_PRICES   = new Set([PRICE_PARK_PRO, PRICE_NOMAD_PRO]);
const PLATFORM_FEE_RATE = 0.03; // 3% collected by RVSpot on every booking

const CORS = {
  'Access-Control-Allow-Origin':  'https://rvspot.net',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    if (url.pathname === '/api/connect-onboard' && request.method === 'POST') {
      return handleConnectOnboard(request, env);
    }
    if (url.pathname === '/api/connect-status' && request.method === 'GET') {
      return handleConnectStatus(request, env);
    }
    if (url.pathname === '/api/stripe-connect-webhook' && request.method === 'POST') {
      return handleConnectWebhook(request, env);
    }
    if (url.pathname === '/sitemap.xml' && request.method === 'GET') {
      return handleSitemap(env);
    }
    if (url.pathname === '/robots.txt' && request.method === 'GET') {
      return handleRobots();
    }

    // Blog post pages: /blog/:slug — serve dynamic HTML with SSR SEO
    if (url.pathname.startsWith('/blog/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 2 && !parts[1].includes('.')) {
        return handleBlogPostPage(parts[1], env);
      }
    }

    // Serve static assets for everything else
    return env.ASSETS.fetch(request);
  },

  // Cron trigger: runs every hour, sends 48-hour Connect reminder emails.
  // Configure in Cloudflare Pages → Functions → Cron Triggers: "0 * * * *"
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendConnectReminders(env));
  },
};

/* ─── Subscription checkout session ────────────────────────── */

async function handleCheckout(request, env) {
  // Authenticate: userId comes from the verified JWT, never from the body
  const auth = await requireAuth(request, env);
  if (auth.error) return auth.error;
  const userId = auth.userId;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { priceId, userEmail, planType } = body;

  if (!ALLOWED_PRICES.has(priceId) || !userEmail) {
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

/* ─── Stripe webhook (platform account) ────────────────────── */

async function handleWebhook(request, env) {
  const payload   = await request.text();
  const sigHeader = request.headers.get('stripe-signature');

  const valid = await verifySignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const event = JSON.parse(payload);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.metadata?.user_id;
        const parkId  = session.metadata?.park_id;

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
            platform_fee:             parseFloat(session.metadata.platform_fee || 0),
            tax_amount:               parseFloat(session.metadata.tax_amount),
            total_amount:             parseFloat(session.metadata.total_amount),
            stripe_payment_intent_id: session.payment_intent,
            status:                   'confirmed',
          }, 'resolution=merge-duplicates');
          break;
        }

        // Subscription payment
        const planType = session.metadata?.plan_type;
        const subId    = session.subscription;
        if (!userId || !subId) break;

        const sub         = await stripeGet(`/v1/subscriptions/${subId}`, env);
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
  // Authenticate: userId comes from the verified JWT, never from the body
  const auth = await requireAuth(request, env);
  if (auth.error) return auth.error;
  const userId = auth.userId;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { parkId, parkName, userEmail, checkIn, checkOut,
          stayType, baseAmount, serviceFee, platformFee, taxAmount, totalAmount } = body;

  if (!parkId || !userEmail || !totalAmount) {
    return json({ error: 'Missing required parameters' }, 400);
  }

  // Enforce Stripe Connect — never fall back to charging RVSpot directly
  const parks = await sbGet(env,
    `/rest/v1/parks?id=eq.${parkId}&select=stripe_connect_account_id,stripe_connect_status`);
  const park = parks[0];

  if (!park) {
    return json({ error: 'Park not found' }, 404);
  }
  if (park.stripe_connect_status !== 'active') {
    return json({ error: 'This park is not currently accepting online bookings.' }, 422);
  }

  const amountCents      = Math.round(parseFloat(totalAmount) * 100);
  // application_fee_amount must not exceed the charge; compute from platformFee if provided,
  // otherwise fall back to PLATFORM_FEE_RATE of total so the math is always consistent.
  const platformFeeCents = platformFee
    ? Math.round(parseFloat(platformFee) * 100)
    : Math.round(amountCents * PLATFORM_FEE_RATE);

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
    'metadata[user_id]':       userId,
    'metadata[park_id]':       parkId,
    'metadata[check_in]':      checkIn,
    'metadata[check_out]':     checkOut,
    'metadata[stay_type]':     stayType,
    'metadata[base_amount]':   String(baseAmount),
    'metadata[service_fee]':   String(serviceFee),
    'metadata[platform_fee]':  String(platformFee || 0),
    'metadata[tax_amount]':    String(taxAmount),
    'metadata[total_amount]':  String(totalAmount),
    // Route funds to the park operator; RVSpot keeps application_fee_amount
    'payment_intent_data[application_fee_amount]':     String(platformFeeCents),
    'payment_intent_data[transfer_data][destination]': park.stripe_connect_account_id,
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
      platform_fee:   session.metadata?.platform_fee,
      tax_amount:     session.metadata?.tax_amount,
      total_amount:   session.metadata?.total_amount,
      payment_intent: session.payment_intent,
      customer_email: session.customer_details?.email,
      payment_status: session.payment_status,
    }
  }, 200);
}

/* ─── Stripe Connect: start onboarding ──────────────────────── */

async function handleConnectOnboard(request, env) {
  // Authenticate: userId comes from the verified JWT, never from the body
  const auth = await requireAuth(request, env);
  if (auth.error) return auth.error;
  const userId = auth.userId;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { parkId } = body;
  if (!parkId) return json({ error: 'Missing parkId' }, 400);

  // Verify park ownership — operator_id must match the authenticated userId
  const parks = await sbGet(env,
    `/rest/v1/parks?id=eq.${parkId}&operator_id=eq.${userId}&select=id,stripe_connect_account_id`);
  const park = parks[0];
  if (!park) return json({ error: 'Park not found or access denied' }, 404);

  let accountId = park.stripe_connect_account_id;

  if (!accountId) {
    // Create a new Stripe Express account for this operator
    const accountRes = await fetch('https://api.stripe.com/v1/accounts', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        type:                                     'express',
        'capabilities[card_payments][requested]': 'true',
        'capabilities[transfers][requested]':     'true',
      }),
    });
    const account = await accountRes.json();
    if (!accountRes.ok) {
      return json({ error: account.error?.message || 'Failed to create Stripe account' }, 400);
    }

    accountId = account.id;
    await sbPatch(env, `/rest/v1/parks?id=eq.${parkId}`, {
      stripe_connect_account_id: accountId,
      stripe_connect_status:     'pending',
    });
  }

  // Account links expire — always generate a fresh one
  const linkRes = await fetch('https://api.stripe.com/v1/account_links', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      account:     accountId,
      refresh_url: `https://rvspot.net/pages/operator-dashboard.html?connect=refresh`,
      return_url:  `https://rvspot.net/pages/operator-dashboard.html?connect=success`,
      type:        'account_onboarding',
    }),
  });
  const link = await linkRes.json();
  if (!linkRes.ok) {
    return json({ error: link.error?.message || 'Failed to create onboarding link' }, 400);
  }

  return json({ url: link.url }, 200);
}

/* ─── Stripe Connect: check status ──────────────────────────── */

async function handleConnectStatus(request, env) {
  const url    = new URL(request.url);
  const parkId = url.searchParams.get('park_id');
  if (!parkId) return json({ error: 'Missing park_id' }, 400);

  const parks = await sbGet(env,
    `/rest/v1/parks?id=eq.${parkId}&select=stripe_connect_status,stripe_connect_account_id`);
  const park = parks[0];
  if (!park) return json({ error: 'Park not found' }, 404);

  // When status is pending, verify directly with Stripe so the dashboard
  // updates immediately after the operator returns from Connect onboarding —
  // without waiting for the account.updated webhook to fire.
  if (park.stripe_connect_account_id && park.stripe_connect_status === 'pending') {
    const account = await stripeGet(
      `/v1/accounts/${park.stripe_connect_account_id}`, env);
    if (account.charges_enabled && account.details_submitted) {
      await sbPatch(env, `/rest/v1/parks?id=eq.${parkId}`, {
        stripe_connect_status: 'active',
      });
      return json({ status: 'active' }, 200);
    }
  }

  return json({ status: park.stripe_connect_status }, 200);
}

/* ─── Stripe Connect webhook (account.updated) ──────────────── */
// Set up a separate "Connect" webhook in Stripe Dashboard pointing to
// /api/stripe-connect-webhook, subscribed to account.updated.
// Set STRIPE_CONNECT_WEBHOOK_SECRET to its signing secret.

async function handleConnectWebhook(request, env) {
  const payload   = await request.text();
  const sigHeader = request.headers.get('stripe-signature');

  const valid = await verifySignature(payload, sigHeader, env.STRIPE_CONNECT_WEBHOOK_SECRET);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const event = JSON.parse(payload);

  if (event.type === 'account.updated') {
    const account = event.data.object;
    if (account.charges_enabled && account.details_submitted) {
      await sbPatch(env,
        `/rest/v1/parks?stripe_connect_account_id=eq.${account.id}`, {
          stripe_connect_status: 'active',
        });
    }
  }

  return json({ received: true }, 200);
}

/* ─── Scheduled: 48-hour Stripe Connect reminder emails ─────── */

async function sendConnectReminders(env) {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Parks whose operators haven't connected, created 48+ hours ago, no reminder sent yet
  const parks = await sbGet(env,
    `/rest/v1/parks` +
    `?stripe_connect_status=neq.active` +
    `&created_at=lte.${encodeURIComponent(cutoff)}` +
    `&stripe_connect_reminder_sent_at=is.null` +
    `&operator_id=not.is.null` +
    `&select=id,name,phone,operator_id`);

  if (!Array.isArray(parks)) return;

  for (const park of parks) {
    // Fetch operator email from Supabase Auth (service role required)
    const authRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${park.operator_id}`,
      { headers: sbHeaders(env) });
    const authUser = await authRes.json();
    if (!authUser?.email) continue;

    const firstName = authUser.user_metadata?.first_name || 'there';

    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    'RVSpot <noreply@rvspot.net>',
        to:      authUser.email,
        subject: `${park.name} isn't live yet — connect your bank to start accepting bookings`,
        html: `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
  <h2 style="color:#1a3c2e">Your park isn't live yet</h2>
  <p>Hi ${firstName},</p>
  <p><strong>${park.name}</strong> is listed on RVSpot, but guests can't book yet because you haven't connected your bank account.</p>
  <p>It takes less than 5 minutes and unlocks:</p>
  <ul>
    <li>The "Book Now" button on your listing</li>
    <li>Booking payments deposited directly to your account</li>
    <li>Your park appearing in guest search results</li>
  </ul>
  <p style="margin-top:24px">
    <a href="https://rvspot.net/pages/operator-dashboard.html"
       style="background:#2a8f5e;color:#fff;padding:14px 28px;border-radius:8px;
              text-decoration:none;display:inline-block;font-weight:600">
      Connect your bank account →
    </a>
  </p>
  <p style="color:#64748b;font-size:13px;margin-top:32px">
    Questions? Email us at <a href="mailto:support@rvspot.net" style="color:#2a8f5e">support@rvspot.net</a>
  </p>
</div>`,
      }),
    });

    // Mark reminder sent so we don't re-send
    await sbPatch(env, `/rest/v1/parks?id=eq.${park.id}`, {
      stripe_connect_reminder_sent_at: new Date().toISOString(),
    });
  }
}

/* ─── JWT authentication (Supabase HS256) ───────────────────── */

// Decodes a base64url string to a UTF-8 string (for header / payload)
function b64urlToStr(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.padEnd(b64.length + (4 - (b64.length % 4)) % 4, '=');
  return atob(pad);
}

// Decodes a base64url string to a Uint8Array (for the signature)
function b64urlToBytes(s) {
  const str = b64urlToStr(s);
  const buf = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
  return buf;
}

// Verifies a Supabase-issued JWT (HS256) and returns the payload.
// Throws on any validation failure so callers never see a partial result.
async function verifySupabaseJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  // 1. Decode and validate header
  const header = JSON.parse(b64urlToStr(parts[0]));
  if (header.alg !== 'HS256') throw new Error(`Unsupported algorithm: ${header.alg}`);

  // 2. Import the HMAC-SHA256 key from the raw secret string
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // 3. Verify signature: HMAC-SHA256( base64url(header) + '.' + base64url(payload) )
  const signingInput = `${parts[0]}.${parts[1]}`;
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(signingInput)
  );
  if (!valid) throw new Error('Invalid JWT signature');

  // 4. Decode payload and check expiry
  const payload = JSON.parse(b64urlToStr(parts[1]));
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('JWT has expired');
  }
  if (!payload.sub) throw new Error('JWT missing sub claim');

  return payload;
}

// Extracts and verifies the Bearer token from the Authorization header.
// Returns { userId } on success, or { error: Response } on failure.
// Usage: const auth = await requireAuth(request, env);
//        if (auth.error) return auth.error;
//        const userId = auth.userId;
async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: json({ error: 'Unauthorized' }, 401) };
  }
  const token = authHeader.slice(7); // strip 'Bearer '
  try {
    const payload = await verifySupabaseJWT(token, env.SUPABASE_JWT_SECRET);
    return { userId: payload.sub };
  } catch {
    return { error: json({ error: 'Unauthorized' }, 401) };
  }
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
    apikey:         env.SUPABASE_SERVICE_ROLE_KEY,
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

/* ─── Blog post page (SSR for SEO) ─────────────────────────── */

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

const BLOG_STATE_NAMES = ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming'];

async function handleBlogPostPage(slug, env) {
  const safeSlug = slug.replace(/[^a-z0-9-]/gi, '').slice(0, 200);
  if (!safeSlug) return new Response('Not Found', { status: 404 });

  const postRes = await sbGet(env, `/rest/v1/blog_posts?slug=eq.${encodeURIComponent(safeSlug)}&is_published=eq.true&limit=1&select=*`);
  if (!Array.isArray(postRes) || !postRes[0]) {
    return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Post Not Found — RVSpot Blog</title><link rel="stylesheet" href="/css/styles.css"></head><body><nav class="nav"><div class="nav-inner"><a href="/" class="nav-logo"><div class="nav-logo-dot"></div>RVSpot</a></div></nav><div class="container" style="padding:80px 24px;text-align:center"><div style="font-size:48px;margin-bottom:16px">📝</div><h1 style="font-size:2rem;margin-bottom:12px">Post not found</h1><p style="color:#4a5568;margin-bottom:24px">This article may have moved or been unpublished.</p><a href="/blog" class="btn btn-primary">Browse all articles</a></div></body></html>`, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  const p = postRes[0];

  // Detect first US state mentioned in content
  const plainText = (p.content || '').replace(/<[^>]*>/g, ' ');
  let mentionedState = null;
  for (const s of BLOG_STATE_NAMES) {
    const re = new RegExp(`\\b${s}\\b`, 'i');
    if (re.test(plainText)) { mentionedState = s; break; }
  }

  // Related parks + related articles in parallel
  const [relParks, relArticles] = await Promise.all([
    mentionedState
      ? sbGet(env, `/rest/v1/parks?state=eq.${encodeURIComponent(mentionedState)}&is_active=eq.true&select=id,name,city,state,slug,price_nightly,avg_rating,review_count&limit=3&order=avg_rating.desc`)
      : Promise.resolve([]),
    p.category
      ? sbGet(env, `/rest/v1/blog_posts?category=eq.${encodeURIComponent(p.category)}&is_published=eq.true&id=neq.${p.id}&select=slug,title,excerpt,featured_image_url,published_at,reading_time_minutes,category&limit=3&order=published_at.desc`)
      : Promise.resolve([]),
  ]);

  const pubDate  = p.published_at ? new Date(p.published_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const pubISO   = p.published_at || p.created_at || '';
  const updISO   = p.updated_at || pubISO;
  const readTime = p.reading_time_minutes ? `${p.reading_time_minutes} min read` : '';

  // Inject CTA box after 3rd </p>
  const ctaState = mentionedState || '';
  const ctaHref  = ctaState ? `/search?state=${encodeURIComponent(ctaState)}` : '/search';
  const ctaLabel = ctaState ? `Browse ${ctaState} Parks →` : 'Browse RV Parks →';
  const ctaTitle = ctaState ? `Planning an RV trip to ${ctaState}?` : 'Ready to find your next RV spot?';
  const ctaBox   = `<div class="blog-cta-box"><strong>${escHtml(ctaTitle)}</strong><p>Browse parks on RVSpot — book directly, no commission.</p><a href="${ctaHref}" class="btn btn-primary btn-sm">${ctaLabel}</a></div>`;
  let articleHtml = p.content || '<p>Content coming soon.</p>';
  let pCount = 0;
  articleHtml = articleHtml.replace(/<\/p>/g, m => { pCount++; return pCount === 3 ? `</p>${ctaBox}` : m; });
  if (pCount < 3) articleHtml += ctaBox;

  // Related parks HTML
  let parksHtml = '';
  if (mentionedState && Array.isArray(relParks) && relParks.length) {
    const cards = relParks.map(pk => `
      <a href="/park/${pk.slug}" class="bpc-card">
        <div class="bpc-name">${escHtml(pk.name)}</div>
        <div class="bpc-loc">${escHtml(pk.city)}, ${escHtml(pk.state)}</div>
        <div class="bpc-foot">
          ${pk.price_nightly ? `<span class="bpc-price">$${pk.price_nightly}/night</span>` : ''}
          ${pk.avg_rating ? `<span class="bpc-rating">★ ${parseFloat(pk.avg_rating).toFixed(1)}</span>` : ''}
        </div>
      </a>`).join('');
    parksHtml = `<section class="blog-related-parks container"><h2>RV Parks in ${escHtml(mentionedState)}</h2><p class="blog-section-sub">Parks near where this article takes you.</p><div class="bpc-grid">${cards}</div><div style="text-align:center;margin-top:24px"><a href="${ctaHref}" class="btn btn-secondary">View all ${escHtml(mentionedState)} parks →</a></div></section>`;
  }

  // Related articles HTML
  let articlesHtml = '';
  if (Array.isArray(relArticles) && relArticles.length) {
    const cards = relArticles.map(a => {
      const d = a.published_at ? new Date(a.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const img = a.featured_image_url
        ? `<div class="bcm-img" style="background-image:url('${escHtml(a.featured_image_url)}')"></div>`
        : `<div class="bcm-img bcm-no-img">📝</div>`;
      return `<a href="/blog/${a.slug}" class="bcm-card">${img}<div class="bcm-body"><span class="blog-cat-badge">${escHtml(a.category || '')}</span><div class="bcm-title">${escHtml(a.title)}</div><div class="bcm-meta">${d}${a.reading_time_minutes ? ` · ${a.reading_time_minutes} min` : ''}</div></div></a>`;
    }).join('');
    articlesHtml = `<section class="blog-related-articles container"><h2>More in ${escHtml(p.category || 'RV Life')}</h2><div class="bcm-grid">${cards}</div></section>`;
  }

  // Hero background
  const heroBg = p.featured_image_url
    ? `background-image:url('${escHtml(p.featured_image_url)}');background-size:cover;background-position:center`
    : 'background:var(--green-900)';

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Article',
    headline: p.title, description: p.meta_description || p.excerpt || '',
    image: p.featured_image_url || undefined,
    author: { '@type': 'Person', name: p.author || 'Renato Bryant' },
    publisher: { '@type': 'Organization', name: 'RVSpot', url: 'https://rvspot.net' },
    datePublished: pubISO, dateModified: updISO,
    url: `https://rvspot.net/blog/${p.slug}`,
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(p.title)} | RVSpot Blog</title>
  <meta name="description" content="${escHtml(p.meta_description || p.excerpt || '')}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escHtml(p.title)}">
  <meta property="og:description" content="${escHtml(p.meta_description || p.excerpt || '')}">
  ${p.featured_image_url ? `<meta property="og:image" content="${escHtml(p.featured_image_url)}">` : ''}
  <meta property="og:url" content="https://rvspot.net/blog/${p.slug}">
  <meta property="og:site_name" content="RVSpot Blog">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escHtml(p.title)}">
  <meta name="twitter:description" content="${escHtml(p.meta_description || p.excerpt || '')}">
  ${p.featured_image_url ? `<meta name="twitter:image" content="${escHtml(p.featured_image_url)}">` : ''}
  <link rel="canonical" href="https://rvspot.net/blog/${p.slug}">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏕</text></svg>">
  <link rel="stylesheet" href="/css/styles.css">
  <script type="application/ld+json">${jsonLd}</script>
  <script src="/js/analytics.js"></script>
  <style>
    .blog-post-hero{height:380px;position:relative;display:flex;align-items:flex-end;${heroBg}}
    .blog-post-hero::before{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.7) 0%,rgba(0,0,0,.2) 60%,transparent 100%)}
    .blog-post-hero-inner{position:relative;z-index:1;width:100%;max-width:760px;margin:0 auto;padding:0 24px 32px}
    .blog-cat-badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:var(--amber-300);color:var(--slate-900);margin-bottom:12px}
    .blog-post-title{font-family:var(--font-display);font-size:clamp(1.8rem,4vw,2.8rem);font-weight:700;color:#fff;line-height:1.2;margin-bottom:16px}
    .blog-post-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:13px;color:rgba(255,255,255,.75)}
    .blog-post-meta .sep{opacity:.4}
    .blog-article-wrap{max-width:760px;margin:0 auto;padding:48px 24px}
    .blog-article-body{font-size:17px;line-height:1.85;color:var(--slate-700)}
    .blog-article-body h2{font-family:var(--font-display);font-size:1.6rem;font-weight:700;color:var(--slate-900);margin:2em 0 .6em;padding-bottom:.4em;border-bottom:2px solid var(--cream-300)}
    .blog-article-body h3{font-family:var(--font-display);font-size:1.25rem;font-weight:700;color:var(--slate-900);margin:1.6em 0 .5em}
    .blog-article-body p{margin-bottom:1.4em}
    .blog-article-body ul,.blog-article-body ol{margin:0 0 1.4em 1.5em}
    .blog-article-body li{margin-bottom:.5em}
    .blog-article-body blockquote{border-left:4px solid var(--green-400);margin:1.6em 0;padding:.8em 1.4em;background:var(--green-50);color:var(--slate-600);font-style:italic;border-radius:0 var(--radius-md) var(--radius-md) 0}
    .blog-article-body img{width:100%;border-radius:var(--radius-lg);margin:1.6em 0;box-shadow:var(--shadow-md)}
    .blog-article-body a{color:var(--green-700);text-decoration:underline}
    .blog-article-body strong{color:var(--slate-900)}
    .blog-cta-box{background:var(--green-800);color:#fff;border-radius:var(--radius-xl);padding:32px;margin:2.4em 0;text-align:center}
    .blog-cta-box strong{font-size:1.1rem;display:block;margin-bottom:8px;color:#fff}
    .blog-cta-box p{color:rgba(255,255,255,.8);font-size:15px;margin-bottom:16px}
    .blog-cta-box .btn{background:var(--amber-300);color:var(--slate-900);font-weight:700}
    .blog-cta-box .btn:hover{background:var(--amber-500)}
    .blog-related-parks{padding:48px 24px;background:var(--cream-100);border-top:1px solid var(--cream-300)}
    .blog-related-parks h2,.blog-related-articles h2{font-family:var(--font-display);font-size:1.5rem;margin-bottom:6px}
    .blog-section-sub{color:var(--slate-400);font-size:14px;margin-bottom:24px}
    .bpc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
    .bpc-card{background:var(--white);border:1px solid var(--cream-300);border-radius:var(--radius-lg);padding:20px;transition:all var(--transition);text-decoration:none;color:inherit}
    .bpc-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-md)}
    .bpc-name{font-weight:700;font-size:15px;color:var(--slate-900);margin-bottom:4px}
    .bpc-loc{font-size:13px;color:var(--slate-400);margin-bottom:12px}
    .bpc-foot{display:flex;justify-content:space-between;font-size:13px}
    .bpc-price{color:var(--green-700);font-weight:600}
    .bpc-rating{color:var(--amber-700);font-weight:600}
    .blog-related-articles{padding:48px 24px;border-top:1px solid var(--cream-300)}
    .bcm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}
    .bcm-card{text-decoration:none;color:inherit;border-radius:var(--radius-lg);overflow:hidden;border:1px solid var(--cream-300);background:var(--white);transition:all var(--transition)}
    .bcm-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-md)}
    .bcm-img{height:140px;background-size:cover;background-position:center;background-color:var(--green-100)}
    .bcm-no-img{display:flex;align-items:center;justify-content:center;font-size:32px}
    .bcm-body{padding:16px}
    .bcm-title{font-weight:700;font-size:14px;color:var(--slate-900);margin:8px 0 4px;line-height:1.4}
    .bcm-meta{font-size:12px;color:var(--slate-400)}
    @media(max-width:600px){.blog-post-hero{height:260px}.blog-post-title{font-size:1.5rem}.blog-article-wrap{padding:32px 16px}}
  </style>
</head>
<body>
<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo"><div class="nav-logo-dot"></div>RVSpot</a>
    <ul class="nav-links">
      <li><a href="/search">Find Parks</a></li>
      <li><a href="/rv-reviews.html">RV Reviews</a></li>
      <li><a href="/routes.html">Route Planner</a></li>
      <li><a href="/blog" class="active">Blog</a></li>
      <li><a href="/pages/for-operators.html">For Operators</a></li>
    </ul>
    <div class="nav-actions">
      <button class="btn btn-ghost btn-sm" onclick="openModal('loginModal')">Sign in</button>
      <button class="btn btn-primary btn-sm" onclick="openModal('signupModal')">Join free</button>
    </div>
  </div>
</nav>

<article>
  <div class="blog-post-hero">
    <div class="blog-post-hero-inner">
      ${p.category ? `<div><span class="blog-cat-badge">${escHtml(p.category)}</span></div>` : ''}
      <h1 class="blog-post-title">${escHtml(p.title)}</h1>
      <div class="blog-post-meta">
        <span>By <strong>${escHtml(p.author || 'Renato Bryant')}</strong>, RVSpot Founder</span>
        ${pubDate ? `<span class="sep">·</span><time datetime="${pubISO}">${pubDate}</time>` : ''}
        ${readTime ? `<span class="sep">·</span><span>${readTime}</span>` : ''}
      </div>
    </div>
  </div>

  <div class="blog-article-wrap">
    <div class="blog-article-body">
      ${articleHtml}
    </div>
  </div>
</article>

${parksHtml}
${articlesHtml}

<footer class="footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <div class="logo">RVSpot</div>
        <p>The complete platform for RV travelers and park operators.</p>
        <p style="margin-top:12px;font-size:12px;color:rgba(255,255,255,0.25)">Operated by Booking Bridge LLC dba RVSpot</p>
      </div>
      <div class="footer-col"><h4>For Travelers</h4><ul><li><a href="/search">Find Parks</a></li><li><a href="/rv-reviews.html">RV Reviews</a></li><li><a href="/routes.html">Route Planner</a></li></ul></div>
      <div class="footer-col"><h4>Resources</h4><ul><li><a href="/blog">Blog</a></li><li><a href="/pages/for-operators.html">For Operators</a></li></ul></div>
      <div class="footer-col"><h4>Company</h4><ul><li><a href="/pages/tos.html">Terms of Service</a></li><li><a href="/pages/privacy.html">Privacy Policy</a></li></ul></div>
    </div>
    <div class="footer-bottom"><div class="footer-legal">© 2026 Booking Bridge LLC dba RVSpot · All rights reserved</div></div>
  </div>
</footer>

<div class="modal-overlay" id="loginModal"><div class="modal"><div class="modal-header"><div class="modal-title">Sign in to RVSpot</div><button class="modal-close" data-modal-close="loginModal">✕</button></div><div class="modal-body"><div class="form-group"><label class="form-label">Email</label><input type="email" id="loginEmail" placeholder="you@example.com"></div><div class="form-group"><label class="form-label">Password</label><input type="password" id="loginPassword" placeholder="Your password"></div><button class="btn btn-primary w-full" style="margin-top:8px" onclick="signInWithEmail(document.getElementById('loginEmail').value,document.getElementById('loginPassword').value)">Sign in</button></div></div></div>
<div class="modal-overlay" id="signupModal"><div class="modal"><div class="modal-header"><div class="modal-title">Join RVSpot free</div><button class="modal-close" data-modal-close="signupModal">✕</button></div><div class="modal-body"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div class="form-group"><label class="form-label">First name</label><input type="text" placeholder="Jane"></div><div class="form-group"><label class="form-label">Last name</label><input type="text" placeholder="Smith"></div></div><div class="form-group"><label class="form-label">Email</label><input type="email" placeholder="you@example.com"></div><div class="form-group"><label class="form-label">Password</label><input type="password" placeholder="Min. 8 characters"></div><button class="btn btn-primary w-full" style="margin-top:8px" onclick="showToast('Welcome to RVSpot! 🏕','success');closeModal('signupModal')">Create free account</button></div></div></div>

<script src="/js/app.js"></script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' },
  });
}

/* ─── Sitemap ───────────────────────────────────────────────── */

const US_STATES = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new-hampshire','new-jersey','new-mexico','new-york','north-carolina',
  'north-dakota','ohio','oklahoma','oregon','pennsylvania','rhode-island',
  'south-carolina','south-dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west-virginia','wisconsin','wyoming',
];

const STATIC_PAGES = [
  { loc: 'https://rvspot.net/',              priority: '1.0' },
  { loc: 'https://rvspot.net/search',        priority: '0.9' },
  { loc: 'https://rvspot.net/pricing',       priority: '0.8' },
  { loc: 'https://rvspot.net/how-it-works',  priority: '0.7' },
  { loc: 'https://rvspot.net/blog',          priority: '0.7' },
  { loc: 'https://rvspot.net/about',         priority: '0.6' },
  { loc: 'https://rvspot.net/faq',           priority: '0.6' },
];

function xmlUrl(loc, priority, lastmod) {
  return [
    '  <url>',
    `    <loc>${loc}</loc>`,
    lastmod ? `    <lastmod>${lastmod.slice(0, 10)}</lastmod>` : '',
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].filter(Boolean).join('\n');
}

async function handleSitemap(env) {
  // Fetch active parks and published blog posts in parallel
  const [parks, posts] = await Promise.all([
    sbGet(env, '/rest/v1/parks?select=slug,updated_at&stripe_connect_status=eq.active&slug=not.is.null'),
    sbGet(env, '/rest/v1/blog_posts?select=slug,updated_at&is_published=eq.true&slug=not.is.null'),
  ]);

  const urls = [];

  // Static pages
  for (const p of STATIC_PAGES) {
    urls.push(xmlUrl(p.loc, p.priority, null));
  }

  // State pages
  for (const state of US_STATES) {
    urls.push(xmlUrl(`https://rvspot.net/rv-parks/${state}`, '0.8', null));
  }

  // Dynamic park pages
  if (Array.isArray(parks)) {
    for (const park of parks) {
      if (park.slug) {
        urls.push(xmlUrl(`https://rvspot.net/park/${park.slug}`, '0.6', park.updated_at));
      }
    }
  }

  // Dynamic blog posts
  if (Array.isArray(posts)) {
    for (const post of posts) {
      if (post.slug) {
        urls.push(xmlUrl(`https://rvspot.net/blog/${post.slug}`, '0.5', post.updated_at));
      }
    }
  }

  // Must start with <?xml with NO leading whitespace or BOM —
  // Google rejects sitemaps that don't begin exactly with the XML declaration.
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.join('\n')
    + '\n</urlset>';

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

/* ─── Robots.txt ─────────────────────────────────────────────── */

function handleRobots() {
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /dashboard',
    'Disallow: /profile',
    'Disallow: /admin',
    'Disallow: /api',
    '',
    'Sitemap: https://rvspot.net/sitemap.xml',
  ].join('\n');

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

/* ─── Utility ───────────────────────────────────────────────── */

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
