-- Add card template fields to businesses table so the template is
-- stored centrally and can be used when a customer joins via QR.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS stamps_required INT,
  ADD COLUMN IF NOT EXISTS reward_description VARCHAR(200);
