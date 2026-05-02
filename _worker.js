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

    // Block sensitive/internal files from public access
    const blocked = /^\/(\.dev\.vars|outreach[-\w]*\.csv|scripts\/|backend\/|docs\/|logs\/|ISSUE_LOG\.md|wrangler\.(json|jsonc|toml))/i;
    if (blocked.test(url.pathname)) {
      return new Response('Not Found', { status: 404 });
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
    if (['/sitemap.xml','/sitemap-static.xml','/sitemap-parks.xml','/sitemap-blog.xml'].includes(url.pathname)) {
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=21600' } });
      }
      if (request.method === 'GET') {
        if (url.pathname === '/sitemap.xml')        return handleSitemapIndex();
        if (url.pathname === '/sitemap-static.xml') return handleSitemapStatic();
        if (url.pathname === '/sitemap-parks.xml')  return handleSitemapParks(env);
        if (url.pathname === '/sitemap-blog.xml')   return handleSitemapBlog(env);
      }
    }
    if (url.pathname === '/robots.txt' && request.method === 'GET') {
      return handleRobots();
    }

    // Reviews API
    if (url.pathname.startsWith('/api/reviews/park/') && request.method === 'GET') {
      const slug = url.pathname.replace('/api/reviews/park/', '').split('/')[0];
      return handleGetParkReviews(slug, env);
    }
    if (url.pathname === '/api/reviews/submit' && request.method === 'POST') {
      return handleSubmitReview(request, env);
    }
    if (url.pathname === '/api/admin/reviews' && request.method === 'GET') {
      return handleAdminListReviews(request, env);
    }
    if (url.pathname === '/api/admin/reviews/moderate' && request.method === 'POST') {
      return handleAdminModerateReview(request, env);
    }

    // RV Travel Routes page: /routes — SSR for SEO
    if (url.pathname === '/routes') {
      return handleRoutesPage(env);
    }

    // Park detail pages: /park/:slug — SSR for SEO (sitemap-matching URLs)
    if (url.pathname.startsWith('/park/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 2 && !parts[1].includes('.')) {
        return handleParkPage(parts[1], env);
      }
    }

    // Blog post pages: /blog/:slug — serve dynamic HTML with SSR SEO
    if (url.pathname.startsWith('/blog/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 2 && !parts[1].includes('.')) {
        return handleBlogPostPage(parts[1], env);
      }
    }

    // Legacy redirect: /park?id=UUID or /park.html?id=UUID → /park/:slug (301)
    if ((url.pathname === '/park' || url.pathname === '/park.html') && url.searchParams.has('id')) {
      const parkId = url.searchParams.get('id');
      try {
        const rows = await sbGet(env, `/rest/v1/parks?id=eq.${encodeURIComponent(parkId)}&select=slug&limit=1`);
        if (Array.isArray(rows) && rows[0]?.slug) {
          return Response.redirect(`${url.origin}/park/${rows[0].slug}`, 301);
        }
      } catch (_) {}
      // ID not found — fall through to static asset (park.html will show "not found")
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
          // Worker-level idempotency guard — bail if this payment intent was already processed.
          // The DB UNIQUE constraint is the hard stop; this avoids the unnecessary upsert entirely.
          const existing = await sbGet(env,
            `/rest/v1/bookings?stripe_payment_intent_id=eq.${session.payment_intent}&select=id&limit=1`);
          if (existing.length > 0) break;

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
    `/rest/v1/parks?id=eq.${encodeURIComponent(parkId)}&select=stripe_connect_account_id,stripe_connect_status`);
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
  const auth = await requireAuth(request, env);
  if (auth.error) return auth.error;
  const userId = auth.userId;

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

  if (session.metadata?.user_id !== userId) {
    return json({ error: 'Access denied' }, 403);
  }

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
  const auth = await requireAuth(request, env);
  if (auth.error) return auth.error;
  const userId = auth.userId;

  const url    = new URL(request.url);
  const parkId = url.searchParams.get('park_id');
  if (!parkId) return json({ error: 'Missing park_id' }, 400);

  const parks = await sbGet(env,
    `/rest/v1/parks?id=eq.${parkId}&operator_id=eq.${userId}&select=stripe_connect_status,stripe_connect_account_id`);
  const park = parks[0];
  if (!park) return json({ error: 'Park not found or access denied' }, 404);

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

/* ─── JWT authentication (Supabase — algorithm-agnostic) ────── */

