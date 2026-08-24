// What to put in "expected salary" when the employer is not in your country.
//
// Your figure is one number in one currency. A form in Berlin wants euros, one in Dubai
// wants dirhams, and typing 3000000 into either is a number so wrong it reads as a
// mistake rather than an ask. So the figure is converted — but which conversion you use
// changes the answer enormously, and both answers are defensible:
//
//   MARKET RATE     what your money is worth if you exchange it. ₹30,00,000 ≈ $36,000.
//                   Nobody in the US is hired at that, so asking it underprices you by
//                   a factor of three and is very hard to walk back later.
//
//   PURCHASING POWER what it takes to live the same way there as here. ₹30,00,000 ≈
//                   $130,000, because a rupee buys roughly three and a half times more
//                   in India than a dollar does in the US.
//
// Purchasing power is the honest basis for "what would I need to move", which is what
// the question is really asking, so that is what this returns. But it is a starting
// point, not a market rate for your role in that city — it knows nothing about what the
// job pays. BOTH figures are logged every time, so the number is never a black box, and
// a currency-specific answer you set yourself always wins over anything computed here.
//
// ON THE NUMBERS BELOW
// PPP conversion factors are World Bank ICP (LCU per international $), FX is indicative.
// Both are approximations, both drift, and neither is fetched live — a local-first app
// should not depend on a currency API to fill a form. PPP moves slowly, which is why it
// is the basis; FX is shown for context only. Override any of it per currency by
// answering e.g. "expected salary (USD)" in the answer bank.

const AS_OF = '2024';

// LCU per international dollar. Source: World Bank ICP.
const PPP = {
  INR: 23.1, USD: 1, GBP: 0.70, EUR: 0.73, AED: 2.55, SAR: 1.85, QAR: 2.19,
  SGD: 0.84, AUD: 1.47, CAD: 1.25, CHF: 1.14, NZD: 1.48, JPY: 100.6,
  ZAR: 7.6, MYR: 1.60, PHP: 19.6, IDR: 4900, THB: 12.2, VND: 7600,
  PLN: 1.85, CZK: 12.6, SEK: 8.9, NOK: 9.8, DKK: 6.7, ILS: 3.7, TRY: 6.9,
  HKD: 5.7, KRW: 861, CNY: 4.2, BRL: 2.5, MXN: 9.5,
};

// Indicative market rate: INR per 1 unit. Context only — never the basis for the answer.
const FX_INR = {
  INR: 1, USD: 83, GBP: 106, EUR: 90, AED: 22.6, SAR: 22.1, QAR: 22.8,
  SGD: 62, AUD: 55, CAD: 61, CHF: 94, NZD: 51, JPY: 0.55,
  ZAR: 4.5, MYR: 18, PHP: 1.45, IDR: 0.0052, THB: 2.3, VND: 0.0033,
  PLN: 21, CZK: 3.6, SEK: 7.9, NOK: 7.7, DKK: 12, ILS: 22, TRY: 2.5,
  HKD: 10.6, KRW: 0.061, CNY: 11.5, BRL: 15, MXN: 4.2,
};

// Country → currency. Only what the boards actually surface.
const CURRENCY_BY_COUNTRY = {
  india: 'INR', 'united states': 'USD', usa: 'USD', 'u.s.': 'USD', america: 'USD',
  'united kingdom': 'GBP', uk: 'GBP', england: 'GBP', scotland: 'GBP', wales: 'GBP', ireland: 'EUR',
  germany: 'EUR', france: 'EUR', spain: 'EUR', italy: 'EUR', netherlands: 'EUR', belgium: 'EUR',
  portugal: 'EUR', austria: 'EUR', finland: 'EUR', greece: 'EUR', luxembourg: 'EUR', estonia: 'EUR',
  'united arab emirates': 'AED', uae: 'AED', dubai: 'AED', 'abu dhabi': 'AED',
  'saudi arabia': 'SAR', qatar: 'QAR', doha: 'QAR',
  singapore: 'SGD', australia: 'AUD', canada: 'CAD', switzerland: 'CHF', 'new zealand': 'NZD',
  japan: 'JPY', 'south africa': 'ZAR', malaysia: 'MYR', philippines: 'PHP', indonesia: 'IDR',
  thailand: 'THB', vietnam: 'VND', poland: 'PLN', czechia: 'CZK', 'czech republic': 'CZK',
  sweden: 'SEK', norway: 'NOK', denmark: 'DKK', israel: 'ILS', turkey: 'TRY', türkiye: 'TRY',
  'hong kong': 'HKD', 'south korea': 'KRW', korea: 'KRW', china: 'CNY', brazil: 'BRL', mexico: 'MXN',
};

