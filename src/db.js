'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
try { db.exec('PRAGMA journal_mode = WAL;'); } catch { db.exec('PRAGMA journal_mode = TRUNCATE;'); }
db.exec('PRAGMA foreign_keys = ON;');

// Migrations for databases created by older versions
function migrate() {
  try { db.exec("ALTER TABLE products ADD COLUMN description TEXT DEFAULT ''"); } catch { /* column already exists */ }
}

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resellers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  email        TEXT DEFAULT '',
  phone        TEXT DEFAULT '',
  discount_pct REAL NOT NULL DEFAULT 22 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  notes        TEXT DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','reseller','customer')),
  reseller_id   INTEGER REFERENCES resellers(id) ON DELETE SET NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE,
  category            TEXT DEFAULT '',
  cost                REAL NOT NULL CHECK (cost >= 0),
  wholesale_price     REAL NOT NULL CHECK (wholesale_price >= 0),
  retail_price        REAL NOT NULL CHECK (retail_price >= 0),
  on_hand             INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 3,
  supplier            TEXT DEFAULT '',
  notes               TEXT DEFAULT '',
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_date         TEXT NOT NULL,
  customer_name      TEXT NOT NULL,
  reseller_id        INTEGER NOT NULL REFERENCES resellers(id),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled','refunded')),
  payment_status     TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid')),
  notes              TEXT DEFAULT '',
  inventory_deducted INTEGER NOT NULL DEFAULT 0,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_reseller ON orders(reseller_id);
CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_date     ON orders(order_date);

CREATE TABLE IF NOT EXISTS order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  product_name  TEXT NOT NULL,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  retail_price  REAL NOT NULL CHECK (retail_price >= 0),
  cost_per_unit REAL NOT NULL CHECK (cost_per_unit >= 0),
  discount_pct  REAL NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  final_price   REAL NOT NULL,
  revenue       REAL NOT NULL,
  cost          REAL NOT NULL,
  profit        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);

CREATE TABLE IF NOT EXISTS deliveries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','packed','out_for_delivery','delivered','cancelled')),
  delivery_date  TEXT DEFAULT '',
  address        TEXT DEFAULT '',
  delivery_notes TEXT DEFAULT '',
  admin_notes    TEXT DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_date TEXT NOT NULL,
  reseller_id  INTEGER NOT NULL REFERENCES resellers(id),
  amount       REAL NOT NULL CHECK (amount > 0),
  method       TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_reseller ON payments(reseller_id);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount     REAL NOT NULL CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS idx_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_alloc_order   ON payment_allocations(order_id);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  change       INTEGER NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('initial','restock','adjustment','sale','restore')),
  ref_order_id INTEGER,
  note         TEXT DEFAULT '',
  created_by   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_moves_product ON inventory_movements(product_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  user_name  TEXT DEFAULT '',
  action     TEXT NOT NULL,
  entity     TEXT DEFAULT '',
  entity_id  INTEGER,
  details    TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

migrate();

module.exports = db;
