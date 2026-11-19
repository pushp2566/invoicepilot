# InvoicePilot — Interview Preparation Guide

> Context file for an AI tutor. Everything below is verified against the actual source at
> https://github.com/pushp2566/invoicepilot (875 lines across 6 files). Where the project has
> real weaknesses, they are stated plainly rather than hidden — the candidate should be able to
> discuss them openly, because interviewers probe exactly there.

**Live demo:** https://invoicepilot-wine.vercel.app
**Repo:** https://github.com/pushp2566/invoicepilot
**Demo video:** https://youtu.be/utlNBZamSPw
**Built for:** PayPal AI Hackathon 2026 (Devpost), submitted Nov 2026

---

## 1. One-line pitch

A freelancer pastes the message a client sent them in plain English; InvoicePilot turns it into a
real PayPal invoice, chases late payers with AI-drafted reminders, and answers questions about what
is owed — with a human approving everything before money-related calls happen.

**30-second version for an interview:**
> "Freelancers lose hours on invoice admin. InvoicePilot takes a plain-English message like 'Bill Priya
> at Bluepeak, 12 hours of design at $40/hr, due in 10 days', uses Gemini to extract it into a
> structured schema, shows the freelancer an editable draft, and on approval creates and sends a real
> invoice through PayPal's Invoicing v2 API. The interesting part isn't the extraction — it's that the
> server never trusts the model. Every total is recomputed server-side from quantity × price, and
> nothing reaches PayPal without explicit human approval."

---

## 2. Resume bullets this defends

> **Bullet 1:** "Built an AI agent that turns a plain-English client message into a live invoice:
> Gemini 2.5 Flash extracts client, line items and due date into a structured schema, and the
> PayPal Invoicing v2 API creates and sends it."

> **Bullet 2:** "Added server-side guardrails that recompute every total, validate inputs, and require
> human approval before any PayPal call; extended with tone-controlled AI payment reminders and
> grounded natural-language Q&A. Deployed on Vercel."

Every claim above maps to specific code — see §4 and §5. Nothing in the bullets is exaggerated;
the candidate can open the repo in front of the interviewer.

---

## 3. Architecture

```
Browser (vanilla JS, no framework)
        │  fetch() JSON
        ▼
Express app (server.js)  ── validateDraft()   ← guardrails, recomputes totals
        │                └─ buildFacts()      ← precomputed aggregates for Q&A
        ├──────────────► gemini.js  ──► Google Gemini API (gemini-2.5-flash)
        └──────────────► paypal.js  ──► PayPal Invoicing v2 REST (sandbox)
```

**Files and responsibilities**

| File | Lines | Responsibility |
|---|---|---|
| `server.js` | 190 | Routes, validation guardrails, fact precomputation |
| `paypal.js` | 170 | OAuth, token cache, retry, all PayPal calls, response normalization |
| `gemini.js` | 109 | LLM client, JSON schemas, the three prompts |
| `public/app.js` | 214 | UI state, draft editor, invoice list, reminder modal |
| `public/index.html` | 98 | Markup |
| `public/style.css` | 94 | Styling |

**Dependencies: exactly two** — `express` and `dotenv`. No ORM, no database driver, no AI SDK.
The PayPal and Gemini clients are hand-written over `fetch`.

*Why so few dependencies?* Good answer: it's a hackathon project where the integration itself was the
point — wrapping two REST APIs directly kept the code auditable and avoided SDK version churn. Honest
caveat: in production you would want the official SDKs for retry/backoff and typed responses.

---

## 4. The five flows (know these cold)

### Flow 1 — Parse (`POST /api/parse`)
1. User pastes free text → frontend posts `{ text }`.
2. `ai.extractInvoice(text)` calls Gemini with `responseMimeType: 'application/json'` and
   `responseSchema: INVOICE_SCHEMA`, `temperature: 0.1`.
3. Gemini returns structured JSON (client, items, currency, due_date, `missing_fields`).
4. **`validateDraft()` runs on that output** — recomputes total, validates email/date/items.
5. Returns `{ draft, errors, missing }`. **Nothing has touched PayPal yet.**

### Flow 2 — Create & send (`POST /api/invoices`)
1. Frontend posts the (possibly human-edited) draft.
2. **`validateDraft()` runs again** on the submitted draft — the client is not trusted either.
3. If errors → 400, nothing sent.
4. `paypal.createAndSend(draft)`:
   - `POST /v2/invoicing/generate-next-invoice-number` → sequential invoice number
   - `POST /v2/invoicing/invoices` with `Prefer: return=representation`
   - `POST /v2/invoicing/invoices/{id}/send`
   - `GET /v2/invoicing/invoices/{id}` → return normalized object

