'use strict';
const db = require('./db');
const { hashPassword, computeLine, setSetting, SETTING_DEFAULTS, recomputePaymentStatus, allocatePayment, round2 } = require('./helpers');

const PRODUCTS = [
  // [name, category, cost, wholesale, retail, on_hand]
  ['Hospira BAC Water (30 mL)', 'Supplies', 17.95, 21.45, 28.54, 5],
  ['Retatrutide (10 mg)', 'Peptide', 11.00, 37.40, 55.00, 20],
  ['GLOW (70 mg)', 'Blend', 17.00, 57.80, 85.00, 10],
  ['GHK-Cu (100 mg)', 'Peptide', 6.00, 20.40, 30.00, 10],
  ['MOTS-c (5 mg)', 'Peptide', 5.90, 20.06, 37.50, 10],
  ['Tirzepatide (10 mg)', 'Peptide', 7.50, 25.50, 34.50, 0],
  ['TB-500 (5 mg)', 'Peptide', 6.90, 23.46, 65.00, 0],
  ['BPC-157 (20 mg)', 'Peptide', 13.00, 44.20, 40.00, 0],
  ['Ipamorelin (10 mg)', 'Peptide', 8.00, 27.20, 49.50, 0],
  ['Tesamorelin (5 mg)', 'Peptide', 9.90, 33.66, 29.50, 0],
  ['DSIP (10 mg)', 'Peptide', 7.90, 26.86, 39.50, 0],
  ['Thymosin Alpha-1 (10 mg)', 'Peptide', 20.00, 68.00, 100.00, 0],
  ['Melanotan (1 mg)', 'Peptide', 4.90, 16.66, 24.50, 10],
  ['HCG (5000 IU)', 'Peptide', 8.00, 27.20, 40.00, 0],
  ['NAD+ Buffer (500 mg)', 'Peptide', 7.50, 25.50, 37.50, 0],
  ['CJC-1295 No DAC (10 mg)', 'Peptide', 14.90, 50.66, 74.50, 0],
  ['CJC-1295 + Ipamorelin', 'Blend', 10.00, 34.00, 50.00, 0],
  ['BPC-157 + TB-500 (10/10 mg)', 'Blend', 16.50, 56.10, 82.50, 0],
  ['Oxytocin (10 mg)', 'Peptide', 7.50, 25.50, 37.50, 0],
  ['Epitalon (10 mg)', 'Peptide', 6.50, 22.10, 32.50, 0],
  ['Epitalon (50 mg)', 'Peptide', 12.00, 40.80, 60.00, 0],
  ['KPV (10 mg)', 'Peptide', 6.50, 22.10, 32.50, 0],
  ['KPV (30 mg)', 'Peptide', 14.00, 47.60, 70.00, 0],
  ['Glutathione (600 mg)', 'Peptide', 8.00, 27.20, 40.00, 0],
  ['SS-31 (10 mg)', 'Peptide', 9.00, 30.60, 45.00, 0],
  ['Semax (5 mg)', 'Peptide', 5.50, 18.70, 27.50, 0],
  ['5-Amino-1MQ (50 mg)', 'Peptide', 12.50, 42.50, 62.50, 0],
  ['VIP (10 mg)', 'Peptide', 13.50, 45.90, 67.50, 0],
  ['Selank (5 mg)', 'Peptide', 5.50, 18.70, 27.50, 0],
  ['Standard BAC Water (10mL)', 'Supplies', 1.50, 5.10, 7.50, 0],
];

