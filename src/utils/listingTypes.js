// src/utils/listingTypes.js
//
// Sale / Rent / Lease listings (Nov 2026). One place for:
//   - the three listing types and how a dealer's reply maps to one
//     ("2", "rent", "kiraye pe", button id "ltype:rent"),
//   - which fields each type needs and the WhatsApp/web-chat questions for
//     them (the FIRST question to a dealer is always "Sell, Rent or Lease?"),
//   - normalising the rent/lease fields before they hit the listings table,
//   - showing a price line ("₹18,000/month + ₹50,000 deposit").
//
// Pure functions only: no database, no model. Unit-tested in
// test/listingTypes.test.js.

const { formatInrShort } = require('./money');

const LISTING_TYPES = ['sale', 'rent', 'lease'];

// Property kinds inside the existing four property_type buckets
// (Plot / Flat / Villa / Commercial). property_type stays the broad bucket so
// every existing filter, search and builder-profile rule keeps working;
// property_subtype says what it actually is.
const PROPERTY_SUBTYPES = [
  'Independent House', 'Independent Floor', 'Flat', 'Room', 'PG',
  'Shop', 'Showroom', 'SCO', 'Office', 'Warehouse', 'Factory', 'Land', 'Plot', 'Other',
];

const FURNISHING = ['unfurnished', 'semi-furnished', 'furnished'];
const PREFERRED_TENANTS = ['family', 'bachelors', 'company', 'any'];

// WhatsApp quick-reply button ids for the first question.
const BUTTON_PREFIX = 'ltype:';

// ----------------------------------------------------------------- parsing

// Roman words use \b; Gurmukhi/Devanagari words can't (JS \b is ASCII-only),
// so they're matched as plain substrings.
const WORDS = [
  ['sale', /\b(?:sell|sale|selling|bech(?:na|ni|ne|o|enge)?|bikri|vech(?:na|ni|o)?|vikri)\b|ਵੇਚ|ਵਿਕਰੀ|बेच|बिक्री/i],
  ['lease', /\b(?:lease|leasing|leased|pagdi|pagri)\b|ਲੀਜ|लीज/i],
  ['rent', /\b(?:rent|rental|renting|to\s*let|tolet|kiray[ae]?|kiraya|kirae|bhada|bhaada)\b|ਕਿਰਾ|किराय|किराए/i],
];
const NUMBER_CHOICE = { 1: 'sale', 2: 'rent', 3: 'lease' };

/**
 * Listing type a message names, or null. `allowNumber` lets a bare "1"/"2"/"3"
 * count (only when the dealer was just shown the 1-2-3 question).
 * Lease is checked before rent: "lease rent 2 lakh" is a lease.
 */
function parseListingType(text, { allowNumber = false } = {}) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.toLowerCase().startsWith(BUTTON_PREFIX)) {
    const v = t.slice(BUTTON_PREFIX.length).toLowerCase();
    return LISTING_TYPES.includes(v) ? v : null;
  }
  if (allowNumber) {
    const digit = t.replace(/[️⃣\s.)!]/g, '').replace(/[१੧]/g, '1').replace(/[२੨]/g, '2').replace(/[३੩]/g, '3');
    if (NUMBER_CHOICE[digit]) return NUMBER_CHOICE[digit];
  }
  for (const [type, re] of WORDS) {
    if (re.test(t)) return type;
  }
  return null;
}

/** True when the whole message is only the choice ("2", "Rent", "kiraye pe", "lease"). */
function isBareListingTypeChoice(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 30) return false;
  if (!parseListingType(t, { allowNumber: true })) return false;
  // Strip the choice words and fillers; nothing meaningful may be left.
  const FILLER = /\b(?:for|sell|sale|selling|bech\w*|vech\w*|rent|rental|to\s*let|tolet|kiray\w*|kirae|bhada|lease|pagdi|pe|par|pr|dena|deni|dene|hai|h|karni|karna|ji|on|it|i|want|to|option)\b/gi;
  const NON_ROMAN_FILLER = /(?:ਵੇਚ|ਵਿਕਰੀ|ਕਿਰਾ|ਲੀਜ|बेच|बिक्री|किराय|किराए|लीज)[\p{L}\p{M}]*|ਹੈ|है|ਤੇ|पे|ਦੇਣਾ|ਦੇਣੀ|देना|देनी/gu;
  const rest = t
    .replace(/^ltype:\w+$/i, '')
    .replace(/[\d️⃣.)!,१२३੧੨੩]/g, ' ')
    .replace(FILLER, ' ')
    .replace(NON_ROMAN_FILLER, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return rest.length === 0;
}

function normalizeListingType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (LISTING_TYPES.includes(v)) return v;
  if (['sell', 'for sale', 'buy'].includes(v)) return 'sale';
  if (['rental', 'to let', 'tolet'].includes(v)) return 'rent';
  return null;
}

