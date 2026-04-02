# RVSpot.net — Complete Setup Guide
**Booking Bridge LLC dba RVSpot**  
Estimated time: 2–3 hours | Tech level: Guided step-by-step

---

## Overview of what you're building
A multi-page HTML/CSS/JS website hosted on **Cloudflare Pages** (free), backed by:
- **Supabase** — database, auth, real-time (free tier)  
- **Stripe** — payments (pay-as-you-go, no monthly cost)  
- **Mapbox** — interactive maps (free up to 50K loads/month)  
- **Resend** — transactional email (free up to 3K/month)

**Monthly cost at launch: ~$0 until you hit free tier limits.**

---

## STEP 1 — GitHub (5 minutes)

### Create a GitHub repository
1. Go to https://github.com and sign up / sign in
2. Click **+ New repository**
3. Name it: `rvspot`
4. Set to **Private** (or Public — your choice)
5. Click **Create repository**

### Upload your files
Two options:
**Option A (easiest):** Drag all your `rvspot/` files into the GitHub web UI  
**Option B (developer):** Install Git, run:
```bash
cd /path/to/your/rvspot
git init
git add .
git commit -m "Initial RVSpot build"
git remote add origin https://github.com/YOUR_USERNAME/rvspot.git
git push -u origin main
```

---

## STEP 2 — Cloudflare Pages (10 minutes)

### Connect your domain and deploy

1. Go to https://dash.cloudflare.com → Sign up with your email
2. **Add your site:** Click **Add a site** → Enter `rvspot.net`
3. Choose **Free plan** → Follow DNS nameserver instructions
   - Log into your domain registrar (where you bought rvspot.net)
   - Replace existing nameservers with the two Cloudflare nameservers shown
   - This takes 10–60 minutes to propagate
4. **Create Pages project:**
   - In Cloudflare dashboard → **Pages** → **Create a project**
   - Connect to **GitHub** → Authorize Cloudflare
   - Select your `rvspot` repository
   - Build settings:
     - Framework preset: **None**
     - Build command: *(leave empty)*
     - Build output directory: `/` (root)
   - Click **Save and Deploy**
5. **Custom domain:**
   - In Pages project → **Custom domains** → Add `rvspot.net` and `www.rvspot.net`

✅ **Result:** Your site is live at https://rvspot.net. Every time you push to GitHub, Cloudflare auto-deploys.

---

## STEP 3 — Supabase (20 minutes)

### Create your database

1. Go to https://supabase.com → **Start your project** → Sign up
2. **Create new project:**
   - Organization: create one (e.g. "Booking Bridge LLC")
   - Project name: `rvspot`
   - Database password: generate a strong password — **SAVE THIS**
   - Region: **US East (N. Virginia)** — best for US audience
3. Wait ~2 minutes for project to provision
4. **Run your schema:**
   - Go to **SQL Editor** (left sidebar)
   - Click **+ New query**
   - Open the file `backend/schema.sql` from your files
   - Paste the entire contents into the SQL editor
   - Click **Run** (top right)
   - You should see: `Success. No rows returned`
5. **Get your API keys:**
   - Go to **Settings** (gear icon) → **API**
   - Copy and save:
     - `Project URL` → this is your `SUPABASE_URL`
     - `anon/public` key → this is your `SUPABASE_ANON_KEY`
6. **Enable Email Auth:**
   - Go to **Authentication** → **Providers** → **Email** → Enable

### Add environment variables to Cloudflare
1. In Cloudflare Pages → your project → **Settings** → **Environment variables**
2. Add these variables (both Production and Preview):
   ```
   SUPABASE_URL = https://xxxxxxxxxxxx.supabase.co
   SUPABASE_ANON_KEY = eyJhbGci...
   ```

---

## STEP 4 — Stripe (15 minutes)

### Configure your two products

You already have a Stripe account under Booking Bridge LLC. Do this:

1. Log into https://dashboard.stripe.com
2. **Add RVSpot as a second business:**
   - Settings → Business → Add business
   - Business name: **RVSpot** (DBA of Booking Bridge LLC)
   - Same EIN as Booking Bridge
