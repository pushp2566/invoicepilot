# InvoicePilot — AI invoicing agent on PayPal

**Live demo (PayPal sandbox):** https://invoicepilot-wine.vercel.app
**Demo video:** https://youtu.be/utlNBZamSPw

Freelancers lose hours writing invoices and chasing late payments. InvoicePilot turns a plain-English message ("Bill Acme 40 hrs at $25, due in 15 days") into a real PayPal invoice, with a human approval step, and then helps you get paid.

---

## How we used PayPal and AI

### PayPal — Invoicing v2 REST API (sandbox)

Auth is OAuth2 `client_credentials`, with the access token cached in memory and one automatic retry that clears the token on a 401/403. All calls live in `paypal.js`.

| What the app does | PayPal endpoint |
| --- | --- |
| Get the next invoice number | `POST /v2/invoicing/generate-next-invoice-number` |
| Create the invoice from the approved draft | `POST /v2/invoicing/invoices` (with `Prefer: return=representation`) |
| Send it to the client | `POST /v2/invoicing/invoices/{id}/send` |
| Build the dashboard totals | `GET /v2/invoicing/invoices` |
| Read one invoice (for reminders) | `GET /v2/invoicing/invoices/{id}` |
| Send a payment reminder | `POST /v2/invoicing/invoices/{id}/remind` |
| Record an offline payment | `POST /v2/invoicing/invoices/{id}/payments` |

`GET /api/debug/scopes` reports which PayPal permissions the app was granted, which is the quickest way to spot a sandbox app that is missing the Invoicing feature.

### AI — Google Gemini (`gemini-2.5-flash`)

Called through the Generative Language REST API with `responseMimeType: application/json` and a response schema, so the model returns structured data rather than prose. All calls live in `gemini.js`.

1. **Invoice extraction** (`extractInvoice`) — turns a free-text client message into a draft: client name, business, email, currency, due date and line items, plus a list of fields it could not find.
2. **Reminder drafting** (`draftReminder`) — writes a payment reminder in a friendly or firm tone from the invoice's own facts.
3. **Question answering** (`answerQuestion`) — answers questions like "Who owes me the most?" using only totals the server has already computed.

---

## Guardrails: the server never trusts the model

AI that touches money needs limits. `validateDraft()` and `buildFacts()` in `server.js` enforce these:

- Every total is recomputed on the server from quantity x price. The model's arithmetic is never used.
- Client email must match an email pattern; an invalid or missing one blocks the invoice.
- A missing or unparseable due date falls back to net-14; a due date in the past is rejected.
- Line items must have a name, a quantity above zero and a price above zero.
- Totals above 50,000 are blocked and flagged for a human to check.
- **Nothing is sent to PayPal until the user clicks Approve.** The AI only ever produces a draft.
- The Ask feature is given pre-computed totals, not raw freedom, so it cannot invent numbers.

---

## Features

- **AI invoice extraction** — Gemini reads a free-text message and fills in the client, line items, currency and due date.
- **Human-in-the-loop approval** — nothing goes to PayPal until you review, edit and approve.
- **Real PayPal invoices** — created and sent through the Invoicing v2 API, with PayPal's hosted payer link.
- **Live dashboard** — paid, outstanding and overdue amounts, with overdue invoices flagged.
- **AI payment reminders** — friendly or firm, editable, sent through PayPal's remind endpoint.
- **Ask your invoices** — "Who owes me the most?", grounded in pre-computed totals.

## Tech stack

Node.js 22 + Express · vanilla JS frontend (no framework, no build step) · PayPal Invoicing v2 API (sandbox) · Google Gemini API · Vercel (free tier). Total running cost: zero.

## Project layout

```
server.js        Express app, API routes, validation and guardrails
paypal.js        PayPal Invoicing v2 client (OAuth, create, send, list, remind, pay)
gemini.js        Gemini client (extraction, reminder drafting, Q&A)
public/          index.html, app.js, style.css — the whole frontend
vercel.json      Vercel serverless config
```

## API routes

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Config check: is PayPal and Gemini wired up? |
| `GET /api/debug/scopes` | Which PayPal scopes were granted |
| `POST /api/parse` | Free text to validated invoice draft (no PayPal call) |
| `POST /api/invoices` | Approved draft to a real, sent PayPal invoice |
| `GET /api/invoices` | Invoice list plus computed totals |
| `POST /api/invoices/:id/reminder-draft` | AI-drafted reminder |
| `POST /api/invoices/:id/remind` | Send the reminder via PayPal |
| `POST /api/invoices/:id/mark-paid` | Record an offline payment |
| `POST /api/ask` | Answer a question about your invoices |

## Run locally

```bash
git clone https://github.com/pushp2566/invoicepilot.git
cd invoicepilot
npm install
cp .env.example .env     # then paste your keys into .env
npm start                # http://localhost:3000
```

Environment variables:

| Name | Value |
| --- | --- |
| `PAYPAL_CLIENT_ID` | From your PayPal sandbox app |
| `PAYPAL_CLIENT_SECRET` | From your PayPal sandbox app |
| `PAYPAL_ENV` | `sandbox` |
| `GEMINI_API_KEY` | From Google AI Studio |
| `GEMINI_MODEL` | `gemini-2.5-flash` |
| `INVOICER_NAME` | Your name, used on the invoice |

Your PayPal sandbox app must have the **Invoicing** feature enabled, or every call returns 403. Check with `GET /api/debug/scopes`: the scope list should contain `services/invoicing`.

## Deploy free on Vercel

1. Push this repo to GitHub.
2. On vercel.com, choose **Add New → Project** and import the repo. The Express preset is detected automatically.
3. Add the six environment variables above under **Environment Variables**. Do not set `PORT`.
4. Deploy. `vercel.json` keeps `public/` bundled with the serverless function.

`.gitignore` excludes `.env` and `env.txt`, so keys never reach the repo.

## Testing payments in the sandbox

- Use a **sandbox Personal account email** (PayPal Developer Dashboard → Testing Tools → Sandbox Accounts) as the client email.
- The sandbox does not deliver real email. Click **Open payer link**, sign in with that sandbox personal account and pay. Hit Refresh and the invoice shows **PAID**.
- **Mark paid** records an offline payment (a bank transfer, say) if you want to see the paid state immediately.

## License

MIT — see [LICENSE](LICENSE).
