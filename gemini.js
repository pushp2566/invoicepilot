// Minimal Gemini REST client (free tier via Google AI Studio key).
async function generate(prompt, schema) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is missing in .env');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: schema
          ? { temperature: 0.1, responseMimeType: 'application/json', responseSchema: schema }
          : { temperature: 0.4 },
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini error: ${data.error?.message || res.status}`);
  const text = (data.candidates?.[0]?.content?.parts || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) throw new Error('Gemini returned an empty response');
  return schema ? JSON.parse(text) : text;
}

const INVOICE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    client_name: { type: 'STRING', description: 'Contact person or company name' },
    client_business_name: { type: 'STRING', nullable: true },
    client_email: { type: 'STRING', nullable: true },
    currency: { type: 'STRING', description: 'ISO 4217 code, e.g. USD' },
    due_date: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD' },
    note: { type: 'STRING', nullable: true },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          description: { type: 'STRING', nullable: true },
          quantity: { type: 'NUMBER' },
          unit_price: { type: 'NUMBER' },
          unit: { type: 'STRING', enum: ['HOURS', 'QUANTITY', 'AMOUNT'] },
        },
        required: ['name', 'quantity', 'unit_price', 'unit'],
      },
    },
    missing_fields: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Important info not found in the message, e.g. client_email',
    },
  },
  required: ['client_name', 'currency', 'items', 'missing_fields'],
};

function extractInvoice(message) {
  const today = new Date().toISOString().slice(0, 10);
  return generate(
    `You are an invoicing assistant for a freelancer. Today is ${today}.
Extract an invoice from the message below.
Rules:
- Convert relative due dates ("in 15 days", "end of month", "net 30") into an absolute YYYY-MM-DD date.
- If no due date is given, set due_date to null.
- Use unit HOURS for hourly work, QUANTITY for countable things, AMOUNT for a flat fee (quantity 1).
- Never invent an email address. If it is not present, set client_email to null and list it in missing_fields.
- Default currency to USD only if none is mentioned.
- Keep item names short; put details in description.
- note: a short, professional thank-you line for the client (one sentence).

Message:
"""${message.slice(0, 4000)}"""`,
    INVOICE_SCHEMA
  );
}

function draftReminder(inv, tone) {
  return generate(
    `Write a payment reminder for an unpaid invoice. Tone: ${tone}.
Invoice ${inv.number} to ${inv.client}, amount due ${inv.due} ${inv.currency}, due date ${inv.dueDate},
${inv.daysOverdue > 0 ? `${inv.daysOverdue} days overdue` : 'not yet overdue'}.
Keep the note under 90 words, polite and specific, no placeholders like [Your Name]. Sign off as ${process.env.INVOICER_NAME || 'the sender'}.`,
    {
      type: 'OBJECT',
      properties: { subject: { type: 'STRING' }, note: { type: 'STRING' } },
      required: ['subject', 'note'],
    }
  );
}

function answerQuestion(question, facts) {
  return generate(
    `You answer a freelancer's questions about their invoices.
Use ONLY the data below. All totals are already computed — do not recalculate them, just quote them.
If the data cannot answer the question, say so. Be concise (2-4 sentences), use plain text.

DATA (JSON):
${JSON.stringify(facts)}

QUESTION: ${question.slice(0, 1000)}`
  );
}

module.exports = { extractInvoice, draftReminder, answerQuestion };