3. **Create Product 1: Nomad Pro (travelers)**
   - Products → + Add product
   - Name: `Nomad Pro`
   - Description: `RVSpot traveler subscription — Wi-Fi ratings, offline maps, discounts`
   - Pricing model: **Recurring** → **Monthly** → **$9.00**
   - Click **Save product**
   - Copy the **Price ID** (starts with `price_...`) → save as `STRIPE_NOMAD_PRO_PRICE_ID`
4. **Create Product 2: Park Pro (operators)**
   - Products → + Add product
   - Name: `Park Pro`
   - Description: `RVSpot Pro Park subscription — zero commissions, analytics, priority placement`
   - Pricing model: **Recurring** → **Monthly** → **$79.00**
   - Click **Save product**
   - Copy the **Price ID** → save as `STRIPE_PARK_PRO_PRICE_ID`
5. **Get your Stripe keys:**
   - Developers → API keys
   - Copy **Publishable key** → save as `STRIPE_PUBLISHABLE_KEY`
   - Copy **Secret key** → save as `STRIPE_SECRET_KEY` (⚠️ never put this in frontend code)
6. **Add to Cloudflare environment variables:**
   ```
   STRIPE_PUBLISHABLE_KEY = pk_live_...
   STRIPE_NOMAD_PRO_PRICE_ID = price_...
   STRIPE_PARK_PRO_PRICE_ID = price_...
   ```
   ⚠️ Never add `STRIPE_SECRET_KEY` to Cloudflare Pages env vars — this goes in a server function only.

---

## STEP 5 — Mapbox (10 minutes)

### Set up interactive maps

1. Go to https://mapbox.com → Sign up (free)
2. Dashboard → **Access tokens** → Copy your **Default public token**
3. **Set your allowed URLs** (security):
   - Edit the token → Add allowed URL: `https://rvspot.net/*`
4. **Add to your code:**
   Open `js/app.js` and add at the top:
   ```javascript
   const MAPBOX_TOKEN = 'pk.eyJ1Ijoi...'; // paste your token here
   ```
5. **Enable map in search.html:**
   In `search.html`, the map placeholder includes a comment. Replace with:
   ```html
   <div id="map" style="height:400px;border-radius:16px"></div>
   <script src="https://api.mapbox.com/mapbox-gl-js/v3.0.0/mapbox-gl.js"></script>
   <link href="https://api.mapbox.com/mapbox-gl-js/v3.0.0/mapbox-gl.css" rel="stylesheet">
   <script>
   mapboxgl.accessToken = MAPBOX_TOKEN;
   const map = new mapboxgl.Map({ container: 'map', style: 'mapbox://styles/mapbox/outdoors-v12', center: [-98.5, 39.5], zoom: 3.5 });
   // Add park markers from Supabase data here
   </script>
   ```
6. **Add to Cloudflare env vars:**
   ```
   MAPBOX_TOKEN = pk.eyJ1Ijoi...
   ```

---

## STEP 6 — Resend Email (10 minutes)

### Set up transactional email (booking confirmations, welcome emails)

1. Go to https://resend.com → Sign up free
2. **Add your domain:**
   - Domains → Add domain → Enter `rvspot.net`
   - Add the DNS records shown to Cloudflare DNS (about 5 minutes to verify)
3. **Create API key:**
   - API Keys → Create API Key
   - Name: `RVSpot Production`
   - Save the key as `RESEND_API_KEY`
4. **Add to Cloudflare env vars:**
   ```
   RESEND_API_KEY = re_...
   FROM_EMAIL = hello@rvspot.net
   ```

---

## STEP 7 — Connect Supabase to your frontend

### Replace mock data with real Supabase queries

Add this to `js/app.js` (at the top, after the imports):

