-- Wafi Loyalty Platform - Initial Schema
-- Run order matters: referenced tables must exist before referencing tables

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Businesses
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_name VARCHAR(100) NOT NULL,
  business_name_ar VARCHAR(100) NOT NULL,
  business_name_en VARCHAR(100),
  business_type VARCHAR(50),
  phone VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  logo_url VARCHAR(500),
  brand_color VARCHAR(7) DEFAULT '#1D9E75',
  thawani_customer_token VARCHAR(255),
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  plan VARCHAR(20) NOT NULL,
  amount_baisa INT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  thawani_session_id VARCHAR(255),
  thawani_receipt VARCHAR(255),
  auto_renew BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Customers (must be before loyalty_cards since loyalty_cards references customers)
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(100),
  password_hash VARCHAR(255) NOT NULL,
  fcm_token VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Loyalty Cards
CREATE TABLE IF NOT EXISTS loyalty_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  stamps_required INT DEFAULT 8,
  current_stamps INT DEFAULT 0,
  total_completed INT DEFAULT 0,
  reward_description VARCHAR(200),
  qr_token VARCHAR(100) UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Stamps
CREATE TABLE IF NOT EXISTS stamps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loyalty_card_id UUID REFERENCES loyalty_cards(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  added_by VARCHAR(20) DEFAULT 'business',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL,
  recipient_type VARCHAR(20) NOT NULL,
  title VARCHAR(200),
  body TEXT,
  type VARCHAR(50),
  sent_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_subscriptions_business_id ON subscriptions(business_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_end_date ON subscriptions(end_date);
CREATE INDEX IF NOT EXISTS idx_loyalty_cards_business_id ON loyalty_cards(business_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_cards_customer_id ON loyalty_cards(customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_cards_qr_token ON loyalty_cards(qr_token);
CREATE INDEX IF NOT EXISTS idx_stamps_loyalty_card_id ON stamps(loyalty_card_id);
CREATE INDEX IF NOT EXISTS idx_stamps_business_id ON stamps(business_id);
CREATE INDEX IF NOT EXISTS idx_stamps_created_at ON stamps(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_id ON notifications(recipient_id);
