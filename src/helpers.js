'use strict';
const crypto = require('node:crypto');
const db = require('./db');

/* ---------- money & calc ---------- */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Single source of truth for line math.
// Final Price = Retail × (1 - Discount%); Revenue = Final × Qty; Cost = Cost/Unit × Qty; Profit = Revenue - Cost
function computeLine(retail, costPerUnit, discountPct, qty) {
  const finalPrice = round2(retail * (1 - discountPct / 100));
  const revenue = round2(finalPrice * qty);
  const cost = round2(costPerUnit * qty);
  return { final_price: finalPrice, revenue, cost, profit: round2(revenue - cost) };
}

/* ---------- passwords & sessions ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const candidate = crypto.scryptSync(String(pw), salt, 64);
    return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
  } catch { return false; }
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now','+30 days'))`).run(token, userId);
  return token;
}
function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.reseller_id, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')`).get(token);
  return row && row.active ? row : null;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/* ---------- settings ---------- */
const SETTING_DEFAULTS = {
  business_name: 'Peptide Manager',
  default_discount_pct: '22',
  currency: 'USD',
  currency_symbol: '$',
  low_stock_default_threshold: '3',
  allow_backorders: '0',
  require_payment_before_delivery: '0',
  show_profit_to_resellers: '0',
  default_shipping_price: '15',
  allow_self_registration: '1',
  registration_code: '',
  product_disclaimer: 'Products are sold for research purposes only and are not intended for human consumption, or to diagnose, treat, cure, or prevent any disease.'
};
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (SETTING_DEFAULTS[key] ?? null);
}
function getAllSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}
const settingBool = (key) => getSetting(key) === '1' || getSetting(key) === 'true';

/* ---------- audit ---------- */
function audit(user, action, entity, entityId, details) {
  db.prepare('INSERT INTO audit_logs (user_id, user_name, action, entity, entity_id, details) VALUES (?,?,?,?,?,?)')
    .run(user ? user.id : null, user ? user.name : 'system', action, entity || '', entityId ?? null, details || '');
}

/* ---------- inventory ---------- */
// Reserved = qty in OPEN orders (not yet deducted). Available = on_hand - reserved.
function reservedQty(productId, excludeOrderId = null) {
  const row = db.prepare(`
    SELECT IFNULL(SUM(oi.qty), 0) AS r
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = ? AND o.status = 'open' AND o.inventory_deducted = 0
      AND (? IS NULL OR o.id != ?)`).get(productId, excludeOrderId, excludeOrderId);
  return row.r;
}
function stockStatus(available, threshold) {
  if (available <= 0) return 'out_of_stock';
  if (available <= threshold) return 'low_stock';
  return 'in_stock';
}
function moveStock(productId, change, type, refOrderId, note, user) {
  db.prepare('UPDATE products SET on_hand = on_hand + ?, updated_at = datetime(\'now\') WHERE id = ?').run(change, productId);
  db.prepare('INSERT INTO inventory_movements (product_id, change, type, ref_order_id, note, created_by) VALUES (?,?,?,?,?,?)')
    .run(productId, change, type, refOrderId ?? null, note || '', user ? user.id : null);
}
function deductOrderInventory(orderId, user) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.inventory_deducted) return;
  for (const it of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId)) {
    moveStock(it.product_id, -it.qty, 'sale', orderId, `Order #${orderId}`, user);
  }
  db.prepare('UPDATE orders SET inventory_deducted = 1, updated_at = datetime(\'now\') WHERE id = ?').run(orderId);
}
function restoreOrderInventory(orderId, user) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || !order.inventory_deducted) return;
  for (const it of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId)) {
    moveStock(it.product_id, it.qty, 'restore', orderId, `Order #${orderId} restored`, user);
  }
  db.prepare('UPDATE orders SET inventory_deducted = 0, updated_at = datetime(\'now\') WHERE id = ?').run(orderId);
}

