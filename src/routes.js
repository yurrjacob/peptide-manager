'use strict';
const express = require('express');
const db = require('./db');
const H = require('./helpers');

const router = express.Router();

/* ============ auth middleware ============ */
router.use((req, res, next) => {
  req.user = H.getSessionUser(req.cookies.session);
  next();
});
const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please log in.' });
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'Admin access required.' });
const requireReseller = (req, res, next) => (req.user && req.user.role === 'reseller' && req.user.reseller_id) ? next() : res.status(403).json({ error: 'Reseller access required.' });

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'lax', secure: !!req.secure, maxAge: 30 * 24 * 3600 * 1000 });

function publicSettings() {
  const s = H.getAllSettings();
  return {
    business_name: s.business_name,
    currency: s.currency,
    currency_symbol: s.currency_symbol,
    default_discount_pct: Number(s.default_discount_pct),
    show_profit_to_resellers: s.show_profit_to_resellers === '1',
    allow_backorders: s.allow_backorders === '1',
    product_disclaimer: s.product_disclaimer
  };
}

/* ============ auth ============ */
router.post('/login', (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) throw H.httpError(400, 'Enter your email and password.');
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (!user || !H.verifyPassword(password, user.password_hash)) throw H.httpError(401, 'Incorrect email or password.');
  if (!user.active) throw H.httpError(403, 'This account has been disabled. Contact the administrator.');
  if (user.role === 'reseller') {
    const r = db.prepare('SELECT status FROM resellers WHERE id = ?').get(user.reseller_id);
    if (!r || r.status !== 'active') throw H.httpError(403, 'This reseller account has been disabled. Contact the administrator.');
  }
  const token = H.createSession(user.id);
  res.cookie('session', token, cookieOpts(req));
  H.audit({ id: user.id, name: user.name }, 'login', 'user', user.id, '');
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, settings: publicSettings() });
});

router.post('/logout', (req, res) => {
  H.destroySession(req.cookies.session);
  res.clearCookie('session');
  res.json({ ok: true });
});

// Public info for the login screen (no auth required, nothing sensitive)
router.get('/public-config', (req, res) => {
  res.json({
    business_name: H.getSetting('business_name'),
    allow_self_registration: H.getSetting('allow_self_registration') === '1',
    registration_code_required: !!String(H.getSetting('registration_code') || '').trim()
  });
});

// Reseller self-registration (optional invite code, set in Settings)
router.post('/register', (req, res) => {
  if (H.getSetting('allow_self_registration') !== '1') throw H.httpError(403, 'Self-registration is turned off. Ask the admin to create your account.');
  const name = str(req.body.name, 200);
  const email = str(req.body.email, 200).toLowerCase();
  const phone = str(req.body.phone, 50);
  const password = String(req.body.password || '');
  const code = str(req.body.code, 100);
  if (!name) throw H.httpError(400, 'Enter your name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw H.httpError(400, 'Enter a valid email address.');
  if (password.length < 6) throw H.httpError(400, 'Password must be at least 6 characters.');
  const requiredCode = String(H.getSetting('registration_code') || '').trim();
  if (requiredCode && code.trim().toLowerCase() !== requiredCode.toLowerCase()) {
    throw H.httpError(400, 'Invite code is incorrect. Ask the admin for the current code.');
  }
  if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) {
    throw H.httpError(400, 'An account with this email already exists. Try signing in instead.');
  }
  const discount = Number(H.getSetting('default_discount_pct')) || 0;
  let userId;
  db.exec('BEGIN');
  try {
    const resellerId = db.prepare('INSERT INTO resellers (name, email, phone, discount_pct, notes) VALUES (?,?,?,?,?)')
      .run(name, email, phone, discount, 'Self-registered').lastInsertRowid;
    userId = db.prepare("INSERT INTO users (name, email, password_hash, role, reseller_id) VALUES (?,?,?,'reseller',?)")
      .run(name, email, H.hashPassword(password), resellerId).lastInsertRowid;
    H.audit({ id: userId, name }, 'register', 'reseller', resellerId, `${name} (${email}) self-registered`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const token = H.createSession(userId);
  res.cookie('session', token, cookieOpts(req));
  res.json({ user: { id: userId, name, email, role: 'reseller' }, settings: publicSettings() });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role }, settings: publicSettings() });
});

/* ============ products / inventory (admin) ============ */
function productWithStock(p) {
  const reserved = H.reservedQty(p.id);
  const available = p.on_hand - reserved;
  return { ...p, reserved, available, stock_status: H.stockStatus(available, p.low_stock_threshold) };
}

router.get('/products', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all().map(productWithStock);
  res.json(rows);
});

function validateProductBody(b) {
  const name = str(b.name, 200);
  if (!name) throw H.httpError(400, 'Product name is required.');
  const nums = { cost: b.cost, wholesale_price: b.wholesale_price, retail_price: b.retail_price };
  for (const [k, v] of Object.entries(nums)) {
    if (v === '' || v == null || !Number.isFinite(Number(v)) || Number(v) < 0) {
      throw H.httpError(400, `${k.replace(/_/g, ' ')} must be a number ≥ 0. Blank prices are not allowed.`);
    }
  }
  const onHand = b.on_hand === '' || b.on_hand == null ? 0 : Number(b.on_hand);
  if (!Number.isInteger(onHand)) throw H.httpError(400, 'On hand must be a whole number.');
  const threshold = b.low_stock_threshold === '' || b.low_stock_threshold == null
    ? Number(H.getSetting('low_stock_default_threshold')) : Number(b.low_stock_threshold);
  if (!Number.isInteger(threshold) || threshold < 0) throw H.httpError(400, 'Low stock threshold must be a whole number ≥ 0.');
  return {
    name, category: str(b.category, 100), cost: H.round2(nums.cost), wholesale_price: H.round2(nums.wholesale_price),
    retail_price: H.round2(nums.retail_price), on_hand: onHand, low_stock_threshold: threshold,
    supplier: str(b.supplier, 200), notes: str(b.notes, 1000)
  };
}