// Brief use-case descriptions, shown on price lists and the inventory page.
const DESCRIPTIONS = {
  'Hospira BAC Water (30 mL)': 'Sterile bacteriostatic water for reconstituting peptides.',
  'Retatrutide (10 mg)': 'Weight loss and metabolic support.',
  'GLOW (70 mg)': 'Skin, hair and recovery blend (GHK-Cu / BPC-157 / TB-500).',
  'GHK-Cu (100 mg)': 'Copper peptide for skin and hair health.',
  'MOTS-c (5 mg)': 'Energy, endurance and metabolic support.',
  'Tirzepatide (10 mg)': 'GLP-1/GIP peptide for weight management.',
  'TB-500 (5 mg)': 'Recovery and injury repair.',
  'BPC-157 (20 mg)': 'Gut health and injury recovery.',
  'Ipamorelin (10 mg)': 'Growth hormone support; recovery and sleep.',
  'Tesamorelin (5 mg)': 'GH peptide; often used for stubborn belly fat.',
  'DSIP (10 mg)': 'Deep-sleep support.',
  'Thymosin Alpha-1 (10 mg)': 'Immune system support.',
  'Melanotan (1 mg)': 'Tanning peptide.',
  'HCG (5000 IU)': 'Hormone support; common TRT add-on.',
  'NAD+ Buffer (500 mg)': 'Cellular energy and anti-aging.',
  'CJC-1295 No DAC (10 mg)': 'GH-releasing peptide; recovery and anti-aging.',
  'CJC-1295 + Ipamorelin': 'GH combo for recovery, sleep and body composition.',
  'BPC-157 + TB-500 (10/10 mg)': 'Combined recovery and repair stack.',
  'Oxytocin (10 mg)': 'Mood and social-bonding support.',
  'Epitalon (10 mg)': 'Longevity / anti-aging peptide.',
  'Epitalon (50 mg)': 'Longevity / anti-aging peptide (larger size).',
  'KPV (10 mg)': 'Anti-inflammatory; gut and skin support.',
  'KPV (30 mg)': 'Anti-inflammatory; gut and skin support (larger size).',
  'Glutathione (600 mg)': 'Antioxidant; detox and skin brightening.',
  'SS-31 (10 mg)': 'Mitochondrial support and energy.',
  'Semax (5 mg)': 'Focus and cognitive support.',
  '5-Amino-1MQ (50 mg)': 'Metabolism and fat-loss support.',
  'VIP (10 mg)': 'Immune and inflammation regulation.',
  'Selank (5 mg)': 'Calm focus; stress and anxiety support.',
  'Standard BAC Water (10mL)': 'Bacteriostatic water for reconstituting peptides.',
};

// Fills in descriptions for existing databases (runs on every start, only touches blank ones).
function backfillDescriptions() {
  const upd = db.prepare("UPDATE products SET description = ? WHERE name = ? AND (description IS NULL OR description = '')");
  for (const [name, desc] of Object.entries(DESCRIPTIONS)) upd.run(desc, name);
}

// Sample orders grouped: one order per (date, customer, reseller) with line items.
// item: [productName, qty, discountPct]
const ORDERS = [
  { date: '2026-05-12', customer: 'Josh', reseller: 'Jacob', status: 'completed',
    items: [['Retatrutide (10 mg)', 1, 22], ['GLOW (70 mg)', 2, 22], ['Hospira BAC Water (30 mL)', 1, 22]] },
  { date: '2026-05-12', customer: 'Angel', reseller: 'Jacob', status: 'completed',
    items: [['Retatrutide (10 mg)', 1, 22], ['GLOW (70 mg)', 2, 22], ['Hospira BAC Water (30 mL)', 1, 22]] },
  { date: '2026-05-12', customer: 'Omar', reseller: 'Jacob', status: 'completed',
    items: [['Retatrutide (10 mg)', 1, 22], ['Hospira BAC Water (30 mL)', 1, 22]] },
  { date: '2026-05-12', customer: 'Luke', reseller: 'Jacob', status: 'completed',
    items: [['Retatrutide (10 mg)', 1, 22], ['GLOW (70 mg)', 1, 100], ['Hospira BAC Water (30 mL)', 1, 100]] },
  { date: '2026-05-12', customer: 'Weston', reseller: 'Jacob', status: 'completed',
    items: [['Retatrutide (10 mg)', 2, 0], ['Standard BAC Water (10mL)', 2, 0]] },
  { date: '2026-05-12', customer: 'Angel Friend', reseller: 'Angel', status: 'completed',
    items: [['GLOW (70 mg)', 2, 22], ['Hospira BAC Water (30 mL)', 1, 22]] },
  { date: '2026-05-12', customer: 'Josh Dad', reseller: 'Jacob', status: 'completed',
    items: [['Retatrutide (10 mg)', 1, 22]] },
  { date: '2026-05-29', customer: 'Angel', reseller: 'Angel', status: 'completed',
    items: [['GLOW (70 mg)', 1, 22], ['Retatrutide (10 mg)', 2, 22], ['Hospira BAC Water (30 mL)', 1, 22]] },
  { date: '2026-05-28', customer: 'Justin', reseller: 'Jacob', status: 'open',
    items: [['GHK-Cu (100 mg)', 6, 0], ['Hospira BAC Water (30 mL)', 3, 0]] },
  { date: '2026-06-05', customer: 'Deen Khwaja', reseller: 'Jacob', status: 'open',
    items: [['Retatrutide (10 mg)', 1, 0], ['Standard BAC Water (10mL)', 1, 0]] },
  { date: '2026-06-10', customer: 'Angel', reseller: 'Angel', status: 'open',
    items: [['Retatrutide (10 mg)', 1, 22], ['GLOW (70 mg)', 3, 22], ['Hospira BAC Water (30 mL)', 2, 0]] },
];