/* ---------- orders & payments ---------- */
function orderTotal(orderId) {
  // Order total billed to the customer = product revenue + shipping charge.
  const items = db.prepare('SELECT IFNULL(SUM(revenue),0) AS t FROM order_items WHERE order_id = ?').get(orderId).t;
  const ship = db.prepare('SELECT IFNULL(shipping_amount,0) AS s FROM orders WHERE id = ?').get(orderId).s;
  return round2(items + ship);
}
function orderAllocated(orderId) {
  return db.prepare('SELECT IFNULL(SUM(amount),0) AS a FROM payment_allocations WHERE order_id = ?').get(orderId).a;
}
function recomputePaymentStatus(orderId) {
  const total = round2(orderTotal(orderId));
  const alloc = round2(orderAllocated(orderId));
  const status = alloc <= 0.004 ? (total <= 0.004 ? 'paid' : 'unpaid') : (alloc >= total - 0.004 ? 'paid' : 'partial');
  db.prepare('UPDATE orders SET payment_status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, orderId);
  return status;
}
// Apply a payment to the oldest unpaid (non-cancelled/refunded) orders of its reseller.
// If preferOrderId is set, that order is filled first. Returns total amount applied.
function allocatePayment(paymentId, preferOrderId = null) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) return 0;
  const alreadyApplied = db.prepare('SELECT IFNULL(SUM(amount),0) AS a FROM payment_allocations WHERE payment_id = ?').get(paymentId).a;
  let remaining = round2(payment.amount - alreadyApplied);
  if (remaining <= 0) return 0;

  const candidates = db.prepare(`
    SELECT o.id FROM orders o
    WHERE o.reseller_id = ? AND o.status NOT IN ('cancelled','refunded')
    ORDER BY (o.id = ?) DESC, o.order_date ASC, o.id ASC`).all(payment.reseller_id, preferOrderId ?? -1);

  let applied = 0;
  for (const { id } of candidates) {
    if (remaining <= 0.004) break;
    const due = round2(orderTotal(id) - orderAllocated(id));
    if (due <= 0.004) continue;
    const take = round2(Math.min(due, remaining));
    db.prepare('INSERT INTO payment_allocations (payment_id, order_id, amount) VALUES (?,?,?)').run(paymentId, id, take);
    remaining = round2(remaining - take);
    applied = round2(applied + take);
    recomputePaymentStatus(id);
  }
  return applied;
}
function resellerBalance(resellerId) {
  const row = db.prepare(`
    SELECT IFNULL(SUM(t.due),0) AS owed FROM (
      SELECT o.id, (SELECT IFNULL(SUM(revenue),0) FROM order_items WHERE order_id=o.id)
                 - (SELECT IFNULL(SUM(amount),0) FROM payment_allocations WHERE order_id=o.id) AS due
      FROM orders o WHERE o.reseller_id = ? AND o.status NOT IN ('cancelled','refunded')
    ) t WHERE t.due > 0.004`).get(resellerId);
  return round2(row.owed);
}

/* ---------- validation ---------- */
// Validates and normalizes order items. Throws {status, message} style errors.
function buildOrderItems(items, reseller, { checkStock = true, excludeOrderId = null, forceDiscount = null } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw httpError(400, 'Add at least one product to the order.');
  const allowBackorders = settingBool('allow_backorders');
  const out = [];
  const qtyByProduct = new Map();
  for (const raw of items) {
    const productId = Number(raw.product_id);
    const qty = Number(raw.qty);
    if (!productId) throw httpError(400, 'Every line needs a product selected.');
    if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, 'Quantity must be a whole number greater than zero.');
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
    if (!p) throw httpError(400, 'Selected product was not found or is inactive.');
    if (p.retail_price == null || p.cost == null) throw httpError(400, `"${p.name}" is missing a price or cost. Fix the product first.`);
    let discount = forceDiscount != null ? Number(forceDiscount)
      : (raw.discount_pct === '' || raw.discount_pct == null ? Number(reseller.discount_pct) : Number(raw.discount_pct));
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw httpError(400, 'Discount must be between 0 and 100.');
    if (p.no_reseller_discount) discount = 0; // this product is always sold at full retail (no reseller/discount price)
    qtyByProduct.set(productId, (qtyByProduct.get(productId) || 0) + qty);
    const calc = computeLine(p.retail_price, p.cost, discount, qty);
    out.push({
      product_id: p.id, product_name: p.name, qty,
      retail_price: p.retail_price, cost_per_unit: p.cost, discount_pct: discount, ...calc
    });
  }
  if (checkStock && !allowBackorders) {
    for (const [pid, qty] of qtyByProduct) {
      const p = db.prepare('SELECT name, on_hand FROM products WHERE id = ?').get(pid);
      const available = p.on_hand - reservedQty(pid, excludeOrderId);
      if (qty > available) {
        throw httpError(400, `Not enough stock for "${p.name}". Available: ${Math.max(available, 0)}, requested: ${qty}. (Backorders are disabled in Settings.)`);
      }
    }
  }
  return out;
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ---------- csv ---------- */
function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(c => esc(c.label)).join(',');
  const lines = rows.map(r => columns.map(c => esc(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(','));
  return [header, ...lines].join('\n');
}

module.exports = {
  round2, computeLine, hashPassword, verifyPassword, createSession, getSessionUser, destroySession,
  getSetting, getAllSettings, setSetting, settingBool, SETTING_DEFAULTS,
  audit, reservedQty, stockStatus, moveStock, deductOrderInventory, restoreOrderInventory,
  orderTotal, orderAllocated, recomputePaymentStatus, allocatePayment, resellerBalance,
  buildOrderItems, httpError, toCsv
};