// Currency named in the field itself. Strongest signal there is — the form is telling us.
const CODE_RE = /\b(INR|USD|GBP|EUR|AED|SAR|QAR|SGD|AUD|CAD|CHF|NZD|JPY|ZAR|MYR|PHP|IDR|THB|VND|PLN|CZK|SEK|NOK|DKK|ILS|TRY|HKD|KRW|CNY|BRL|MXN)\b/i;
const SYMBOL = { '₹': 'INR', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₩': 'KRW', '₫': 'VND', '₪': 'ILS', '₺': 'TRY' };

/** Is this field asking what you want to be paid? Not what you are paid now. */
export function isSalaryExpectationField(label = '') {
  const s = String(label).toLowerCase();
  if (/\bcurrent\b|\bpresent\b|\bexisting\b|\blast drawn\b/.test(s)) return false;
  return /expected\s*(ctc|salary|compensation|pay|remuneration)|salary\s*expectation|compensation\s*expectation|desired\s*(salary|compensation|pay)|what\s*(salary|compensation).*(expect|seeking)|expected\s*annual/i.test(s);
}

/**
 * Which currency does this field want?
 *
 * The label wins when it says — "Expected CTC in INR" on a job listed in Dubai means
 * rupees, and guessing from the country there would be wrong. Location is the fallback.
 * Returns null when neither is clear, which is a real answer: the caller then asks you
 * rather than picking a currency on your behalf.
 */
export function detectCurrency(label = '', job = {}) {
  const text = String(label);
  const code = text.match(CODE_RE);
  if (code) return { currency: code[1].toUpperCase(), from: 'the field label' };
  for (const [sym, cur] of Object.entries(SYMBOL)) {
    if (text.includes(sym)) return { currency: cur, from: `the ${sym} in the field label` };
  }
  if (/\blakh|\blpa\b|\bcrore\b/i.test(text)) return { currency: 'INR', from: 'the field asking in lakhs' };

  const place = `${job.location || ''} ${job.company || ''}`.toLowerCase();
  if (place.trim()) {
    // Longest country name first, so "united states" is not shadowed by a shorter key.
    const hit = Object.keys(CURRENCY_BY_COUNTRY)
      .sort((a, b) => b.length - a.length)
      .find((c) => place.includes(c));
    if (hit) return { currency: CURRENCY_BY_COUNTRY[hit], from: `the job being in ${hit}` };
  }

  // A bare "$" is not enough on its own — it could be four different currencies, and
  // the difference between USD and SGD is a third of the number.
  if (text.includes('$')) return null;
  return null;
}

/** Round to something a person would actually type. */
export function roundExpectation(n, currency) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Round to roughly three significant figures, on a step that suits the magnitude.
  const step = n >= 1e7 ? 1e6 : n >= 1e6 ? 1e5 : n >= 1e5 ? 5e3 : n >= 1e4 ? 1e3 : n >= 1e3 ? 100 : 10;
  const r = Math.round(n / step) * step;
  return currency === 'JPY' || currency === 'KRW' || currency === 'IDR' || currency === 'VND'
    ? Math.round(r / 1e5) * 1e5 || r
    : r;
}

/**
 * Convert a home-currency expectation into `currency`.
 *
 * @returns {{value:number, currency:string, ppp:number, market:number, ratio:number}|null}
 */
export function convertExpectation(baseAmount, baseCurrency, currency) {
  const from = PPP[baseCurrency];
  const to = PPP[currency];
  if (!from || !to || !Number.isFinite(baseAmount) || baseAmount <= 0) return null;

  // Same purchasing power: home → international dollars → target currency.
  const intl = baseAmount / from;
  const ppp = roundExpectation(intl * to, currency);

  // What a bank would give you. Reported for contrast, never used as the answer.
  const fxFrom = FX_INR[baseCurrency];
  const fxTo = FX_INR[currency];
  const market = fxFrom && fxTo ? roundExpectation((baseAmount * fxFrom) / fxTo, currency) : 0;

  return { value: ppp, currency, ppp, market, ratio: market ? ppp / market : 0 };
}

export function formatAmount(n, currency) {
  return `${currency} ${Number(n).toLocaleString('en-US')}`;
}

/**
 * The answer for a salary-expectation field, or null to leave it to the answer bank.
 *
 * `overrides` is the approved answer bank: a key like "expected salary usd" always beats
 * anything computed, so a figure you have decided on for a market is never second-guessed.
 */
export function salaryAnswer(label, { job = {}, baseAmount, baseCurrency = 'INR', overrides = {} } = {}) {
  if (!isSalaryExpectationField(label)) return null;
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return null;

  const det = detectCurrency(label, job);
  if (!det) {
    return {
      unknownCurrency: true,
      why: 'the form does not say which currency it wants, and the job does not name a country',
    };
  }
  const { currency, from } = det;

  const override = overrides[`expected salary ${currency.toLowerCase()}`]
    || overrides[`expected ctc ${currency.toLowerCase()}`];
  if (override) {
    return { value: String(override), currency, why: `your own ${currency} figure from the answer bank` };
  }

  if (currency === baseCurrency) {
    return { value: String(baseAmount), currency, why: `your usual figure — ${from} means ${currency}` };
  }

  const c = convertExpectation(baseAmount, baseCurrency, currency);
  if (!c) return { unknownCurrency: true, why: `no conversion data for ${currency}` };

  return {
    value: String(c.value),
    currency,
    ppp: c.ppp,
    market: c.market,
    why: `${formatAmount(baseAmount, baseCurrency)} at equal purchasing power = ${formatAmount(c.ppp, currency)}`
      + (c.market ? ` (straight exchange would be ${formatAmount(c.market, currency)})` : '')
      + `; currency from ${from}; PPP ${AS_OF}`,
  };
}
