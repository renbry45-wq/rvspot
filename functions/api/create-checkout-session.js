const ALLOWED_PRICES = new Set([
  'price_1THw7R1J9Y6gYEOf0uy5xzEj', // Park Pro  $79/mo
  'price_1THw3g1J9Y6gYEOfGNjMp4ke', // Nomad Pro  $9/mo
]);

const CORS = {
  'Access-Control-Allow-Origin': 'https://rvspot.net',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

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
    mode:                        'subscription',
    'payment_method_types[]':    'card',
    'line_items[0][price]':      priceId,
    'line_items[0][quantity]':   '1',
    success_url:                 `https://rvspot.net/${successPath}?upgraded=1`,
    cancel_url:                  `https://rvspot.net/${cancelPath}`,
    customer_email:              userEmail,
    'metadata[user_id]':         userId,
    'metadata[plan_type]':       planType,
  });

  let stripeRes, session;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:  'POST',
      headers: {
        Authorization:   `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type':  'application/x-www-form-urlencoded',
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

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