```javascript
// Supabase client (add script tag to HTML pages first)
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
const supabase = window.supabase?.createClient(
  'YOUR_SUPABASE_URL',
  'YOUR_SUPABASE_ANON_KEY'
);

// Fetch parks from Supabase (replaces mockParks)
async function fetchParks(filters = {}) {
  if (!supabase) return mockParks; // fallback to mock data
  let query = supabase.from('parks').select('*').eq('is_active', true);
  if (filters.wifi) query = query.eq('has_wifi', true);
  if (filters.longstay) query = query.eq('allows_long_stay', true);
  if (filters.ev) query = query.eq('has_ev_charging', true);
  if (filters.pets) query = query.eq('pets_allowed', true);
  if (filters.minRating) query = query.gte('avg_rating', filters.minRating);
  if (filters.maxPrice) query = query.lte('price_nightly', filters.maxPrice);
  const { data, error } = await query.order('avg_rating', { ascending: false }).limit(50);
  if (error) { console.error('Supabase error:', error); return mockParks; }
  return data || mockParks;
}
```

---

## STEP 8 — Google Analytics (5 minutes)

1. Go to https://analytics.google.com → Create account → Create property
2. Property name: `RVSpot.net`
3. Get your **Measurement ID** (starts with `G-...`)
4. Add to all HTML pages inside `<head>`:
```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

---

## STEP 9 — Google Search Console (5 minutes)

1. Go to https://search.google.com/search-console
2. Add property → Domain → Enter `rvspot.net`
3. Verify via Cloudflare DNS TXT record (Cloudflare shows you exactly where)
4. Submit your sitemap: `https://rvspot.net/sitemap.xml`

Create `sitemap.xml` in your root folder:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://rvspot.net/</loc><priority>1.0</priority></url>
  <url><loc>https://rvspot.net/search.html</loc><priority>0.9</priority></url>
  <url><loc>https://rvspot.net/rv-reviews.html</loc><priority>0.8</priority></url>
  <url><loc>https://rvspot.net/routes.html</loc><priority>0.8</priority></url>
  <url><loc>https://rvspot.net/pages/for-operators.html</loc><priority>0.8</priority></div></url>
</urlset>
```

---

## STEP 10 — Cloudflare routing config

Your `_redirects` file (already in the root) handles clean URLs.

Add to `_headers` file (create in root):
```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com https://api.mapbox.com https://cdn.jsdelivr.net; img-src 'self' data: https:;
```

---

## Maintenance & operations

### Weekly tasks (15 minutes)
- Check Supabase for new user signups
- Review any flagged reviews in the admin panel
- Check Stripe for new subscriptions / failed payments
- Review Google Analytics for top search terms

### Monthly tasks (1 hour)
- Update park data for any operator changes
- Publish 2–3 new SEO articles (Claude can write these)
- Review and reply to any outstanding reviews
- Check Cloudflare analytics for performance issues

---

## Environment variables reference (all keys)

Keep this list in your password manager (1Password, Bitwarden, etc.)

| Variable | Where to find it | Used in |
|---|---|---|
| SUPABASE_URL | Supabase → Settings → API | Frontend JS |
| SUPABASE_ANON_KEY | Supabase → Settings → API | Frontend JS |
| STRIPE_PUBLISHABLE_KEY | Stripe → Developers → API keys | Frontend JS |
| STRIPE_SECRET_KEY | Stripe → Developers → API keys | Server only |
| STRIPE_NOMAD_PRO_PRICE_ID | Stripe → Products | Checkout |
| STRIPE_PARK_PRO_PRICE_ID | Stripe → Products | Checkout |
| MAPBOX_TOKEN | Mapbox → Access tokens | Maps |
| RESEND_API_KEY | Resend → API Keys | Email |

---

## Support resources

- Cloudflare Pages docs: https://developers.cloudflare.com/pages
- Supabase docs: https://supabase.com/docs
- Stripe docs: https://stripe.com/docs
- Mapbox GL JS docs: https://docs.mapbox.com/mapbox-gl-js
- Resend docs: https://resend.com/docs

---

*Generated by Claude for Booking Bridge LLC dba RVSpot · April 2026*