router.post('/products', requireAdmin, (req, res) => {
  const p = validateProductBody(req.body);
  const dupe = db.prepare('SELECT id FROM products WHERE name = ? AND active = 1').get(p.name);
  if (dupe) throw H.httpError(400, 'A product with this name already exists.');
  const id = db.prepare(`INSERT INTO products (name, category, cost, wholesale_price, retail_price, on_hand, low_stock_threshold, supplier, notes)
                         VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(p.name, p.category, p.cost, p.wholesale_price, p.retail_price, p.on_hand, p.low_stock_threshold, p.supplier, p.notes).lastInsertRowid;
  if (p.on_hand !== 0) db.prepare("INSERT INTO inventory_movements (product_id, change, type, note, created_by) VALUES (?,?,'initial','Starting inventory',?)").run(id, p.on_hand, req.user.id);
  H.audit(req.user, 'create', 'product', id, p.name);
  res.json(productWithStock(db.prepare('SELECT * FROM products WHERE id = ?').get(id)));
});

router.put('/products/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!existing) throw H.httpError(404, 'Product not found.');
  const p = validateProductBody({ ...existing, ...req.body, on_hand: req.body.on_hand ?? existing.on_hand });
  if (p.on_hand !== existing.on_hand) {
    const diff = p.on_hand - existing.on_hand;
    db.prepare("INSERT INTO inventory_movements (product_id, change, type, note, created_by) VALUES (?,?,'adjustment','Manual edit of on-hand',?)").run(existing.id, diff, req.user.id);
  }
  db.prepare(`UPDATE products SET name=?, category=?, cost=?, wholesale_price=?, retail_price=?, on_hand=?, low_stock_threshold=?, supplier=?, notes=?, updated_at=datetime('now') WHERE id=?`)
    .run(p.name, p.category, p.cost, p.wholesale_price, p.retail_price, p.on_hand, p.low_stock_threshold, p.supplier, p.notes, existing.id);
  H.audit(req.user, 'update', 'product', existing.id, p.name);
  res.json(productWithStock(db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id)));
});

router.post('/products/:id/adjust', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!p) throw H.httpError(404, 'Product not found.');
  const change = Number(req.body.change);
  if (!Number.isInteger(change) || change === 0) throw H.httpError(400, 'Adjustment must be a non-zero whole number (e.g. 10 to restock, -2 for breakage).');
  H.moveStock(p.id, change, change > 0 ? 'restock' : 'adjustment', null, str(req.body.note, 300), req.user);
  H.audit(req.user, 'stock-adjust', 'product', p.id, `${p.name}: ${change > 0 ? '+' : ''}${change}`);
  res.json(productWithStock(db.prepare('SELECT * FROM products WHERE id = ?').get(p.id)));
});

router.delete('/products/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!p) throw H.httpError(404, 'Product not found.');
  const used = db.prepare('SELECT COUNT(*) AS c FROM order_items WHERE product_id = ?').get(p.id).c;
  if (used > 0) {
    db.prepare("UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?").run(p.id);
    H.audit(req.user, 'archive', 'product', p.id, `${p.name} (kept for order history)`);
    res.json({ ok: true, archived: true });
  } else {
    db.prepare('DELETE FROM inventory_movements WHERE product_id = ?').run(p.id);
    db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
    H.audit(req.user, 'delete', 'product', p.id, p.name);
    res.json({ ok: true, archived: false });
  }
});

/* ============ orders ============ */
function fetchOrders(where, params) {
  const rows = db.prepare(`
    SELECT o.*, r.name AS reseller_name,
      (SELECT IFNULL(SUM(revenue),0) FROM order_items WHERE order_id = o.id) AS total_revenue,
      (SELECT IFNULL(SUM(cost),0)    FROM order_items WHERE order_id = o.id) AS total_cost,
      (SELECT IFNULL(SUM(profit),0)  FROM order_items WHERE order_id = o.id) AS total_profit,
      (SELECT IFNULL(SUM(amount),0)  FROM payment_allocations WHERE order_id = o.id) AS paid_amount,
      d.status AS delivery_status, d.delivery_date, d.address, d.delivery_notes, d.admin_notes
    FROM orders o
    JOIN resellers r ON r.id = o.reseller_id
    LEFT JOIN deliveries d ON d.order_id = o.id
    ${where}
    ORDER BY o.order_date DESC, o.id DESC`).all(...params);
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const byOrder = {};
    for (const it of items) (byOrder[it.order_id] ||= []).push(it);
    for (const r of rows) {
      r.items = byOrder[r.id] || [];
      r.total_revenue = H.round2(r.total_revenue);
      r.total_cost = H.round2(r.total_cost);
      r.total_profit = H.round2(r.total_profit);
      r.paid_amount = H.round2(r.paid_amount);
      r.balance_due = H.round2(Math.max(0, r.total_revenue - r.paid_amount));
    }
  }
  return rows;
}

function buildOrderFilters(q) {
  const conds = [], params = [];
  if (q.status) { conds.push('o.status = ?'); params.push(q.status); }
  if (q.payment_status) { conds.push('o.payment_status = ?'); params.push(q.payment_status); }
  if (q.delivery_status) { conds.push('d.status = ?'); params.push(q.delivery_status); }
  if (q.reseller_id) { conds.push('o.reseller_id = ?'); params.push(Number(q.reseller_id)); }
  if (q.product_id) { conds.push('EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = o.id AND x.product_id = ?)'); params.push(Number(q.product_id)); }
  if (isDate(q.date_from)) { conds.push('o.order_date >= ?'); params.push(q.date_from); }
  if (isDate(q.date_to)) { conds.push('o.order_date <= ?'); params.push(q.date_to); }
  if (q.q) {
    conds.push(`(o.customer_name LIKE ? OR o.notes LIKE ? OR EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = o.id AND x.product_name LIKE ?))`);
    const like = `%${str(q.q, 100)}%`;
    params.push(like, like, like);
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

router.get('/orders', requireAdmin, (req, res) => {
  const { where, params } = buildOrderFilters(req.query);
  res.json(fetchOrders(where, params));
});

function createOrder(req, { resellerId, customerName, orderDate, status, notes, address, deliveryNotes, items, forceDiscount }) {
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(resellerId);
  if (!reseller) throw H.httpError(400, 'Choose a reseller for this order.');
  if (!customerName) throw H.httpError(400, 'Customer name is required.');
  if (!isDate(orderDate)) throw H.httpError(400, 'Order date is required (YYYY-MM-DD).');
  const lines = H.buildOrderItems(items, reseller, { forceDiscount });

  db.exec('BEGIN');
  try {
    const orderId = db.prepare('INSERT INTO orders (order_date, customer_name, reseller_id, status, notes, created_by) VALUES (?,?,?,?,?,?)')
      .run(orderDate, customerName, reseller.id, status, notes, req.user.id).lastInsertRowid;
    const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, qty, retail_price, cost_per_unit, discount_pct, final_price, revenue, cost, profit)
                                VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const l of lines) insItem.run(orderId, l.product_id, l.product_name, l.qty, l.retail_price, l.cost_per_unit, l.discount_pct, l.final_price, l.revenue, l.cost, l.profit);
    db.prepare('INSERT INTO deliveries (order_id, address, delivery_notes) VALUES (?,?,?)').run(orderId, address, deliveryNotes);
    if (status === 'completed') H.deductOrderInventory(orderId, req.user);
    H.recomputePaymentStatus(orderId);
    H.audit(req.user, 'create', 'order', orderId, `${customerName} — ${lines.length} item(s), ${reseller.name}`);
    db.exec('COMMIT');
    return orderId;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

router.post('/orders', requireAdmin, (req, res) => {
  const b = req.body;
  const status = ['open', 'completed'].includes(b.status) ? b.status : 'open';
  const orderId = createOrder(req, {
    resellerId: Number(b.reseller_id), customerName: str(b.customer_name, 200), orderDate: str(b.order_date, 10),
    status, notes: str(b.notes, 2000), address: str(b.address, 500), deliveryNotes: str(b.delivery_notes, 1000),
    items: b.items, forceDiscount: null
  });
  res.json(fetchOrders('WHERE o.id = ?', [orderId])[0]);
});

router.put('/orders/:id', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) throw H.httpError(404, 'Order not found.');
  const b = req.body;
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(Number(b.reseller_id ?? order.reseller_id));
  if (!reseller) throw H.httpError(400, 'Choose a reseller for this order.');
  const customerName = str(b.customer_name ?? order.customer_name, 200);
  const orderDate = str(b.order_date ?? order.order_date, 10);
  if (!customerName) throw H.httpError(400, 'Customer name is required.');
  if (!isDate(orderDate)) throw H.httpError(400, 'Order date is required (YYYY-MM-DD).');

  db.exec('BEGIN');
  try {
    const wasDeducted = !!order.inventory_deducted;
    if (wasDeducted) H.restoreOrderInventory(order.id, req.user);
    if (Array.isArray(b.items)) {
      const lines = H.buildOrderItems(b.items, reseller, { excludeOrderId: order.id, checkStock: order.status !== 'cancelled' && order.status !== 'refunded' });
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);
      const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, qty, retail_price, cost_per_unit, discount_pct, final_price, revenue, cost, profit)
                                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const l of lines) insItem.run(order.id, l.product_id, l.product_name, l.qty, l.retail_price, l.cost_per_unit, l.discount_pct, l.final_price, l.revenue, l.cost, l.profit);
    }
    db.prepare(`UPDATE orders SET order_date=?, customer_name=?, reseller_id=?, notes=?, updated_at=datetime('now') WHERE id=?`)
      .run(orderDate, customerName, reseller.id, str(b.notes ?? order.notes, 2000), order.id);
    if (b.address !== undefined || b.delivery_notes !== undefined) {
      db.prepare(`UPDATE deliveries SET address = COALESCE(?, address), delivery_notes = COALESCE(?, delivery_notes), updated_at=datetime('now') WHERE order_id=?`)
        .run(b.address !== undefined ? str(b.address, 500) : null, b.delivery_notes !== undefined ? str(b.delivery_notes, 1000) : null, order.id);
    }
    if (wasDeducted) H.deductOrderInventory(order.id, req.user);
    H.recomputePaymentStatus(order.id);
    H.audit(req.user, 'update', 'order', order.id, customerName);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json(fetchOrders('WHERE o.id = ?', [Number(req.params.id)])[0]);
});

router.patch('/orders/:id/status', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) throw H.httpError(404, 'Order not found.');
  const status = String(req.body.status || '');
  if (!['open', 'completed', 'cancelled', 'refunded'].includes(status)) throw H.httpError(400, 'Invalid order status.');

  db.exec('BEGIN');
  try {
    if (status === 'completed' && !order.inventory_deducted) {
      if (!H.settingBool('allow_backorders')) {
        for (const it of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id)) {
          const p = db.prepare('SELECT name, on_hand FROM products WHERE id = ?').get(it.product_id);
          if (p.on_hand < it.qty) throw H.httpError(400, `Cannot complete: not enough stock of "${p.name}" (on hand: ${p.on_hand}, needed: ${it.qty}). Restock or enable backorders in Settings.`);
        }
      }
      H.deductOrderInventory(order.id, req.user);
    }
    if ((status === 'cancelled' || status === 'refunded' || status === 'open') && order.inventory_deducted) {
      H.restoreOrderInventory(order.id, req.user);
    }
    db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, order.id);
    if (status === 'cancelled') db.prepare("UPDATE deliveries SET status = 'cancelled', updated_at = datetime('now') WHERE order_id = ?").run(order.id);
    H.audit(req.user, 'status-change', 'order', order.id, `${order.status} → ${status}`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json(fetchOrders('WHERE o.id = ?', [order.id])[0]);
});

router.patch('/orders/:id/delivery', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) throw H.httpError(404, 'Order not found.');
  const b = req.body;
  const fields = {};
  if (b.status !== undefined) {
    if (!['pending', 'packed', 'out_for_delivery', 'delivered', 'cancelled'].includes(b.status)) throw H.httpError(400, 'Invalid delivery status.');
    fields.status = b.status;
  }
  if (b.delivery_date !== undefined) fields.delivery_date = str(b.delivery_date, 10);
  if (b.address !== undefined) fields.address = str(b.address, 500);
  if (b.delivery_notes !== undefined) fields.delivery_notes = str(b.delivery_notes, 1000);
  if (b.admin_notes !== undefined) fields.admin_notes = str(b.admin_notes, 1000);
  if (!Object.keys(fields).length) throw H.httpError(400, 'Nothing to update.');

  db.exec('BEGIN');
  try {
    if (fields.status === 'delivered') {
      if (order.status === 'cancelled' || order.status === 'refunded') {
        throw H.httpError(400, `This order is ${order.status} — set it back to Open before delivering.`);
      }
      if (H.settingBool('require_payment_before_delivery') && order.payment_status !== 'paid') {
        throw H.httpError(400, 'This order is not fully paid. "Require payment before delivery" is on in Settings.');
      }
      if (!order.inventory_deducted) H.deductOrderInventory(order.id, req.user);
      if (order.status === 'open') db.prepare("UPDATE orders SET status='completed', updated_at=datetime('now') WHERE id = ?").run(order.id);
      if (!fields.delivery_date) fields.delivery_date = new Date().toISOString().slice(0, 10);
    }
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE deliveries SET ${sets}, updated_at = datetime('now') WHERE order_id = ?`).run(...Object.values(fields), order.id);
    if (fields.status) H.audit(req.user, 'delivery-status', 'order', order.id, fields.status);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json(fetchOrders('WHERE o.id = ?', [order.id])[0]);
});

