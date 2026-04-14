-- Feature: customer join by code
-- Add 6-char join_code to businesses (auto-generated, unique)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS join_code VARCHAR(6) UNIQUE;

-- Backfill existing businesses with random hex-based codes
UPDATE businesses
SET join_code = upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 6))
WHERE join_code IS NULL;

-- Feature: card completion notification to business via FCM
-- Add fcm_token to businesses so owners receive push notifications
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS fcm_token VARCHAR(500);

-- Feature: live card updates
-- Add brand_color to loyalty_cards so each card is self-contained
-- and can be updated independently of the businesses row
ALTER TABLE loyalty_cards
  ADD COLUMN IF NOT EXISTS brand_color VARCHAR(7);

-- Backfill brand_color from the owning business for all existing cards
UPDATE loyalty_cards lc
SET brand_color = b.brand_color
FROM businesses b
WHERE lc.business_id = b.id
  AND lc.brand_color IS NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_join_code ON businesses(join_code);