function seedIfEmpty() {
  const hasUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
  if (hasUsers) return false;

  db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(SETTING_DEFAULTS)) setSetting(key, value);
    setSetting('business_name', 'Peptide Manager');

    // Resellers (Jacob = house/owner account, Angel = external reseller)
    const insReseller = db.prepare('INSERT INTO resellers (name, email, phone, discount_pct, notes) VALUES (?,?,?,?,?)');
    const jacobResellerId = insReseller.run('Jacob', 'jacobkennedypersonal@gmail.com', '', 22, 'Owner / house account — direct sales.').lastInsertRowid;
    const angelResellerId = insReseller.run('Angel', 'angel@example.com', '', 22, '').lastInsertRowid;

    // Users
    const insUser = db.prepare('INSERT INTO users (name, email, password_hash, role, reseller_id) VALUES (?,?,?,?,?)');
    const adminId = insUser.run('Jacob', 'admin@peptide.local', hashPassword('admin123'), 'admin', jacobResellerId).lastInsertRowid;
    insUser.run('Angel', 'angel@peptide.local', hashPassword('angel123'), 'reseller', angelResellerId);

    // Products
    const insProduct = db.prepare('INSERT INTO products (name, category, cost, wholesale_price, retail_price, on_hand, low_stock_threshold, description) VALUES (?,?,?,?,?,?,?,?)');
    const insMove = db.prepare("INSERT INTO inventory_movements (product_id, change, type, note) VALUES (?,?,?,?)");
    const productIds = {};
    for (const [name, category, cost, wholesale, retail, onHand] of PRODUCTS) {
      const id = insProduct.run(name, category, cost, wholesale, retail, onHand, 3, DESCRIPTIONS[name] || '').lastInsertRowid;
      productIds[name] = id;
      if (onHand > 0) insMove.run(id, onHand, 'initial', 'Starting inventory');
    }

    // Orders. NOTE: completed seed orders are flagged inventory_deducted=1 because the
    // starting on-hand figures above already reflect those past sales.
    const resellerIds = { Jacob: jacobResellerId, Angel: angelResellerId };
    const insOrder = db.prepare(`INSERT INTO orders (order_date, customer_name, reseller_id, status, inventory_deducted, created_by, created_at, updated_at)
                                 VALUES (?,?,?,?,?,?, ?||' 12:00:00', ?||' 12:00:00')`);
    const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, qty, retail_price, cost_per_unit, discount_pct, final_price, revenue, cost, profit)
                                VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const insDelivery = db.prepare('INSERT INTO deliveries (order_id, status, delivery_date) VALUES (?,?,?)');

    const jacobCompletedOrderIds = [];
    for (const o of ORDERS) {
      const completed = o.status === 'completed';
      const orderId = insOrder.run(o.date, o.customer, resellerIds[o.reseller], o.status, completed ? 1 : 0, adminId, o.date, o.date).lastInsertRowid;
      for (const [productName, qty, discount] of o.items) {
        const pid = productIds[productName];
        const p = db.prepare('SELECT cost, retail_price FROM products WHERE id = ?').get(pid);
        const calc = computeLine(p.retail_price, p.cost, discount, qty);
        insItem.run(orderId, pid, productName, qty, p.retail_price, p.cost, discount, calc.final_price, calc.revenue, calc.cost, calc.profit);
      }
      insDelivery.run(orderId, completed ? 'delivered' : 'pending', completed ? o.date : '');
      if (completed && o.reseller === 'Jacob') jacobCompletedOrderIds.push(orderId);
      recomputePaymentStatus(orderId);
    }

    // House (Jacob) completed sales were collected in cash — record one settling payment so
    // the owed balance reflects only Angel's unpaid orders and the open house orders.
    const houseTotal = round2(db.prepare(`SELECT IFNULL(SUM(revenue),0) AS t FROM order_items WHERE order_id IN (${jacobCompletedOrderIds.map(() => '?').join(',')})`)
      .get(...jacobCompletedOrderIds).t);
    if (houseTotal > 0) {
      const payId = db.prepare("INSERT INTO payments (payment_date, reseller_id, amount, method, notes, created_by) VALUES (?,?,?,?,?,?)")
        .run('2026-05-30', jacobResellerId, houseTotal, 'Cash', 'Seed: house sales collected directly', adminId).lastInsertRowid;
      allocatePayment(payId);
    }

    db.prepare('INSERT INTO audit_logs (user_name, action, entity, details) VALUES (?,?,?,?)')
      .run('system', 'seed', 'database', 'Database created with starter products, resellers and sample orders');
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { seedIfEmpty, backfillDescriptions };