// --------------------------------------------------------------- normalise

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const s = String(value).toLowerCase().replace(/[,₹\s]/g, '').replace(/^rs\.?/, '');
  const m = s.match(/^(\d+(?:\.\d+)?)(k|thousand|l|lakh|lakhs|lac|lacs|cr|crore)?$/);
  if (!m) return null;
  const unit = { k: 1e3, thousand: 1e3, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, cr: 1e7, crore: 1e7 }[m[2]] || 1;
  return Math.round(Number(m[1]) * unit);
}

function pick(value, allowed) {
  const v = String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!v) return null;
  if (allowed.includes(v)) return v;
  if (allowed === FURNISHING) {
    if (/semi/.test(v)) return 'semi-furnished';
    if (/un|non|empty|khali/.test(v)) return 'unfurnished';
    if (/full|furnish/.test(v)) return 'furnished';
  }
  if (allowed === PREFERRED_TENANTS) {
    if (/famil|pariwar/.test(v)) return 'family';
    if (/bach|student|single/.test(v)) return 'bachelors';
    if (/compan|corporate|office/.test(v)) return 'company';
    if (/any|all|koi/.test(v)) return 'any';
  }
  return null;
}

function cleanText(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function pickSubtype(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  return PROPERTY_SUBTYPES.find((s) => s.toLowerCase() === v) || null;
}

/**
 * Rent/lease columns for a listings insert/update, from extraction output
 * (snake_case) or a dashboard form. Only keys that were actually given are
 * returned, so an update never blanks a value it wasn't sent.
 */
function rentalColumns(input = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  if (has('listing_type')) {
    const t = normalizeListingType(input.listing_type);
    if (t) out.listing_type = t;
  }
  if (has('monthly_rent')) out.monthly_rent = toNumber(input.monthly_rent);
  if (has('security_deposit')) out.security_deposit = toNumber(input.security_deposit);
  if (has('maintenance_charges')) out.maintenance_charges = toNumber(input.maintenance_charges);
  if (has('furnishing')) out.furnishing = pick(input.furnishing, FURNISHING);
  if (has('preferred_tenant')) out.preferred_tenant = pick(input.preferred_tenant, PREFERRED_TENANTS);
  if (has('available_from')) out.available_from = cleanText(input.available_from, 60);
  if (has('lease_term')) out.lease_term = cleanText(input.lease_term, 60);
  if (has('lock_in')) out.lock_in = cleanText(input.lock_in, 60);
  if (has('rent_escalation_percent')) {
    const n = Number(String(input.rent_escalation_percent ?? '').replace('%', ''));
    out.rent_escalation_percent = input.rent_escalation_percent === null || input.rent_escalation_percent === '' || !Number.isFinite(n) || n < 0 || n > 100 ? null : n;
  }
  if (has('property_subtype')) out.property_subtype = pickSubtype(input.property_subtype);
  return out;
}

/** Same as rentalColumns but drops nulls, for "only apply what the dealer actually said" merges. */
function rentalColumnsNonNull(input = {}) {
  const cols = rentalColumns(input);
  return Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== null && v !== undefined));
}

// --------------------------------------------------------------- questions

const BASE_REQUIRED = ['title', 'raw_address', 'property_type'];

/**
 * Required fields, in the order they're asked. listing_type is always first.
 * Rent/lease also need the monthly rent (a rental without a rent is useless
 * to a tenant); sale price stays optional, exactly as before.
 */
function requiredFieldsFor(listingType) {
  const t = normalizeListingType(listingType);
  if (!t) return ['listing_type', ...BASE_REQUIRED];
  if (t === 'sale') return [...BASE_REQUIRED];
  return [...BASE_REQUIRED, 'monthly_rent'];
}

function missingFields(listingType, extracted = {}) {
  return requiredFieldsFor(listingType).filter((f) => {
    if (f === 'listing_type') return !normalizeListingType(listingType);
    const v = extracted[f];
    return v === null || v === undefined || String(v).trim() === '';
  });
}

