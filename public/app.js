const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur = 'USD') => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n); }
  catch { return `${Number(n).toFixed(2)} ${cur}`; }
};

function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), isErr ? 7000 : 3500);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = old; }
}

// ---------- Draft editor ----------
let items = [];

function renderItems() {
  const cur = $('dCur').value.toUpperCase() || 'USD';
  $('itemRows').innerHTML = items.map((it, i) => `
    <tr>
      <td><input data-i="${i}" data-k="name" value="${esc(it.name)}" /></td>
      <td style="width:70px"><input data-i="${i}" data-k="quantity" type="number" min="0" step="any" value="${esc(it.quantity)}" /></td>
      <td style="width:105px"><select data-i="${i}" data-k="unit">
        ${['HOURS', 'QUANTITY', 'AMOUNT'].map((u) => `<option ${u === it.unit ? 'selected' : ''}>${u}</option>`).join('')}
      </select></td>
      <td style="width:95px"><input data-i="${i}" data-k="unit_price" type="number" min="0" step="0.01" value="${esc(it.unit_price)}" /></td>
      <td class="amt">${money((Number(it.quantity) || 0) * (Number(it.unit_price) || 0), cur)}</td>
      <td><button class="rm" data-rm="${i}" title="Remove">✕</button></td>
    </tr>`).join('');
  updateTotal();
}

function updateTotal() {
  const cur = $('dCur').value.toUpperCase() || 'USD';
  const total = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0);
  $('dTotal').textContent = money(total, cur);
}

$('itemRows').addEventListener('input', (e) => {
  const { i, k } = e.target.dataset;
  if (i === undefined) return;
  items[i][k] = e.target.value;
  if (k !== 'name') {
    e.target.closest('tr').querySelector('.amt').textContent =
      money((Number(items[i].quantity) || 0) * (Number(items[i].unit_price) || 0), $('dCur').value.toUpperCase() || 'USD');
  }
  updateTotal();
});
$('itemRows').addEventListener('click', (e) => {
  if (e.target.dataset.rm !== undefined) { items.splice(Number(e.target.dataset.rm), 1); renderItems(); }
});
$('addItem').onclick = () => { items.push({ name: '', quantity: 1, unit: 'QUANTITY', unit_price: 0 }); renderItems(); };
$('dCur').oninput = renderItems;

