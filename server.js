const path = require('path');
// Keys can live in env.txt (easy to see/edit) or .env
require('dotenv').config({ path: path.join(__dirname, 'env.txt') });
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const paypal = require('./paypal');
const ai = require('./gemini');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(err.status && err.status < 500 ? 400 : 500).json({ error: err.message });
  });

const isoDate = (d) => d.toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Server-side guardrails: never trust the model's output blindly.
function validateDraft(d) {
  const errors = [];
  const draft = {
    client_name: String(d.client_name || '').trim(),
    client_business_name: d.client_business_name ? String(d.client_business_name).trim() : null,
    client_email: d.client_email ? String(d.client_email).trim() : null,
    currency: String(d.currency || 'USD').trim().toUpperCase(),
    due_date: d.due_date || null,
    note: d.note ? String(d.note).slice(0, 4000) : null,
    items: [],
  };

  if (!draft.client_name) errors.push('Client name is required.');
  if (!draft.client_email || !EMAIL_RE.test(draft.client_email))
    errors.push('A valid client email is required.');
  if (!/^[A-Z]{3}$/.test(draft.currency)) errors.push('Currency must be a 3-letter code like USD.');

  const todayStr = isoDate(new Date());
  if (!draft.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(draft.due_date) || isNaN(Date.parse(draft.due_date))) {
    draft.due_date = isoDate(new Date(Date.now() + 14 * 86_400_000)); // default net 14
  } else if (draft.due_date < todayStr) {
    errors.push('Due date cannot be in the past.');
  }

  for (const [idx, it] of (d.items || []).entries()) {
    const quantity = Number(it.quantity);
    const unit_price = round2(Number(it.unit_price));
    const unit = ['HOURS', 'QUANTITY', 'AMOUNT'].includes(it.unit) ? it.unit : 'QUANTITY';
    if (!String(it.name || '').trim()) errors.push(`Item ${idx + 1}: name is required.`);
    if (!(quantity > 0)) errors.push(`Item ${idx + 1}: quantity must be > 0.`);
    if (!(unit_price > 0)) errors.push(`Item ${idx + 1}: price must be > 0.`);
    draft.items.push({
      name: String(it.name || '').trim(),
      description: it.description ? String(it.description).trim() : null,
      quantity,
      unit_price,
      unit,
    });
  }
  if (!draft.items.length) errors.push('At least one line item is required.');

  draft.total = round2(draft.items.reduce((s, i) => s + i.quantity * i.unit_price, 0));
  if (draft.total > 50_000) errors.push('Total above 50,000 — please double-check before sending.');
  return { draft, errors };
}

// Pre-computed facts so the model only explains numbers, never computes them.
function buildFacts(invoices) {
  const byClient = {};
  const totals = { invoices: invoices.length, paid: 0, outstanding: 0, overdue: 0 };
  for (const inv of invoices) {
    if (['DRAFT', 'CANCELLED'].includes(inv.status)) continue;
    const c = (byClient[inv.client] ||= { billed: 0, paid: 0, outstanding: 0, overdue: 0, invoices: 0 });
    c.invoices++;
    c.billed = round2(c.billed + inv.total);
    if (inv.status === 'PAID' || inv.status === 'MARKED_AS_PAID') {
      c.paid = round2(c.paid + inv.total);
      totals.paid = round2(totals.paid + inv.total);
    } else {
      c.outstanding = round2(c.outstanding + inv.due);
      totals.outstanding = round2(totals.outstanding + inv.due);
      if (inv.overdue) {
        c.overdue = round2(c.overdue + inv.due);
        totals.overdue = round2(totals.overdue + inv.due);
      }
    }
  }
  return {
    today: isoDate(new Date()),
    note: 'Amounts are summed as-is; assume a single currency unless invoices say otherwise.',
    totals,
    byClient,
    invoices: invoices.map(({ payerLink, ...rest }) => rest),
  };
}

app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    version: 2,
    paypalConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    env: process.env.PAYPAL_ENV || 'sandbox',
  })
);

// Diagnostic: which API permissions did PayPal grant this app? (never returns secrets)
app.get(
  '/api/debug/scopes',
  wrap(async (req, res) => {
    const scopes = await paypal.getScopes();
    res.json({ invoicingGranted: scopes.some((x) => x.includes('invoicing')), scopes });
  })
);

// 1. AI reads a free-text request and proposes an invoice (nothing is sent yet).
app.post(
  '/api/parse',
  wrap(async (req, res) => {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Please paste a message first.' });
    const extracted = await ai.extractInvoice(text);
    const { draft, errors } = validateDraft(extracted);
    res.json({ draft, errors, missing: extracted.missing_fields || [] });
  })
);

// 2. Human-approved draft -> real PayPal invoice, created and sent.
app.post(
  '/api/invoices',
  wrap(async (req, res) => {
    const { draft, errors } = validateDraft(req.body.draft || {});
    if (errors.length) return res.status(400).json({ error: errors.join(' '), errors });
    const invoice = await paypal.createAndSend(draft);
    res.json({ invoice });
  })
);

app.get(
  '/api/invoices',
  wrap(async (req, res) => {
    const invoices = await paypal.listInvoices();
    res.json({ invoices, facts: buildFacts(invoices) });
  })
);

app.post(
  '/api/invoices/:id/reminder-draft',
  wrap(async (req, res) => {
    const inv = await paypal.getInvoice(req.params.id);
    const tone = ['friendly', 'firm'].includes(req.body.tone) ? req.body.tone : 'friendly';
    res.json(await ai.draftReminder(inv, tone));
  })
);

app.post(
  '/api/invoices/:id/remind',
  wrap(async (req, res) => {
    const subject = String(req.body.subject || '').trim();
    const note = String(req.body.note || '').trim();
    if (!subject || !note) return res.status(400).json({ error: 'Subject and note are required.' });
    await paypal.remind(req.params.id, subject, note);
    res.json({ ok: true });
  })
);

app.post(
  '/api/invoices/:id/mark-paid',
  wrap(async (req, res) => res.json({ invoice: await paypal.markPaid(req.params.id) }))
);

app.post(
  '/api/ask',
  wrap(async (req, res) => {
    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Ask a question first.' });
    const invoices = await paypal.listInvoices();
    res.json({ answer: await ai.answerQuestion(question, buildFacts(invoices)) });
  })
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`InvoicePilot running on http://localhost:${port}`));

module.exports = { validateDraft, buildFacts };