### Flow 3 — List & stats (`GET /api/invoices`)
- `GET /v2/invoicing/invoices?page=1&page_size=100&total_required=true`
- Each raw invoice → `simplify()` (flattens PayPal's nested shape, computes `daysOverdue`)
- `buildFacts(invoices)` → per-client and overall totals

### Flow 4 — AI reminder (two steps, deliberately)
- `POST /api/invoices/:id/reminder-draft` → Gemini writes `{ subject, note }` for tone
  `friendly` or `firm`. **This does not send anything.**
- Human reads/edits the draft in a modal, then clicks send.
- `POST /api/invoices/:id/remind` → `POST /v2/invoicing/invoices/{id}/remind`

### Flow 5 — Ask (`POST /api/ask`)
1. Fetch invoices → `buildFacts()` computes **every number in JavaScript**.
2. Prompt tells the model: *"All totals are already computed — do not recalculate them, just quote them."*
3. Gemini gets facts + question, returns 2–4 sentences of plain text.

---

## 5. PayPal integration — exact endpoints

| Action | Endpoint |
|---|---|
| Auth | `POST /v1/oauth2/token` (`grant_type=client_credentials`, Basic auth) |
| Next number | `POST /v2/invoicing/generate-next-invoice-number` |
| Create | `POST /v2/invoicing/invoices` (header `Prefer: return=representation`) |
| Send | `POST /v2/invoicing/invoices/{id}/send` |
| Get one | `GET /v2/invoicing/invoices/{id}` |
| List | `GET /v2/invoicing/invoices?page=1&page_size=100&total_required=true` |
| Remind | `POST /v2/invoicing/invoices/{id}/remind` |
| Record payment | `POST /v2/invoicing/invoices/{id}/payments` |

**Token caching** (`paypal.js`):
```js
if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
```
Cached in module scope with a **60-second safety margin** so a token never expires mid-flight.

**401/403 retry-once:**
```js
if ((res.status === 401 || res.status === 403) && !retried) {
  cachedToken = null;
  return pp(method, path, body, extraHeaders, true);
}
```
*Why:* a token minted **before** the Invoicing feature was enabled on the sandbox app stays cached and
keeps failing. Clearing and retrying once fixes it automatically.

**`GET /api/debug/scopes`** — returns which permissions PayPal actually granted, never the secrets.
Built after losing time to a 403 that turned out to be a missing app permission.

---

## 6. The guardrails (the strongest part — lead with this)

All in `validateDraft()` in `server.js`:

1. **Totals are recomputed, never read from the model:**
   ```js
   draft.total = round2(draft.items.reduce((s, i) => s + i.quantity * i.unit_price, 0));
   ```
   The model's arithmetic is discarded entirely.

2. **Email must match a regex** — invoice is rejected without a valid one.

3. **The model is forbidden to invent emails.** Prompt: *"Never invent an email address. If it is not
   present, set client_email to null and list it in missing_fields."* The UI surfaces this as
   "AI couldn't find: client_email".

4. **Due date sanity:** malformed/missing → defaults to net-14; a past date is an error.

5. **Hard cap:** total > 50,000 → blocked.

6. **Validation runs twice** — once on model output, once on the human-submitted draft.

7. **Human approval gate** — `/api/parse` never calls PayPal. Only `/api/invoices`, triggered by an
   explicit click, does.

8. **Grounded Q&A** — `buildFacts()` precomputes everything; the model only quotes numbers.

9. **Payer links stripped before the LLM sees data:**
   ```js
   invoices: invoices.map(({ payerLink, ...rest }) => rest)
   ```
   Payment URLs never go to Google.

**The framing that lands in interviews:**
> "The model is a parser, not a calculator, and never an actor. It converts unstructured text to
> structured data. Arithmetic, validation, and the decision to call PayPal all live in code."

---

## 7. Gemini usage

Three functions, one shared `generate(prompt, schema)` helper.

| Function | Schema? | Temp | Purpose |
|---|---|---|---|
| `extractInvoice` | `INVOICE_SCHEMA` | 0.1 | Text → structured invoice |
| `draftReminder` | `{subject, note}` | 0.1 | Tone-controlled reminder |
| `answerQuestion` | none | 0.4 | Natural-language answer |

**Why two temperatures?** Extraction must be deterministic and repeatable — 0.1. Reminder/answer text
is prose where a little variation reads more natural — 0.4.

**Why `responseSchema` instead of "return JSON" in the prompt?** The API enforces the shape, so there's
no brittle regex-stripping of ```` ```json ```` fences and no parse-failure retry loop.

**Thought-part filtering** — `gemini-2.5-flash` can emit reasoning parts; they're filtered out:
```js
.filter((p) => !p.thought)
```

**`missing_fields`** — the model reports what it couldn't find instead of hallucinating it. A small
pattern worth naming in an interview: *make the model's uncertainty an explicit output field.*

---

## 8. Deployment

- **Vercel Hobby (free), serverless.**
- Required exporting the app instead of always listening:
  ```js
  if (require.main === module) app.listen(port, ...);
  module.exports = app;
  ```
  Locally `require.main === module` is true → server listens. On Vercel the file is imported, so it
  exports a handler instead.
- `vercel.json`: `{"functions": {"server.js": {"includeFiles": "public/**"}}}` — serverless bundling
  excludes unreferenced files, so static assets must be declared.
- Secrets as Vercel environment variables; `.env` and `env.txt` are gitignored.

**Deployment history (good "tell me about a problem" story):** Render required a credit card even on
the free tier; Hugging Face Spaces turned out to charge for Docker Spaces; Vercel worked, but needed
the serverless refactor above.

---

## 9. Known limitations — BE HONEST ABOUT THESE

Interviewers respect a candidate who names their own weaknesses before being asked. All of these are
real and verifiable in the source.

### Critical

**1. No authentication at all.**
There is no auth middleware. Anyone with the public Vercel URL can create and send invoices from the
owner's PayPal sandbox account.
> *Say:* "It's a single-tenant demo on a sandbox account, so there's no real money and no user data at
> risk. But it's the first thing I'd fix for anything real — session auth plus per-user PayPal
> credentials via OAuth, so each freelancer connects their own account."

**2. Multi-currency totals are wrong.**
`buildFacts()` sums `inv.total` across invoices regardless of currency. USD 100 + EUR 100 shows as 200.
The code's own note admits it: *"Amounts are summed as-is; assume a single currency unless invoices say
otherwise."*
> *Say:* "Known bug, documented in the code. The fix is bucketing totals by currency code and either
> reporting per-currency subtotals or converting through an FX rate at a fixed timestamp."

**3. No idempotency on invoice creation.**
`createAndSend` doesn't send PayPal's `PayPal-Request-Id` header. A double-click or network retry can
create two invoices.
> *Say:* "Real gap. PayPal supports an idempotency key header; I'd generate one per draft submission."

### Significant

**4. No database — PayPal is the datastore.** Every list hits the PayPal API; no caching. Simple, but
slow and rate-limit exposed.

**5. No webhooks.** Status only refreshes when the user clicks Refresh. An invoice paid through PayPal
shows stale until then. Webhooks (`INVOICING.INVOICE.PAID`) are the proper fix.

**6. Pagination capped.** `page=1&page_size=100` — only the first page, max 100 invoices. Breaks silently
past that.

**7. No tests.** Zero test files. `validateDraft` and `buildFacts` are exported specifically to be
testable (pure functions, no I/O) — but no tests were written.
> *Say:* "I exported them as pure functions intending to test them and ran out of time. They're the
> obvious first unit tests — totals, email rejection, past-due-date, the 50k cap."

**8. No rate limiting.** Every `/api/parse` and `/api/ask` call hits Gemini. Free-tier quota is
exhaustible, and in production this is a direct cost per request.

### Worth mentioning if asked

**9. Prompt injection surface.** The pasted client message goes into the extraction prompt. A hostile
message could attempt to manipulate extraction.
> *Mitigation already present:* schema constrains output shape, server recomputes all totals, and a
> human approves before sending. So the blast radius is a wrong draft a human sees — not a wrong
> invoice sent silently. That layered answer is strong.

**10. Client emails are sent to Google.** `buildFacts` strips `payerLink` but keeps `clientEmail`, so
the Ask feature transmits client emails to the Gemini API. A privacy-conscious version would redact
them too.

**11. `markPaid` hardcodes `BANK_TRANSFER`** as the payment method regardless of reality.

**12. Error messages pass PayPal's raw text to the client** — fine for a demo, leaks internals in prod.

**13. Module-level token cache in serverless** — each cold start/instance re-authenticates. Correct,
just not shared. Redis would fix it if scale demanded.

---

## 10. Improvements (roadmap answers)

**Immediate (days):** auth + per-user PayPal OAuth; idempotency keys; unit tests on `validateDraft`/
`buildFacts`; currency bucketing; rate limiting.

**Short term (weeks):** webhooks for real-time status; a database for caching and audit history;
full pagination; recurring invoices; partial-payment handling.

**Longer term:** multi-channel intake (email forwarding, WhatsApp, voice); automated reminder schedules
with approval; FX conversion; PDF export; analytics on payment behaviour (which clients pay late).

**If asked "what would you do differently?"**
> "I'd put the schema and validation in TypeScript with a shared type between client and server — I
> wrote the same shape three times in JS. And I'd have written the tests first for `validateDraft`,
> since that function is the whole safety story and it's pure, so it was always the easiest thing to test."

---

## 11. Cross-questions, with answers

**Q: Why not let the model compute the total? It can do arithmetic.**
> Because it can also get it wrong, and this is money. LLM arithmetic is probabilistic; a 1% error rate
> on invoice totals is unacceptable. The multiplication is trivial in JS and correct 100% of the time.
> The model's job is parsing unstructured language, which code is bad at. Each does what it's good at.

**Q: What if Gemini returns something that doesn't match the schema?**
> `responseSchema` is enforced API-side, so shape violations are rare. If JSON.parse still fails it
> throws and the wrapper returns a 400 — the user sees an error rather than a malformed draft. Nothing
> partial reaches PayPal.

**Q: What happens if the PayPal call fails halfway — invoice created but send fails?**
> That's a real gap. Currently it throws and the user sees an error, but a draft invoice exists on
> PayPal's side. Proper fix is either compensating cleanup (delete the draft) or surfacing it as
> "created but not sent" with a retry, since the invoice object is recoverable by ID.

**Q: How do you stop someone sending a $1,000,000 invoice?**
> A hard cap at 50,000 in `validateDraft`. It's crude — hardcoded and currency-blind. In production it
> should be a configurable per-user limit.

**Q: Is the human approval real, or just a UI step?**
> Real, and enforced server-side. `/api/parse` has no PayPal client call in its code path at all. The
> only route that creates an invoice is `/api/invoices`, which requires a POST with a full draft body.
> You cannot reach PayPal through the parse endpoint even by crafting requests.

**Q: Why vanilla JS instead of React?**
> Scope. It's one page with maybe six interactive regions, and a hackathon deadline. No build step
> meant deploying was just pushing files. For anything larger I'd use React — state management in
> `app.js` is manual and would get unwieldy fast.

**Q: Why Gemini over OpenAI/Claude?**
> Free tier with a generous quota via Google AI Studio, and native structured-output support through
> `responseSchema`. The whole project runs at zero cost, which mattered for a hackathon. The client is
> ~40 lines, so swapping providers is contained.

**Q: How would you test this?**
> `validateDraft` and `buildFacts` are pure and already exported — unit tests on totals, email
> validation, past due dates, the cap, and multi-currency (which would fail today, correctly). For the
> API layer, mock `fetch` and assert the right PayPal endpoints are called with the right bodies. An
> integration test against the sandbox for the create→send→remind→pay path.

**Q: Walk me through what happens when I click "Approve and send".**
> Frontend assembles the draft from form fields → `POST /api/invoices` → `validateDraft()` re-validates
> and recomputes the total → if clean, `createAndSend()` requests the next invoice number, creates the
> invoice with `Prefer: return=representation`, sends it, then re-fetches it → normalized object back to
> the client → toast, draft hidden, list refreshed.

**Q: What was the hardest bug?**
> A 403 from PayPal on every call. Credentials were right; the Invoicing feature just wasn't enabled on
> the sandbox app. I added `/api/debug/scopes` to show which permissions were actually granted, and the
> 401/403 retry-once, because a token cached before the permission change stays stale.

**Q: What does "grounded" mean in your Q&A feature?**
> The model never sees raw invoices to reason over freely. `buildFacts()` computes every aggregate in
> JS, and the prompt instructs the model to quote, not calculate. So "Who owes me the most?" is answered
> from a precomputed `byClient` map. The model does language, not math.

**Q: If this got 10,000 users tomorrow, what breaks first?**
> Auth — there isn't any, so it's not multi-tenant at all. Then the PayPal rate limit, since every page
> load hits their API with no caching. Then pagination at 100 invoices. In that order.

---

## 12. Numbers and facts worth memorizing

- **875 lines** total across 6 source files
- **2 npm dependencies** (express, dotenv)
- **8 PayPal endpoints**, **3 Gemini functions**, **9 API routes**
- Model: **gemini-2.5-flash**; temps **0.1** (structured) / **0.4** (prose)
- Token cache margin: **60 seconds**; retry-once on 401/403
- Invoice cap: **50,000**; default payment term: **net-14**
- Deployed on **Vercel Hobby (free)**, PayPal **sandbox**
- License: **MIT**

---

## 13. How to use this file with an AI tutor

Suggested prompts:

- "Quiz me on InvoicePilot. Ask one interview question at a time, wait for my answer, then critique it."
- "Act as a skeptical senior engineer. Attack the design decisions in §6 and make me defend them."
- "I have a 45-minute interview. Build me a 10-minute explanation of this project and drill me on it."
- "Take the limitations in §9 and turn them into the hardest follow-up questions an interviewer could ask."
- "Explain the serverless export pattern in §8 like I've never deployed to Vercel."

**One instruction worth giving the tutor:** *do not let me claim anything not in this file.* The value
of knowing the real limitations is that the candidate never gets caught overstating — which is the
fastest way to lose an interviewer's trust.