// Validates a Bearer token via Supabase's /auth/v1/user endpoint.
// Works with both HS256 and ES256 tokens (Supabase migrated to ES256).
// Returns { userId } on success, or { error: Response } on failure.
async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: json({ error: 'Unauthorized' }, 401) };
  }
  const token = authHeader.slice(7);
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${token}`,
      }
    });
    if (!res.ok) return { error: json({ error: 'Unauthorized' }, 401) };
    const user = await res.json();
    if (!user.id) return { error: json({ error: 'Unauthorized' }, 401) };
    return { userId: user.id };
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

  // Reject webhooks older than 5 minutes (Stripe's standard tolerance)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(ts, 10)) > 300) return false;

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

/* ─── Park detail page (SSR for SEO) ───────────────────────── */

async function handleParkPage(slug, env) {
  const safeSlug = slug.replace(/[^a-z0-9-]/gi, '').slice(0, 200);
  if (!safeSlug) return new Response('Not Found', { status: 404 });

  // Fetch park + nearby parks in parallel
  const [parkRes, _] = await Promise.all([
    sbGet(env, `/rest/v1/parks?slug=eq.${encodeURIComponent(safeSlug)}&is_active=eq.true&limit=1&select=*`),
    Promise.resolve(null),
  ]);

  if (!Array.isArray(parkRes) || !parkRes[0]) {
    return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Park Not Found — RVSpot</title><link rel="stylesheet" href="/css/styles.css"></head><body><nav class="nav"><div class="nav-inner"><a href="/" class="nav-logo"><div class="nav-logo-dot"></div>RVSpot</a></div></nav><div class="container" style="padding:80px 24px;text-align:center"><div style="font-size:48px;margin-bottom:16px">🏕️</div><h1 style="font-size:2rem;margin-bottom:12px">Park not found</h1><p style="color:#4a5568;margin-bottom:24px">This park may have moved or is no longer listed.</p><a href="/search" class="btn btn-primary">Browse all parks</a></div></body></html>`, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const pk = parkRes[0];

  // Fetch 3 nearby parks from same state (exclude this park)
  const nearbyParks = await sbGet(env,
    `/rest/v1/parks?state=eq.${encodeURIComponent(pk.state)}&is_active=eq.true&slug=neq.${encodeURIComponent(safeSlug)}&select=id,name,city,state,slug,price_nightly,avg_rating,review_count,has_wifi,has_pool,pets_allowed&limit=3&order=avg_rating.desc.nullslast`
  );

  // ── Generate stopgap description if missing ──────────────────
  let desc = pk.description;
  if (!desc || desc.trim() === '') {
    const amenityList = [];
    if (pk.has_30amp || pk.has_50amp || pk.has_full_hookup) amenityList.push('electric hookups');
    if (pk.has_water)        amenityList.push('water hookups');
    if (pk.has_sewer)        amenityList.push('sewer hookups');
    if (pk.has_wifi)         amenityList.push('Wi-Fi');
    if (pk.has_pool)         amenityList.push('a swimming pool');
    if (pk.pets_allowed)     amenityList.push('pet-friendly sites');
    if (pk.has_laundry)      amenityList.push('laundry facilities');
    if (pk.has_dump_station) amenityList.push('an RV dump station');
    if (pk.has_cowork)       amenityList.push('a co-working space');
    if (pk.has_ev_charging)  amenityList.push('EV charging');
    const amenStr = amenityList.length
      ? `Amenities include ${amenityList.slice(0, -1).join(', ')}${amenityList.length > 1 ? ' and ' + amenityList[amenityList.length - 1] : amenityList[0]}.`
      : '';
    const typeLabel = pk.type ? pk.type.replace(/_/g,' ') : 'RV park';
    const priceStr = pk.price_nightly ? `Nightly rates start at $${pk.price_nightly}.` : '';
    desc = `${pk.name} is a ${typeLabel} located in ${pk.city}, ${pk.state}. ${amenStr} ${priceStr} Find availability, read reviews, and book your stay directly on RVSpot — no commission, no booking fees.`.replace(/\s{2,}/g,' ').trim();
  }

  // ── Meta description (≤155 chars) ───────────────────────────
  const metaDesc = desc.length > 155 ? desc.slice(0, 152) + '...' : desc;

  // ── Quick Facts block (SSR, no JS — Google featured-snippet target) ──
  {
    // Scope to avoid name collisions
  }
  const qfParts = [];
  // Opener: first sentence of description (natural prose already contains name/type/city/state)
  const qfFirstSent = desc ? desc.split(/(?<=[.!?])\s+/)[0].trim() : '';
  if (qfFirstSent) {
    qfParts.push(escHtml(qfFirstSent) + (qfFirstSent.match(/[.!?]$/) ? '' : '.'));
  } else {
    const qfType = pk.type ? pk.type.replace(/_/g,' ') : 'RV park';
    qfParts.push(`${escHtml(pk.name)} is a ${qfType} in ${escHtml(pk.city)}, ${escHtml(pk.state)}.`);
  }
  // Non-default amenities only (skip pets/big-rigs here — shown in chips)
  const qfAmen = [];
  if (pk.has_full_hookup) qfAmen.push('full hookups');
  else { if (pk.has_50amp) qfAmen.push('50-amp electric'); else if (pk.has_30amp) qfAmen.push('30-amp electric'); }
  if (pk.has_wifi)         qfAmen.push('Wi-Fi');
  if (pk.has_pool)         qfAmen.push('pool');
  if (pk.has_cowork)       qfAmen.push('co-working space');
  if (pk.has_dump_station) qfAmen.push('RV dump station');
  if (pk.has_ev_charging)  qfAmen.push('EV charging');
  if (qfAmen.length) qfParts.push(`Amenities include ${qfAmen.join(', ')}.`);
  // Pricing (5 parks have data)
  if (pk.price_nightly) qfParts.push(`From $${pk.price_nightly}/night.`);
  // Rating (5 parks have data)
  if (pk.avg_rating && pk.review_count > 0) qfParts.push(`Rated ${parseFloat(pk.avg_rating).toFixed(1)}/5 by ${pk.review_count} traveler${pk.review_count === 1 ? '' : 's'}.`);
  // Build the contact line separately (has HTML links)
  const qfContactParts = [];
  if (pk.phone) qfContactParts.push(`<a href="tel:${escHtml(pk.phone)}" class="qf-link">📞 ${escHtml(pk.phone)}</a>`);
  if (pk.website) qfContactParts.push(`<a href="${escHtml(pk.website)}" class="qf-link" target="_blank" rel="nofollow noopener">Visit ${escHtml(pk.name)}'s website ↗</a>`);
  const quickFactsHtml = `<div class="park-quick-facts">
  <p>${qfParts.join(' ')}</p>${qfContactParts.length ? `\n  <p class="qf-contact">${qfContactParts.join(' &nbsp;·&nbsp; ')}</p>` : ''}
</div>`;

  // ── Amenity chips ────────────────────────────────────────────
  const hasElectric = pk.has_30amp || pk.has_50amp || pk.has_full_hookup;
  const chipDefs = [
    { field: hasElectric,          icon: '⚡', label: 'Electric Hookups' },
    { field: pk.has_water,         icon: '💧', label: 'Water' },
    { field: pk.has_sewer,         icon: '🔧', label: 'Sewer' },
    { field: pk.has_wifi,          icon: '📶', label: 'Wi-Fi' },
    { field: pk.has_pool,          icon: '🏊', label: 'Pool' },
    { field: pk.pets_allowed,      icon: '🐾', label: 'Pet Friendly' },
    { field: pk.has_laundry,       icon: '👕', label: 'Laundry' },
    { field: pk.has_dump_station,  icon: '🚿', label: 'RV Dump' },
    { field: pk.has_ev_charging,   icon: '🔌', label: 'EV Charging' },
    { field: pk.has_cowork,        icon: '💻', label: 'Co-Working' },
    { field: pk.accepts_packages,  icon: '📦', label: 'Package Delivery' },
    { field: pk.has_quiet_hours,   icon: '🔇', label: 'Quiet Hours' },
    { field: pk.big_rigs_ok,       icon: '🚛', label: 'Big Rigs OK' },
  ];
  const chipsHtml = chipDefs.filter(c => c.field)
    .map(c => `<span class="park-chip">${c.icon} ${c.label}</span>`)
    .join('');

  // ── Work-Ready badge ─────────────────────────────────────────
  const isWorkReady = pk.has_wifi && (pk.has_cowork || (pk.avg_wifi_mbps && pk.avg_wifi_mbps >= 25) || pk.wifi_speed_tier === 'fast' || pk.wifi_speed_tier === 'gigabit');
  const workBadge = isWorkReady ? `<span class="badge-work-ready" title="Strong Wi-Fi + remote-work amenities">💻 Work-Ready</span>` : '';

  // ── Pricing block ────────────────────────────────────────────
  const priceItems = [];
  if (pk.price_nightly)  priceItems.push(`<div class="price-item"><span class="price-label">Nightly</span><span class="price-val">$${pk.price_nightly}</span></div>`);
  if (pk.price_weekly)   priceItems.push(`<div class="price-item"><span class="price-label">Weekly</span><span class="price-val">$${pk.price_weekly}</span></div>`);
  if (pk.price_monthly)  priceItems.push(`<div class="price-item"><span class="price-label">Monthly</span><span class="price-val">$${pk.price_monthly}</span></div>`);
  const priceHtml = priceItems.length
    ? `<div class="price-grid">${priceItems.join('')}</div>`
    : '';

  // ── True Monthly Cost block ──────────────────────────────────
  let trueMonthlyHtml = '';
  if (pk.price_monthly || pk.price_nightly) {
    let tmcRowsHtml = '';
    let tmcDepositNote = '';
    let tmcFooterNote = '';

    if (pk.price_monthly) {
      const base = parseFloat(pk.price_monthly);
      const tmcRows = [];
      let total = base;
      let isEstimate = false;

      tmcRows.push({ label: 'Base monthly rate', val: `$${Math.round(base).toLocaleString()}` });

      if (pk.monthly_utilities_included) {
        tmcRows.push({ label: 'Electricity', val: 'Included ✓' });
      } else if (pk.monthly_electric_surcharge != null) {
        const v = parseFloat(pk.monthly_electric_surcharge);
        tmcRows.push({ label: 'Electricity (metered)', val: `$${Math.round(v)}` });
        total += v;
      } else {
        tmcRows.push({ label: 'Electricity (metered)', val: '~$50–$150/mo typical', estimated: true });
        total += 100;
        isEstimate = true;
      }

      if (pk.monthly_wifi_surcharge != null) {
        const v = parseFloat(pk.monthly_wifi_surcharge);
        tmcRows.push({ label: 'Wi-Fi fee', val: `$${Math.round(v)}` });
        total += v;
      }

      if (pk.monthly_pet_fee != null) {
        const v = parseFloat(pk.monthly_pet_fee);
        tmcRows.push({ label: 'Pet fee (per pet/mo)', val: `$${Math.round(v)}` });
      }

      if (pk.monthly_admin_fee != null) {
        const v = parseFloat(pk.monthly_admin_fee);
        tmcRows.push({ label: 'Admin / processing fee', val: `$${Math.round(v)}` });
        total += v;
      }

      tmcRows.push({ label: isEstimate ? 'Estimated monthly total*' : 'Monthly total', val: `$${Math.round(total).toLocaleString()}`, isTotal: true });

      tmcRowsHtml = tmcRows.map(r =>
        `<div class="tmc-row${r.isTotal ? ' tmc-row-total' : ''}"><span class="tmc-label">${escHtml(r.label)}</span><span class="tmc-val${r.estimated ? ' tmc-val-est' : ''}">${escHtml(r.val)}</span></div>`
      ).join('');

      if (pk.monthly_deposit != null) {
        tmcDepositNote = `<p class="tmc-disclosure">💳 Deposit: $${Math.round(parseFloat(pk.monthly_deposit))} (one-time, typically refundable).</p>`;
      }

      tmcFooterNote = isEstimate
        ? `<p class="tmc-disclosure">* Electricity is metered at this park — actual charges vary by usage. Other figures are park-provided. <a href="/monthly-cost-methodology" class="tmc-link">How we calculate this →</a></p>`
        : `<p class="tmc-disclosure">Rates provided by park. Verify current pricing directly with the park. <a href="/monthly-cost-methodology" class="tmc-link">About our cost estimates →</a></p>`;
    } else {
      const nightlyEst = Math.round(parseFloat(pk.price_nightly) * 30);
      tmcRowsHtml = `<div class="tmc-row"><span class="tmc-label">30-night estimate (nightly × 30)</span><span class="tmc-val tmc-val-est">~$${nightlyEst.toLocaleString()}</span></div>`;
      tmcFooterNote = `<p class="tmc-disclosure">No monthly rate published. Monthly long-stay rates are typically 30–50% lower than this estimate — contact the park directly. <a href="/monthly-cost-methodology" class="tmc-link">How we estimate →</a></p>`;
    }

    trueMonthlyHtml = `<div class="detail-section true-monthly-block">
  <h2>💰 True Monthly Cost</h2>
  <div class="tmc-rows">${tmcRowsHtml}</div>${tmcDepositNote}${tmcFooterNote}</div>`;
  }

  // ── Rating stars ─────────────────────────────────────────────
  const ratingHtml = pk.avg_rating
    ? `<div class="park-rating-row"><span class="rating-stars">★ ${parseFloat(pk.avg_rating).toFixed(1)}</span><span class="rating-count">(${pk.review_count || 0} review${pk.review_count === 1 ? '' : 's'})</span></div>`
    : '';

  // ── Wi-Fi detail ─────────────────────────────────────────────
  const wifiTierLabel = { unknown: 'Speed unknown', slow: 'Slow (<10 Mbps)', moderate: 'Moderate (10–50 Mbps)', fast: 'Fast (50–300 Mbps)', gigabit: 'Gigabit (300+ Mbps)' };
  let wifiHtml = '';
  if (pk.has_wifi) {
    wifiHtml = `<div class="detail-section"><h2>Wi-Fi & Connectivity</h2>`;
    if (pk.wifi_speed_tier && pk.wifi_speed_tier !== 'unknown') wifiHtml += `<p><strong>Speed tier:</strong> ${escHtml(wifiTierLabel[pk.wifi_speed_tier] || pk.wifi_speed_tier)}</p>`;
    if (pk.avg_wifi_mbps) wifiHtml += `<p><strong>Avg speed:</strong> ${pk.avg_wifi_mbps} Mbps</p>`;
    if (pk.cell_signal_notes) wifiHtml += `<p><strong>Cell signal:</strong> ${escHtml(pk.cell_signal_notes)}</p>`;
    if (pk.cowork_notes) wifiHtml += `<p><strong>Co-work notes:</strong> ${escHtml(pk.cowork_notes)}</p>`;
    if (pk.quiet_hours) wifiHtml += `<p><strong>Quiet hours:</strong> ${escHtml(pk.quiet_hours)}</p>`;
    wifiHtml += `</div>`;
  }

  // ── Travel corridors section ─────────────────────────────────
  // Use DB travel_corridors if populated; fall back to state-based lookup
  const pkCorridorIds = (Array.isArray(pk.travel_corridors) && pk.travel_corridors.length > 0)
    ? pk.travel_corridors
    : (STATE_TO_CORRIDORS[pk.state] || []);
  let corridorHtml = '';
  if (pkCorridorIds.length > 0) {
    const matchedCorridors = pkCorridorIds
      .map(id => TRAVEL_CORRIDORS.find(c => c.id === id))
      .filter(Boolean);
    if (matchedCorridors.length > 0) {
      const tags = matchedCorridors.map(c =>
        `<a href="/routes#${c.id}" class="corridor-tag">${c.emoji} ${escHtml(c.name)}</a>`
      ).join('');
      corridorHtml = `<div class="detail-section">
  <h2>On the Road</h2>
  <p style="font-size:15px;color:var(--slate-500);margin-bottom:12px">This park sits along popular RV travel corridors:</p>
  <div class="corridor-tags">${tags}</div>
</div>`;
    }
  }

  // ── Nearby parks ─────────────────────────────────────────────
  let nearbyHtml = '';
  if (Array.isArray(nearbyParks) && nearbyParks.length) {
    const cards = nearbyParks.map(np => `
      <a href="/park/${np.slug}" class="bpc-card">
        <div class="bpc-name">${escHtml(np.name)}</div>
        <div class="bpc-loc">${escHtml(np.city)}, ${escHtml(np.state)}</div>
        <div class="bpc-foot">
          ${np.price_nightly ? `<span class="bpc-price">$${np.price_nightly}/night</span>` : ''}
          ${np.avg_rating ? `<span class="bpc-rating">★ ${parseFloat(np.avg_rating).toFixed(1)}</span>` : ''}
        </div>
      </a>`).join('');
    nearbyHtml = `<section class="nearby-parks-section container"><h2>More RV Parks in ${escHtml(pk.state)}</h2><div class="bpc-grid">${cards}</div><div style="text-align:center;margin-top:24px"><a href="/search?state=${encodeURIComponent(pk.state)}" class="btn btn-secondary">View all ${escHtml(pk.state)} parks →</a></div></section>`;
  }

  // ── JSON-LD Campground (schema.org/Campground) ───────────────
  const jsonLdObj = {
    '@context': 'https://schema.org',
    '@type': 'Campground',
    name: pk.name,
    description: desc,
    url: `https://rvspot.net/park/${pk.slug}`,
    ...(pk.website ? { sameAs: pk.website } : {}),
    address: {
      '@type': 'PostalAddress',
      addressLocality: pk.city,
      addressRegion: pk.state,
      postalCode: pk.zip || undefined,
      addressCountry: 'US',
      streetAddress: pk.address || undefined,
    },
    telephone: pk.phone || undefined,
    ...(pk.lat && pk.lng ? { geo: { '@type': 'GeoCoordinates', latitude: parseFloat(pk.lat), longitude: parseFloat(pk.lng) } } : {}),
    ...(pk.avg_rating && pk.review_count > 0 ? {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: parseFloat(pk.avg_rating).toFixed(1),
        reviewCount: pk.review_count,
        bestRating: 5,
        worstRating: 1,
      }
    } : {}),
    ...(pk.price_nightly ? { priceRange: `$${pk.price_nightly}/night` } : {}),
    amenityFeature: chipDefs.filter(c => c.field).map(c => ({ '@type': 'LocationFeatureSpecification', name: c.label, value: true })),
  };
  // Omit undefined values for clean output
  const jsonLd = JSON.stringify(jsonLdObj, (k, v) => v === undefined ? undefined : v);

  const parkTypeBadge = pk.type ? `<span class="park-type-label">${escHtml(pk.type.replace(/_/g,' '))}</span>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(pk.name)} — RV Park in ${escHtml(pk.city)}, ${escHtml(pk.state)} | RVSpot</title>
  <meta name="description" content="${escHtml(metaDesc)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escHtml(pk.name)} — RV Park in ${escHtml(pk.city)}, ${escHtml(pk.state)}">
  <meta property="og:description" content="${escHtml(metaDesc)}">
  <meta property="og:url" content="https://rvspot.net/park/${pk.slug}">
  <meta property="og:site_name" content="RVSpot">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escHtml(pk.name)} | RVSpot">
  <meta name="twitter:description" content="${escHtml(metaDesc)}">
  <link rel="canonical" href="https://rvspot.net/park/${pk.slug}">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏕</text></svg>">
  <link rel="stylesheet" href="/css/styles.css">
  <script type="application/ld+json">${jsonLd}</script>
  <script src="/js/analytics.js"></script>
  <style>
    .park-hero{background:linear-gradient(135deg,var(--green-900) 0%,var(--green-700) 100%);padding:64px 24px 48px;color:#fff}
    .park-hero-inner{max-width:900px;margin:0 auto}
    .park-breadcrumb{font-size:13px;color:rgba(255,255,255,.6);margin-bottom:16px}
    .park-breadcrumb a{color:rgba(255,255,255,.7);text-decoration:none}
    .park-breadcrumb a:hover{color:#fff}
    .park-hero h1{font-family:var(--font-display);font-size:clamp(1.8rem,4vw,2.6rem);font-weight:700;margin:0 0 8px;line-height:1.2}
    .park-hero-loc{font-size:16px;color:rgba(255,255,255,.8);margin-bottom:16px}
    .park-hero-badges{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
    .park-type-label{display:inline-block;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:rgba(255,255,255,.15);color:#fff}
    .badge-work-ready{display:inline-block;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700;background:var(--amber-300);color:var(--slate-900)}
    .rating-stars{color:var(--amber-300);font-weight:700;font-size:16px}
    .rating-count{color:rgba(255,255,255,.6);font-size:14px;margin-left:6px}
    .park-rating-row{margin-top:8px}
    .park-body{max-width:900px;margin:0 auto;padding:48px 24px;display:grid;grid-template-columns:1fr 320px;gap:40px}
    .park-main{}
    .park-sidebar{}
    .park-quick-facts{background:var(--cream-100,#faf9f7);border:1px solid var(--cream-300,#e8e4de);border-radius:var(--radius-lg,10px);padding:16px 20px;margin-bottom:24px;font-size:15px;line-height:1.65;color:var(--slate-700,#374151)}
    .park-quick-facts p{margin:0 0 6px}
    .park-quick-facts p:last-child{margin-bottom:0}
    .qf-contact{font-size:14px;color:var(--slate-500,#6b7280)}
    .qf-link{color:var(--green-700,#15803d);text-decoration:none}
    .qf-link:hover{text-decoration:underline}
    .park-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:32px}
    .park-chip{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:500;background:var(--green-50);color:var(--green-900);border:1px solid var(--green-200)}
    .park-description{font-size:16px;line-height:1.8;color:var(--slate-700);margin-bottom:32px}
    .detail-section{margin-bottom:32px}
    .detail-section h2{font-family:var(--font-display);font-size:1.25rem;font-weight:700;color:var(--slate-900);margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid var(--cream-300)}
    .detail-section p{font-size:15px;color:var(--slate-600);margin-bottom:8px}
    .detail-section strong{color:var(--slate-800)}
    .park-card-sidebar{background:var(--white);border:1px solid var(--cream-300);border-radius:var(--radius-xl);padding:24px;box-shadow:var(--shadow-sm);position:sticky;top:80px}
    .park-card-sidebar h3{font-family:var(--font-display);font-size:1.1rem;font-weight:700;margin-bottom:16px;color:var(--slate-900)}
    .price-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}
    .price-item{text-align:center;background:var(--cream-100);border-radius:var(--radius-md);padding:12px 8px}
    .price-label{display:block;font-size:11px;color:var(--slate-400);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
    .price-val{display:block;font-size:1.2rem;font-weight:700;color:var(--green-700)}
    .sidebar-cta{display:block;width:100%;padding:14px;border-radius:var(--radius-lg);background:var(--green-700);color:#fff;font-weight:700;text-align:center;text-decoration:none;font-size:15px;transition:background var(--transition);margin-bottom:12px}
    .sidebar-cta:hover{background:var(--green-900)}
    .sidebar-contact{font-size:13px;color:var(--slate-400);margin-top:12px}
    .sidebar-contact a{color:var(--green-700)}
    .corridor-tags{display:flex;flex-wrap:wrap;gap:8px}
    .corridor-tag{display:inline-flex;align-items:center;gap:5px;padding:7px 16px;border-radius:20px;font-size:13px;font-weight:600;background:var(--green-50,#f0fdf4);color:var(--green-800,#166534);border:1px solid var(--green-200,#bbf7d0);text-decoration:none;transition:all var(--transition)}
    .corridor-tag:hover{background:var(--green-100,#dcfce7);border-color:var(--green-400,#4ade80)}
    .nearby-parks-section{padding:48px 24px;background:var(--cream-100);border-top:1px solid var(--cream-300)}
    .nearby-parks-section h2{font-family:var(--font-display);font-size:1.5rem;margin-bottom:24px}
    .true-monthly-block{background:var(--green-50,#f0fdf4);border:1px solid var(--green-200,#bbf7d0)}
    .true-monthly-block h2{border-color:var(--green-300,#86efac)!important}
    .tmc-rows{display:flex;flex-direction:column}
    .tmc-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--green-100,#dcfce7);font-size:14px}
    .tmc-row:last-child{border-bottom:none}
    .tmc-row-total{padding-top:12px;border-top:2px solid var(--green-300,#86efac)!important;border-bottom:none!important}
    .tmc-label{color:var(--slate-600,#4b5563)}
    .tmc-val{font-weight:600;color:var(--slate-900,#111827)}
    .tmc-val-est{color:var(--slate-400,#9ca3af);font-style:italic;font-weight:400}
    .tmc-row-total .tmc-label{color:var(--green-800,#166534);font-weight:700;font-size:15px}
    .tmc-row-total .tmc-val{color:var(--green-700,#15803d);font-size:1.15rem}
    .tmc-disclosure{font-size:12px;color:var(--slate-400,#9ca3af);margin-top:10px;line-height:1.6;margin-bottom:0}
    .tmc-link{color:var(--green-700,#15803d);text-decoration:none}
    .tmc-link:hover{text-decoration:underline}
    @media(max-width:768px){.park-body{grid-template-columns:1fr}.park-sidebar{order:-1}.park-card-sidebar{position:static}}
    @media(max-width:600px){.park-hero{padding:48px 16px 36px}.price-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo"><div class="nav-logo-dot"></div>RVSpot</a>
    <ul class="nav-links">
      <li><a href="/search" class="active">Find Parks</a></li>
      <li><a href="/rv-reviews.html">RV Reviews</a></li>
      <li><a href="/routes.html">Route Planner</a></li>
      <li><a href="/blog">Blog</a></li>
      <li><a href="/pages/for-operators.html">For Operators</a></li>
    </ul>
    <div class="nav-actions">
      <button class="btn btn-ghost btn-sm" onclick="openModal('loginModal')">Sign in</button>
      <button class="btn btn-primary btn-sm" onclick="openModal('signupModal')">Join free</button>
    </div>
  </div>
</nav>

<div class="park-hero">
  <div class="park-hero-inner">
    <div class="park-breadcrumb">
      <a href="/">Home</a> › <a href="/search">Find Parks</a> › <a href="/search?state=${encodeURIComponent(pk.state)}">${escHtml(pk.state)}</a> › ${escHtml(pk.city)}
    </div>
    <h1>${escHtml(pk.name)}</h1>
    <div class="park-hero-loc">📍 ${escHtml(pk.city)}, ${escHtml(pk.state)}</div>
    ${ratingHtml}
    <div class="park-hero-badges">
      ${parkTypeBadge}
      ${workBadge}
    </div>
  </div>
</div>

<div class="park-body container">
  <div class="park-main">
    ${quickFactsHtml}
    ${chipsHtml ? `<div class="park-chips">${chipsHtml}</div>` : ''}
    <div class="park-description">${escHtml(desc)}</div>
    ${trueMonthlyHtml}
    ${wifiHtml}
    ${corridorHtml}
    ${pk.address ? `<div class="detail-section"><h2>Location</h2><p>${escHtml(pk.address)}, ${escHtml(pk.city)}, ${escHtml(pk.state)}${pk.zip ? ' ' + escHtml(pk.zip) : ''}</p></div>` : ''}
  </div>

  <div class="park-sidebar">
    <div class="park-card-sidebar">
      <h3>Book Your Stay</h3>
      ${priceHtml}
      <a href="/park/${pk.slug}" class="sidebar-cta">View Full Listing →</a>
      <div style="text-align:center;margin-top:8px">
        <a href="/search?state=${encodeURIComponent(pk.state)}" class="btn btn-ghost btn-sm" style="font-size:13px">More ${escHtml(pk.state)} parks</a>
      </div>
      ${pk.phone ? `<div class="sidebar-contact">📞 <a href="tel:${escHtml(pk.phone)}">${escHtml(pk.phone)}</a></div>` : ''}
      ${pk.website ? `<div class="sidebar-contact">🌐 <a href="${escHtml(pk.website)}" target="_blank" rel="nofollow noopener">Park website ↗</a></div>` : ''}
    </div>
  </div>
</div>

${nearbyHtml}

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
      <div class="footer-col"><h4>Company</h4><ul><li><a href="/pages/tos.html">Terms of Service</a></li><li><a href="/privacy.html">Privacy Policy</a></li></ul></div>
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
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
    },
  });
}

/* ─── RV Travel Corridors data ──────────────────────────────── */

const TRAVEL_CORRIDORS = [
  {
    id: 'i-10',
    name: 'I-10',
    fullName: 'Interstate 10',
    emoji: '🛣️',
    desc: 'The southern coast route runs 2,460 miles from Jacksonville, Florida to Santa Monica, California — the classic snowbird highway. It connects Florida\'s Gulf Coast, the Louisiana bayou, Texas Hill Country, New Mexico\'s desert, and Arizona\'s Sonoran Desert before ending at the Pacific.',
    states: ['Florida','Alabama','Mississippi','Louisiana','Texas','New Mexico','Arizona','California'],
    blog: 'snowbird-rv-route-arizona-texas-winter-2026',
    searchState: 'Texas',
  },
  {
    id: 'i-40',
    name: 'I-40',
    fullName: 'Interstate 40',
    emoji: '🛣️',
    desc: 'Following much of the old Route 66 corridor, I-40 runs 2,555 miles from Wilmington, North Carolina to Barstow, California. The route takes RVers through the Great Smoky Mountains, Arkansas Ozarks, Oklahoma plains, Texas Panhandle, New Mexico\'s red rock country, and Arizona\'s canyon lands.',
    states: ['North Carolina','Tennessee','Arkansas','Oklahoma','Texas','New Mexico','Arizona','California'],
    blog: null,
    searchState: 'Arizona',
  },
  {
    id: 'i-70',
    name: 'I-70',
    fullName: 'Interstate 70',
    emoji: '🛣️',
    desc: 'Running 2,153 miles from Baltimore to the Utah desert, I-70 cuts through the heart of America. The highlight for RVers is the Rocky Mountain section through Colorado — ascending through Denver, crossing the Eisenhower Tunnel at 11,000 feet, and dropping through the stunning Glenwood Canyon.',
    states: ['Maryland','West Virginia','Pennsylvania','Ohio','Indiana','Illinois','Missouri','Kansas','Colorado','Utah'],
    blog: null,
    searchState: 'Colorado',
  },
  {
    id: 'i-75',
    name: 'I-75',
    fullName: 'Interstate 75',
    emoji: '🛣️',
    desc: 'The snowbird superhighway runs 1,786 miles from the Upper Peninsula of Michigan to Miami, Florida. Every winter, hundreds of thousands of RVers follow I-75 south through Ohio, Kentucky, Tennessee, and Georgia into Florida\'s warm sunshine — one of the most-traveled RV migrations in North America.',
    states: ['Michigan','Ohio','Kentucky','Tennessee','Georgia','Florida'],
    blog: null,
    searchState: 'Florida',
  },
  {
    id: 'i-90',
    name: 'I-90',
    fullName: 'Interstate 90',
    emoji: '🛣️',
    desc: 'The longest US interstate at 3,020 miles stretches from Boston to Seattle. The western stretch through South Dakota\'s Badlands, Wyoming\'s Bighorn Mountains, Montana\'s glacier country, and Idaho into Washington is some of the most spectacular RV scenery in America.',
    states: ['Massachusetts','New York','Ohio','Indiana','Illinois','Wisconsin','Minnesota','South Dakota','Wyoming','Montana','Idaho','Washington'],
    blog: 'wyoming-northern-rockies-rv-route-yellowstone-grand-teton-2026',
    searchState: 'Montana',
  },
  {
    id: 'i-95',
    name: 'I-95',
    fullName: 'Interstate 95',
    emoji: '🛣️',
    desc: 'The East Coast corridor runs 1,926 miles along the Atlantic seaboard from Houlton, Maine to Miami, Florida. This route connects New England\'s rocky coastline, New York City, Philadelphia, Washington D.C., the Carolina Outer Banks, and Florida\'s warm Atlantic beaches.',
    states: ['Maine','New Hampshire','Massachusetts','Rhode Island','Connecticut','New York','New Jersey','Delaware','Maryland','Virginia','North Carolina','South Carolina','Georgia','Florida'],
    blog: null,
    searchState: 'Florida',
  },
  {
    id: 'pch',
    name: 'Pacific Coast Highway',
    fullName: 'Pacific Coast Highway (US-101 / CA-1)',
    emoji: '🌊',
    desc: 'The PCH hugs the Pacific coastline from Southern California through Oregon and Washington — one of the most scenic drives in the world. US-101 through the Northern California redwoods, the Oregon Coast, and Washington\'s Olympic Peninsula is a bucket-list RV route for good reason.',
    states: ['California','Oregon','Washington'],
    blog: 'pacific-coast-highway-rv-road-trip-guide-2026',
    searchState: 'California',
  },
  {
    id: 'blue-ridge-parkway',
    name: 'Blue Ridge Parkway',
    fullName: 'Blue Ridge Parkway',
    emoji: '🏔️',
    desc: 'Called "America\'s Favorite Drive," this 469-mile scenic parkway winds through the Appalachian Highlands of Virginia and North Carolina. Fall foliage transforms this route into one of the most beautiful RV drives in the eastern US, connecting Shenandoah National Park to the Great Smoky Mountains.',
    states: ['Virginia','North Carolina'],
    blog: 'best-spring-rv-routes-south-natchez-trace-blue-ridge-gulf-2026',
    searchState: 'Virginia',
  },
  {
    id: 'natchez-trace',
    name: 'Natchez Trace',
    fullName: 'Natchez Trace Parkway',
    emoji: '🌳',
    desc: 'The Natchez Trace Parkway follows a 444-mile historic trail from Nashville, Tennessee through Alabama to Natchez, Mississippi. RVers love this peaceful route for its lack of commercial traffic and its rich history — ancient Native American trails, Civil War battlefields, and antebellum Southern towns.',
    states: ['Tennessee','Alabama','Mississippi'],
    blog: 'best-spring-rv-routes-south-natchez-trace-blue-ridge-gulf-2026',
    searchState: 'Tennessee',
  },
  {
    id: 'great-river-road',
    name: 'Great River Road',
    fullName: 'Great River Road (Mississippi River)',
    emoji: '🏞️',
    desc: 'The Great River Road follows the Mississippi River for over 3,000 miles from Minnesota to the Louisiana Gulf Coast through 10 states and dozens of historic river towns. It\'s the perfect route for RVers who like to slow down and explore small-town America, Delta blues country, and Cajun bayou culture.',
    states: ['Minnesota','Wisconsin','Iowa','Illinois','Missouri','Kentucky','Tennessee','Arkansas','Mississippi','Louisiana'],
    blog: null,
    searchState: 'Mississippi',
  },
];

// Build a lookup: state → array of corridor IDs
const STATE_TO_CORRIDORS = {};
for (const c of TRAVEL_CORRIDORS) {
  for (const st of c.states) {
    if (!STATE_TO_CORRIDORS[st]) STATE_TO_CORRIDORS[st] = [];
    STATE_TO_CORRIDORS[st].push(c.id);
  }
}

/* ─── /routes SSR page ──────────────────────────────────────── */

async function handleRoutesPage(env) {
  // Fetch park counts per state to compute corridor coverage
  const stateRows = await sbGet(env, '/rest/v1/parks?is_active=eq.true&select=state&limit=2000');
  const stateCounts = {};
  if (Array.isArray(stateRows)) {
    for (const r of stateRows) {
      stateCounts[r.state] = (stateCounts[r.state] || 0) + 1;
    }
  }
  const corridorCounts = {};
  for (const c of TRAVEL_CORRIDORS) {
    corridorCounts[c.id] = c.states.reduce((sum, st) => sum + (stateCounts[st] || 0), 0);
  }

  const today = new Date().toISOString().slice(0, 10);

  const routeCards = TRAVEL_CORRIDORS.map(c => {
    const cnt = corridorCounts[c.id] || 0;
    const blogLink = c.blog
      ? `<a href="/blog/${c.blog}" class="routes-blog-link">Read the guide →</a>`
      : '';
    return `<div class="route-card">
      <div class="route-card-header">
        <span class="route-emoji">${c.emoji}</span>
        <div>
          <h2 class="route-name">${escHtml(c.fullName)}</h2>
          <span class="route-park-count">${cnt} RV park${cnt !== 1 ? 's' : ''} on RVSpot</span>
        </div>
      </div>
      <p class="route-desc">${escHtml(c.desc)}</p>
      <div class="route-actions">
        <a href="/search?state=${encodeURIComponent(c.searchState)}" class="btn btn-primary btn-sm">Browse ${escHtml(c.searchState)} parks →</a>
        ${blogLink}
      </div>
    </div>`;
  }).join('\n');

  const jsonLdItems = TRAVEL_CORRIDORS.map((c, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: c.fullName,
    url: `https://rvspot.net/routes#${c.id}`,
    description: c.desc,
  }));
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Major RV Travel Corridors in the United States',
    description: 'The top RV travel routes and interstate corridors across America, with parks and campgrounds listed along each route.',
    url: 'https://rvspot.net/routes',
    numberOfItems: TRAVEL_CORRIDORS.length,
    itemListElement: jsonLdItems,
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RV Travel Routes & Interstate Corridors | RVSpot</title>
  <meta name="description" content="Find RV parks along America's top travel routes — I-10, I-95, Pacific Coast Highway, Blue Ridge Parkway, Natchez Trace, and more. ${stateRows.length || 1015}+ parks listed along major corridors.">
  <link rel="canonical" href="https://rvspot.net/routes">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏕</text></svg>">
  <link rel="stylesheet" href="/css/styles.css">
  <script type="application/ld+json">${jsonLd}</script>
  <script src="/js/analytics.js"></script>
  <style>
    .routes-hero{background:linear-gradient(135deg,var(--green-900) 0%,var(--green-700) 100%);padding:64px 24px 48px;color:#fff;text-align:center}
    .routes-hero h1{font-family:var(--font-display);font-size:clamp(1.8rem,4vw,2.6rem);font-weight:700;margin:0 0 12px;color:#fff}
    .routes-hero p{font-size:17px;color:rgba(255,255,255,.8);max-width:580px;margin:0 auto 24px;line-height:1.6}
    .routes-grid{max-width:900px;margin:0 auto;padding:48px 24px;display:grid;grid-template-columns:1fr;gap:24px}
    .route-card{background:var(--white);border:1px solid var(--cream-300,#e8e4de);border-radius:var(--radius-xl);padding:28px;box-shadow:var(--shadow-sm);transition:box-shadow var(--transition)}
    .route-card:hover{box-shadow:var(--shadow-md)}
    .route-card-header{display:flex;align-items:flex-start;gap:16px;margin-bottom:12px}
    .route-emoji{font-size:2rem;line-height:1;flex-shrink:0;margin-top:2px}
    .route-name{font-family:var(--font-display);font-size:1.25rem;font-weight:700;color:var(--slate-900);margin:0 0 4px}
    .route-park-count{font-size:13px;color:var(--green-700);font-weight:600}
    .route-desc{font-size:15px;line-height:1.7;color:var(--slate-600);margin:0 0 20px}
    .route-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
    .routes-blog-link{font-size:14px;color:var(--green-700);font-weight:600;text-decoration:none}
    .routes-blog-link:hover{text-decoration:underline}
    @media(max-width:600px){.routes-grid{padding:32px 16px}.route-card{padding:20px}.routes-hero{padding:48px 16px 36px}}
  </style>
</head>
<body>
<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo"><div class="nav-logo-dot"></div>RVSpot</a>
    <ul class="nav-links">
      <li><a href="/search">Find Parks</a></li>
      <li><a href="/rv-reviews.html">RV Reviews</a></li>
      <li><a href="/routes" class="active">Travel Routes</a></li>
      <li><a href="/blog">Blog</a></li>
      <li><a href="/pages/for-operators.html">For Operators</a></li>
    </ul>
    <div class="nav-actions">
      <button class="btn btn-ghost btn-sm" onclick="openModal('loginModal')">Sign in</button>
      <button class="btn btn-primary btn-sm" onclick="openModal('signupModal')">Join free</button>
    </div>
  </div>
</nav>

<div class="routes-hero">
  <h1>🗺️ RV Travel Routes & Corridors</h1>
  <p>Find RV parks and campgrounds along America's most-traveled routes — from the I-10 snowbird highway to the Pacific Coast Highway and the Blue Ridge Parkway.</p>
  <a href="/search" class="btn btn-primary">Search All Parks</a>
</div>

<div class="routes-grid" id="routes-list">
  ${routeCards}
</div>

<footer class="footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <div class="logo">RVSpot</div>
        <p>The complete platform for RV travelers and park operators.</p>
        <p style="margin-top:12px;font-size:12px;color:rgba(255,255,255,0.25)">Operated by Booking Bridge LLC dba RVSpot</p>
      </div>
      <div class="footer-col"><h4>For Travelers</h4><ul><li><a href="/search">Find Parks</a></li><li><a href="/rv-reviews.html">RV Reviews</a></li><li><a href="/routes">Travel Routes</a></li></ul></div>
      <div class="footer-col"><h4>Resources</h4><ul><li><a href="/blog">Blog</a></li><li><a href="/pages/for-operators.html">For Operators</a></li></ul></div>
      <div class="footer-col"><h4>Company</h4><ul><li><a href="/pages/tos.html">Terms of Service</a></li><li><a href="/privacy.html">Privacy Policy</a></li></ul></div>
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
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
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
  const updDate  = updISO && updISO !== pubISO ? new Date(updISO).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
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
        ${updDate ? `<span class="sep">·</span><span>Updated ${updDate}</span>` : ''}
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
      <div class="footer-col"><h4>Company</h4><ul><li><a href="/pages/tos.html">Terms of Service</a></li><li><a href="/privacy.html">Privacy Policy</a></li></ul></div>
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

// 6-hour edge cache for all child sitemaps (parks change ~300/week, not per-minute)
const SITEMAP_CC = 'public, max-age=21600';

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
  { loc: 'https://rvspot.net/',                    priority: '1.0' },
  { loc: 'https://rvspot.net/search',              priority: '0.9' },
  { loc: 'https://rvspot.net/routes',              priority: '0.8' },
  { loc: 'https://rvspot.net/pricing',             priority: '0.8' },
  { loc: 'https://rvspot.net/pages/for-operators', priority: '0.8' },
  { loc: 'https://rvspot.net/how-it-works',        priority: '0.7' },
  { loc: 'https://rvspot.net/blog',                priority: '0.7' },
  { loc: 'https://rvspot.net/about',               priority: '0.6' },
  { loc: 'https://rvspot.net/faq',                 priority: '0.6' },
  { loc: 'https://rvspot.net/monthly-cost-methodology', priority: '0.5' },
];

function xmlUrl(loc, { priority = '0.5', lastmod = null, changefreq = null } = {}) {
  return [
    '  <url>',
    `    <loc>${loc}</loc>`,
    lastmod      ? `    <lastmod>${lastmod.slice(0, 10)}</lastmod>` : '',
    changefreq   ? `    <changefreq>${changefreq}</changefreq>`     : '',
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].filter(Boolean).join('\n');
}

// Wraps XML body with the declaration Google requires at byte 0.
function xmlResponse(body, cache = SITEMAP_CC) {
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?>\n' + body,
    { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': cache } },
  );
}

// /sitemap.xml — sitemap index pointing to the three child sitemaps
function handleSitemapIndex() {
  const today = new Date().toISOString().slice(0, 10);
  const entries = ['sitemap-static', 'sitemap-parks', 'sitemap-blog'].map(name =>
    `  <sitemap>\n    <loc>https://rvspot.net/${name}.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`
  );
  const body = '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + entries.join('\n') + '\n</sitemapindex>';
  return xmlResponse(body);
}

// /sitemap-static.xml — static pages + all 50 state landing pages
function handleSitemapStatic() {
  const urls = [
    ...STATIC_PAGES.map(p =>
      xmlUrl(p.loc, { priority: p.priority, changefreq: 'monthly' })
    ),
    ...US_STATES.map(s =>
      xmlUrl(`https://rvspot.net/rv-parks/${s}`, { priority: '0.8', changefreq: 'weekly' })
    ),
  ];
  const body = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.join('\n') + '\n</urlset>';
  return xmlResponse(body);
}

// /sitemap-parks.xml — all active parks, paginated to handle 300+ weekly additions
async function handleSitemapParks(env) {
  let parks = [], offset = 0;
  const PAGE = 1000;
  for (;;) {
    const page = await sbGet(env,
      `/rest/v1/parks?select=slug,updated_at&is_active=eq.true&slug=not.is.null` +
      `&order=updated_at.desc&limit=${PAGE}&offset=${offset}`
    );
    if (!Array.isArray(page) || page.length === 0) break;
    parks = parks.concat(page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  const urls = parks.map(p =>
    xmlUrl(`https://rvspot.net/park/${p.slug}`, { priority: '0.8', lastmod: p.updated_at, changefreq: 'weekly' })
  );
  const body = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.join('\n') + '\n</urlset>';
  return xmlResponse(body);
}

// /sitemap-blog.xml — all published blog posts
async function handleSitemapBlog(env) {
  const posts = await sbGet(env,
    '/rest/v1/blog_posts?select=slug,updated_at&is_published=eq.true&slug=not.is.null&order=published_at.desc'
  );
  const urls = Array.isArray(posts) ? posts.map(p =>
    xmlUrl(`https://rvspot.net/blog/${p.slug}`, { priority: '0.7', lastmod: p.updated_at, changefreq: 'monthly' })
  ) : [];
  const body = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.join('\n') + '\n</urlset>';
  return xmlResponse(body);
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

/* ─── Park Reviews ──────────────────────────────────────────── */

async function handleGetParkReviews(slug, env) {
  if (!slug) return json({ error: 'Missing park slug' }, 400);
  const res = await sbGet(
    env,
    `/rest/v1/reviews?park_slug=eq.${encodeURIComponent(slug)}&status=eq.approved&select=id,reviewer_name,rating_overall,rating_wifi,rating_cleanliness,rating_noise,rating_management,rating_rig_fit,rating_long_stay,body,rig_type,stay_length,stay_type,created_at&order=created_at.desc&limit=20`,
  );
  return json(Array.isArray(res) ? res : [], 200);
}

async function handleSubmitReview(request, env) {
  // Validate JWT — reviews require an account
  const auth = await requireAuth(request, env);
  if (auth.error) return auth.error;
  const userId = auth.userId;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { park_slug, rating_overall, rating_wifi, rating_cleanliness, rating_noise,
          rating_management, rating_rig_fit, rating_long_stay, review_body,
          rig_type, stay_length, reviewer_name } = body;

  if (!park_slug || !rating_overall || !review_body) {
    return json({ error: 'park_slug, rating_overall, and review body are required' }, 422);
  }
  if (rating_overall < 1 || rating_overall > 5) {
    return json({ error: 'rating_overall must be 1–5' }, 422);
  }
  if (review_body.trim().length < 20) {
    return json({ error: 'Review must be at least 20 characters' }, 422);
  }

  // Look up park_id from slug
  const parks = await sbGet(env, `/rest/v1/parks?slug=eq.${encodeURIComponent(park_slug)}&select=id&limit=1`);
  const parkId = Array.isArray(parks) && parks[0] ? parks[0].id : null;
  if (!parkId) return json({ error: 'Park not found' }, 404);

  const payload = {
    user_id: userId,
    park_id: parkId,
    park_slug,
    rating: Number(rating_overall),
    rating_overall: Number(rating_overall),
    rating_wifi:        rating_wifi        ? Number(rating_wifi)        : null,
    rating_cleanliness: rating_cleanliness ? Number(rating_cleanliness) : null,
    rating_noise:       rating_noise       ? Number(rating_noise)       : null,
    rating_management:  rating_management  ? Number(rating_management)  : null,
    rating_rig_fit:     rating_rig_fit     ? Number(rating_rig_fit)     : null,
    rating_long_stay:   rating_long_stay   ? Number(rating_long_stay)   : null,
    body: review_body.trim(),
    rig_type:      rig_type      || null,
    stay_length:   stay_length   || null,
    reviewer_name: reviewer_name || null,
    stay_type: 'community',
    status: 'pending',
  };

  const result = await sbPostSafe(env, '/rest/v1/reviews', payload);
  if (!result || result.error) return json({ error: 'Failed to save review' }, 500);
  return json({ ok: true, message: 'Review submitted for moderation. Thank you!' }, 201);
}

async function handleAdminListReviews(request, env) {
  const adminCheck = await requireAdminJwt(request, env);
  if (adminCheck.error) return adminCheck.error;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const res = await sbGet(
    env,
    `/rest/v1/reviews?status=eq.${encodeURIComponent(status)}&select=id,park_slug,reviewer_name,rating_overall,body,rig_type,stay_length,stay_type,status,admin_notes,created_at&order=created_at.asc&limit=50`,
  );
  return json(Array.isArray(res) ? res : [], 200);
}

async function handleAdminModerateReview(request, env) {
  const adminCheck = await requireAdminJwt(request, env);
  if (adminCheck.error) return adminCheck.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { review_id, action, admin_notes } = body;
  if (!review_id || !['approve', 'reject'].includes(action)) {
    return json({ error: 'review_id and action (approve|reject) required' }, 422);
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  const updates = { status: newStatus, updated_at: new Date().toISOString() };
  if (admin_notes) updates.admin_notes = admin_notes;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/reviews?id=eq.${encodeURIComponent(review_id)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(updates),
    },
  );
  if (!res.ok) return json({ error: 'Failed to update review' }, 500);

  // If approved, refresh the park's avg_rating + review_count
  if (action === 'approve') {
    const rows = await sbGet(env, `/rest/v1/reviews?id=eq.${encodeURIComponent(review_id)}&select=park_slug`);
    const parkSlug = Array.isArray(rows) && rows[0] ? rows[0].park_slug : null;
    if (parkSlug) await refreshParkRating(parkSlug, env);
  }

  return json({ ok: true, status: newStatus }, 200);
}

async function refreshParkRating(slug, env) {
  const reviews = await sbGet(
    env,
    `/rest/v1/reviews?park_slug=eq.${encodeURIComponent(slug)}&status=eq.approved&select=rating_overall`,
  );
  if (!Array.isArray(reviews) || reviews.length === 0) return;
  const avg = reviews.reduce((s, r) => s + (r.rating_overall || 0), 0) / reviews.length;
  await fetch(`${SUPABASE_URL}/rest/v1/parks?slug=eq.${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      avg_rating:   Math.round(avg * 10) / 10,
      review_count: reviews.length,
      updated_at:   new Date().toISOString(),
    }),
  });
}

async function sbPostSafe(env, endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: text };
  }
  return { ok: true };
}

async function requireAdminJwt(request, env) {
  const auth = await requireAuth(request, env);
  if (auth.error) return auth;
  // Fetch email from Supabase auth.users using service role
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${auth.userId}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return { error: json({ error: 'Forbidden' }, 403) };
  const user = await res.json();
  if (user.email !== 'renato@rvspot.net') return { error: json({ error: 'Forbidden' }, 403) };
  return { userId: auth.userId, email: user.email };
}

/* ─── Utility ───────────────────────────────────────────────── */

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