// Mark an order fully paid (records a payment for the remaining balance)
router.post('/orders/:id/mark-paid', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) throw H.httpError(404, 'Order not found.');
  const due = H.round2(H.orderTotal(order.id) - H.orderAllocated(order.id));
  if (due <= 0.004) throw H.httpError(400, 'This order is already fully paid.');
  db.exec('BEGIN');
  try {
    const payId = db.prepare('INSERT INTO payments (payment_date, reseller_id, amount, method, notes, created_by) VALUES (?,?,?,?,?,?)')
      .run(new Date().toISOString().slice(0, 10), order.reseller_id, due, str(req.body.method, 50) || 'Cash', `Marked paid — order #${order.id}`, req.user.id).lastInsertRowid;
    H.allocatePayment(payId, order.id);
    H.audit(req.user, 'mark-paid', 'order', order.id, `$${due.toFixed(2)}`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json(fetchOrders('WHERE o.id = ?', [order.id])[0]);
});

router.delete('/orders/:id', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) throw H.httpError(404, 'Order not found.');
  db.exec('BEGIN');
  try {
    if (order.inventory_deducted) H.restoreOrderInventory(order.id, req.user);
    const affectedPayments = db.prepare('SELECT DISTINCT payment_id FROM payment_allocations WHERE order_id = ?').all(order.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(order.id); // cascades items, delivery, allocations
    for (const { payment_id } of affectedPayments) H.allocatePayment(payment_id); // re-apply freed money to other unpaid orders
    H.audit(req.user, 'delete', 'order', order.id, order.customer_name);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

/* ============ resellers (admin) ============ */
function resellerRow(r) {
  const agg = db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN o.status = 'open' THEN 1 ELSE 0 END) AS open_orders,
      SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) AS completed_orders,
      IFNULL(SUM(CASE WHEN o.status NOT IN ('cancelled','refunded') THEN (SELECT SUM(revenue) FROM order_items WHERE order_id = o.id) END), 0) AS total_revenue,
      IFNULL(SUM(CASE WHEN o.status NOT IN ('cancelled','refunded') THEN (SELECT SUM(profit) FROM order_items WHERE order_id = o.id) END), 0) AS total_profit
    FROM orders o WHERE o.reseller_id = ?`).get(r.id);
  const paid = db.prepare('SELECT IFNULL(SUM(amount),0) AS p FROM payments WHERE reseller_id = ?').get(r.id).p;
  const owed = H.resellerBalance(r.id);
  const login = db.prepare("SELECT id, email, active FROM users WHERE reseller_id = ? AND role = 'reseller'").get(r.id);
  return {
    ...r,
    total_orders: agg.total_orders || 0, open_orders: agg.open_orders || 0, completed_orders: agg.completed_orders || 0,
    total_revenue: H.round2(agg.total_revenue), total_profit: H.round2(agg.total_profit),
    amount_owed: owed, amount_paid: H.round2(paid), balance: owed,
    login_email: login ? login.email : null, login_active: login ? !!login.active : false, login_user_id: login ? login.id : null
  };
}

router.get('/resellers', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM resellers ORDER BY name').all().map(resellerRow));
});

router.get('/resellers/:id', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(Number(req.params.id));
  if (!r) throw H.httpError(404, 'Reseller not found.');
  res.json({
    ...resellerRow(r),
    orders: fetchOrders('WHERE o.reseller_id = ?', [r.id]),
    payments: db.prepare('SELECT * FROM payments WHERE reseller_id = ? ORDER BY payment_date DESC, id DESC').all(r.id)
  });
});

function validateResellerBody(b) {
  const name = str(b.name, 200);
  if (!name) throw H.httpError(400, 'Reseller name is required.');
  const discount = b.discount_pct === '' || b.discount_pct == null ? Number(H.getSetting('default_discount_pct')) : Number(b.discount_pct);
  if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw H.httpError(400, 'Discount must be between 0 and 100.');
  return { name, email: str(b.email, 200), phone: str(b.phone, 50), discount_pct: discount, notes: str(b.notes, 1000) };
}

router.post('/resellers', requireAdmin, (req, res) => {
  const r = validateResellerBody(req.body);
  const id = db.prepare('INSERT INTO resellers (name, email, phone, discount_pct, notes) VALUES (?,?,?,?,?)')
    .run(r.name, r.email, r.phone, r.discount_pct, r.notes).lastInsertRowid;
  if (str(req.body.login_email) && req.body.login_password) {
    const email = str(req.body.login_email, 200).toLowerCase();
    if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) throw H.httpError(400, 'That login email is already in use.');
    if (String(req.body.login_password).length < 6) throw H.httpError(400, 'Password must be at least 6 characters.');
    db.prepare("INSERT INTO users (name, email, password_hash, role, reseller_id) VALUES (?,?,?,'reseller',?)")
      .run(r.name, email, H.hashPassword(req.body.login_password), id);
  }
  H.audit(req.user, 'create', 'reseller', id, r.name);
  res.json(resellerRow(db.prepare('SELECT * FROM resellers WHERE id = ?').get(id)));
});

router.put('/resellers/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM resellers WHERE id = ?').get(Number(req.params.id));
  if (!existing) throw H.httpError(404, 'Reseller not found.');
  const r = validateResellerBody({ ...existing, ...req.body });
  const status = ['active', 'disabled'].includes(req.body.status) ? req.body.status : existing.status;
  db.prepare(`UPDATE resellers SET name=?, email=?, phone=?, discount_pct=?, notes=?, status=?, updated_at=datetime('now') WHERE id=?`)
    .run(r.name, r.email, r.phone, r.discount_pct, r.notes, status, existing.id);
  H.audit(req.user, 'update', 'reseller', existing.id, `${r.name}${status !== existing.status ? ` (${status})` : ''}`);
  res.json(resellerRow(db.prepare('SELECT * FROM resellers WHERE id = ?').get(existing.id)));
});

// Create or update reseller login; reset password; enable/disable login
router.post('/resellers/:id/login', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(Number(req.params.id));
  if (!r) throw H.httpError(404, 'Reseller not found.');
  const existing = db.prepare("SELECT * FROM users WHERE reseller_id = ? AND role = 'reseller'").get(r.id);
  const b = req.body;
  if (b.action === 'disable' || b.action === 'enable') {
    if (!existing) throw H.httpError(400, 'This reseller has no login yet.');
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.action === 'enable' ? 1 : 0, existing.id);
    if (b.action === 'disable') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    H.audit(req.user, `login-${b.action}`, 'reseller', r.id, r.name);
    return res.json({ ok: true });
  }
  const password = String(b.password || '');
  if (password.length < 6) throw H.httpError(400, 'Password must be at least 6 characters.');
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?').run(H.hashPassword(password), existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    H.audit(req.user, 'password-reset', 'reseller', r.id, r.name);
  } else {
    const email = str(b.email, 200).toLowerCase();
    if (!email) throw H.httpError(400, 'Login email is required.');
    if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) throw H.httpError(400, 'That login email is already in use.');
    db.prepare("INSERT INTO users (name, email, password_hash, role, reseller_id) VALUES (?,?,?,'reseller',?)")
      .run(r.name, email, H.hashPassword(password), r.id);
    H.audit(req.user, 'login-created', 'reseller', r.id, `${r.name} (${email})`);
  }
  res.json({ ok: true });
});

// Settle a reseller's entire outstanding balance
router.post('/resellers/:id/settle', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(Number(req.params.id));
  if (!r) throw H.httpError(404, 'Reseller not found.');
  const owed = H.resellerBalance(r.id);
  if (owed <= 0.004) throw H.httpError(400, 'This reseller has no outstanding balance.');
  db.exec('BEGIN');
  try {
    const payId = db.prepare('INSERT INTO payments (payment_date, reseller_id, amount, method, notes, created_by) VALUES (?,?,?,?,?,?)')
      .run(new Date().toISOString().slice(0, 10), r.id, owed, str(req.body.method, 50) || 'Cash', 'Balance settled in full', req.user.id).lastInsertRowid;
    H.allocatePayment(payId);
    H.audit(req.user, 'settle-balance', 'reseller', r.id, `$${owed.toFixed(2)}`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json(resellerRow(db.prepare('SELECT * FROM resellers WHERE id = ?').get(r.id)));
});

/* ============ payments (admin) ============ */
router.get('/payments', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, r.name AS reseller_name, u.name AS created_by_name
    FROM payments p JOIN resellers r ON r.id = p.reseller_id LEFT JOIN users u ON u.id = p.created_by
    ORDER BY p.payment_date DESC, p.id DESC`).all();
  const allocs = db.prepare(`
    SELECT pa.payment_id, pa.order_id, pa.amount, o.customer_name, o.order_date
    FROM payment_allocations pa JOIN orders o ON o.id = pa.order_id`).all();
  const byPayment = {};
  for (const a of allocs) (byPayment[a.payment_id] ||= []).push(a);
  for (const p of rows) {
    p.allocations = byPayment[p.id] || [];
    p.applied = H.round2(p.allocations.reduce((s, a) => s + a.amount, 0));
    p.unapplied = H.round2(p.amount - p.applied);
  }
  res.json(rows);
});