const Q = {
  listing_type: {
    hi: 'Yeh property kis liye hai? 👇\n1️⃣ *Sell* (bechni hai)\n2️⃣ *Rent* (kiraye pe deni hai: flat, kothi, floor, room/PG, shop, office)\n3️⃣ *Lease* (commercial/long-term lease: shop, showroom, office, godown, zameen)\n\nNeeche button dabayein ya 1, 2, 3 likhein.',
    en: 'Is this property for sale, rent or lease? 👇\n1️⃣ *Sell*\n2️⃣ *Rent* (flat, house, floor, room/PG, shop, office)\n3️⃣ *Lease* (commercial/long-term: shop, showroom, office, warehouse, land)\n\nTap a button below or reply 1, 2 or 3.',
  },
  raw_address: {
    hi: "Property ka address kya hai? (e.g. 'Plot No. 142-B, Ranjit Avenue, Amritsar' ya 'SCO 145, Sector 34-A, Chandigarh')",
    en: "What's the property address? (e.g. 'Plot No. 142-B, Ranjit Avenue, Amritsar' or 'SCO 145, Sector 34-A, Chandigarh')",
  },
  title: {
    hi: 'Ek chhota sa title de dijiye is listing ke liye.',
    en: 'Give me a short title for this listing.',
  },
  price: {
    hi: 'Price kitni hai? (e.g. 55 lakh)',
    en: "What's the price? (e.g. 55 lakh)",
  },
  property_type_sale: {
    hi: 'Property type kya hai: Plot, Flat, Kothi/House ya Commercial (shop, SCO, office)?',
    en: 'What type of property: Plot, Flat, House/Kothi or Commercial (shop, SCO, office)?',
  },
  property_type_rent: {
    hi: 'Kya kiraye pe dena hai: Flat, Kothi/House, Independent Floor, Room/PG, Shop ya Office?',
    en: 'What is for rent: Flat, House/Kothi, Independent Floor, Room/PG, Shop or Office?',
  },
  property_type_lease: {
    hi: 'Kya lease pe dena hai: Shop, Showroom, SCO, Office, Godown/Warehouse, Factory ya Zameen?',
    en: 'What is for lease: Shop, Showroom, SCO, Office, Warehouse, Factory or Land?',
  },
  monthly_rent_rent: {
    hi: 'Kiraya kitna hai per month? (e.g. 18000 ya 18k)',
    en: "What's the monthly rent? (e.g. 18000 or 18k)",
  },
  monthly_rent_lease: {
    hi: 'Lease rent kitna hai per month? (e.g. 1.5 lakh/month)',
    en: "What's the monthly lease rent? (e.g. 1.5 lakh/month)",
  },
};

const lng = (lang) => (lang === 'en' ? 'en' : 'hi');

function questionFor(field, listingType, lang) {
  const t = normalizeListingType(listingType) || 'sale';
  const key = Q[`${field}_${t}`] ? `${field}_${t}` : field;
  return Q[key] ? Q[key][lng(lang)] : null;
}

/**
 * The next message to send for missing fields. The listing-type question is
 * always asked ALONE (it decides what the rest of the questions are);
 * after that the remaining missing fields are asked together, as before.
 * Returns { body, buttons } (buttons only for the listing-type question).
 */
function nextQuestion(missing, listingType, lang) {
  if (!missing.length) return null;
  if (missing.includes('listing_type')) {
    return {
      body: Q.listing_type[lng(lang)],
      buttons: listingTypeButtons(lang),
    };
  }
  return { body: missing.map((f) => questionFor(f, listingType, lang)).filter(Boolean).join(' '), buttons: undefined };
}

function listingTypeButtons(lang) {
  return lang === 'en'
    ? [{ id: `${BUTTON_PREFIX}sale`, title: 'Sell' }, { id: `${BUTTON_PREFIX}rent`, title: 'Rent' }, { id: `${BUTTON_PREFIX}lease`, title: 'Lease' }]
    : [{ id: `${BUTTON_PREFIX}sale`, title: 'Sell (Bechna)' }, { id: `${BUTTON_PREFIX}rent`, title: 'Rent (Kiraya)' }, { id: `${BUTTON_PREFIX}lease`, title: 'Lease' }];
}

/**
 * One optional follow-up after the required fields, asked once only (any
 * reply, or "skip", moves on). Rent: deposit / furnishing / who it's for /
 * from when. Lease: term / lock-in / yearly increase / deposit.
 * Returns null when there's nothing worth asking (sale, or the dealer
 * already gave most of it).
 */
