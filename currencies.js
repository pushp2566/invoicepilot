// Currencies the PayPal REST API accepts.
// Source: https://developer.paypal.com/api/rest/reference/currency-codes/
//
// INR is deliberately absent: PayPal stopped offering domestic payment services
// in India on 1 April 2021. Indian accounts can still send and receive
// internationally, but only in a supported currency such as USD. Passing INR
// gets rejected by PayPal with "Currency Code is not valid".
const SUPPORTED = new Set([
  'AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY',
  'MYR', 'MXN', 'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'RUB', 'SGD', 'SEK',
  'CHF', 'THB', 'USD',
]);

// These reject any fractional amount — sending "100.00" errors out.
const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD']);

const isSupported = (code) => SUPPORTED.has(code);
const decimalsFor = (code) => (ZERO_DECIMAL.has(code) ? 0 : 2);

// Round a number to the precision the currency allows.
const roundAmount = (n, code) =>
  ZERO_DECIMAL.has(code) ? Math.round(n) : Math.round(n * 100) / 100;

// Format a number as the string PayPal expects in a money field.
const formatAmount = (n, code) => Number(n).toFixed(decimalsFor(code));

// Human-readable explanation for a rejected currency.
function unsupportedMessage(code) {
  const base = `PayPal cannot issue invoices in ${code}.`;
  const hint =
    code === 'INR'
      ? ' PayPal ended domestic payment services in India in 2021 — Indian accounts invoice internationally in USD.'
      : '';
  return `${base}${hint} Supported currencies: ${[...SUPPORTED].join(', ')}.`;
}

module.exports = {
  SUPPORTED,
  ZERO_DECIMAL,
  isSupported,
  decimalsFor,
  roundAmount,
  formatAmount,
  unsupportedMessage,
};
