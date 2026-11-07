# InvoicePilot — AI invoicing agent on PayPal

Freelancers lose hours writing invoices and chasing late payments. InvoicePilot turns a plain-English
message ("Bill Acme 40 hrs at $25, due in 15 days") into a real PayPal invoice, with a human
approval step, and then helps you get paid.

## Features
- **AI invoice extraction**: Gemini reads a free-text message and fills in the client, line items, currency and due date.
- **Human-in-the-loop approval**: nothing goes to PayPal until you review, edit and approve.
- **Server-side guardrails**: the server recomputes totals (it never trusts the model's math), validates emails and dates, flags missing info and blocks unusually large totals.
- **Real PayPal invoices**: created and sent through the PayPal Invoicing v2 API, with a hosted payer link.
- **Live dashboard**: shows paid, outstanding and overdue amounts, and flags overdue invoices.
- **AI payment reminders**: friendly or firm tone, editable, sent through PayPal's remind endpoint.
- **Ask your invoices**: "Who owes me the most?" The answer is grounded in pre-computed totals, so the model can't hallucinate numbers.

## Tech stack (all free)
Node.js + Express · vanilla JS frontend · PayPal Invoicing API (sandbox) · Google Gemini API (free tier) · Render (free hosting)

## Run locally
```bash
npm install
# open env.txt and paste your PayPal sandbox + Gemini keys
npm start                # open http://localhost:3000
```

## Deploy free on Render
1. Push this folder to a GitHub repo. `.env` is git-ignored, so your keys stay private.
2. On render.com, choose New → Web Service → connect the repo.
3. Build command: `npm install` · Start command: `npm start` · Instance type: **Free**
4. Under Environment, add `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox`,
   `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-2.5-flash`, `INVOICER_NAME`.
5. Deploy. The free tier sleeps when idle, so open the URL a minute before you demo.

## Testing payments in the sandbox
- Use a **sandbox Personal account email** (Developer Dashboard → Testing Tools → Sandbox Accounts)
  as the client email.
- Sandbox doesn't deliver real emails. Click **Open payer link**, log in with that sandbox
  personal account and pay. Hit Refresh and the invoice shows **PAID**.
- **Mark paid** records an offline payment (e.g. bank transfer) if you want a quick demo.
