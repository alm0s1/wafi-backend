-- 005_google_auth.sql
-- Allow Google Sign-In for customers: make phone and password_hash nullable,
-- add google_id column for OAuth identity matching.

ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;
