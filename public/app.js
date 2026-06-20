'use strict';
/* Peptide Manager — single page app (no build step) */

/* ================= state ================= */
const S = {
  user: null,
  settings: null,
  products: null,   // admin cache
  resellers: null,  // admin cache
};

/* ================= utils ================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function money(n, { sign = false } = {}) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const sym = (S.settings && S.settings.currency_symbol) || '$';
  const v = Number(n);
  const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '-' : (sign && v > 0 ? '+' : '')) + sym + abs;
}
function moneyCls(n) { return Number(n) < 0 ? 'neg' : 'pos'; }
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  if (!y) return esc(d);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(String(d).replace(' ', 'T') + 'Z');
  return isNaN(dt) ? esc(d) : dt.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const today = () => new Date().toISOString().slice(0, 10);
function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function itemsSummary(items) {
  return items.map(i => `${esc(i.product_name)} ×${i.qty}`).join(', ');
}

/* ================= api ================= */
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && S.user) { S.user = null; renderLogin(); throw new Error('Session expired. Please log in again.'); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

/* ================= toast / confirm / modal ================= */
function toast(msg, type = 'success') {
  const root = $('#toast-root');
  root.className = 'toast-root';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3200);
}

function openModal(html, { wide = false } = {}) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog">${html}</div>`;
  root.appendChild(backdrop);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }
  $$('.modal-x', backdrop).forEach(b => b.addEventListener('click', close));
  return { el: backdrop, close };
}

function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Delete', danger = true }) {
  return new Promise(resolve => {
    const m = openModal(`
      <div class="modal-head"><h2>${esc(title)}</h2><button class="modal-x">✕</button></div>
      <div class="modal-body"><p style="margin:0">${esc(message)}</p></div>
      <div class="modal-foot">
        <button class="btn" data-act="no">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="yes">${esc(confirmText)}</button>
      </div>`);
    $('[data-act="no"]', m.el).onclick = () => { m.close(); resolve(false); };
    $('[data-act="yes"]', m.el).onclick = () => { m.close(); resolve(true); };
  });
}

/* Submit guard: disables button + shows spinner while fn runs (blocks double submits) */
async function guard(btn, fn) {
  if (!btn || btn.disabled) return;
  const isBtn = btn.tagName === 'BUTTON';
  const old = btn.innerHTML;
  btn.disabled = true;
  if (isBtn) btn.innerHTML = '<span class="spinner sm"></span>';
  try { await fn(); }
  finally { btn.disabled = false; if (isBtn) btn.innerHTML = old; }
}
function showFormError(form, msg) {
  const box = $('.form-error', form);
  if (box) { box.textContent = msg; box.classList.add('show'); box.scrollIntoView({ block: 'nearest' }); }
  else toast(msg, 'error');
}

/* ================= badges ================= */
const BADGE = {
  order: { open: ['yellow', 'Open'], completed: ['green', 'Completed'], cancelled: ['gray', 'Cancelled'], refunded: ['red', 'Refunded'] },
  payment: { paid: ['green', 'Paid'], partial: ['blue', 'Partial'], unpaid: ['yellow', 'Unpaid'] },
  delivery: { pending: ['yellow', 'Pending'], packed: ['blue', 'Packed'], out_for_delivery: ['blue', 'Out for delivery'], delivered: ['green', 'Delivered'], cancelled: ['gray', 'Cancelled'] },
  stock: { in_stock: ['green', 'In stock'], low_stock: ['yellow', 'Low stock'], out_of_stock: ['red', 'Out of stock'] },
  reseller: { active: ['green', 'Active'], disabled: ['red', 'Disabled'] },
};
function badge(kind, value) {
  const [color, label] = (BADGE[kind] && BADGE[kind][value]) || ['gray', value || '—'];
  return `<span class="badge ${color}">${esc(label)}</span>`;
}

/* One simple status for orders: Unpaid → Paid → Delivered (or Cancelled) */
const SIMPLE_STATUS = {
  unpaid: ['yellow', '⚠️ Unpaid'],
  paid: ['green', '💲 Paid'],
  delivered: ['dgreen', '✔️ Delivered'],
  cancelled: ['red', '❌ Cancelled'],
};
function orderDisplayStatus(o) {
  if (o.status === 'cancelled' || o.status === 'refunded') return 'cancelled';
  if (o.delivery_status === 'delivered') return 'delivered';
  if (o.payment_status === 'paid') return 'paid';
  return 'unpaid';
}
function statusBadge(o) {
  const [color, label] = SIMPLE_STATUS[orderDisplayStatus(o)];
  return `<span class="badge nodot ${color}">${label}</span>`;
}

/* ================= theme ================= */
function applyTheme() {
  document.documentElement.dataset.theme = localStorage.getItem('pm-theme') || 'light';
}
function toggleTheme() {
  localStorage.setItem('pm-theme', (localStorage.getItem('pm-theme') || 'light') === 'light' ? 'dark' : 'light');
  applyTheme();
}

