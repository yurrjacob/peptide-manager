'use strict';
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { seedIfEmpty, backfillDescriptions, archivePastOrders, seedInitialExpense } = require('./src/seed');
const routes = require('./src/routes');

const seeded = seedIfEmpty();
backfillDescriptions();
archivePastOrders();
seedInitialExpense();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api', routes);
app.use(express.static(path.join(__dirname, 'public')));
// SPA fallback: send index.html for any non-API GET
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('  Peptide Manager is running');
  console.log(`  Open:  http://localhost:${PORT}`);
  if (seeded) {
    console.log('');
    console.log('  Fresh database created with seed data. Demo logins:');
    console.log('    Admin:    admin@peptide.local / admin123');
    console.log('    Reseller: angel@peptide.local / angel123');
    console.log('  Change these passwords in Settings after first login.');
  }
  console.log('');
});
