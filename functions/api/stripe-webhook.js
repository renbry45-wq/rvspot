const SUPABASE_URL = 'https://uydiifdgjzylfxxaoznv.supabase.co';
const PRICE_PARK_PRO  = 'price_1THw7R1J9Y6gYEOf0uy5xzEj';
const PRICE_NOMAD_PRO = 'price_1THw3g1J9Y6gYEOfGNjMp4ke';

export async function onRequestPost(context) {
  const { request, env } = context;

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
        const planType = session.metadata?.plan_type;
        const subId    = session.subscription;
        if (!userId || !subId) break;

        // Fetch subscription from Stripe to get price + period
        const sub = await stripeGet(`/v1/subscriptions/${subId}`, env);
        const priceId = sub.items?.data?.[0]?.price?.id;
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
        const periodStart = new Date(sub.current_period_start * 1000).toISOString();

        // Insert into subscriptions table
        await sbPost(env, '/rest/v1/subscriptions', {
          user_id:               userId,
          type:                  planType,
          stripe_subscription_id: subId,
          stripe_price_id:       priceId,
          status:                'active',
          current_period_start:  periodStart,
          current_period_end:    periodEnd,
          cancel_at_period_end:  false,
        }, 'resolution=merge-duplicates');

        if (planType === 'nomad_pro') {
          await sbPatch(env, `/rest/v1/profiles?id=eq.${userId}`, {
            plan:              'nomad_pro',
            plan_expires_at:   periodEnd,
            stripe_customer_id: session.customer,
          });
        }

        if (planType === 'park_pro') {
          // Upgrade all parks belonging to this operator
          await sbPatch(env, `/rest/v1/parks?operator_id=eq.${userId}`, {
            plan:                    'pro',
            stripe_subscription_id:  subId,
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub     = event.data.object;
        const subId   = sub.id;
        const status  = sub.status;
        const isActive = status === 'active' || status === 'trialing';
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString();

        // Look up our subscription record
        const [rec] = await sbGet(env, `/rest/v1/subscriptions?stripe_subscription_id=eq.${subId}&select=user_id,type`);
        if (!rec) break;

        await sbPatch(env, `/rest/v1/subscriptions?stripe_subscription_id=eq.${subId}`, {
          status,
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
        const sub   = event.data.object;
        const subId = sub.id;

        const [rec] = await sbGet(env, `/rest/v1/subscriptions?stripe_subscription_id=eq.${subId}&select=user_id,type`);
        if (!rec) break;

        await sbPatch(env, `/rest/v1/subscriptions?stripe_subscription_id=eq.${subId}`, {
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

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Webhook error:', err);
    return new Response('Internal error', { status: 500 });
  }
}

// ── Stripe helper ────────────────────────────────────────────
async function stripeGet(path, env) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  return res.json();
}

// ── Supabase helpers (service role) ──────────────────────────
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
  const headers = { ...sbHeaders(env), Prefer: prefer ? `return=minimal,${prefer}` : 'return=minimal' };
  return fetch(`${SUPABASE_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(data) });
}

async function sbPatch(env, path, data) {
  const headers = { ...sbHeaders(env), Prefer: 'return=minimal' };
  return fetch(`${SUPABASE_URL}${path}`, { method: 'PATCH', headers, body: JSON.stringify(data) });
}

// ── Stripe webhook signature verification ────────────────────
async function verifySignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  const parts  = sigHeader.split(',');
  const tsPart = parts.find(p => p.startsWith('t='));
  const sigPart = parts.find(p => p.startsWith('v1='));
  if (!tsPart || !sigPart) return false;

  const ts  = tsPart.slice(2);
  const sig = sigPart.slice(3);
  const data = `${ts}.${payload}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const computed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const computedHex = Array.from(new Uint8Array(computed))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time comparison
  if (computedHex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}