/* ================= sortable table helper ================= */
/* cfg: { columns:[{label, html(row), sort(row)|null, cls}], rows, empty, onRow(row) } */
function renderTable(container, cfg) {
  const state = { key: cfg.defaultSort ?? null, dir: cfg.defaultDir ?? 1 };
  function draw() {
    let rows = [...cfg.rows];
    if (state.key != null && cfg.columns[state.key] && cfg.columns[state.key].sort) {
      const get = cfg.columns[state.key].sort;
      rows.sort((a, b) => {
        const x = get(a), y = get(b);
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * state.dir;
      });
    }
    if (!rows.length) {
      container.innerHTML = `<div class="empty"><div class="big">${esc(cfg.emptyIcon || '📭')}</div>${esc(cfg.empty || 'Nothing here yet.')}</div>`;
      return;
    }
    container.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>${cfg.columns.map((c, i) =>
          `<th class="${c.cls || ''} ${c.sort ? 'sortable' : ''}" data-i="${i}">${esc(c.label)}${state.key === i ? (state.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r, ri) => `<tr data-ri="${ri}" class="${cfg.onRow ? 'clickable' : ''}">${cfg.columns.map(c => `<td class="${c.cls || ''}">${c.html(r)}</td>`).join('')}</tr>`).join('')}</tbody>
        ${cfg.footer ? `<tfoot><tr class="totals-row">${cfg.footer(rows).map((cell, i) => `<td class="${cfg.columns[i] && cfg.columns[i].cls || ''}">${cell}</td>`).join('')}</tr></tfoot>` : ''}
      </table></div>`;
    $$('th.sortable', container).forEach(th => th.addEventListener('click', () => {
      const i = Number(th.dataset.i);
      if (state.key === i) state.dir = -state.dir; else { state.key = i; state.dir = 1; }
      draw();
    }));
    if (cfg.onRow) $$('tbody tr', container).forEach(tr => tr.addEventListener('click', e => {
      if (e.target.closest('button, select, a, input')) return;
      cfg.onRow(rows[Number(tr.dataset.ri)]);
    }));
    if (cfg.afterDraw) cfg.afterDraw(container, rows);
  }
  draw();
  return { redraw: draw };
}

/* ================= shell & router ================= */
const ADMIN_NAV = [
  ['dashboard', '📊', 'Dashboard'], ['orders', '🧾', 'Orders'], ['inventory', '📦', 'Inventory'],
  ['resellers', '🤝', 'Resellers'],
  ['audit', '🕘', 'Activity log'], ['settings', '⚙️', 'Settings'],
];
const RESELLER_NAV = [
  ['home', '📊', 'Dashboard'], ['new-order', '➕', 'New order'], ['my-orders', '🧾', 'My orders'], ['price-list', '🏷️', 'Price list'],
];

function buildShell() {
  const nav = S.user.role === 'admin' ? ADMIN_NAV : RESELLER_NAV;
  const initials = S.user.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  $('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-icon">💧</div>
          <div><div class="brand-name">${esc(S.settings.business_name)}</div>
          <div class="brand-role">${S.user.role === 'admin' ? 'Admin' : 'Reseller'}</div></div>
        </div>
        <nav class="nav">${nav.map(([r, ico, label]) =>
          `<a href="#/${r}" data-route="${r}"><span class="ico">${ico}</span>${label}</a>`).join('')}</nav>
        <div class="sidebar-foot">
          <div class="user-chip"><div class="avatar">${esc(initials)}</div>
            <div><div class="nm">${esc(S.user.name)}</div><div class="em">${esc(S.user.email)}</div></div></div>
          <div class="foot-row">
            <button class="btn sm" id="theme-btn">🌗 Theme</button>
            <button class="btn sm" id="logout-btn">Log out</button>
          </div>
        </div>
      </aside>
      <div class="sidebar-scrim" id="scrim" style="display:none"></div>
      <main class="main">
        <div class="topbar">
          <button class="ham" id="ham">☰</button>
          <div class="t-name">${esc(S.settings.business_name)}</div>
        </div>
        <div id="page"></div>
      </main>
    </div>`;
  $('#theme-btn').onclick = toggleTheme;
  $('#logout-btn').onclick = async () => { await api('/logout', { method: 'POST' }); S.user = null; location.hash = ''; renderLogin(); };
  $('#ham').onclick = () => { $('#sidebar').classList.add('open'); $('#scrim').style.display = 'block'; };
  $('#scrim').onclick = closeSidebar;
  $$('.nav a').forEach(a => a.addEventListener('click', closeSidebar));
}
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').style.display = 'none'; }

const ROUTES = {
  admin: { dashboard: pageDashboard, orders: pageOrders, inventory: pageInventory, resellers: pageResellers, audit: pageAudit, settings: pageSettings },
  reseller: { 'home': pageResellerHome, 'new-order': pageResellerNewOrder, 'my-orders': pageResellerOrders, 'price-list': pageResellerPrices },
};
async function navigate() {
  if (!S.user) return renderLogin();
  const routes = ROUTES[S.user.role] || {};
  let route = (location.hash || '').replace(/^#\//, '').split('?')[0];
  if (!routes[route]) { route = S.user.role === 'admin' ? 'dashboard' : 'home'; location.hash = '#/' + route; return; }
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  const page = $('#page');
  page.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row" style="width:70%"></div>';
  try { await routes[route](page); }
  catch (e) { page.innerHTML = `<div class="empty"><div class="big">⚠️</div>${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', navigate);

/* ================= login ================= */
function enterApp(data) {
  S.user = data.user; S.settings = data.settings;
  document.title = S.settings.business_name;
  buildShell();
  location.hash = S.user.role === 'admin' ? '#/dashboard' : '#/home';
  navigate();
}

async function renderLogin(mode = 'login') {
  applyTheme();
  let cfg = { business_name: 'Peptide Manager', allow_self_registration: false, registration_code_required: false };
  try { cfg = await api('/public-config'); } catch { /* server unreachable — show plain login */ }
  if (mode === 'register' && !cfg.allow_self_registration) mode = 'login';
  document.title = (mode === 'register' ? 'Create account — ' : 'Sign in — ') + cfg.business_name;

  if (mode === 'register') {
    $('#app').innerHTML = `
      <div class="login-wrap"><div class="login-card">
        <div class="login-logo">💧</div>
        <h1>Create reseller account</h1>
        <div class="login-sub">${esc(cfg.business_name)}</div>
        <form id="reg-form" novalidate>
          <div class="form-error"></div>
          <div class="field"><label>Your name</label>
            <input name="name" autocomplete="name" placeholder="First and last name"></div>
          <div class="field"><label>Email</label>
            <input type="email" name="email" autocomplete="username" placeholder="you@example.com"></div>
          <div class="field"><label>Phone (optional)</label>
            <input name="phone" autocomplete="tel" inputmode="tel"></div>
          <div class="field"><label>Password</label>
            <input type="password" name="password" autocomplete="new-password" placeholder="At least 6 characters"></div>
          ${cfg.registration_code_required ? `<div class="field"><label>Invite code</label>
            <input name="code" placeholder="Provided by the admin"></div>` : ''}
          <button class="btn primary block" type="submit">Create account</button>
        </form>
        <div class="demo-creds">Already have an account? <a href="#" id="goto-login">Sign in</a></div>
      </div></div>`;
    $('#goto-login').onclick = e => { e.preventDefault(); renderLogin('login'); };
    $('#reg-form').addEventListener('submit', e => {
      e.preventDefault();
      const form = e.target;
      guard($('button[type=submit]', form), async () => {
        try {
          if (!form.name.value.trim()) throw new Error('Enter your name.');
          if (!form.email.value.trim()) throw new Error('Enter your email.');
          if (form.password.value.length < 6) throw new Error('Password must be at least 6 characters.');
          const data = await api('/register', {
            method: 'POST',
            body: {
              name: form.name.value.trim(), email: form.email.value.trim(), phone: form.phone.value.trim(),
              password: form.password.value, code: form.code ? form.code.value : '',
            },
          });
          toast('Welcome! Your account is ready.');
          enterApp(data);
        } catch (err) { showFormError(form, err.message); }
      });
    });
    return;
  }

  $('#app').innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <div class="login-logo">💧</div>
      <h1>Welcome back</h1>
      <div class="login-sub">${esc(cfg.business_name)}</div>
      <form id="login-form" novalidate>
        <div class="form-error"></div>
        <div class="field"><label>Email</label>
          <input type="email" name="email" autocomplete="username" placeholder="you@example.com" required></div>
        <div class="field"><label>Password</label>
          <input type="password" name="password" autocomplete="current-password" placeholder="••••••••" required></div>
        <button class="btn primary block" type="submit">Sign in</button>
      </form>
      ${cfg.allow_self_registration ? `<div class="demo-creds">New reseller? <a href="#" id="goto-register">Create an account</a></div>` : ''}
    </div></div>`;
  const regLink = $('#goto-register');
  if (regLink) regLink.onclick = e => { e.preventDefault(); renderLogin('register'); };
  $('#login-form').addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target;
    const email = form.email.value.trim(), password = form.password.value;
    if (!email || !password) return showFormError(form, 'Enter your email and password.');
    guard($('button[type=submit]', form), async () => {
      try {
        const data = await api('/login', { method: 'POST', body: { email, password } });
        enterApp(data);
      } catch (err) { showFormError(form, err.message); }
    });
  });
}

/* ================= shared loaders ================= */
async function loadProducts(force = false) {
  if (!S.products || force) S.products = await api('/products');
  return S.products;
}
async function loadResellers(force = false) {
  if (!S.resellers || force) S.resellers = await api('/resellers');
  return S.resellers;
}

/* ======================================================================
   ADMIN — DASHBOARD
====================================================================== */
async function pageDashboard(page) {
  const d = await api('/dashboard');
  const c = d.cards;
  const months = d.monthly;
  const maxMonthly = Math.max(1, ...months.map(m => Math.max(m.revenue, m.profit)));
  const maxProd = Math.max(1, ...d.top_products.map(p => p.revenue));

  page.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1>
      <div class="page-sub">Everything at a glance — ${fmtDate(today())}</div></div></div>
    <div class="cards">
      <div class="stat good"><div class="lbl">Total revenue</div><div class="val">${money(c.total_revenue)}</div><div class="sub">${c.completed_orders} completed order${c.completed_orders === 1 ? '' : 's'}</div></div>
      <div class="stat ${c.total_profit < 0 ? 'bad' : 'good'}"><div class="lbl">Total profit</div><div class="val">${money(c.total_profit)}</div><div class="sub">after ${money(c.total_cost)} cost</div></div>
      <div class="stat ${c.cash_profit < 0 ? 'bad' : 'good'}"><div class="lbl">Cash profit</div><div class="val">${money(c.cash_profit)}</div><div class="sub">revenue − ${money(c.expenses_total)} spent</div></div>
      <div class="stat ${c.amount_owed > 0 ? 'warn' : 'good'}"><div class="lbl">Owed to you</div><div class="val">${money(c.amount_owed)}</div><div class="sub">unpaid reseller balances</div></div>
      <div class="stat ${c.open_orders > 0 ? 'warn' : ''}"><div class="lbl">Open orders</div><div class="val">${c.open_orders}</div><div class="sub">worth ${money(c.open_value)}</div></div>
      <div class="stat"><div class="lbl">Inventory value</div><div class="val">${money(c.inventory_at_cost)}</div><div class="sub">${money(c.inventory_at_retail)} at retail</div></div>
      <div class="stat ${c.low_stock_count > 0 ? 'bad' : 'good'}"><div class="lbl">Low / out of stock</div><div class="val">${c.low_stock_count}</div><div class="sub">products need attention</div></div>
    </div>

    <div class="panel"><div class="panel-head"><h2>Who owes you${c.amount_owed > 0 ? ` — <span class="neg">${money(c.amount_owed)}</span> outstanding` : ''}</h2><a class="btn sm" href="#/resellers">Resellers</a></div>
      <div id="dash-owed"></div></div>

    <div class="grid-2">
      <div class="panel"><div class="panel-head"><h2>Revenue & profit by month</h2></div>
        <div class="panel-body">${months.length ? `
          <div class="chart-bars">${months.map(m => `
            <div class="chart-col">
              <div class="chart-duo">
                <div class="chart-bar rev" style="height:${Math.max(2, m.revenue / maxMonthly * 100)}%" title="Revenue ${money(m.revenue)}"></div>
                <div class="chart-bar prof" style="height:${Math.max(2, Math.max(0, m.profit) / maxMonthly * 100)}%" title="Profit ${money(m.profit)}"></div>
              </div>
              <div class="chart-lbl">${esc(m.month)}</div>
              <div class="chart-lbl" style="color:var(--text-soft)">${money(m.revenue)}</div>
            </div>`).join('')}</div>
          <div class="chart-legend">
            <span><span class="dot" style="background:var(--primary)"></span>Revenue</span>
            <span><span class="dot" style="background:var(--green)"></span>Profit</span></div>`
          : '<div class="empty">No completed orders yet.</div>'}</div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Top products by revenue</h2></div>
        <div class="panel-body">${d.top_products.length ? d.top_products.map(p => `
          <div class="hbar-row"><span class="nm" title="${esc(p.name)}">${esc(p.name)}</span>
            <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(2, p.revenue / maxProd * 100)}%"></div></div>
            <span class="vv">${money(p.revenue)}</span></div>`).join('')
          : '<div class="empty">No sales yet.</div>'}</div>
      </div>
    </div>

    <div class="panel"><div class="panel-head"><h2>Open orders</h2><a class="btn sm" href="#/orders">All orders</a></div>
      <div id="dash-open"></div></div>
    <div class="panel"><div class="panel-head"><h2>Low stock products</h2><a class="btn sm" href="#/inventory">View inventory</a></div>
      <div id="dash-lowstock"></div></div>
    <div class="panel"><div class="panel-head"><h2>Expenses (money out)</h2><button class="btn sm primary" id="add-exp">＋ Log expense</button></div>
      <div class="hint" style="padding:11px 16px;border-bottom:1px solid var(--border);background:var(--surface-2)">💡 Reminder: shipping you charge on orders counts as revenue &amp; profit. Log what you actually pay for postage/packaging here so your Cash profit stays accurate.</div>
      <div id="dash-exp"></div></div>`;

  renderTable($('#dash-lowstock'), {
    rows: d.low_stock.slice(0, 10),
    empty: 'All products are healthy on stock.', emptyIcon: '✅',
    columns: [
      { label: 'Product', html: r => `<span class="cell-main">${esc(r.name)}</span>` },
      { label: 'Available', cls: 'num', html: r => String(r.available), sort: r => r.available },
      { label: 'On hand', cls: 'num', html: r => String(r.on_hand) },
      { label: 'Status', html: r => badge('stock', r.stock_status) },
    ],
  });
  const miniOrderCols = [
    { label: 'Date', html: r => `<span class="nowrap">${fmtDate(r.order_date)}</span>`, sort: r => r.order_date },
    { label: 'Customer', html: r => `<span class="cell-main">${esc(r.customer_name)}</span><div class="cell-sub">${esc(r.reseller_name)}</div>` },
    { label: 'Items', html: r => `<span class="cell-sub">${itemsSummary(r.items)}</span>` },
    { label: 'Total', cls: 'num', html: r => `<b>${money(r.total_revenue)}</b>`, sort: r => r.total_revenue },
    { label: 'Status', html: r => statusBadge(r) },
  ];
  renderTable($('#dash-open'), { rows: d.open_orders, empty: 'No open orders. 🎉', columns: miniOrderCols, onRow: r => openOrderDetail(r.id) });

  try {
    const resz = await api('/resellers');
    const owing = (resz || []).filter(r => r.amount_owed > 0.009).sort((a, b) => b.amount_owed - a.amount_owed);
    renderTable($('#dash-owed'), {
      rows: owing, empty: 'Nobody owes you right now. 🎉', emptyIcon: '✅',
      columns: [
        { label: 'Reseller', html: r => `<span class="cell-main">${esc(r.name)}</span>${r.phone ? `<div class="cell-sub">${esc(r.phone)}</div>` : ''}`, sort: r => r.name },
        { label: 'Open orders', cls: 'num', html: r => String(r.open_orders || 0), sort: r => r.open_orders || 0 },
        { label: 'Owes', cls: 'num', html: r => `<b class="neg">${money(r.amount_owed)}</b>`, sort: r => r.amount_owed },
      ],
      defaultSort: 2, defaultDir: -1,
      onRow: () => { location.hash = '#/resellers'; },
    });
  } catch { renderTable($('#dash-owed'), { rows: [], empty: 'Could not load balances.' }); }

  renderTable($('#dash-exp'), {
    rows: d.expenses, empty: 'No expenses yet. Log one when you buy inventory or supplies.', emptyIcon: '💸',
    columns: [
      { label: 'Date', html: r => fmtDate(r.expense_date), sort: r => r.expense_date },
      { label: 'Amount', cls: 'num', html: r => `<b class="neg">−${money(r.amount)}</b>`, sort: r => r.amount },
      { label: 'Note', html: r => esc(r.note || '—') },
      { label: '', html: r => `<button class="btn sm danger" data-delexp="${r.id}">Delete</button>` },
    ],
    afterDraw(container) {
      $$('button[data-delexp]', container).forEach(b => b.addEventListener('click', async () => {
        const x = d.expenses.find(e => e.id === Number(b.dataset.delexp));
        const ok = await confirmDialog({ title: 'Delete expense?', message: `Remove the ${money(x.amount)} expense${x.note ? ` (${x.note})` : ''}? Cash profit will go back up by that amount.` });
        if (!ok) return;
        try { await api(`/expenses/${x.id}`, { method: 'DELETE' }); toast('Expense deleted'); pageDashboard(page); }
        catch (err) { toast(err.message, 'error'); }
      }));
    },
  });
  $('#add-exp').onclick = () => openExpenseForm(() => pageDashboard(page));
}

function openExpenseForm(onSaved) {
  const m = openModal(`
    <div class="modal-head"><h2>Log expense</h2><button class="modal-x">✕</button></div>
    <div class="modal-body"><form id="exp-form" novalidate>
      <div class="form-error"></div>
      <div class="form-row">
        <div class="field"><label>Amount <span class="req">*</span></label><input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00"></div>
        <div class="field"><label>Date</label><input name="expense_date" type="date" value="${today()}"></div>
      </div>
      <div class="field"><label>What was it for?</label><input name="note" placeholder="e.g. Inventory restock, shipping, supplies"></div>
      <div class="hint">Expenses lower your Cash profit card (revenue minus money spent). Product cost-per-unit is separate — that's already counted in Total profit when items sell.</div>
    </form></div>
    <div class="modal-foot">
      <button class="btn" id="exp-cancel">Cancel</button>
      <button class="btn primary" id="exp-save">Log expense</button>
    </div>`);
  const form = $('#exp-form', m.el);
  $('#exp-cancel', m.el).onclick = m.close;
  $('#exp-save', m.el).onclick = e => guard(e.target, async () => {
    try {
      const amount = Number(form.amount.value);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount greater than zero.');
      await api('/expenses', { method: 'POST', body: { amount, expense_date: form.expense_date.value, note: form.note.value } });
      m.close(); toast('Expense logged'); onSaved && onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

/* ======================================================================
   ADMIN — ORDERS
====================================================================== */
const orderFilters = { q: '', status: '', payment_status: '', delivery_status: '', reseller_id: '', product_id: '', date_from: '', date_to: '' };

function filterQuery() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(orderFilters)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

async function pageOrders(page) {
  // simple filters only: search, status tabs, payment dropdown
  orderFilters.delivery_status = ''; orderFilters.reseller_id = ''; orderFilters.product_id = '';
  orderFilters.date_from = ''; orderFilters.date_to = '';
  page.innerHTML = `
    <div class="page-head"><div><h1>Orders</h1><div class="page-sub">Search and manage every order</div></div>
      <div class="head-actions">
        <button class="btn" id="export-orders">⬇️ Export CSV</button>
        <button class="btn primary" id="new-order">＋ New order</button>
      </div></div>
    <div class="panel">
      <div class="toolbar">
        <input class="search" id="f-q" placeholder="Search customer, product, notes…" value="${esc(orderFilters.q)}">
        <div class="pill-tabs" id="f-status-tabs">
          ${['', 'unpaid', 'paid', 'delivered', 'cancelled', 'deleted'].map(s =>
            `<button data-s="${s}" class="${orderFilters.status === s ? 'active' : ''}">${s === '' ? 'All' : s === 'deleted' ? '🗑 Trash' : s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div id="orders-table"><div class="skeleton-row"></div></div>
    </div>`;

  const refresh = async () => {
    // Trash view: soft-deleted orders, each restorable
    if (orderFilters.status === 'deleted') {
      const trashed = await api('/orders?deleted=1');
      const host = $('#orders-table');
      host.innerHTML = '';
      renderTable(host, {
        rows: trashed, empty: 'Trash is empty. Deleted orders land here and can be restored.', emptyIcon: '🗑️',
        columns: [
          { label: '#', html: r => `<span class="muted">${r.id}</span>`, sort: r => r.id },
          { label: 'Date', html: r => `<span class="nowrap">${fmtDate(r.order_date)}</span>`, sort: r => r.order_date },
          { label: 'Customer', html: r => `<span class="cell-main">${esc(r.customer_name)}</span>`, sort: r => r.customer_name },
          { label: 'Reseller', html: r => esc(r.reseller_name), sort: r => r.reseller_name },
          { label: 'Products', html: r => `<span class="cell-sub">${itemsSummary(r.items)}</span>` },
          { label: 'Revenue', cls: 'num', html: r => `<b>${money(r.total_revenue)}</b>`, sort: r => r.total_revenue },
          { label: '', html: r => `<button class="btn sm" data-restore="${r.id}">↩︎ Restore</button>` },
        ],
        defaultSort: 1, defaultDir: -1,
        afterDraw(container) {
          $$('button[data-restore]', container).forEach(b => b.addEventListener('click', e => guard(e.target, async () => {
            try { await api(`/orders/${b.dataset.restore}/restore`, { method: 'POST' }); toast('Order restored'); refresh(); }
            catch (err) { toast(err.message, 'error'); }
          })));
        },
      });
      return;
    }
    let rows = await api('/orders' + (orderFilters.q ? '?q=' + encodeURIComponent(orderFilters.q) : ''));
    if (orderFilters.status) rows = rows.filter(r => orderDisplayStatus(r) === orderFilters.status);
    const columns = [
      { label: '#', html: r => `<span class="muted">${r.id}</span>`, sort: r => r.id },
      { label: 'Date', html: r => `<span class="nowrap">${fmtDate(r.order_date)}</span>`, sort: r => r.order_date },
      { label: 'Customer', html: r => `<span class="cell-main">${esc(r.customer_name)}</span>`, sort: r => r.customer_name },
      { label: 'Reseller', html: r => esc(r.reseller_name), sort: r => r.reseller_name },
      { label: 'Products', html: r => `<span class="cell-sub">${itemsSummary(r.items)}</span>` },
      { label: 'Revenue', cls: 'num', html: r => `<b>${money(r.total_revenue)}</b>`, sort: r => r.total_revenue },
      { label: 'Cost', cls: 'num', html: r => money(r.total_cost), sort: r => r.total_cost },
      { label: 'Profit', cls: 'num', html: r => `<span class="${moneyCls(r.total_profit)}">${money(r.total_profit)}</span>`, sort: r => r.total_profit },
      { label: 'Status', html: r => statusBadge(r), sort: r => orderDisplayStatus(r) },
    ];
    const ordersFooter = (rows) => {
      const rev = round2(rows.reduce((s, r) => s + (r.total_revenue || 0), 0));
      const cost = round2(rows.reduce((s, r) => s + (r.total_cost || 0), 0));
      const prof = round2(rows.reduce((s, r) => s + (r.total_profit || 0), 0));
      return ['<b>Totals</b>', '', '', '', `<span class="muted">${rows.length} order${rows.length === 1 ? '' : 's'}</span>`,
        `<b>${money(rev)}</b>`, `<b>${money(cost)}</b>`, `<b class="${moneyCls(prof)}">${money(prof)}</b>`, ''];
    };
    const tableCfg = (rows, empty) => ({
      rows, empty, columns,
      onRow: r => openOrderDetail(r.id, refresh),
      defaultSort: 1, defaultDir: -1,
      footer: ordersFooter,
    });

    const host = $('#orders-table');
    // When a specific status tab is selected, show a single flat table.
    if (orderFilters.status) {
      host.innerHTML = '';
      renderTable(host, tableCfg(rows, 'No orders match these filters.'));
      return;
    }
    // Default view: split into outstanding (not yet delivered) and delivered.
    const delivered = rows.filter(r => orderDisplayStatus(r) === 'delivered');
    const active = rows.filter(r => orderDisplayStatus(r) !== 'delivered');
    host.innerHTML = `
      <div class="order-group">
        <div class="order-group-head"><span class="ogh-icon">🟡</span> To do · not yet delivered <span class="ogh-count">${active.length}</span></div>
        <div id="orders-active"></div>
      </div>
      <div class="order-group">
        <div class="order-group-head done"><span class="ogh-icon">✅</span> Delivered <span class="ogh-count">${delivered.length}</span></div>
        <div id="orders-delivered"></div>
      </div>`;
    renderTable($('#orders-active'), tableCfg(active, 'Nothing outstanding — all caught up!'));
    renderTable($('#orders-delivered'), tableCfg(delivered, 'No delivered orders yet.'));
  };

  const onFilter = debounce(refresh, 250);
  $('#f-q').addEventListener('input', e => { orderFilters.q = e.target.value; onFilter(); });
  $$('#f-status-tabs button').forEach(b => b.addEventListener('click', () => {
    $$('#f-status-tabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); orderFilters.status = b.dataset.s; refresh();
  }));
  $('#export-orders').onclick = () => { window.location.href = '/api/export/orders.csv' + (orderFilters.q ? '?q=' + encodeURIComponent(orderFilters.q) : ''); };
  $('#new-order').onclick = () => openOrderForm(null, refresh);
  await refresh();
}

/* ---------- order line editor (shared admin form) ---------- */
function lineEditorHTML(showProfit) {
  return `
    <div class="line-items" id="lines">
      <div class="line-row header"><span>Product</span><span>Qty</span><span>Disc %</span><span style="text-align:right">Final price</span><span style="text-align:right">Line total</span><span></span></div>
    </div>
    <button type="button" class="btn sm" id="add-line">＋ Add product</button>
    <div class="totals-box" id="totals"></div>`;
}

function setupLineEditor(form, products, getDiscount, { showProfit = true, showAvailability = true, getShipping = null } = {}) {
  const linesEl = $('#lines', form);
  const totalsEl = $('#totals', form);
  const productOpts = products.map(p =>
    `<option value="${p.id}">${esc(p.name)}${showAvailability ? ` — ${p.available} avail` : ''}</option>`).join('');

  function addLine(item) {
    const row = document.createElement('div');
    row.className = 'line-row';
    row.innerHTML = `
      <select class="li-product"><option value="">Select product…</option>${productOpts}</select>
      <input class="li-qty" type="number" min="1" step="1" placeholder="1" inputmode="numeric">
      <input class="li-disc" type="number" min="0" max="100" step="0.1" inputmode="decimal">
      <div class="line-calc li-final muted">—</div>
      <div class="line-calc li-total muted">—</div>
      <button type="button" class="line-del" title="Remove line">✕</button>`;
    linesEl.appendChild(row);
    const sel = $('.li-product', row), qty = $('.li-qty', row), disc = $('.li-disc', row);
    // Lock the discount field to 0 for products flagged "no reseller discount".
    const applyDiscLock = () => {
      const p = products.find(x => x.id === Number(sel.value));
      if (p && p.no_reseller_discount) {
        disc.value = 0; disc.disabled = true; disc.title = 'Always sold at full retail — no reseller discount';
      } else {
        disc.disabled = false; disc.title = '';
      }
    };
    if (item) { sel.value = item.product_id; qty.value = item.qty; disc.value = item.discount_pct; applyDiscLock(); }
    sel.addEventListener('change', () => {
      const p = products.find(x => x.id === Number(sel.value));
      if (sel.value && disc.value === '' && !(p && p.no_reseller_discount)) disc.value = getDiscount();
      applyDiscLock();
      if (sel.value && qty.value === '') qty.value = 1;
      recalc();
    });
    qty.addEventListener('input', recalc);
    disc.addEventListener('input', recalc);
    $('.line-del', row).addEventListener('click', () => { row.remove(); recalc(); });
    recalc();
  }

  function lineData(row) {
    const pid = Number($('.li-product', row).value) || null;
    const qty = Number($('.li-qty', row).value);
    const discRaw = $('.li-disc', row).value;
    const disc = discRaw === '' ? null : Number(discRaw);
    const p = products.find(x => x.id === pid);
    return { pid, qty, disc, p };
  }

  function recalc() {
    let rev = 0, cost = 0, valid = true;
    $$('.line-row:not(.header)', linesEl).forEach(row => {
      const { qty, disc: rawDisc, p } = lineData(row);
      const disc = (p && p.no_reseller_discount) ? 0 : rawDisc; // flagged products never get a discount
      const finalEl = $('.li-final', row), totalEl = $('.li-total', row);
      if (!p || !Number.isInteger(qty) || qty <= 0 || disc == null || disc < 0 || disc > 100) {
        finalEl.textContent = '—'; totalEl.textContent = '—'; valid = false; return;
      }
      const fp = round2(p.retail_price * (1 - disc / 100));
      const lineRev = round2(fp * qty);
      finalEl.textContent = money(fp);
      totalEl.textContent = money(lineRev);
      finalEl.classList.remove('muted'); totalEl.classList.remove('muted');
      rev = round2(rev + lineRev);
      if (p.cost != null) cost = round2(cost + round2(p.cost * qty));
    });
    const shipping = getShipping ? (round2(Number(getShipping()) || 0)) : 0;
    const grand = round2(rev + shipping);
    totalsEl.innerHTML = `
      <span>Products: <b>${money(rev)}</b></span>
      ${shipping > 0 ? `<span>Shipping: <b>${money(shipping)}</b></span>` : ''}
      ${showProfit ? `<span>Cost: <b>${money(cost)}</b></span>
      <span>Profit: <b class="${moneyCls(grand - cost)}">${money(round2(grand - cost))}</b></span>` : ''}
      <span>${showProfit ? 'Total' : 'Amount owed'}: <b>${money(grand)}</b></span>`;
    return { rev, cost, valid };
  }

  $('#add-line', form).addEventListener('click', () => addLine());

  return {
    addLine, recalc,
    collect() {
      const rows = $$('.line-row:not(.header)', linesEl);
      if (!rows.length) throw new Error('Add at least one product to the order.');
      return rows.map(row => {
        const { pid, qty, disc: rawDisc, p } = lineData(row);
        if (!pid || !p) throw new Error('Every line needs a product selected.');
        if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Quantity for "${p.name}" must be a whole number above zero.`);
        const disc = (p && p.no_reseller_discount) ? 0 : rawDisc; // flagged products always sold at full retail
        if (disc == null || !Number.isFinite(disc) || disc < 0 || disc > 100) throw new Error(`Discount for "${p.name}" must be between 0 and 100.`);
        return { product_id: pid, qty, discount_pct: disc };
      });
    },
  };
}

/* ---------- admin order form (create / edit) ---------- */
async function openOrderForm(order, onSaved) {
  const [products, resellers] = await Promise.all([loadProducts(true), loadResellers()]);
  const isEdit = !!order;
  const m = openModal(`
    <div class="modal-head"><h2>${isEdit ? `Edit order #${order.id}` : 'New order'}</h2><button class="modal-x">✕</button></div>
    <div class="modal-body"><form id="order-form" novalidate>
      <div class="form-error"></div>
      <div class="form-row-3">
        <div class="field"><label>Date <span class="req">*</span></label><input type="date" name="order_date" value="${esc(isEdit ? order.order_date : today())}"></div>
        <div class="field"><label>Customer <span class="req">*</span></label><input name="customer_name" placeholder="Customer name" value="${esc(isEdit ? order.customer_name : '')}"></div>
        <div class="field"><label>Reseller <span class="req">*</span></label>
          <select name="reseller_id"><option value="">Choose…</option>${resellers.map(r =>
            `<option value="${r.id}" data-disc="${r.discount_pct}" ${isEdit && order.reseller_id === r.id ? 'selected' : ''}>${esc(r.name)} (${r.discount_pct}%)</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Products <span class="req">*</span></label>${lineEditorHTML(true)}</div>
      ${!isEdit ? `<div class="field"><label>Order status</label>
        <select name="status"><option value="open">Open</option><option value="completed">Completed (deducts stock now)</option></select></div>` : ''}
      <div class="form-row">
        <div class="field"><label style="display:flex;align-items:center;gap:9px;cursor:pointer">
            <input type="checkbox" name="add_shipping" ${isEdit && order.shipping_amount > 0 ? 'checked' : ''} style="width:auto;margin:0">
            <span>Add shipping</span></label>
          <div class="hint">Adds a flat shipping charge to the order total.</div></div>
        <div class="field"><label>Shipping price</label>
          <input name="shipping_amount" type="number" min="0" step="0.01" inputmode="decimal" value="${isEdit && order.shipping_amount ? order.shipping_amount : (S.settings.default_shipping_price ?? 15)}" ${(isEdit && order.shipping_amount > 0) ? '' : 'disabled'}></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Delivery address</label><input name="address" placeholder="Optional" value="${esc(isEdit ? (order.address || '') : '')}"></div>
        <div class="field"><label>Delivery notes</label><input name="delivery_notes" placeholder="Optional" value="${esc(isEdit ? (order.delivery_notes || '') : '')}"></div>
      </div>
      <div class="field"><label>Order notes</label><textarea name="notes" placeholder="Optional">${esc(isEdit ? (order.notes || '') : '')}</textarea></div>
    </form></div>
    <div class="modal-foot">
      <button class="btn" id="cancel-btn">Cancel</button>
      <button class="btn primary" id="save-btn">${isEdit ? 'Save changes' : 'Create order'}</button>
    </div>`, { wide: true });

  const form = $('#order-form', m.el);
  const shippingValue = () => form.add_shipping.checked ? (Number(form.shipping_amount.value) || 0) : 0;
  const editor = setupLineEditor(form, products, () => {
    const opt = form.reseller_id.selectedOptions[0];
    return opt && opt.dataset.disc != null ? opt.dataset.disc : (S.settings.default_discount_pct ?? 0);
  }, { getShipping: shippingValue });
  if (isEdit) order.items.forEach(it => editor.addLine(it));
  else editor.addLine();

  form.add_shipping.addEventListener('change', () => {
    form.shipping_amount.disabled = !form.add_shipping.checked;
    if (form.add_shipping.checked && form.shipping_amount.value === '') form.shipping_amount.value = S.settings.default_shipping_price ?? 15;
    editor.recalc();
  });
  form.shipping_amount.addEventListener('input', editor.recalc);

  form.reseller_id.addEventListener('change', () => {
    // fill blank discounts with the new reseller default
    const d = form.reseller_id.selectedOptions[0]?.dataset.disc;
    if (d == null) return;
    $$('.li-disc', form).forEach(inp => { if (inp.value === '' && inp.closest('.line-row').querySelector('.li-product').value) inp.value = d; });
    editor.recalc();
  });

  $('#cancel-btn', m.el).onclick = m.close;
  $('#save-btn', m.el).onclick = (e) => guard(e.target, async () => {
    try {
      if (!form.order_date.value) throw new Error('Pick an order date.');
      if (!form.customer_name.value.trim()) throw new Error('Customer name is required.');
      if (!form.reseller_id.value) throw new Error('Choose a reseller — every order belongs to one.');
      const items = editor.collect();
      const body = {
        order_date: form.order_date.value, customer_name: form.customer_name.value.trim(),
        reseller_id: Number(form.reseller_id.value), notes: form.notes.value,
        address: form.address.value, delivery_notes: form.delivery_notes.value, items,
        shipping_amount: shippingValue(),
      };
      if (!isEdit) body.status = form.status.value;
      if (isEdit) await api(`/orders/${order.id}`, { method: 'PUT', body });
      else await api('/orders', { method: 'POST', body });
      await loadProducts(true);
      m.close();
      toast(isEdit ? 'Order updated' : 'Order created');
      onSaved && onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

/* ---------- order detail modal ---------- */
async function openOrderDetail(orderId, onChanged) {
  const orders = await api('/orders?' + new URLSearchParams({ q: '' }));
  const o = orders.find(x => x.id === orderId);
  if (!o) return toast('Order not found', 'error');

  const m = openModal(`
    <div class="modal-head"><h2>Order #${o.id} — ${esc(o.customer_name)}</h2><button class="modal-x">✕</button></div>
    <div class="modal-body">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        ${statusBadge(o)}
      </div>
      <div class="table-wrap" style="margin-bottom:12px"><table>
        <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Retail</th><th class="num">Disc %</th><th class="num">Final</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Profit</th></tr></thead>
        <tbody>${o.items.map(it => `<tr>
          <td class="cell-main">${esc(it.product_name)}</td><td class="num">${it.qty}</td>
          <td class="num">${money(it.retail_price)}</td><td class="num">${it.discount_pct}%</td>
          <td class="num">${money(it.final_price)}</td><td class="num"><b>${money(it.revenue)}</b></td>
          <td class="num">${money(it.cost)}</td><td class="num"><span class="${moneyCls(it.profit)}">${money(it.profit)}</span></td></tr>`).join('')}
        </tbody></table></div>
      <div class="totals-box" style="margin-bottom:14px">
        <span>Revenue: <b>${money(o.total_revenue)}</b></span>${o.shipping_amount > 0 ? `<span>(incl. shipping <b>${money(o.shipping_amount)}</b>)</span>` : ''}<span>Cost: <b>${money(o.total_cost)}</b></span>
        <span>Profit: <b class="${moneyCls(o.total_profit)}">${money(o.total_profit)}</b></span>
        <span>Paid: <b>${money(o.paid_amount)}</b></span><span>Due: <b class="${o.balance_due > 0 ? 'neg' : 'pos'}">${money(o.balance_due)}</b></span>
      </div>
      <div class="field"><label>Status</label>
        <select id="od-set">${['unpaid', 'paid', 'delivered', 'cancelled'].map(s =>
          `<option value="${s}" ${orderDisplayStatus(o) === s ? 'selected' : ''}>${SIMPLE_STATUS[s][1]}</option>`).join('')}</select>
        <div class="hint">Paid records a payment for the balance · Delivered deducts stock · Cancelled puts stock back.</div></div>
      <dl class="kv">
        <dt>Reseller</dt><dd>${esc(o.reseller_name)}</dd>
        <dt>Order date</dt><dd>${fmtDate(o.order_date)}</dd>
        <dt>Delivery date</dt><dd>${o.delivery_date ? fmtDate(o.delivery_date) : '—'}</dd>
        <dt>Address</dt><dd>${esc(o.address) || '—'}</dd>
        <dt>Delivery notes</dt><dd>${esc(o.delivery_notes) || '—'}</dd>
        <dt>Admin notes</dt><dd>${esc(o.admin_notes) || '—'}</dd>
        <dt>Order notes</dt><dd>${esc(o.notes) || '—'}</dd>
        <dt>Created</dt><dd>${fmtDateTime(o.created_at)}</dd>
        <dt>Updated</dt><dd>${fmtDateTime(o.updated_at)}</dd>
      </dl>
    </div>
    <div class="modal-foot">
      <div class="left">
        <button class="btn danger sm" id="od-delete">🗑 Move to Trash</button>
        <button class="btn sm" id="od-edit">✏️ Edit</button>
      </div>
      <button class="btn" id="od-close">Close</button>
    </div>`, { wide: true });

  const changed = async () => { await loadProducts(true); m.close(); onChanged && onChanged(); };
  $('#od-close', m.el).onclick = m.close;
  $('#od-set', m.el).addEventListener('change', e => guard(e.target, async () => {
    try { await api(`/orders/${o.id}/set-status`, { method: 'PATCH', body: { value: e.target.value } }); toast('Order updated'); await changed(); }
    catch (err) { toast(err.message, 'error'); e.target.value = orderDisplayStatus(o); }
  }));
  $('#od-edit', m.el).onclick = () => { m.close(); openOrderForm(o, onChanged); };
  $('#od-delete', m.el).onclick = async e => {
    const ok = await confirmDialog({
      title: `Move order #${o.id} to Trash?`,
      message: `This hides the order for ${o.customer_name} (${money(o.total_revenue)}) and removes it from your totals. Stock is restored if it was deducted. You can get it back anytime from Orders → 🗑 Trash → Restore.`,
      confirmText: 'Move to Trash',
    });
    if (!ok) return;
    guard(e.target, async () => {
      try { await api(`/orders/${o.id}`, { method: 'DELETE' }); toast('Order moved to Trash'); await changed(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };
}

/* ======================================================================
   ADMIN — INVENTORY
====================================================================== */
async function pageInventory(page) {
  let products = await api('/products?include_archived=1');
  page.innerHTML = `
    <div class="page-head"><div><h1>Inventory</h1><div class="page-sub">Products, pricing and stock levels</div></div>
      <div class="head-actions">
        <button class="btn" id="export-inv">⬇️ Export CSV</button>
        <button class="btn primary" id="add-product">＋ Add product</button>
      </div></div>
    <div class="panel">
      <div class="toolbar">
        <input class="search" id="i-q" placeholder="Search products…">
        <select id="i-stock"><option value="">Stock: all</option><option value="available">Available</option><option value="out_of_stock">Out of stock</option></select>
        <select id="i-status"><option value="active">Active</option><option value="archived">Archived</option><option value="all">All (incl. archived)</option></select>
      </div>
      <div id="inv-table"></div>
    </div>`;

  const filters = { q: '', stock: '', status: 'active' };
  function draw() {
    const rows = products.filter(p =>
      (filters.status === 'all' || (filters.status === 'archived' ? !p.active : !!p.active)) &&
      (!filters.q || p.name.toLowerCase().includes(filters.q) || (p.description || '').toLowerCase().includes(filters.q)) &&
      (!filters.stock
        || (filters.stock === 'available' && p.available > 0)
        || (filters.stock === 'out_of_stock' && p.available <= 0)));
    renderTable($('#inv-table'), {
      rows, empty: 'No products match.', defaultSort: 6, defaultDir: -1,
      columns: [
        { label: 'Product', html: r => `<span class="cell-main">${esc(r.name)}</span>${(r.description || r.notes) ? `<div class="cell-sub">${esc(r.description || r.notes)}</div>` : ''}`, sort: r => r.name },
        { label: 'Cost', cls: 'num', html: r => money(r.cost), sort: r => r.cost },
        { label: 'Retail', cls: 'num', html: r => `<b>${money(r.retail_price)}</b>`, sort: r => r.retail_price },
        { label: 'Reseller price', cls: 'num', html: r => r.no_reseller_discount ? `${money(r.retail_price)} <span class="badge gray nodot" title="No reseller discount">retail</span>` : money(round2(r.retail_price * (1 - (Number(S.settings.default_discount_pct) || 0) / 100))), sort: r => r.retail_price },
        { label: 'On hand', cls: 'num', html: r => String(r.on_hand), sort: r => r.on_hand },
        { label: 'Reserved', cls: 'num', html: r => r.reserved ? `<span class="badge yellow">${r.reserved}</span>` : '<span class="muted">0</span>', sort: r => r.reserved },
        { label: 'Available', cls: 'num', html: r => `<b>${r.available}</b>`, sort: r => r.available },
        { label: 'Status', html: r => r.active ? badge('stock', r.stock_status) : '<span class="badge gray nodot">Archived</span>', sort: r => (r.active ? '1' : '0') + r.stock_status },
        {
          label: '', cls: 'nowrap', html: r => r.active ? `
          <button class="btn sm" data-act="adjust" data-id="${r.id}">± Stock</button>
          <button class="btn sm" data-act="edit" data-id="${r.id}">Edit</button>
          <button class="btn sm" data-act="archive" data-id="${r.id}">Archive</button>
          <button class="btn sm danger" data-act="del" data-id="${r.id}">Delete</button>` : `
          <button class="btn sm primary" data-act="unarchive" data-id="${r.id}">↩︎ Unarchive</button>
          <button class="btn sm danger" data-act="del" data-id="${r.id}">Delete</button>` },
      ],
      afterDraw(container) {
        $$('button[data-act]', container).forEach(b => b.addEventListener('click', async () => {
          const p = products.find(x => x.id === Number(b.dataset.id));
          if (b.dataset.act === 'edit') openProductForm(p, reload);
          if (b.dataset.act === 'adjust') openAdjustStock(p, reload);
          if (b.dataset.act === 'del') deleteProduct(p, reload);
          if (b.dataset.act === 'archive') guard(b, async () => {
            try { await api(`/products/${p.id}/archive`, { method: 'POST' }); await loadProducts(true); toast('Product archived — hidden from dropdowns'); reload(); }
            catch (err) { toast(err.message, 'error'); }
          });
          if (b.dataset.act === 'unarchive') guard(b, async () => {
            try { await api(`/products/${p.id}/unarchive`, { method: 'POST' }); await loadProducts(true); toast('Product unarchived'); reload(); }
            catch (err) { toast(err.message, 'error'); }
          });
        }));
      },
    });
  }
  async function reload() { products = await api('/products?include_archived=1'); draw(); }
  $('#i-q').addEventListener('input', debounce(e => { filters.q = e.target.value.toLowerCase(); draw(); }, 200));
  $('#i-stock').addEventListener('change', e => { filters.stock = e.target.value; draw(); });
  $('#i-status').addEventListener('change', e => { filters.status = e.target.value; draw(); });
  $('#export-inv').onclick = () => { window.location.href = '/api/export/inventory.csv'; };
  $('#add-product').onclick = () => openProductForm(null, reload);
  draw();
}

function openProductForm(p, onSaved) {
  const isEdit = !!p;
  const m = openModal(`
    <div class="modal-head"><h2>${isEdit ? 'Edit product' : 'Add product'}</h2><button class="modal-x">✕</button></div>
    <div class="modal-body"><form id="p-form" novalidate>
      <div class="form-error"></div>
      <div class="field"><label>Name <span class="req">*</span></label><input name="name" value="${esc(p?.name || '')}" placeholder="e.g. BPC-157 (10 mg)"></div>
      <div class="field"><label>Short description</label><input name="description" value="${esc(p?.description || '')}" placeholder="e.g. Recovery and injury repair">
        <div class="hint">Shown to resellers on their price list.</div></div>
      <div class="form-row">
        <div class="field"><label>Cost / unit <span class="req">*</span></label><input name="cost" type="number" min="0" step="0.01" inputmode="decimal" value="${p ? p.cost : ''}" placeholder="0.00"></div>
        <div class="field"><label>Retail price <span class="req">*</span></label><input name="retail_price" type="number" min="0" step="0.01" inputmode="decimal" value="${p ? p.retail_price : ''}" placeholder="0.00"></div>
      </div>
      <div class="field"><label>On hand</label><input name="on_hand" type="number" step="1" inputmode="numeric" value="${p ? p.on_hand : 0}">
        ${isEdit ? '<div class="hint">Changing this logs a manual stock adjustment.</div>' : ''}</div>
      <div class="field"><label style="display:flex;align-items:center;gap:9px;cursor:pointer">
          <input type="checkbox" name="no_reseller_discount" ${p && p.no_reseller_discount ? 'checked' : ''} style="width:auto;margin:0">
          <span>No reseller discount — always sold at full retail</span></label>
        <div class="hint">For low-margin items (e.g. BAC water) so resellers don't get their discount on it.</div></div>
      <div class="field"><label>Notes</label><textarea name="notes">${esc(p?.notes || '')}</textarea></div>
    </form></div>
    <div class="modal-foot">
      <button class="btn" id="p-cancel">Cancel</button>
      <button class="btn primary" id="p-save">${isEdit ? 'Save changes' : 'Add product'}</button>
    </div>`);
  const form = $('#p-form', m.el);
  $('#p-cancel', m.el).onclick = m.close;
  $('#p-save', m.el).onclick = e => guard(e.target, async () => {
    try {
      const f = form;
      if (!f.name.value.trim()) throw new Error('Product name is required.');
      for (const k of ['cost', 'retail_price']) {
        if (f[k].value === '' || Number(f[k].value) < 0) throw new Error('Cost and retail price are both required (0 or more). Blank prices break order math.');
      }
      const body = {
        name: f.name.value.trim(),
        cost: Number(f.cost.value), retail_price: Number(f.retail_price.value),
        on_hand: Number(f.on_hand.value || 0), notes: f.notes.value,
        description: f.description.value.trim(),
        no_reseller_discount: f.no_reseller_discount.checked ? 1 : 0,
      };
      if (isEdit) await api(`/products/${p.id}`, { method: 'PUT', body });
      else await api('/products', { method: 'POST', body });
      m.close(); toast(isEdit ? 'Product updated' : 'Product added'); onSaved && onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

function openAdjustStock(p, onSaved) {
  const m = openModal(`
    <div class="modal-head"><h2>Adjust stock — ${esc(p.name)}</h2><button class="modal-x">✕</button></div>
    <div class="modal-body"><form id="adj-form" novalidate>
      <div class="form-error"></div>
      <dl class="kv" style="margin-bottom:14px"><dt>On hand</dt><dd>${p.on_hand}</dd><dt>Reserved</dt><dd>${p.reserved}</dd><dt>Available</dt><dd><b>${p.available}</b></dd></dl>
      <div class="field"><label>Change (+ restock / − remove) <span class="req">*</span></label>
        <input name="change" type="number" step="1" inputmode="numeric" placeholder="e.g. 10 or -2"></div>
      <div class="field"><label>Note</label><input name="note" placeholder="e.g. New shipment, breakage…"></div>
    </form></div>
    <div class="modal-foot">
      <button class="btn" id="adj-cancel">Cancel</button>
      <button class="btn primary" id="adj-save">Apply</button>
    </div>`);
  const form = $('#adj-form', m.el);
  $('#adj-cancel', m.el).onclick = m.close;
  $('#adj-save', m.el).onclick = e => guard(e.target, async () => {
    try {
      const change = Number(form.change.value);
      if (!Number.isInteger(change) || change === 0) throw new Error('Enter a non-zero whole number, e.g. 10 or -2.');
      await api(`/products/${p.id}/adjust`, { method: 'POST', body: { change, note: form.note.value } });
      m.close(); toast('Stock updated'); onSaved && onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

async function deleteProduct(p, onDone) {
  const ok = await confirmDialog({
    title: `Delete "${p.name}"?`,
    message: 'If this product appears on past orders it will be archived (hidden from new orders) so your history stays intact. Otherwise it is removed permanently.',
  });
  if (!ok) return;
  try { const r = await api(`/products/${p.id}`, { method: 'DELETE' }); toast(r.archived ? 'Product archived' : 'Product deleted'); onDone && onDone(); }
  catch (err) { toast(err.message, 'error'); }
}

/* ======================================================================
   ADMIN — RESELLERS
====================================================================== */
async function pageResellers(page) {
  page.innerHTML = `
    <div class="page-head"><div><h1>Resellers</h1><div class="page-sub">Partners, discounts and balances</div></div>
      <div class="head-actions">
        <button class="btn" id="export-res">⬇️ Export balances</button>
        <button class="btn primary" id="add-res">＋ Add reseller</button>
      </div></div>
    <div class="panel"><div id="res-table"><div class="skeleton-row"></div></div></div>`;

  const refresh = async () => {
    const rows = await loadResellers(true);
    renderTable($('#res-table'), {
      rows, empty: 'No resellers yet. Add your first one.',
      columns: [
        { label: 'Reseller', html: r => `<span class="cell-main">${esc(r.name)}</span><div class="cell-sub">${esc(r.email || '')}${r.phone ? ' · ' + esc(r.phone) : ''}</div>`, sort: r => r.name },
        { label: 'Disc %', cls: 'num', html: r => `${r.discount_pct}%`, sort: r => r.discount_pct },
        { label: 'Orders', cls: 'num', html: r => `${r.total_orders}<div class="cell-sub">${r.open_orders} open · ${r.completed_orders} done</div>`, sort: r => r.total_orders },
        { label: 'Revenue', cls: 'num', html: r => `<b>${money(r.total_revenue)}</b>`, sort: r => r.total_revenue },
        { label: 'Profit', cls: 'num', html: r => `<span class="${moneyCls(r.total_profit)}">${money(r.total_profit)}</span>`, sort: r => r.total_profit },
        { label: 'Paid', cls: 'num', html: r => money(r.amount_paid), sort: r => r.amount_paid },
        { label: 'Owes', cls: 'num', html: r => r.amount_owed > 0 ? `<b class="neg">${money(r.amount_owed)}</b>` : `<span class="pos">${money(0)}</span>`, sort: r => r.amount_owed },
        { label: 'Status', html: r => badge('reseller', r.status), sort: r => r.status },
        { label: 'Login', html: r => r.login_email ? (r.login_active ? `<span class="cell-sub">${esc(r.login_email)}</span>` : '<span class="badge red">Login off</span>') : '<span class="muted">—</span>' },
        {
          label: '', cls: 'nowrap', html: r => `
          <button class="btn sm" data-act="view" data-id="${r.id}">History</button>
          <button class="btn sm" data-act="pay" data-id="${r.id}">＋ Payment</button>
          <button class="btn sm" data-act="edit" data-id="${r.id}">Edit</button>
          ${r.name !== 'PAST ORDERS' ? `<button class="btn sm danger" data-act="del" data-id="${r.id}">Delete</button>` : ''}` },
      ],
      onRow: r => openResellerDetail(r.id, refresh),
      afterDraw(container) {
        $$('button[data-act]', container).forEach(b => b.addEventListener('click', () => {
          const r = S.resellers.find(x => x.id === Number(b.dataset.id));
          if (b.dataset.act === 'view') openResellerDetail(r.id, refresh);
          if (b.dataset.act === 'pay') openPaymentForm({ reseller: r, onSaved: refresh });
          if (b.dataset.act === 'edit') openResellerForm(r, refresh);
          if (b.dataset.act === 'del') deleteReseller(r, refresh);
        }));
      },
    });
  };
  $('#export-res').onclick = () => { window.location.href = '/api/export/reseller-balances.csv'; };
  $('#add-res').onclick = () => openResellerForm(null, refresh);
  await refresh();
}

async function deleteReseller(r, onDone) {
  const ok = await confirmDialog({
    title: `Delete "${r.name}"?`,
    message: `${r.total_orders > 0 ? `Their ${r.total_orders} order(s) and payments will be moved to the PAST ORDERS archive so your numbers stay correct. ` : ''}Their login will be removed. This cannot be undone.`,
  });
  if (!ok) return;
  try {
    await api(`/resellers/${r.id}`, { method: 'DELETE' });
    toast('Reseller deleted');
    await loadResellers(true);
    onDone && onDone();
  } catch (err) { toast(err.message, 'error'); }
}

function openResellerForm(r, onSaved) {
  const isEdit = !!r;
  const m = openModal(`
    <div class="modal-head"><h2>${isEdit ? 'Edit reseller' : 'Add reseller'}</h2><button class="modal-x">✕</button></div>
    <div class="modal-body"><form id="r-form" novalidate>
      <div class="form-error"></div>
      <div class="form-row">
        <div class="field"><label>Name <span class="req">*</span></label><input name="name" value="${esc(r?.name || '')}"></div>
        <div class="field"><label>Discount % <span class="req">*</span></label><input name="discount_pct" type="number" min="0" max="100" step="0.1" value="${r ? r.discount_pct : (S.settings?.default_discount_pct ?? 22)}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Email</label><input name="email" type="email" value="${esc(r?.email || '')}"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(r?.phone || '')}"></div>
      </div>
      ${isEdit ? `<div class="field"><label>Status</label>
        <select name="status"><option value="active" ${r.status === 'active' ? 'selected' : ''}>Active</option><option value="disabled" ${r.status === 'disabled' ? 'selected' : ''}>Disabled (blocks login & new orders)</option></select></div>` : `
      <div class="form-row">
        <div class="field"><label>Login email (optional)</label><input name="login_email" type="email" placeholder="Lets them sign in"></div>
        <div class="field"><label>Login password</label><input name="login_password" type="text" placeholder="Min 6 characters"></div>
      </div>`}
      <div class="field"><label>Notes</label><textarea name="notes">${esc(r?.notes || '')}</textarea></div>
    </form></div>
    <div class="modal-foot">
      <button class="btn" id="r-cancel">Cancel</button>
      <button class="btn primary" id="r-save">${isEdit ? 'Save changes' : 'Add reseller'}</button>
    </div>`);
  const form = $('#r-form', m.el);
  $('#r-cancel', m.el).onclick = m.close;
  $('#r-save', m.el).onclick = e => guard(e.target, async () => {
    try {
      if (!form.name.value.trim()) throw new Error('Reseller name is required.');
      const d = Number(form.discount_pct.value);
      if (!Number.isFinite(d) || d < 0 || d > 100) throw new Error('Discount must be between 0 and 100.');
      const body = {
        name: form.name.value.trim(), email: form.email.value.trim(), phone: form.phone.value.trim(),
        discount_pct: d, notes: form.notes.value,
      };
      if (isEdit) { body.status = form.status.value; await api(`/resellers/${r.id}`, { method: 'PUT', body }); }
      else {
        if (form.login_email.value && form.login_password.value.length < 6) throw new Error('Login password must be at least 6 characters.');
        body.login_email = form.login_email.value.trim(); body.login_password = form.login_password.value;
        await api('/resellers', { method: 'POST', body });
      }
      m.close(); toast(isEdit ? 'Reseller updated' : 'Reseller added'); onSaved && onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

async function openResellerDetail(id, onChanged) {
  const r = await api(`/resellers/${id}`);
  const m = openModal(`
    <div class="modal-head"><h2>${esc(r.name)}</h2><button class="modal-x">✕</button></div>
    <div class="modal-body">
      <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))">
        <div class="stat ${r.amount_owed > 0 ? 'warn' : 'good'}"><div class="lbl">Owes</div><div class="val">${money(r.amount_owed)}</div></div>
        <div class="stat"><div class="lbl">Paid</div><div class="val">${money(r.amount_paid)}</div></div>
        <div class="stat good"><div class="lbl">Revenue</div><div class="val">${money(r.total_revenue)}</div></div>
        <div class="stat"><div class="lbl">Orders</div><div class="val">${r.total_orders}</div><div class="sub">${r.open_orders} open</div></div>
      </div>
      <h2 style="font-size:14.5px;margin:8px 0">Orders</h2>
      <div id="rd-orders"></div>
      <h2 style="font-size:14.5px;margin:16px 0 8px">Payments</h2>
      <div id="rd-payments"></div>
    </div>
    <div class="modal-foot">
      <div class="left">
        ${r.login_user_id
          ? `<button class="btn sm" id="rd-resetpw">Reset password</button>
             <button class="btn sm ${r.login_active ? 'danger' : ''}" id="rd-togglelogin">${r.login_active ? 'Disable login' : 'Enable login'}</button>`
          : '<button class="btn sm" id="rd-createlogin">Create login</button>'}
        ${r.amount_owed > 0 ? `<button class="btn sm primary" id="rd-settle">Mark balance paid (${money(r.amount_owed)})</button>` : ''}
      </div>
      <button class="btn" id="rd-close">Close</button>
    </div>`, { wide: true });

  renderTable($('#rd-orders', m.el), {
    rows: r.orders, empty: 'No orders yet.',
    columns: [
      { label: 'Date', html: x => fmtDate(x.order_date), sort: x => x.order_date },
      { label: 'Customer', html: x => `<span class="cell-main">${esc(x.customer_name)}</span><div class="cell-sub">${itemsSummary(x.items)}</div>` },
      { label: 'Total', cls: 'num', html: x => `<b>${money(x.total_revenue)}</b>` },
      { label: 'Due', cls: 'num', html: x => x.balance_due > 0 ? `<span class="neg">${money(x.balance_due)}</span>` : `<span class="pos">${money(0)}</span>` },
      { label: 'Status', html: x => badge('order', x.status) },
      { label: 'Payment', html: x => badge('payment', x.payment_status) },
    ],
  });
  renderTable($('#rd-payments', m.el), {
    rows: r.payments, empty: 'No payments recorded.',
    columns: [
      { label: 'Date', html: x => fmtDate(x.payment_date), sort: x => x.payment_date },
      { label: 'Amount', cls: 'num', html: x => `<b class="pos">${money(x.amount)}</b>` },
      { label: 'Method', html: x => esc(x.method || '—') },
      { label: 'Notes', html: x => `<span class="cell-sub">${esc(x.notes || '—')}</span>` },
      { label: '', html: x => `<button class="btn sm danger" data-delpay="${x.id}">Delete</button>` },
    ],
    afterDraw(container) {
      $$('button[data-delpay]', container).forEach(b => b.addEventListener('click', async () => {
        const pay = r.payments.find(x => x.id === Number(b.dataset.delpay));
        const ok = await confirmDialog({
          title: 'Delete payment?',
          message: `Remove the ${money(pay.amount)} payment from ${r.name}? The orders it covered will show as owed again.`,
        });
        if (!ok) return;
        try {
          await api(`/payments/${pay.id}`, { method: 'DELETE' });
          toast('Payment deleted');
          m.close();
          openResellerDetail(r.id, onChanged);
        } catch (err) { toast(err.message, 'error'); }
      }));
    },
  });

  const done = async () => { m.close(); onChanged && onChanged(); };
  $('#rd-close', m.el).onclick = m.close;
  const settle = $('#rd-settle', m.el);
  if (settle) settle.onclick = async e => {
    const ok = await confirmDialog({ title: 'Mark balance as paid?', message: `Record a payment of ${money(r.amount_owed)} from ${r.name} and apply it to their oldest unpaid orders?`, confirmText: 'Record payment', danger: false });
    if (ok) guard(e.target, async () => { try { await api(`/resellers/${r.id}/settle`, { method: 'POST', body: {} }); toast('Balance settled'); await done(); } catch (err) { toast(err.message, 'error'); } });
  };
  const createLogin = $('#rd-createlogin', m.el);
  if (createLogin) createLogin.onclick = () => { m.close(); openResellerLoginForm(r, onChanged); };
  const resetPw = $('#rd-resetpw', m.el);
  if (resetPw) resetPw.onclick = () => { m.close(); openResellerLoginForm(r, onChanged, true); };
  const toggleLogin = $('#rd-togglelogin', m.el);
  if (toggleLogin) toggleLogin.onclick = e => guard(e.target, async () => {
    try { await api(`/resellers/${r.id}/login`, { method: 'POST', body: { action: r.login_active ? 'disable' : 'enable' } }); toast(r.login_active ? 'Login disabled' : 'Login enabled'); await done(); }
    catch (err) { toast(err.message, 'error'); }
  });
}

function openResellerLoginForm(r, onSaved, isReset = false) {
  const m = openModal(`
    <div class="modal-head"><h2>${isReset ? 'Reset password' : 'Create login'} — ${esc(r.name)}</h2><button class="modal-x">✕</button></div>
    <div class="modal-body"><form id="rl-form" novalidate>
      <div class="form-error"></div>
      ${!isReset ? `<div class="field"><label>Login email <span class="req">*</span></label><input name="email" type="email" value="${esc(r.email || '')}"></div>` : ''}
      <div class="field"><label>New password <span class="req">*</span></label><input name="password" type="text" placeholder="Min 6 characters"></div>
    </form></div>
    <div class="modal-foot">
      <button class="btn" id="rl-cancel">Cancel</button>
      <button class="btn primary" id="rl-save">${isReset ? 'Reset password' : 'Create login'}</button>
    </div>`);
  const form = $('#rl-form', m.el);
  $('#rl-cancel', m.el).onclick = m.close;
  $('#rl-save', m.el).onclick = e => guard(e.target, async () => {
    try {
      if (form.password.value.length < 6) throw new Error('Password must be at least 6 characters.');
      const body = { password: form.password.value };
      if (!isReset) body.email = form.email.value.trim();
      await api(`/resellers/${r.id}/login`, { method: 'POST', body });
      m.close(); toast(isReset ? 'Password reset' : 'Login created'); onSaved && onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

/* ======================================================================
   ADMIN — PAYMENTS
====================================================================== */
async function pagePayments(page) {
  await loadResellers();
  page.innerHTML = `
    <div class="page-head"><div><h1>Payments</h1><div class="page-sub">Money received from resellers — applied oldest order first</div></div>
      <div class="head-actions"><button class="btn primary" id="add-pay">＋ Record payment</button></div></div>
    <div class="panel"><div id="pay-table"><div class="skeleton-row"></div></div></div>`;

  const refresh = async () => {
    const rows = await api('/payments');
    renderTable($('#pay-table'), {
      rows, empty: 'No payments yet. Record one when a reseller pays you.', emptyIcon: '💵',
      columns: [
        { label: 'Date', html: r => fmtDate(r.payment_date), sort: r => r.payment_date },
        { label: 'Reseller', html: r => `<span class="cell-main">${esc(r.reseller_name)}</span>`, sort: r => r.reseller_name },
        { label: 'Amount', cls: 'num', html: r => `<b class="pos">${money(r.amount)}</b>`, sort: r => r.amount },
        { label: 'Method', html: r => esc(r.method || '—') },
        {
          label: 'Applied to', html: r => r.allocations.length
            ? r.allocations.map(a => `<div class="cell-sub">#${a.order_id} ${esc(a.customer_name)} — ${money(a.amount)}</div>`).join('') + (r.unapplied > 0.004 ? `<div class="cell-sub neg">Unapplied: ${money(r.unapplied)}</div>` : '')
            : '<span class="muted">Unapplied</span>' },
        { label: 'Notes', html: r => `<span class="cell-sub">${esc(r.notes || '—')}</span>` },
        { label: 'By', html: r => `<span class="cell-sub">${esc(r.created_by_name || '—')}</span>` },
        { label: '', html: r => `<button class="btn sm danger" data-del="${r.id}">Delete</button>` },
      ],
      defaultSort: 0, defaultDir: -1,
      afterDraw(container) {
        $$('button[data-del]', container).forEach(b => b.addEventListener('click', async () => {
          const p = rows.find(x => x.id === Number(b.dataset.del));
          const ok = await confirmDialog({ title: 'Delete payment?', message: `Remove the ${money(p.amount)} payment from ${p.reseller_name}? The related orders will show as owed again.` });
          if (!ok) return;
          try { await api(`/payments/${p.id}`, { method: 'DELETE' }); toast('Payment deleted'); refresh(); }
          catch (err) { toast(err.message, 'error'); }
        }));
      },
    });
  };
  $('#add-pay').onclick = () => openPaymentForm({ onSaved: refresh });
  await refresh();
}

function openPaymentForm({ reseller = null, onSaved }) {
  const resellers = S.resellers || [];
  const m = openModal(`
    <div class="modal-head"><h2>Record payment</h2><button class="modal-x">✕</button></div>
    <div class="modal-body"><form id="pay-form" novalidate>
      <div class="form-error"></div>
      <div class="field"><label>Reseller <span class="req">*</span></label>
        <select name="reseller_id"><option value="">Choose…</option>${resellers.map(r =>
          `<option value="${r.id}" data-owed="${r.amount_owed}" ${reseller && reseller.id === r.id ? 'selected' : ''}>${esc(r.name)} — owes ${money(r.amount_owed)}</option>`).join('')}</select>
        <div class="hint" id="owed-hint"></div></div>
      <div class="form-row">
        <div class="field"><label>Amount <span class="req">*</span></label><input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00"></div>
        <div class="field"><label>Date</label><input name="payment_date" type="date" value="${today()}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Method</label>
          <select name="method"><option>Cash</option><option>Zelle</option><option>Venmo</option><option>CashApp</option><option>PayPal</option><option>Crypto</option><option>Other</option></select></div>
        <div class="field"><label>Notes</label><input name="notes" placeholder="Optional"></div>
      </div>
      <div class="hint">The payment is applied to this reseller's oldest unpaid orders first. If it doesn't cover everything, the rest shows as a partial payment.</div>
    </form></div>
    <div class="modal-foot">
      <button class="btn" id="pay-cancel">Cancel</button>
      <button class="btn primary" id="pay-save">Record payment</button>
    </div>`);
  const form = $('#pay-form', m.el);
  const hint = $('#owed-hint', m.el);
  const updateHint = () => {
    const opt = form.reseller_id.selectedOptions[0];
    hint.textContent = opt && opt.dataset.owed ? `Current balance: ${money(opt.dataset.owed)}` : '';
  };
  form.reseller_id.addEventListener('change', updateHint); updateHint();
  $('#pay-cancel', m.el).onclick = m.close;
  $('#pay-save', m.el).onclick = e => guard(e.target, async () => {
    try {
      if (!form.reseller_id.value) throw new Error('Choose a reseller.');
      const amount = Number(form.amount.value);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a payment amount greater than zero.');
      const res = await api('/payments', {
        method: 'POST',
        body: { reseller_id: Number(form.reseller_id.value), amount, payment_date: form.payment_date.value, method: form.method.value, notes: form.notes.value },
      });
      m.close();
      toast(res.unapplied > 0.004 ? `Payment recorded — ${money(res.unapplied)} not yet applied (no unpaid orders left)` : 'Payment recorded');
      await loadResellers(true);
      onSaved && onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

/* ======================================================================
   ADMIN — DELIVERIES
====================================================================== */
async function pageDeliveries(page) {
  page.innerHTML = `
    <div class="page-head"><div><h1>Deliveries</h1><div class="page-sub">Track every order from packed to delivered</div></div></div>
    <div class="panel">
      <div class="toolbar"><div class="pill-tabs" id="del-tabs">
        ${['all', 'pending', 'packed', 'out_for_delivery', 'delivered', 'cancelled'].map((s, i) =>
          `<button data-s="${s === 'all' ? '' : s}" class="${i === 0 ? 'active' : ''}">${s === 'all' ? 'All' : s.replace(/_/g, ' ')}</button>`).join('')}
      </div></div>
      <div id="del-table"><div class="skeleton-row"></div></div>
    </div>`;

  let statusFilter = '';
  const refresh = async () => {
    let rows = await api('/deliveries');
    if (statusFilter) rows = rows.filter(r => r.delivery_status === statusFilter);
    renderTable($('#del-table'), {
      rows, empty: 'No deliveries in this view.', emptyIcon: '🚚',
      columns: [
        { label: 'Order', html: r => `<span class="cell-main">#${r.id}</span><div class="cell-sub">${fmtDate(r.order_date)}</div>`, sort: r => r.id },
        { label: 'Customer', html: r => `<span class="cell-main">${esc(r.customer_name)}</span>`, sort: r => r.customer_name },
        { label: 'Reseller', html: r => esc(r.reseller_name), sort: r => r.reseller_name },
        { label: 'Products', html: r => `<span class="cell-sub">${itemsSummary(r.items)}</span>` },
        {
          label: 'Delivery status', html: r => `
          <select data-id="${r.id}" class="del-status" style="min-width:130px;padding:6px 8px;font-size:13px">
            ${['pending', 'packed', 'out_for_delivery', 'delivered', 'cancelled'].map(s =>
              `<option value="${s}" ${r.delivery_status === s ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}</select>`, sort: r => r.delivery_status || '' },
        { label: 'Delivery date', html: r => r.delivery_date ? fmtDate(r.delivery_date) : '<span class="muted">—</span>', sort: r => r.delivery_date || '' },
        { label: 'Address / notes', html: r => `<span class="cell-sub">${esc(r.address || '')}${r.address && r.delivery_notes ? ' · ' : ''}${esc(r.delivery_notes || '')}</span>${!r.address && !r.delivery_notes ? '<span class="muted">—</span>' : ''}` },
        { label: 'Admin notes', html: r => `<span class="cell-sub">${esc(r.admin_notes || '—')}</span>` },
        { label: '', html: r => `<button class="btn sm" data-edit="${r.id}">Edit</button>` },
      ],
      afterDraw(container, drawn) {
        $$('.del-status', container).forEach(sel => sel.addEventListener('change', async () => {
          const id = Number(sel.dataset.id);
          try { await api(`/orders/${id}/delivery`, { method: 'PATCH', body: { status: sel.value } }); toast('Delivery updated'); refresh(); }
          catch (err) { toast(err.message, 'error'); refresh(); }
        }));
        $$('button[data-edit]', container).forEach(b => b.addEventListener('click', () => {
          openDeliveryEdit(rows.find(x => x.id === Number(b.dataset.edit)), refresh);
        }));
      },
    });
  };
  $$('#del-tabs button').forEach(b => b.addEventListener('click', () => {
    $$('#del-tabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); statusFilter = b.dataset.s; refresh();
  }));
  await refresh();
}

function openDeliveryEdit(o, onSaved) {
  const m = openModal(`
    <div class="modal-head"><h2>Delivery — order #${o.id} (${esc(o.customer_name)})</h2><button class="modal-x">✕</button></div>
    <div class="modal-body"><form id="de-form" novalidate>
      <div class="form-error"></div>
      <div class="form-row">
        <div class="field"><label>Delivery date</label><input type="date" name="delivery_date" value="${esc(o.delivery_date || '')}"></div>
        <div class="field"><label>Status</label>
          <select name="status">${['pending', 'packed', 'out_for_delivery', 'delivered', 'cancelled'].map(s =>
            `<option value="${s}" ${o.delivery_status === s ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Address</label><input name="address" value="${esc(o.address || '')}"></div>
      <div class="field"><label>Delivery notes</label><textarea name="delivery_notes">${esc(o.delivery_notes || '')}</textarea></div>
      <div class="field"><label>Admin notes</label><textarea name="admin_notes">${esc(o.admin_notes || '')}</textarea></div>
    </form></div>
    <div class="modal-foot">
      <button class="btn" id="de-cancel">Cancel</button>
      <button class="btn primary" id="de-save">Save</button>
    </div>`);
  const form = $('#de-form', m.el);
  $('#de-cancel', m.el).onclick = m.close;
  $('#de-save', m.el).onclick = e => guard(e.target, async () => {
    try {
      await api(`/orders/${o.id}/delivery`, {
        method: 'PATCH',
        body: { status: form.status.value, delivery_date: form.delivery_date.value, address: form.address.value, delivery_notes: form.delivery_notes.value, admin_notes: form.admin_notes.value },
      });
      m.close(); toast('Delivery updated'); onSaved && onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

/* ======================================================================
   ADMIN — AUDIT LOG
====================================================================== */
async function pageAudit(page) {
  const rows = await api('/audit');
  page.innerHTML = `
    <div class="page-head"><div><h1>Activity log</h1><div class="page-sub">Every important change, newest first</div></div></div>
    <div class="panel"><div id="audit-table"></div></div>`;
  renderTable($('#audit-table'), {
    rows, empty: 'No activity yet.',
    columns: [
      { label: 'When', html: r => `<span class="nowrap">${fmtDateTime(r.created_at)}</span>`, sort: r => r.created_at },
      { label: 'Who', html: r => esc(r.user_name || '—') },
      { label: 'Action', html: r => `<span class="badge gray">${esc(r.action)}</span>` },
      { label: 'What', html: r => `${esc(r.entity)}${r.entity_id ? ' #' + r.entity_id : ''}` },
      { label: 'Details', html: r => `<span class="cell-sub">${esc(r.details || '')}</span>` },
    ],
  });
}

/* ======================================================================
   ADMIN — SETTINGS
====================================================================== */
async function pageSettings(page) {
  const [settings, users] = await Promise.all([api('/settings'), api('/users')]);
  const sw = (key, label, sub) => `
    <div class="switch-row"><div><div class="sw-label">${label}</div><div class="sw-sub">${sub}</div></div>
      <label class="switch"><input type="checkbox" name="${key}" ${settings[key] === '1' ? 'checked' : ''}><span class="track"></span></label></div>`;

  page.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><div class="page-sub">Business preferences and admin access</div></div></div>
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><h2>Business</h2></div>
        <div class="panel-body"><form id="set-form" novalidate>
          <div class="form-error"></div>
          <div class="field"><label>Business name</label><input name="business_name" value="${esc(settings.business_name)}"></div>
          <div class="form-row-3">
            <div class="field"><label>Default reseller discount %</label><input name="default_discount_pct" type="number" min="0" max="100" step="0.1" value="${esc(settings.default_discount_pct)}"></div>
            <div class="field"><label>Currency code</label><input name="currency" value="${esc(settings.currency)}" placeholder="USD"></div>
            <div class="field"><label>Currency symbol</label><input name="currency_symbol" value="${esc(settings.currency_symbol)}" placeholder="$"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Low-stock threshold (applies to all products)</label><input name="low_stock_default_threshold" type="number" min="0" step="1" value="${esc(settings.low_stock_default_threshold)}"></div>
            <div class="field"><label>Default shipping price</label><input name="default_shipping_price" type="number" min="0" step="0.01" value="${esc(settings.default_shipping_price ?? '15')}">
              <div class="hint">Pre-fills the shipping amount when you tick "Add shipping" on an order.</div></div>
          </div>
          ${sw('allow_backorders', 'Allow backorders', 'Let orders exceed available stock')}
          ${sw('require_payment_before_delivery', 'Require payment before delivery', 'Orders must be fully paid before they can be marked delivered')}
          ${sw('show_profit_to_resellers', 'Show profit to resellers', 'Off by default — resellers never see your cost')}
          ${sw('allow_self_registration', 'Allow reseller sign-up', 'Shows a "create account" link on the login page')}
          <div class="field" style="margin-top:14px"><label>Sign-up invite code (optional)</label>
            <input name="registration_code" value="${esc(settings.registration_code || '')}" placeholder="Leave blank to allow anyone with the link">
            <div class="hint">If set, new resellers must enter this code to create an account. Strongly recommended once the app is on the internet.</div></div>
          <div class="field" style="margin-top:14px"><label>Product disclaimer</label><textarea name="product_disclaimer" rows="3">${esc(settings.product_disclaimer)}</textarea>
            <div class="hint">Shown to resellers on their price list.</div></div>
          <button class="btn primary" id="set-save" type="button">Save settings</button>
        </form></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Admin users</h2><button class="btn sm primary" id="add-admin">＋ Add admin</button></div>
        <div id="users-table"></div>
      </div>
    </div>`;

  renderTable($('#users-table'), {
    rows: users, empty: 'No admins.',
    columns: [
      { label: 'Name', html: u => `<span class="cell-main">${esc(u.name)}</span><div class="cell-sub">${esc(u.email)}</div>` },
      { label: 'Status', html: u => u.active ? '<span class="badge green">Active</span>' : '<span class="badge red">Disabled</span>' },
      {
        label: '', cls: 'nowrap', html: u => `
        <button class="btn sm" data-pw="${u.id}">Reset password</button>
        ${u.id !== S.user.id ? `<button class="btn sm ${u.active ? 'danger' : ''}" data-tg="${u.id}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>` : '<span class="muted cell-sub">(you)</span>'}` },
    ],
    afterDraw(container) {
      $$('button[data-pw]', container).forEach(b => b.addEventListener('click', () => {
        const u = users.find(x => x.id === Number(b.dataset.pw));
        openAdminPasswordForm(u, () => pageSettings(page));
      }));
      $$('button[data-tg]', container).forEach(b => b.addEventListener('click', async () => {
        const active = b.dataset.active === '1';
        const ok = !active || await confirmDialog({ title: 'Disable admin?', message: 'They will be logged out and unable to sign in.', confirmText: 'Disable' });
        if (!ok) return;
        try { await api(`/users/${b.dataset.tg}`, { method: 'PATCH', body: { active: !active } }); toast('Updated'); pageSettings(page); }
        catch (err) { toast(err.message, 'error'); }
      }));
    },
  });

  $('#set-save').onclick = e => guard(e.target, async () => {
    const f = $('#set-form');
    try {
      const body = {
        business_name: f.business_name.value.trim() || 'Peptide Manager',
        default_discount_pct: f.default_discount_pct.value,
        currency: f.currency.value.trim() || 'USD',
        currency_symbol: f.currency_symbol.value.trim() || '$',
        low_stock_default_threshold: f.low_stock_default_threshold.value,
        default_shipping_price: f.default_shipping_price.value,
        allow_backorders: f.allow_backorders.checked ? '1' : '0',
        require_payment_before_delivery: f.require_payment_before_delivery.checked ? '1' : '0',
        show_profit_to_resellers: f.show_profit_to_resellers.checked ? '1' : '0',
        allow_self_registration: f.allow_self_registration.checked ? '1' : '0',
        registration_code: f.registration_code.value.trim(),
        product_disclaimer: f.product_disclaimer.value,
      };
      await api('/settings', { method: 'PUT', body });
      const me = await api('/me');
      S.settings = me.settings;
      toast('Settings saved');
      buildShell(); navigate();
    } catch (err) { showFormError(f, err.message); }
  });
  $('#add-admin').onclick = () => openAdminPasswordForm(null, () => pageSettings(page));
}

function openAdminPasswordForm(u, onSaved) {
  const isNew = !u;
  const m = openModal(`
    <div class="modal-head"><h2>${isNew ? 'Add admin' : `Reset password — ${esc(u.name)}`}</h2><button class="modal-x">✕</button></div>
    <div class="modal-body"><form id="au-form" novalidate>
      <div class="form-error"></div>
      ${isNew ? `
      <div class="field"><label>Name <span class="req">*</span></label><input name="name"></div>
      <div class="field"><label>Email <span class="req">*</span></label><input name="email" type="email"></div>` : ''}
      <div class="field"><label>${isNew ? 'Password' : 'New password'} <span class="req">*</span></label><input name="password" type="text" placeholder="Min 6 characters"></div>
    </form></div>
    <div class="modal-foot">
      <button class="btn" id="au-cancel">Cancel</button>
      <button class="btn primary" id="au-save">${isNew ? 'Add admin' : 'Reset password'}</button>
    </div>`);
  const form = $('#au-form', m.el);
  $('#au-cancel', m.el).onclick = m.close;
  $('#au-save', m.el).onclick = e => guard(e.target, async () => {
    try {
      if (form.password.value.length < 6) throw new Error('Password must be at least 6 characters.');
      if (isNew) {
        if (!form.name.value.trim() || !form.email.value.trim()) throw new Error('Name and email are required.');
        await api('/users', { method: 'POST', body: { name: form.name.value.trim(), email: form.email.value.trim(), password: form.password.value } });
      } else {
        await api(`/users/${u.id}`, { method: 'PATCH', body: { password: form.password.value } });
      }
      m.close(); toast(isNew ? 'Admin added' : 'Password reset'); onSaved && onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

/* ======================================================================
   RESELLER PORTAL
====================================================================== */
async function pageResellerHome(page) {
  const d = await api('/my/summary');
  const showProfit = S.settings.show_profit_to_resellers;
  page.innerHTML = `
    <div class="page-head"><div><h1>Hi, ${esc(S.user.name)} 👋</h1>
      <div class="page-sub">Here's how your sales are going</div></div>
      <div class="head-actions"><a class="btn primary" href="#/new-order">＋ New order</a></div></div>
    <div class="cards">
      <div class="stat ${d.unpaid_balance > 0 ? 'warn' : 'good'}"><div class="lbl">You owe</div><div class="val">${money(d.unpaid_balance)}</div><div class="sub">unpaid balance</div></div>
      <div class="stat good"><div class="lbl">Total sales</div><div class="val">${money(d.total_sales)}</div></div>
      <div class="stat"><div class="lbl">Open orders</div><div class="val">${d.open_count}</div></div>
      <div class="stat"><div class="lbl">Completed</div><div class="val">${d.completed_count}</div></div>
    </div>
    <div class="panel"><div class="panel-head"><h2>Recent orders</h2><a class="btn sm" href="#/my-orders">View all</a></div>
      <div id="rh-orders"></div></div>`;
  renderTable($('#rh-orders'), {
    rows: d.orders.slice(0, 8), empty: 'No orders yet — create your first one!', emptyIcon: '🧾',
    columns: [
      { label: 'Date', html: r => fmtDate(r.order_date), sort: r => r.order_date },
      { label: 'Customer', html: r => `<span class="cell-main">${esc(r.customer_name)}</span><div class="cell-sub">${itemsSummary(r.items)}</div>` },
      { label: 'Total', cls: 'num', html: r => `<b>${money(r.total_revenue)}</b>` },
      ...(showProfit ? [{ label: 'Profit', cls: 'num', html: r => `<span class="${moneyCls(r.total_profit)}">${money(r.total_profit)}</span>` }] : []),
      { label: 'Status', html: r => statusBadge(r) },
    ],
  });
}

async function pageResellerNewOrder(page) {
  const data = await api('/my/products');
  const products = data.products;
  page.innerHTML = `
    <div class="page-head"><div><h1>New order</h1><div class="page-sub">Your prices fill in automatically</div></div></div>
    <div class="panel"><div class="panel-body">
      <form id="ro-form" novalidate>
        <div class="form-error"></div>
        <div class="field"><label>Customer name <span class="req">*</span></label><input name="customer_name" placeholder="Who is this for?"></div>
        <div class="field"><label>Products <span class="req">*</span></label>
          <div class="line-items no-disc" id="lines">
            <div class="line-row header"><span>Product</span><span>Qty</span><span style="text-align:right">Your price</span><span style="text-align:right">Line total</span><span></span></div>
          </div>
          <button type="button" class="btn sm" id="add-line">＋ Add product</button>
          <div class="totals-box" id="totals"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Delivery address</label><input name="address" placeholder="Where to deliver (optional)"></div>
          <div class="field"><label>Delivery notes</label><input name="delivery_notes" placeholder="e.g. Meet at gym (optional)"></div>
        </div>
        <div class="field"><label>Note to admin</label><textarea name="notes" placeholder="Anything the owner should know (optional)"></textarea></div>
        <button class="btn primary" id="ro-submit" type="button" style="min-width:160px">Submit order</button>
      </form>
    </div></div>
    <div class="disclaimer">${esc(data.disclaimer || '')}</div>`;

  const form = $('#ro-form');
  const linesEl = $('#lines', form);
  const totalsEl = $('#totals', form);
  const productOpts = products.filter(p => p.can_order).map(p => `<option value="${p.id}">${esc(p.name)} — ${p.available} avail</option>`).join('');

  function recalc() {
    let total = 0;
    $$('.line-row:not(.header)', linesEl).forEach(row => {
      const p = products.find(x => x.id === Number($('.li-product', row).value));
      const qty = Number($('.li-qty', row).value);
      const priceEl = $('.li-final', row), totalEl = $('.li-total', row);
      if (!p || !Number.isInteger(qty) || qty <= 0) {
        priceEl.textContent = '—'; totalEl.textContent = '—'; return;
      }
      const line = round2(p.your_price * qty);
      priceEl.textContent = money(p.your_price);
      totalEl.textContent = money(line);
      priceEl.classList.remove('muted'); totalEl.classList.remove('muted');
      total = round2(total + line);
    });
    totalsEl.innerHTML = `<span>Amount owed: <b>${money(total)}</b></span>`;
  }
  function addLine() {
    const row = document.createElement('div');
    row.className = 'line-row';
    row.innerHTML = `
      <select class="li-product"><option value="">Select product…</option>${productOpts}</select>
      <input class="li-qty" type="number" min="1" step="1" placeholder="1" inputmode="numeric">
      <div class="line-calc li-final muted">—</div>
      <div class="line-calc li-total muted">—</div>
      <button type="button" class="line-del" title="Remove line">✕</button>`;
    linesEl.appendChild(row);
    const sel = $('.li-product', row), qty = $('.li-qty', row);
    sel.addEventListener('change', () => { if (sel.value && qty.value === '') qty.value = 1; recalc(); });
    qty.addEventListener('input', recalc);
    $('.line-del', row).addEventListener('click', () => { row.remove(); recalc(); });
    recalc();
  }
  $('#add-line', form).addEventListener('click', () => addLine());
  addLine();

  $('#ro-submit').onclick = e => guard(e.target, async () => {
    try {
      if (!form.customer_name.value.trim()) throw new Error('Customer name is required.');
      const rows = $$('.line-row:not(.header)', linesEl);
      if (!rows.length) throw new Error('Add at least one product to the order.');
      const items = rows.map(row => {
        const pid = Number($('.li-product', row).value) || null;
        const qty = Number($('.li-qty', row).value);
        const p = products.find(x => x.id === pid);
        if (!pid || !p) throw new Error('Every line needs a product selected.');
        if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Quantity for "${p.name}" must be a whole number above zero.`);
        if (!p.can_order) throw new Error(`"${p.name}" is out of stock right now.`);
        if (!data.allow_backorders && qty > p.available) throw new Error(`Only ${p.available} of "${p.name}" available.`);
        return { product_id: pid, qty };
      });
      await api('/my/orders', {
        method: 'POST',
        body: { customer_name: form.customer_name.value.trim(), items, address: form.address.value, delivery_notes: form.delivery_notes.value, notes: form.notes.value },
      });
      toast('Order submitted! The admin can now see it.');
      location.hash = '#/my-orders';
    } catch (err) { showFormError(form, err.message); }
  });
}

async function pageResellerOrders(page) {
  const d = await api('/my/summary');
  const showProfit = S.settings.show_profit_to_resellers;
  page.innerHTML = `
    <div class="page-head"><div><h1>My orders</h1>
      <div class="page-sub">Unpaid balance: <b class="${d.unpaid_balance > 0 ? 'neg' : 'pos'}">${money(d.unpaid_balance)}</b></div></div>
      <div class="head-actions"><a class="btn primary" href="#/new-order">＋ New order</a></div></div>
    <div class="panel">
      <div class="toolbar"><div class="pill-tabs" id="ro-tabs">
        <button class="active" data-s="">All</button><button data-s="unpaid">Unpaid</button><button data-s="paid">Paid</button><button data-s="delivered">Delivered</button><button data-s="cancelled">Cancelled</button>
      </div><input class="search" id="ro-q" placeholder="Search customer…"></div>
      <div id="ro-table"></div>
    </div>`;

  let statusFilter = '', q = '';
  function draw() {
    const rows = d.orders.filter(o => (!statusFilter || orderDisplayStatus(o) === statusFilter) && (!q || o.customer_name.toLowerCase().includes(q)));
    renderTable($('#ro-table'), {
      rows, empty: 'No orders here yet.',
      columns: [
        { label: 'Date', html: r => fmtDate(r.order_date), sort: r => r.order_date },
        { label: 'Customer', html: r => `<span class="cell-main">${esc(r.customer_name)}</span>`, sort: r => r.customer_name },
        { label: 'Products', html: r => `<span class="cell-sub">${r.items.map(i => `${esc(i.product_name)} ×${i.qty} @ ${money(i.final_price)}`).join('<br>')}</span>` },
        { label: 'Total', cls: 'num', html: r => `<b>${money(r.total_revenue)}</b>`, sort: r => r.total_revenue },
        { label: 'Owed', cls: 'num', html: r => r.balance_due > 0 ? `<span class="neg">${money(r.balance_due)}</span>` : `<span class="pos">${money(0)}</span>`, sort: r => r.balance_due },
        ...(showProfit ? [{ label: 'Profit', cls: 'num', html: r => money(r.total_profit) }] : []),
        { label: 'Status', html: r => statusBadge(r) },
        { label: 'Notes', html: r => `<span class="cell-sub">${esc(r.notes || '—')}</span>` },
      ],
      defaultSort: 0, defaultDir: -1,
    });
  }
  $$('#ro-tabs button').forEach(b => b.addEventListener('click', () => {
    $$('#ro-tabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); statusFilter = b.dataset.s; draw();
  }));
  $('#ro-q').addEventListener('input', debounce(e => { q = e.target.value.toLowerCase(); draw(); }, 200));
  draw();
}

async function pageResellerPrices(page) {
  const data = await api('/my/products');
  page.innerHTML = `
    <div class="page-head"><div><h1>Price list</h1><div class="page-sub">Retail prices and your price after discount</div></div></div>
    <div class="panel">
      <div class="toolbar">
        <input class="search" id="pl-q" placeholder="Search products…">
        <div class="pill-tabs" id="pl-stock"><button class="active" data-v="instock">In stock</button><button data-v="all">Show all</button></div>
      </div>
      <div id="pl-table"></div>
    </div>
    <div class="disclaimer">${esc(data.disclaimer || '')}</div>`;
  let q = '', stockView = 'instock';
  function draw() {
    const rows = data.products.filter(p => (!q || p.name.toLowerCase().includes(q)) && (stockView === 'all' || p.available > 0));
    renderTable($('#pl-table'), {
      rows, empty: stockView === 'instock' ? 'Nothing in stock right now — tap “Show all” to see the full list.' : 'No products found.', defaultSort: 2, defaultDir: -1,
      columns: [
        { label: 'Product', html: r => `<span class="cell-main">${esc(r.name)}</span>${r.description ? `<div class="cell-sub">${esc(r.description)}</div>` : ''}`, sort: r => r.name },
        { label: 'Your price', cls: 'num', html: r => `<b>${money(r.your_price)}</b>${r.no_reseller_discount ? ' <span class="badge gray nodot" title="Sold at retail — no reseller discount">retail</span>' : ''}`, sort: r => r.your_price },
        { label: 'In stock', cls: 'num', html: r => `${badge('stock', r.stock_status)} <b style="margin-left:6px">${Math.max(0, r.available)}</b>`, sort: r => r.available },
      ],
    });
  }
  $('#pl-q').addEventListener('input', debounce(e => { q = e.target.value.toLowerCase(); draw(); }, 200));
  $$('#pl-stock button').forEach(b => b.addEventListener('click', () => {
    $$('#pl-stock button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); stockView = b.dataset.v; draw();
  }));
  draw();
}

/* ================= boot ================= */
(async function boot() {
  applyTheme();
  try {
    const me = await api('/me');
    S.user = me.user; S.settings = me.settings;
    document.title = S.settings.business_name;
    buildShell();
    navigate();
  } catch {
    renderLogin();
  }
})();
