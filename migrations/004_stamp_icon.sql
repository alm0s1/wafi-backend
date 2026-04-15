-- 004_stamp_icon.sql
-- Add stamp_icon_url column to businesses and loyalty_cards tables.
-- Allows businesses to upload a custom image used for filled stamps.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stamp_icon_url VARCHAR(500);
ALTER TABLE loyalty_cards ADD COLUMN IF NOT EXISTS stamp_icon_url VARCHAR(500);
