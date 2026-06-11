# Peptide Manager

A complete business dashboard for managing products, inventory, orders, resellers, payments and deliveries. Node.js + Express backend, SQLite database (built into Node — nothing extra to install), and a fast mobile-friendly web UI with dark/light mode.

## Run it

You need **Node.js 22.5 or newer** (https://nodejs.org). Then:

```
cd peptide-manager
npm install
npm start
```

Open **http://localhost:3000** in your browser (works on your phone too if you're on the same Wi-Fi — use your computer's IP, e.g. `http://192.168.1.20:3000`).

## Logins (change these after first sign-in)

| Role | Email | Password |
|---|---|---|
| Admin (you) | `admin@peptide.local` | `admin123` |
| Reseller (Angel) | `angel@peptide.local` | `angel123` |

Reset your admin password in **Settings → Admin users**. Reset reseller passwords from the **Resellers** page.

## What's inside

- **Dashboard** — revenue / cost / profit / open value / owed-by-resellers cards, monthly revenue & profit chart, top products, top resellers, low stock, open + recent orders.
- **Orders** — multi-product orders with snapshot pricing (old orders never change when you edit a product), filters by date / customer / reseller / product / status / payment / delivery, CSV export. Completing or delivering an order deducts stock; cancelling restores it.
- **Inventory** — cost / wholesale / retail, on-hand, reserved (by open orders), available, low-stock and out-of-stock badges, stock adjustments with history, CSV export.
- **Resellers** — per-reseller discount (default 22%), balances, order history, logins (create / reset password / disable), "mark balance paid".
- **Payments** — applied to the oldest unpaid orders first, partial payments supported, per-order paid/partial/unpaid status, CSV export of balances.
- **Deliveries** — pending → packed → out for delivery → delivered, plus addresses and notes.
- **Reseller portal** — resellers see only their own orders, their price list and unpaid balance. They never see your cost or profit (unless you turn that on in Settings).
- **Settings** — business name, default discount, currency, low-stock threshold, allow backorders, require payment before delivery, show profit to resellers, disclaimer text, admin users.
- **Activity log** — every important change is audited.

## Good to know

- Data lives in `data/app.db` (SQLite). **Back it up by copying that file.**
- `npm run reset-db` deletes the database; the next `npm start` re-creates it with the starter products and sample orders.
- The seeded sample orders are flagged as already deducted from stock, since the starter on-hand counts already reflect those past sales.
- The database has a `customer` role reserved in the users table, so a customer login portal can be added later without schema changes.
