-- ============================================
-- RVSpot.net — Supabase Database Schema
-- Booking Bridge LLC dba RVSpot
-- Run this in the Supabase SQL Editor
-- ============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for full-text search

-- ────────────────────────────────────────────
-- USERS (extends Supabase auth.users)
-- ────────────────────────────────────────────
CREATE TABLE public.profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  first_name      TEXT,
  last_name       TEXT,
  avatar_url      TEXT,
  role            TEXT NOT NULL DEFAULT 'traveler' CHECK (role IN ('traveler','operator','admin')),
  plan            TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','nomad_pro')),
  plan_expires_at TIMESTAMPTZ,
  stripe_customer_id TEXT,
  rig_type        TEXT,
  rig_length_ft   INTEGER,
  bio             TEXT,
  linkedin_url    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: users can only read/update their own profile
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Public profiles viewable" ON public.profiles FOR SELECT USING (true);

-- ────────────────────────────────────────────
-- PARKS
-- ────────────────────────────────────────────
CREATE TABLE public.parks (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id       UUID REFERENCES public.profiles(id),
  name              TEXT NOT NULL,
  slug              TEXT UNIQUE NOT NULL, -- url-safe name e.g. "pineview-lake-rv-resort"
  type              TEXT CHECK (type IN ('resort','campground','community','state_park','rv_park','mobile_home_park')),
  description       TEXT,
  
  -- Location
  address           TEXT,
  city              TEXT NOT NULL,
  state             TEXT NOT NULL,
  zip               TEXT,
  county            TEXT,
  country           TEXT DEFAULT 'US',
  lat               DECIMAL(9,6),
  lng               DECIMAL(9,6),
  
  -- Pricing
  price_nightly     DECIMAL(8,2),
  price_weekly      DECIMAL(8,2),
  price_monthly     DECIMAL(8,2),
  price_annual      DECIMAL(10,2),
  price_note        TEXT,
  
  -- Amenities (booleans)
  has_wifi          BOOLEAN DEFAULT FALSE,
  has_30amp         BOOLEAN DEFAULT FALSE,
  has_50amp         BOOLEAN DEFAULT FALSE,
  has_full_hookup   BOOLEAN DEFAULT FALSE,
  has_water         BOOLEAN DEFAULT FALSE,
  has_sewer         BOOLEAN DEFAULT FALSE,
  has_cable         BOOLEAN DEFAULT FALSE,
  has_ev_charging   BOOLEAN DEFAULT FALSE,
  has_pool          BOOLEAN DEFAULT FALSE,
  has_laundry       BOOLEAN DEFAULT FALSE,
  has_bathhouse     BOOLEAN DEFAULT FALSE,
  has_dump_station  BOOLEAN DEFAULT FALSE,
  has_dog_park      BOOLEAN DEFAULT FALSE,
  has_cowork        BOOLEAN DEFAULT FALSE,
  has_mail          BOOLEAN DEFAULT FALSE,
  has_store         BOOLEAN DEFAULT FALSE,
  has_rv_service    BOOLEAN DEFAULT FALSE,
  has_gated         BOOLEAN DEFAULT FALSE,
  
  -- Policies
  pets_allowed      BOOLEAN DEFAULT TRUE,
  big_rigs_ok       BOOLEAN DEFAULT TRUE,
  slideouts_ok      BOOLEAN DEFAULT TRUE,
  community_55plus  BOOLEAN DEFAULT FALSE,
  allows_long_stay  BOOLEAN DEFAULT FALSE,
  allows_annual     BOOLEAN DEFAULT FALSE,
  
  -- Metadata
  total_sites       INTEGER,
  max_rig_length_ft INTEGER,
  elevation_ft      INTEGER,
  phone             TEXT,
  email             TEXT,
  website           TEXT,
  
  -- Platform status
  plan              TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
  stripe_subscription_id TEXT,
  -- Stripe Connect (required before park can accept bookings)
  stripe_connect_account_id       TEXT,
  stripe_connect_status           TEXT NOT NULL DEFAULT 'not_started'
                                  CHECK (stripe_connect_status IN ('not_started','pending','active')),
  stripe_connect_reminder_sent_at TIMESTAMPTZ,
  is_verified       BOOLEAN DEFAULT FALSE,
  is_active         BOOLEAN DEFAULT TRUE,
  is_claimed        BOOLEAN DEFAULT FALSE,
  
  -- Computed / denormalized
  avg_rating        DECIMAL(3,2) DEFAULT 0,
  review_count      INTEGER DEFAULT 0,
  avg_wifi_mbps     DECIMAL(6,1),
  
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast search
CREATE INDEX idx_parks_location ON public.parks (state, city);
CREATE INDEX idx_parks_slug ON public.parks (slug);
CREATE INDEX idx_parks_plan ON public.parks (plan);
CREATE INDEX idx_parks_wifi ON public.parks (has_wifi) WHERE has_wifi = TRUE;
CREATE INDEX idx_parks_long_stay ON public.parks (allows_long_stay) WHERE allows_long_stay = TRUE;
CREATE INDEX idx_parks_rating ON public.parks (avg_rating DESC);
CREATE INDEX idx_parks_geo ON public.parks (lat, lng);
CREATE INDEX idx_parks_fts ON public.parks USING GIN (to_tsvector('english', name || ' ' || COALESCE(city,'') || ' ' || COALESCE(state,'')));

ALTER TABLE public.parks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Parks are publicly readable" ON public.parks FOR SELECT USING (is_active = TRUE);
CREATE POLICY "Operators can update own park" ON public.parks FOR UPDATE USING (auth.uid() = operator_id);

-- ────────────────────────────────────────────
-- PARK PHOTOS
-- ────────────────────────────────────────────
CREATE TABLE public.park_photos (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  park_id     UUID NOT NULL REFERENCES public.parks(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  caption     TEXT,
  is_primary  BOOLEAN DEFAULT FALSE,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_park_photos_park ON public.park_photos (park_id);
ALTER TABLE public.park_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Photos are publicly readable" ON public.park_photos FOR SELECT USING (true);

-- ────────────────────────────────────────────
-- BOOKINGS
-- ────────────────────────────────────────────
CREATE TABLE public.bookings (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  park_id             UUID NOT NULL REFERENCES public.parks(id),
  user_id             UUID NOT NULL REFERENCES public.profiles(id),
  
  check_in            DATE NOT NULL,
  check_out           DATE NOT NULL,
  stay_type           TEXT CHECK (stay_type IN ('nightly','weekly','monthly','annual')),
  
  site_number         TEXT,
  rig_type            TEXT,
  rig_length_ft       INTEGER,
  guest_count         INTEGER DEFAULT 1,
  
  -- Pricing
  base_amount         DECIMAL(10,2) NOT NULL,
  service_fee         DECIMAL(10,2) NOT NULL DEFAULT 0,
  platform_fee        DECIMAL(10,2) NOT NULL DEFAULT 0,
  tax_amount          DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_amount        DECIMAL(10,2) NOT NULL,
  currency            TEXT DEFAULT 'USD',
  
  -- Stripe
  stripe_payment_intent_id TEXT,
  stripe_charge_id         TEXT,
  
  status              TEXT DEFAULT 'pending' CHECK (status IN ('pending','confirmed','checked_in','checked_out','cancelled','refunded')),
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,
  
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bookings_user ON public.bookings (user_id);
CREATE INDEX idx_bookings_park ON public.bookings (park_id);
CREATE INDEX idx_bookings_dates ON public.bookings (check_in, check_out);
CREATE INDEX idx_bookings_status ON public.bookings (status);

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own bookings" ON public.bookings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Operators can view park bookings" ON public.bookings FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.parks WHERE parks.id = park_id AND parks.operator_id = auth.uid())
);

-- ────────────────────────────────────────────
-- REVIEWS
-- ────────────────────────────────────────────
CREATE TABLE public.reviews (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  park_id         UUID NOT NULL REFERENCES public.parks(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES public.profiles(id),
  booking_id      UUID REFERENCES public.bookings(id),
  
  rating          INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  rating_wifi     INTEGER CHECK (rating_wifi >= 1 AND rating_wifi <= 5),
  rating_location INTEGER CHECK (rating_location >= 1 AND rating_location <= 5),
  rating_value    INTEGER CHECK (rating_value >= 1 AND rating_value <= 5),
  rating_clean    INTEGER CHECK (rating_clean >= 1 AND rating_clean <= 5),
  
  title           TEXT,
  body            TEXT NOT NULL,
  
  rig_type        TEXT,
  stay_type       TEXT,
  stay_month      INTEGER,
  stay_year       INTEGER,
  
  is_verified     BOOLEAN DEFAULT FALSE, -- true if has booking_id
  is_published    BOOLEAN DEFAULT FALSE, -- set true after moderation
  
  operator_reply  TEXT,
  replied_at      TIMESTAMPTZ,
  
  helpful_count   INTEGER DEFAULT 0,
  
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE (park_id, user_id) -- one review per park per user
);

CREATE INDEX idx_reviews_park ON public.reviews (park_id) WHERE is_published = TRUE;
CREATE INDEX idx_reviews_user ON public.reviews (user_id);

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Published reviews are public" ON public.reviews FOR SELECT USING (is_published = TRUE);
CREATE POLICY "Users can insert own review" ON public.reviews FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own review" ON public.reviews FOR UPDATE USING (auth.uid() = user_id);

-- ────────────────────────────────────────────
-- WI-FI SPEED TESTS
-- ────────────────────────────────────────────
CREATE TABLE public.wifi_tests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  park_id         UUID NOT NULL REFERENCES public.parks(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES public.profiles(id),
  booking_id      UUID REFERENCES public.bookings(id),
  
  download_mbps   DECIMAL(8,2) NOT NULL,
  upload_mbps     DECIMAL(8,2),
  latency_ms      INTEGER,
  
  location_note   TEXT, -- e.g. "Site 42, near pool"
  test_tool       TEXT, -- e.g. "Speedtest.net", "Fast.com"
  
  tested_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wifi_park ON public.wifi_tests (park_id);

-- Trigger to update park avg_wifi_mbps when new test added
CREATE OR REPLACE FUNCTION update_park_wifi_avg()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.parks
  SET avg_wifi_mbps = (
    SELECT AVG(download_mbps) FROM public.wifi_tests WHERE park_id = NEW.park_id
  )
  WHERE id = NEW.park_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wifi_test_insert
AFTER INSERT ON public.wifi_tests
FOR EACH ROW EXECUTE FUNCTION update_park_wifi_avg();

-- ────────────────────────────────────────────
-- SAVED PARKS (favorites)
-- ────────────────────────────────────────────
CREATE TABLE public.saved_parks (
  user_id    UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  park_id    UUID REFERENCES public.parks(id) ON DELETE CASCADE,
  saved_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, park_id)
);

ALTER TABLE public.saved_parks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own saved parks" ON public.saved_parks USING (auth.uid() = user_id);

-- ────────────────────────────────────────────
-- ROUTES (saved trip plans)
-- ────────────────────────────────────────────
CREATE TABLE public.routes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  waypoints   JSONB NOT NULL DEFAULT '[]', -- [{lat, lng, label, park_id}]
  filters     JSONB DEFAULT '{}',
  is_public   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own routes" ON public.routes USING (auth.uid() = user_id);
CREATE POLICY "Public routes are readable" ON public.routes FOR SELECT USING (is_public = TRUE);

-- ────────────────────────────────────────────
-- MESSAGES (operator ↔ traveler)
-- ────────────────────────────────────────────
CREATE TABLE public.messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id  UUID REFERENCES public.bookings(id),
  park_id     UUID NOT NULL REFERENCES public.parks(id),
  from_id     UUID NOT NULL REFERENCES public.profiles(id),
  to_id       UUID NOT NULL REFERENCES public.profiles(id),
  body        TEXT NOT NULL,
  is_read     BOOLEAN DEFAULT FALSE,
  sent_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_booking ON public.messages (booking_id);
CREATE INDEX idx_messages_to ON public.messages (to_id) WHERE is_read = FALSE;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own messages" ON public.messages FOR SELECT USING (auth.uid() = from_id OR auth.uid() = to_id);
CREATE POLICY "Users can send messages" ON public.messages FOR INSERT WITH CHECK (auth.uid() = from_id);

-- ────────────────────────────────────────────
-- SUBSCRIPTIONS (Stripe webhooks update these)
-- ────────────────────────────────────────────
CREATE TABLE public.subscriptions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID REFERENCES public.profiles(id),
  park_id               UUID REFERENCES public.parks(id),
  type                  TEXT CHECK (type IN ('nomad_pro','park_pro')),
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id       TEXT,
  status                TEXT DEFAULT 'active' CHECK (status IN ('active','cancelled','past_due','trialing')),
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  cancel_at_period_end  BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own subscriptions" ON public.subscriptions FOR SELECT USING (auth.uid() = user_id);

-- ────────────────────────────────────────────
-- TRIGGER: update updated_at timestamps
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_parks_updated_at BEFORE UPDATE ON public.parks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_bookings_updated_at BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_reviews_updated_at BEFORE UPDATE ON public.reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ────────────────────────────────────────────
-- TRIGGER: update park avg rating on review publish
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_park_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.parks
  SET 
    avg_rating = (SELECT AVG(rating) FROM public.reviews WHERE park_id = NEW.park_id AND is_published = TRUE),
    review_count = (SELECT COUNT(*) FROM public.reviews WHERE park_id = NEW.park_id AND is_published = TRUE)
  WHERE id = NEW.park_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_review_rating
AFTER INSERT OR UPDATE ON public.reviews
FOR EACH ROW EXECUTE FUNCTION update_park_rating();

-- ────────────────────────────────────────────
-- SEED DATA (run after schema is created)
-- ────────────────────────────────────────────
-- ────────────────────────────────────────────
-- MIGRATIONS (run against existing deployments)
-- ────────────────────────────────────────────
ALTER TABLE public.parks
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id       TEXT,
  ADD COLUMN IF NOT EXISTS stripe_connect_status           TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS stripe_connect_reminder_sent_at TIMESTAMPTZ;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS platform_fee DECIMAL(10,2) NOT NULL DEFAULT 0;

-- ── Unclaimed park listing system ─────────────────────────────────────────────
ALTER TABLE public.parks
  ADD COLUMN IF NOT EXISTS claimed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS data_source     TEXT DEFAULT 'operator' CHECK (data_source IN ('operator','directory')),
  ADD COLUMN IF NOT EXISTS listing_status  TEXT NOT NULL DEFAULT 'active' CHECK (listing_status IN ('active','unclaimed','pending_claim'));

-- is_claimed already exists in CREATE TABLE above; ensure default is consistent
-- UPDATE parks SET listing_status = 'unclaimed' WHERE is_claimed = FALSE AND data_source = 'directory';

-- Park claims (pending approval)
CREATE TABLE IF NOT EXISTS public.park_claims (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  park_id      UUID NOT NULL REFERENCES public.parks(id) ON DELETE CASCADE,
  claimant_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  attestation  BOOLEAN NOT NULL DEFAULT FALSE, -- claimant checked "I confirm I am authorized"
  notes        TEXT,                           -- optional message from claimant
  reviewed_by  UUID REFERENCES public.profiles(id),
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (park_id, claimant_id)               -- one pending claim per park per user
);

CREATE INDEX IF NOT EXISTS idx_park_claims_park    ON public.park_claims (park_id);
CREATE INDEX IF NOT EXISTS idx_park_claims_status  ON public.park_claims (status);
CREATE INDEX IF NOT EXISTS idx_park_claims_claimant ON public.park_claims (claimant_id);

ALTER TABLE public.park_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Claimants can view own claims"  ON public.park_claims FOR SELECT USING (auth.uid() = claimant_id);
CREATE POLICY "Claimants can insert own claims" ON public.park_claims FOR INSERT WITH CHECK (auth.uid() = claimant_id);

CREATE TRIGGER trg_park_claims_updated_at
BEFORE UPDATE ON public.park_claims
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ────────────────────────────────────────────
-- BLOG POSTS
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blog_posts (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug                 TEXT UNIQUE NOT NULL,
  title                TEXT NOT NULL,
  meta_description     TEXT,
  content              TEXT,
  excerpt              TEXT,
  featured_image_url   TEXT,
  author               TEXT NOT NULL DEFAULT 'Renato Bryant',
  category             TEXT CHECK (category IN ('Destination Guides','Tips & Advice','Park Spotlights','Gear & Planning')),
  published_at         TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  is_published         BOOLEAN NOT NULL DEFAULT FALSE,
  reading_time_minutes INTEGER,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT excerpt_max_length CHECK (length(excerpt) <= 300)
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_slug      ON public.blog_posts (slug);
CREATE INDEX IF NOT EXISTS idx_blog_posts_category  ON public.blog_posts (category);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published ON public.blog_posts (published_at DESC) WHERE is_published = TRUE;

ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Published posts are publicly readable" ON public.blog_posts
  FOR SELECT USING (is_published = TRUE);
CREATE POLICY "Admin can manage blog posts" ON public.blog_posts
  FOR ALL USING (auth.email() = 'renato@rvspot.net')
  WITH CHECK (auth.email() = 'renato@rvspot.net');

CREATE TRIGGER trg_blog_posts_updated_at
BEFORE UPDATE ON public.blog_posts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ────────────────────────────────────────────
-- Insert 6 sample parks for testing
INSERT INTO public.parks (name, slug, type, city, state, lat, lng, price_nightly, price_monthly, has_wifi, has_50amp, has_ev_charging, allows_long_stay, pets_allowed, avg_rating, review_count, plan, is_active, is_verified) VALUES
('Pineview Lake RV Resort', 'pineview-lake-rv-resort', 'resort', 'Austin', 'TX', 30.2672, -97.7431, 45.00, 650.00, TRUE, TRUE, FALSE, TRUE, TRUE, 4.8, 124, 'pro', TRUE, TRUE),
('Blue Ridge Mountain Camp', 'blue-ridge-mountain-camp', 'campground', 'Asheville', 'NC', 35.5951, -82.5515, 38.00, 520.00, TRUE, TRUE, TRUE, TRUE, TRUE, 4.6, 87, 'pro', TRUE, TRUE),
('Sunbelt RV Community', 'sunbelt-rv-community', 'community', 'Fort Myers', 'FL', 26.6406, -81.8723, 55.00, 780.00, TRUE, TRUE, TRUE, TRUE, FALSE, 4.7, 203, 'pro', TRUE, TRUE),
('Pacific Coast Trailer Park', 'pacific-coast-trailer-park', 'rv_park', 'San Luis Obispo', 'CA', 35.2828, -120.6596, 65.00, 950.00, TRUE, TRUE, TRUE, FALSE, TRUE, 4.4, 56, 'free', TRUE, FALSE),
('Desert Rose RV Park', 'desert-rose-rv-park', 'rv_park', 'Scottsdale', 'AZ', 33.4942, -111.9261, 42.00, 580.00, TRUE, FALSE, FALSE, TRUE, TRUE, 4.9, 312, 'pro', TRUE, TRUE),
('Great Plains Stopover', 'great-plains-stopover', 'rv_park', 'Oklahoma City', 'OK', 35.4676, -97.5164, 28.00, 380.00, FALSE, TRUE, FALSE, TRUE, TRUE, 4.2, 44, 'free', TRUE, FALSE);