router.post('/payments', requireAdmin, (req, res) => {
  const b = req.body;
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(Number(b.reseller_id));
  if (!reseller) throw H.httpError(400, 'Choose a reseller for this payment.');
  const amount = H.round2(Number(b.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw H.httpError(400, 'Payment amount must be greater than zero.');
  const date = isDate(b.payment_date) ? b.payment_date : new Date().toISOString().slice(0, 10);
  db.exec('BEGIN');
  try {
    const payId = db.prepare('INSERT INTO payments (payment_date, reseller_id, amount, method, notes, created_by) VALUES (?,?,?,?,?,?)')
      .run(date, reseller.id, amount, str(b.method, 50), str(b.notes, 1000), req.user.id).lastInsertRowid;
    const applied = H.allocatePayment(payId, b.order_id ? Number(b.order_id) : null);
    H.audit(req.user, 'payment', 'reseller', reseller.id, `$${amount.toFixed(2)} from ${reseller.name} (applied $${applied.toFixed(2)})`);
    db.exec('COMMIT');
    res.json({ ok: true, payment_id: payId, applied, unapplied: H.round2(amount - applied) });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

router.delete('/payments/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.id));
  if (!p) throw H.httpError(404, 'Payment not found.');
  db.exec('BEGIN');
  try {
    const orders = db.prepare('SELECT DISTINCT order_id FROM payment_allocations WHERE payment_id = ?').all(p.id);
    db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
    for (const { order_id } of orders) H.recomputePaymentStatus(order_id);
    H.audit(req.user, 'delete', 'payment', p.id, `$${p.amount.toFixed(2)}`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

/* ============ dashboard (admin) ============ */
router.get('/dashboard', requireAdmin, (req, res) => {
  const completed = db.prepare(`
    SELECT IFNULL(SUM(oi.revenue),0) AS revenue, IFNULL(SUM(oi.cost),0) AS cost, IFNULL(SUM(oi.profit),0) AS profit
    FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'completed'`).get();
  const open = db.prepare(`
    SELECT IFNULL(SUM(oi.revenue),0) AS value FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'open'`).get();
  const counts = db.prepare(`
    SELECT SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open FROM orders`).get();
  const inv = db.prepare(`SELECT IFNULL(SUM(on_hand*cost),0) AS at_cost, IFNULL(SUM(on_hand*retail_price),0) AS at_retail FROM products WHERE active = 1`).get();
  const owed = db.prepare('SELECT id FROM resellers').all().reduce((s, r) => H.round2(s + H.resellerBalance(r.id)), 0);

  const monthly = db.prepare(`
    SELECT substr(o.order_date,1,7) AS month, IFNULL(SUM(oi.revenue),0) AS revenue, IFNULL(SUM(oi.profit),0) AS profit
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'completed' GROUP BY month ORDER BY month`).all();
  const topProducts = db.prepare(`
    SELECT oi.product_name AS name, SUM(oi.qty) AS qty, IFNULL(SUM(oi.revenue),0) AS revenue, IFNULL(SUM(oi.profit),0) AS profit
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status NOT IN ('cancelled','refunded')
    GROUP BY oi.product_name ORDER BY revenue DESC LIMIT 8`).all();
  const topResellers = db.prepare(`
    SELECT r.name, COUNT(DISTINCT o.id) AS orders, IFNULL(SUM(oi.revenue),0) AS revenue, IFNULL(SUM(oi.profit),0) AS profit
    FROM orders o JOIN resellers r ON r.id = o.reseller_id JOIN order_items oi ON oi.order_id = o.id
    WHERE o.status NOT IN ('cancelled','refunded')
    GROUP BY r.id ORDER BY revenue DESC LIMIT 8`).all();

  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all().map(productWithStock);
  const lowStock = products.filter(p => p.stock_status !== 'in_stock');
  const recentOrders = fetchOrders('', []).slice(0, 8);
  const openOrders = fetchOrders("WHERE o.status = 'open'", []);

  res.json({
    cards: {
      total_revenue: H.round2(completed.revenue), total_cost: H.round2(completed.cost), total_profit: H.round2(completed.profit),
      open_value: H.round2(open.value), amount_owed: owed,
      completed_orders: counts.completed || 0, open_orders: counts.open || 0,
      inventory_at_cost: H.round2(inv.at_cost), inventory_at_retail: H.round2(inv.at_retail),
      low_stock_count: lowStock.length
    },
    monthly, top_products: topProducts, top_resellers: topResellers,
    low_stock: lowStock, recent_orders: recentOrders, open_orders: openOrders
  });
});

/* ============ deliveries (admin) ============ */
router.get('/deliveries', requireAdmin, (req, res) => {
  res.json(fetchOrders("WHERE o.status NOT IN ('cancelled','refunded') OR d.status = 'cancelled'", []));
});

/* ============ audit log (admin) ============ */
router.get('/audit', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300').all());
});

/* ============ settings & admin users ============ */
router.get('/settings', requireAdmin, (req, res) => {
  res.json(H.getAllSettings());
});

router.put('/settings', requireAdmin, (req, res) => {
  const allowed = Object.keys(H.SETTING_DEFAULTS);
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    let v = String(req.body[key]);
    if (key === 'default_discount_pct') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw H.httpError(400, 'Default discount must be between 0 and 100.');
      v = String(n);
    }
    if (key === 'low_stock_default_threshold') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw H.httpError(400, 'Low stock threshold must be a whole number ≥ 0.');
      v = String(n);
    }
    H.setSetting(key, v);
  }
  H.audit(req.user, 'update', 'settings', null, Object.keys(req.body).join(', '));
  res.json(H.getAllSettings());
});

router.get('/users', requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT id, name, email, role, active, created_at FROM users WHERE role = 'admin' ORDER BY id").all());
});

router.post('/users', requireAdmin, (req, res) => {
  const name = str(req.body.name, 200), email = str(req.body.email, 200).toLowerCase(), password = String(req.body.password || '');
  if (!name || !email) throw H.httpError(400, 'Name and email are required.');
  if (password.length < 6) throw H.httpError(400, 'Password must be at least 6 characters.');
  if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) throw H.httpError(400, 'That email is already in use.');
  const id = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,'admin')").run(name, email, H.hashPassword(password)).lastInsertRowid;
  H.audit(req.user, 'create', 'user', id, `admin ${email}`);
  res.json({ ok: true });
});

router.patch('/users/:id', requireAdmin, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(Number(req.params.id));
  if (!u) throw H.httpError(404, 'User not found.');
  if (req.body.password !== undefined) {
    if (String(req.body.password).length < 6) throw H.httpError(400, 'Password must be at least 6 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(H.hashPassword(req.body.password), u.id);
    H.audit(req.user, 'password-reset', 'user', u.id, u.email);
  }
  if (req.body.active !== undefined) {
    if (u.id === req.user.id && !req.body.active) throw H.httpError(400, 'You cannot disable your own account.');
    const activeAdmins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1").get().c;
    if (!req.body.active && activeAdmins <= 1) throw H.httpError(400, 'At least one active admin is required.');
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, u.id);
    if (!req.body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    H.audit(req.user, req.body.active ? 'enable' : 'disable', 'user', u.id, u.email);
  }
  res.json({ ok: true });
});

/* ============ CSV exports (admin) ============ */
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv);
}