function showDraft({ draft, errors, missing }) {
  $('dName').value = draft.client_name || '';
  $('dBiz').value = draft.client_business_name || '';
  $('dEmail').value = draft.client_email || '';
  $('dCur').value = draft.currency || 'USD';
  $('dDue').value = draft.due_date || '';
  $('dNote').value = draft.note || '';
  items = draft.items.map((i) => ({ ...i }));
  const warn = [...new Set([...(missing || []).map((m) => `AI couldn't find: ${m}`), ...(errors || [])])];
  $('warnings').innerHTML = warn.map((w) => `<div class="warning">⚠ ${esc(w)}</div>`).join('');
  $('draftBox').classList.remove('hidden');
  renderItems();
  $('draftBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.querySelectorAll('[data-ex]').forEach((b) => (b.onclick = () => { $('msg').value = b.dataset.ex; }));

$('parseBtn').onclick = () =>
  withBusy($('parseBtn'), 'Reading…', async () => showDraft(await api('/api/parse', { text: $('msg').value })));

$('sendBtn').onclick = () =>
  withBusy($('sendBtn'), 'Sending via PayPal…', async () => {
    const draft = {
      client_name: $('dName').value,
      client_business_name: $('dBiz').value || null,
      client_email: $('dEmail').value,
      currency: $('dCur').value,
      due_date: $('dDue').value,
      note: $('dNote').value,
      items,
    };
    const { invoice } = await api('/api/invoices', { draft });
    toast(`Invoice ${invoice.number} sent to ${invoice.client} ✔`);
    $('draftBox').classList.add('hidden');
    $('msg').value = '';
    loadInvoices();
  });

// ---------- Invoice list ----------
function statusLabel(inv) { return inv.overdue ? 'OVERDUE' : inv.status; }

function renderInvoices(invoices) {
  if (!invoices.length) {
    $('invoiceList').innerHTML = '<p class="muted">No invoices yet — create your first one on the left.</p>';
    return;
  }
  $('invoiceList').innerHTML = invoices.map((inv) => {
    const open = ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status);
    return `
    <div class="inv ${inv.overdue ? 'overdue' : ''}">
      <div class="invTop">
        <div>
          <strong>${esc(inv.client)}</strong>
          <div class="meta">#${esc(inv.number)} · ${money(inv.total, inv.currency)} · due ${esc(inv.dueDate || '—')}
            ${inv.overdue ? ` · <b>${inv.daysOverdue} days overdue</b>` : ''}</div>
        </div>
        <span class="pill ${statusLabel(inv)}">${statusLabel(inv).replace('_', ' ')}</span>
      </div>
      <div class="actions">
        ${inv.payerLink ? `<a href="${esc(inv.payerLink)}" target="_blank" rel="noopener">Open payer link ↗</a>` : ''}
        ${open ? `<button class="ghost" data-remind="${esc(inv.id)}">✉ AI reminder</button>` : ''}
        ${open ? `<button class="ghost" data-paid="${esc(inv.id)}">Mark paid</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderStats(f) {
  $('sCount').textContent = f.totals.invoices;
  $('sPaid').textContent = money(f.totals.paid);
  $('sOut').textContent = money(f.totals.outstanding);
  $('sOver').textContent = money(f.totals.overdue);
}

async function loadInvoices() {
  try {
    const { invoices, facts } = await api('/api/invoices');
    renderInvoices(invoices);
    renderStats(facts);
  } catch (e) {
    $('invoiceList').innerHTML = `<p class="muted">Couldn't load invoices: ${esc(e.message)}</p>`;
  }
}
$('refreshBtn').onclick = () => withBusy($('refreshBtn'), 'Refreshing…', loadInvoices);

$('invoiceList').addEventListener('click', (e) => {
  const remindId = e.target.dataset.remind;
  const paidId = e.target.dataset.paid;
  if (remindId) openReminder(remindId);
  if (paidId) withBusy(e.target, 'Recording…', async () => {
    await api(`/api/invoices/${encodeURIComponent(paidId)}/mark-paid`, {});
    toast('Payment recorded ✔');
    loadInvoices();
  });
});

// ---------- Reminder dialog ----------
let remindFor = null;
async function draftReminder(tone) {
  $('rSubject').value = '';
  $('rNote').value = 'AI is writing a reminder…';
  try {
    const r = await api(`/api/invoices/${encodeURIComponent(remindFor)}/reminder-draft`, { tone });
    $('rSubject').value = r.subject;
    $('rNote').value = r.note;
  } catch (e) { $('rNote').value = ''; toast(e.message, true); }
}
function openReminder(id) { remindFor = id; $('remindDlg').showModal(); draftReminder('friendly'); }
document.querySelectorAll('[data-tone]').forEach((b) => (b.onclick = () => draftReminder(b.dataset.tone)));
$('rSend').onclick = () =>
  withBusy($('rSend'), 'Sending…', async () => {
    await api(`/api/invoices/${encodeURIComponent(remindFor)}/remind`, { subject: $('rSubject').value, note: $('rNote').value });
    $('remindDlg').close();
    toast('Reminder sent via PayPal ✔');
  });

// ---------- Ask ----------
async function ask() {
  await withBusy($('askBtn'), '…', async () => {
    const { answer } = await api('/api/ask', { question: $('question').value });
    $('answer').textContent = answer;
    $('answer').classList.remove('hidden');
  });
}
$('askBtn').onclick = ask;
$('question').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });

// ---------- Boot ----------
(async () => {
  try {
    const h = await api('/api/health');
    const ok = h.paypalConfigured && h.geminiConfigured;
    $('envBadge').textContent = ok ? `PayPal ${h.env} · connected` : 'Keys missing in .env';
    if (!ok) $('envBadge').classList.add('bad');
  } catch { $('envBadge').textContent = 'server offline'; $('envBadge').classList.add('bad'); }
  loadInvoices();
})();
