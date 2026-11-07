// Thin wrapper around the PayPal Invoicing v2 REST API.
const BASE =
  process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

let cachedToken = null;

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are missing in .env');
  }
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth failed: ${data.error_description || res.status}`);
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000, scope: data.scope || '' };
  return cachedToken.value;
}

async function pp(method, path, body, extraHeaders = {}, retried = false) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  // A token cached before app permissions changed can be rejected: refresh it once and retry.
  if ((res.status === 401 || res.status === 403) && !retried) {
    cachedToken = null;
    return pp(method, path, body, extraHeaders, true);
  }
  if (!res.ok) {
    const details = (data.details || [])
      .map((d) => `${d.field || ''} ${d.description || d.issue || ''}`.trim())
      .join('; ');
    const err = new Error(`PayPal error (${res.status}): ${details || data.message || text}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const today = () => new Date().toISOString().slice(0, 10);

function splitName(full) {
  const parts = String(full || 'Client').trim().split(/\s+/);
  return { given_name: parts[0], surname: parts.slice(1).join(' ') || undefined };
}

// Turn a PayPal invoice object into the flat shape the UI uses.
function simplify(inv) {
  const d = inv.detail || {};
  const r = (inv.primary_recipients || [])[0]?.billing_info || {};
  const dueDate = d.payment_term?.due_date || null;
  const open = ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status);
  const daysOverdue =
    open && dueDate ? Math.floor((Date.parse(today()) - Date.parse(dueDate)) / 86_400_000) : 0;
  const clientName =
    r.business_name || [r.name?.given_name, r.name?.surname].filter(Boolean).join(' ') || r.email_address || 'Unknown';
  return {
    id: inv.id,
    number: d.invoice_number,
    status: inv.status,
    client: clientName,
    clientEmail: r.email_address || null,
    currency: inv.amount?.currency_code || d.currency_code,
    total: Number(inv.amount?.value || 0),
    due: Number(inv.due_amount?.value ?? inv.amount?.value ?? 0),
    invoiceDate: d.invoice_date || null,
    dueDate,
    overdue: daysOverdue > 0,
    daysOverdue: Math.max(0, daysOverdue),
    payerLink: d.metadata?.recipient_view_url || null,
  };
}

async function createAndSend(draft) {
  const { invoice_number } = await pp('POST', '/v2/invoicing/generate-next-invoice-number');
  const name = splitName(draft.client_name);
  const body = {
    detail: {
      invoice_number,
      currency_code: draft.currency,
      invoice_date: today(),
      note: draft.note || undefined,
      payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: draft.due_date },
    },
    invoicer: process.env.INVOICER_NAME ? { name: splitName(process.env.INVOICER_NAME) } : undefined,
    primary_recipients: [
      {
        billing_info: {
          name,
          business_name: draft.client_business_name || undefined,
          email_address: draft.client_email,
        },
      },
    ],
    items: draft.items.map((i) => ({
      name: i.name.slice(0, 200),
      description: i.description ? i.description.slice(0, 1000) : undefined,
      quantity: String(i.quantity),
      unit_amount: { currency_code: draft.currency, value: i.unit_price.toFixed(2) },
      unit_of_measure: i.unit,
    })),
    configuration: { allow_tip: false, tax_inclusive: false },
  };

  const created = await pp('POST', '/v2/invoicing/invoices', body, { Prefer: 'return=representation' });
  const id = created.id || (created.href || '').split('/').pop();
  await pp('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: true });
  return getInvoice(id);
}

async function getInvoice(id) {
  return simplify(await pp('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`));
}

async function listInvoices() {
  const data = await pp('GET', '/v2/invoicing/invoices?page=1&page_size=100&total_required=true');
  return (data.items || []).map(simplify);
}

async function remind(id, subject, note) {
  await pp('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
    subject: subject.slice(0, 4000),
    note: note.slice(0, 4000),
    send_to_invoicer: true,
    send_to_recipient: true,
  });
}

// Records an offline payment (e.g. bank transfer) — handy for demos.
async function markPaid(id) {
  const inv = await getInvoice(id);
  await pp('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
    method: 'BANK_TRANSFER',
    payment_date: today(),
    amount: { currency_code: inv.currency, value: inv.due.toFixed(2) },
    note: 'Recorded via InvoicePilot',
  });
  return getInvoice(id);
}

async function getScopes() {
  cachedToken = null;
  await getToken();
  return String(cachedToken.scope).split(/\s+/).filter(Boolean).map((u) => u.replace('https://uri.paypal.com/', ''));
}

module.exports = { getScopes, createAndSend, getInvoice, listInvoices, remind, markPaid };