router.get('/export/orders.csv', requireAdmin, (req, res) => {
  const { where, params } = buildOrderFilters(req.query);
  const orders = fetchOrders(where, params);
  const rows = [];
  for (const o of orders) for (const it of o.items) rows.push({ o, it });
  sendCsv(res, 'orders.csv', H.toCsv(rows, [
    { label: 'Order #', value: r => r.o.id }, { label: 'Date', value: r => r.o.order_date },
    { label: 'Customer', value: r => r.o.customer_name }, { label: 'Reseller', value: r => r.o.reseller_name },
    { label: 'Product', value: r => r.it.product_name }, { label: 'Qty', value: r => r.it.qty },
    { label: 'Retail Price', value: r => r.it.retail_price.toFixed(2) }, { label: 'Discount %', value: r => r.it.discount_pct },
    { label: 'Final Price', value: r => r.it.final_price.toFixed(2) }, { label: 'Revenue', value: r => r.it.revenue.toFixed(2) },
    { label: 'Cost', value: r => r.it.cost.toFixed(2) }, { label: 'Profit', value: r => r.it.profit.toFixed(2) },
    { label: 'Order Status', value: r => r.o.status }, { label: 'Payment Status', value: r => r.o.payment_status },
    { label: 'Delivery Status', value: r => r.o.delivery_status }, { label: 'Notes', value: r => r.o.notes },
    { label: 'Created At', value: r => r.o.created_at }, { label: 'Updated At', value: r => r.o.updated_at }
  ]));
});