function detailsQuestion(listingType, extracted = {}, lang) {
  const t = normalizeListingType(listingType);
  const en = lng(lang) === 'en';
  if (t === 'rent') {
    const asks = [];
    if (extracted.security_deposit == null) asks.push(en ? 'security deposit' : 'security deposit kitna');
    if (!extracted.furnishing) asks.push(en ? 'furnished / semi / unfurnished' : 'furnished / semi / unfurnished');
    if (!extracted.preferred_tenant) asks.push(en ? 'for family, bachelors or company' : 'family, bachelors ya company ke liye');
    if (!extracted.available_from) asks.push(en ? 'available from when' : 'kab se available');
    if (asks.length < 2) return null;
    return en
      ? `A few rental details help tenants decide faster (optional): ${asks.join(', ')}?\nSend them in one message, e.g. "deposit 36k, semi furnished, family, 1 Dec". Reply *skip* to continue without them.`
      : `Kiraye ki kuch details tenant ke liye kaam ki hain (optional): ${asks.join(', ')}?\nEk hi message mein bhej dein, jaise "deposit 36k, semi furnished, family, 1 Dec se". Nahi dena to *skip* likhein.`;
  }
  if (t === 'lease') {
    const asks = [];
    if (!extracted.lease_term) asks.push(en ? 'lease term (years)' : 'lease kitne saal ki');
    if (!extracted.lock_in) asks.push(en ? 'lock-in period' : 'lock-in period');
    if (extracted.rent_escalation_percent == null) asks.push(en ? 'yearly rent increase %' : 'har saal kitna % badhega');
    if (extracted.security_deposit == null) asks.push(en ? 'security deposit' : 'security deposit');
    if (asks.length < 2) return null;
    return en
      ? `A few lease details (optional): ${asks.join(', ')}?\nSend them in one message, e.g. "9 years, 3 years lock-in, 5% yearly, deposit 6 months". Reply *skip* to continue without them.`
      : `Lease ki kuch details (optional): ${asks.join(', ')}?\nEk hi message mein bhej dein, jaise "9 saal, 3 saal lock-in, 5% yearly, deposit 6 mahine". Nahi dena to *skip* likhein.`;
  }
  return null;
}

// ------------------------------------------------------------------ display

const LABEL = {
  en: { sale: 'For Sale', rent: 'For Rent', lease: 'For Lease' },
  hi: { sale: 'Sale', rent: 'Rent', lease: 'Lease' },
};

function listingTypeLabel(listingType, lang = 'en') {
  return LABEL[lng(lang) === 'en' ? 'en' : 'hi'][normalizeListingType(listingType) || 'sale'];
}

/** ₹18,000 / ₹1.5 lakh: rent amounts read better in full below a lakh. */
function formatRent(value) {
  return formatInrShort(value);
}

/**
 * Price line for a listing: "₹55 lakh" for a sale, "₹18,000/month" (+
 * deposit) for rent/lease, or null when no amount is known.
 */
function formatListingPrice(listing = {}, { withDeposit = true } = {}) {
  const t = normalizeListingType(listing.listing_type) || 'sale';
  if (t === 'sale') return formatInrShort(listing.price);
  const rent = formatRent(listing.monthly_rent);
  if (!rent) return null;
  const dep = withDeposit ? formatRent(listing.security_deposit) : null;
  return `${rent}/month${dep ? ` + ${dep} deposit` : ''}`;
}

/** Short summary lines of the rent/lease details, for previews and alerts. */
function rentalDetailLines(listing = {}, lang = 'en') {
  const t = normalizeListingType(listing.listing_type);
  if (t !== 'rent' && t !== 'lease') return [];
  const en = lng(lang) === 'en';
  const lines = [];
  if (listing.maintenance_charges != null) lines.push(`${en ? 'Maintenance' : 'Maintenance'}: ${formatRent(listing.maintenance_charges)}/month`);
  if (listing.furnishing) lines.push(`${en ? 'Furnishing' : 'Furnishing'}: ${listing.furnishing}`);
  if (listing.preferred_tenant) lines.push(`${en ? 'For' : 'Kiske liye'}: ${listing.preferred_tenant}`);
  if (listing.available_from) lines.push(`${en ? 'Available from' : 'Kab se'}: ${listing.available_from}`);
  if (listing.lease_term) lines.push(`${en ? 'Lease term' : 'Lease'}: ${listing.lease_term}`);
  if (listing.lock_in) lines.push(`Lock-in: ${listing.lock_in}`);
  if (listing.rent_escalation_percent != null) lines.push(`${en ? 'Yearly increase' : 'Saalana badhotri'}: ${Number(listing.rent_escalation_percent)}%`);
  return lines;
}

/**
 * Monthly rent budgets are thousands, sale budgets lakhs/crores. When a
 * buyer doesn't say buy or rent, a budget under ₹2 lakh is read as a monthly
 * rent ("15k", "25000").
 */
const RENT_BUDGET_CEILING = 200000;
function guessTypeFromBudget(budgetInr) {
  const n = Number(budgetInr);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < RENT_BUDGET_CEILING ? 'rent' : 'sale';
}

module.exports = {
  LISTING_TYPES,
  PROPERTY_SUBTYPES,
  FURNISHING,
  PREFERRED_TENANTS,
  BUTTON_PREFIX,
  parseListingType,
  isBareListingTypeChoice,
  normalizeListingType,
  toNumber,
  rentalColumns,
  rentalColumnsNonNull,
  requiredFieldsFor,
  missingFields,
  questionFor,
  nextQuestion,
  listingTypeButtons,
  detailsQuestion,
  listingTypeLabel,
  formatRent,
  formatListingPrice,
  rentalDetailLines,
  guessTypeFromBudget,
  RENT_BUDGET_CEILING,
};
