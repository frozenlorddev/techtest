-- BLACKLORD TECH Database Schema
-- PostgreSQL

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  firstname VARCHAR(255) NOT NULL,
  lastname VARCHAR(255) NOT NULL,
  fullname VARCHAR(255),
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255),
  google_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Wallet table
CREATE TABLE IF NOT EXISTS wallet (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) UNIQUE NOT NULL,
  balance DECIMAL(10, 2) DEFAULT 0.00,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Wallet transactions
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  type VARCHAR(50) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  reference VARCHAR(255),
  description TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Panels
CREATE TABLE IF NOT EXISTS panels (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  ptero_server_id INTEGER,
  ptero_user_id INTEGER,
  ptero_username VARCHAR(255),
  package_name VARCHAR(255),
  package_price DECIMAL(10, 2),
  nest_id INTEGER,
  egg_id INTEGER,
  status VARCHAR(50) DEFAULT 'active',
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  package_name VARCHAR(255),
  amount DECIMAL(10, 2),
  status VARCHAR(50) DEFAULT 'pending',
  reference VARCHAR(255) UNIQUE,
  pterodactyl_credentials TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Packages
CREATE TABLE IF NOT EXISTS packages (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  cpu INTEGER NOT NULL DEFAULT 0,
  ram INTEGER NOT NULL DEFAULT 0,
  disk INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  popular BOOLEAN DEFAULT false,
  accent VARCHAR(20) DEFAULT '#fbbf24',
  active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  expires_after_hours INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Vouchers
CREATE TABLE IF NOT EXISTS voucher_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(10) UNIQUE NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  created_by VARCHAR(255),
  used_by INTEGER REFERENCES users(id),
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Inquiries
CREATE TABLE IF NOT EXISTS inquiries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_email VARCHAR(255),
  user_name VARCHAR(255),
  subject VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'open',
  admin_reply TEXT,
  replied_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Inquiry messages
CREATE TABLE IF NOT EXISTS inquiry_messages (
  id SERIAL PRIMARY KEY,
  inquiry_id INTEGER REFERENCES inquiries(id) ON DELETE CASCADE,
  sender VARCHAR(20) NOT NULL DEFAULT 'user',
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed default packages
INSERT INTO packages (name, price, cpu, ram, disk, description, popular, accent, active, sort_order)
VALUES
  ('Starter', 50, 20, 512, 2048, 'Perfect for small bots and lightweight servers', false, '#1e3a8a', true, 1),
  ('Standard', 75, 50, 1024, 5120, 'Great for Minecraft, Discord bots & medium workloads', true, '#fbbf24', true, 2),
  ('Premium', 100, 100, 5120, 10240, 'Full power for high-performance game servers', false, '#f59e0b', true, 3),
  ('Testing', 5, 20, 512, 1024, 'Try our platform risk-free. Server removed after 6 hours.', false, '#7c3aed', true, 0)
ON CONFLICT (id) DO NOTHING;