router.get('/export/inventory.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all().map(productWithStock);
  sendCsv(res, 'inventory.csv', H.toCsv(rows, [
    { label: 'Product', value: 'name' }, { label: 'Category', value: 'category' },
    { label: 'Cost/Unit', value: r => r.cost.toFixed(2) }, { label: 'Wholesale Price', value: r => r.wholesale_price.toFixed(2) },
    { label: 'Retail Price', value: r => r.retail_price.toFixed(2) }, { label: 'On Hand', value: 'on_hand' },
    { label: 'Reserved', value: 'reserved' }, { label: 'Available', value: 'available' },
    { label: 'Low Stock Threshold', value: 'low_stock_threshold' }, { label: 'Stock Status', value: r => r.stock_status.replace(/_/g, ' ') },
    { label: 'Supplier', value: 'supplier' }, { label: 'Notes', value: 'notes' }
  ]));
});

router.get('/export/reseller-balances.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM resellers ORDER BY name').all().map(resellerRow);
  sendCsv(res, 'reseller-balances.csv', H.toCsv(rows, [
    { label: 'Reseller', value: 'name' }, { label: 'Email', value: 'email' }, { label: 'Phone', value: 'phone' },
    { label: 'Discount %', value: 'discount_pct' }, { label: 'Total Orders', value: 'total_orders' },
    { label: 'Open Orders', value: 'open_orders' }, { label: 'Completed Orders', value: 'completed_orders' },
    { label: 'Total Revenue', value: r => r.total_revenue.toFixed(2) }, { label: 'Total Profit', value: r => r.total_profit.toFixed(2) },
    { label: 'Amount Paid', value: r => r.amount_paid.toFixed(2) }, { label: 'Amount Owed', value: r => r.amount_owed.toFixed(2) },
    { label: 'Status', value: 'status' }, { label: 'Notes', value: 'notes' }
  ]));
});

/* ============ reseller portal ============ */
function stripCosts(order, showProfit) {
  const { total_cost, total_profit, ...rest } = order;
  rest.items = order.items.map(it => {
    const { cost_per_unit, cost, profit, discount_pct, ...itemRest } = it;
    return showProfit ? { ...itemRest, profit } : itemRest;
  });
  if (showProfit) rest.total_profit = total_profit;
  return rest;
}

router.get('/my/summary', requireReseller, (req, res) => {
  const r = db.prepare('SELECT id, name, email, phone, status FROM resellers WHERE id = ?').get(req.user.reseller_id);
  const showProfit = H.settingBool('show_profit_to_resellers');
  const orders = fetchOrders('WHERE o.reseller_id = ?', [r.id]).map(o => stripCosts(o, showProfit));
  const totalSales = H.round2(orders.filter(o => !['cancelled', 'refunded'].includes(o.status)).reduce((s, o) => s + o.total_revenue, 0));
  res.json({
    reseller: r,
    unpaid_balance: H.resellerBalance(r.id),
    total_sales: totalSales,
    open_count: orders.filter(o => o.status === 'open').length,
    completed_count: orders.filter(o => o.status === 'completed').length,
    orders
  });
});

router.get('/my/products', requireReseller, (req, res) => {
  const r = db.prepare('SELECT discount_pct FROM resellers WHERE id = ?').get(req.user.reseller_id);
  const allowBackorders = H.settingBool('allow_backorders');
  const rows = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all().map(p => {
    const ps = productWithStock(p);
    const calc = H.computeLine(p.retail_price, 0, r.discount_pct, 1);
    return {
      id: p.id, name: p.name, category: p.category, retail_price: p.retail_price,
      your_price: calc.final_price,
      available: ps.available, stock_status: ps.stock_status, can_order: allowBackorders || ps.available > 0
    };
  });
  res.json({ products: rows, allow_backorders: allowBackorders, disclaimer: H.getSetting('product_disclaimer') });
});

router.post('/my/orders', requireReseller, (req, res) => {
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.user.reseller_id);
  if (!r || r.status !== 'active') throw H.httpError(403, 'Your reseller account is disabled.');
  const b = req.body;
  // Resellers always get their own discount — they cannot change pricing.
  const orderId = createOrder(req, {
    resellerId: r.id, customerName: str(b.customer_name, 200), orderDate: new Date().toISOString().slice(0, 10),
    status: 'open', notes: str(b.notes, 2000), address: str(b.address, 500), deliveryNotes: str(b.delivery_notes, 1000),
    items: b.items, forceDiscount: Number(r.discount_pct)
  });
  const showProfit = H.settingBool('show_profit_to_resellers');
  res.json(stripCosts(fetchOrders('WHERE o.id = ?', [orderId])[0], showProfit));
});

/* ============ errors ============ */
router.use((err, req, res, next) => {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

module.exports = router;
