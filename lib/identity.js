// Personal information — the facts about you that do not change.
//
// Your name, how to reach you, where you are, and your links. You verify these once and
// they stay put. Everything else in the answer bank is a reply to a question somebody
// asked on a form, and those two things were being kept in one pile.
//
// THE BUG THIS EXISTS TO KILL
// Field keys are canonicalised so "E-mail address", "Email ID" and "Your email" all
// resolve to one answer. The rule matched the LABEL and nothing else, so a question that
// merely mentions email — "Do you consent to email updates?", "Is this your preferred
// email? Yes/No" — also canonicalised to `email`, and its answer was written there.
//
// The result, observed on a real profile:
//
//     email          = "Yes"      instead of an address
//     city           = "Yes"
//     portfolio url  = "Yes"
//     notice period  = "Yes"
//
// An autofill then typed "Yes" into an employer's email box. Nothing detected it,
// because to the bank one approved string is as good as another.
//
// So identity fields carry a SHAPE. An email contains an @ and a dot; a phone number is
// mostly digits; a LinkedIn URL mentions linkedin.com. A value that fails its field's
// shape is not written there — it is kept as the ordinary question-and-answer it always
// was. The check runs when an answer is captured AND again when a form is filled,
// because a bank that is already corrupt should not be able to put "Yes" in an email box
// tomorrow either.

const NO_YES = /^(yes|no|y|n|true|false|n\/?a|not applicable)$/i;

/** Shared floor: nothing that is really a yes/no answer belongs in a personal field. */
function notAYesNo(v) {
  return NO_YES.test(String(v).trim()) ? 'that is a yes/no answer, not a personal detail' : '';
}

const nameLike = (v) => {
  const s = String(v).trim();
  if (notAYesNo(s)) return notAYesNo(s);
  if (s.length < 2 || s.length > 60) return 'a name is between 2 and 60 characters';
  if (/\d/.test(s)) return 'a name should not contain digits';
  if (/@|https?:/i.test(s)) return 'that looks like an address or a link, not a name';
  return '';
};

const placeLike = (v) => {
  const s = String(v).trim();
  if (notAYesNo(s)) return notAYesNo(s);
  if (s.length < 2 || s.length > 80) return 'a place name is between 2 and 80 characters';
  if (/@|https?:/i.test(s)) return 'that looks like an address or a link, not a place';
  return '';
};

const urlLike = (host) => (v) => {
  const s = String(v).trim();
  if (notAYesNo(s)) return notAYesNo(s);
  if (/\s/.test(s)) return 'a link cannot contain spaces';
  if (!/\.[a-z]{2,}/i.test(s)) return 'that does not look like a link';
  if (host && !s.toLowerCase().includes(host)) return `a ${host} link should contain "${host}"`;
  return '';
};

/**
 * The personal fields, in the order they are shown.
 *
 * `key` matches the canonical key the rest of the app already uses, so nothing has to be
 * migrated or looked up twice.
 */
export const IDENTITY_FIELDS = [
  { key: 'full name', label: 'Full name', group: 'You', validate: nameLike, placeholder: 'Ada Lovelace' },
  { key: 'first name', label: 'First name', group: 'You', validate: nameLike, placeholder: 'Ada' },
  { key: 'last name', label: 'Last name', group: 'You', validate: nameLike, placeholder: 'Lovelace' },
  {
    key: 'email',
    label: 'Email address',
    group: 'Contact',
    placeholder: 'you@example.com',
    validate: (v) => {
      const s = String(v).trim();
      if (notAYesNo(s)) return notAYesNo(s);
      return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s) ? '' : 'an email address needs an @ and a domain';
    },
  },
  {
    key: 'phone',
    label: 'Phone number',
    group: 'Contact',
    placeholder: '+44 7700 900123',
    validate: (v) => {
      const s = String(v).trim();
      if (notAYesNo(s)) return notAYesNo(s);
      const digits = s.replace(/\D/g, '');
      if (digits.length < 7) return 'a phone number needs at least 7 digits';
      if (digits.length > 15) return 'that is too long for a phone number';
      return '';
    },
  },
  { key: 'linkedin url', label: 'LinkedIn', group: 'Links', validate: urlLike('linkedin.'), placeholder: 'linkedin.com/in/you' },
  { key: 'github url', label: 'GitHub', group: 'Links', validate: urlLike('github.'), placeholder: 'github.com/you' },
  { key: 'portfolio url', label: 'Portfolio / website', group: 'Links', validate: urlLike(''), placeholder: 'yoursite.com' },
  { key: 'city', label: 'City', group: 'Where you are', validate: placeLike, placeholder: 'Bristol' },
  { key: 'state', label: 'State', group: 'Where you are', validate: placeLike, placeholder: 'Somerset' },
  { key: 'country', label: 'Country', group: 'Where you are', validate: placeLike, placeholder: 'United Kingdom' },
  {
    key: 'zip code',
    label: 'Postal / ZIP code',
    group: 'Where you are',
    placeholder: 'SW1A 1AA',
    validate: (v) => {
      const s = String(v).trim();
      if (notAYesNo(s)) return notAYesNo(s);
      return /^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$/.test(s) ? '' : 'that does not look like a postal code';
    },
  },
  { key: 'nationality', label: 'Nationality', group: 'Where you are', validate: placeLike, placeholder: 'British' },
];

const BY_KEY = new Map(IDENTITY_FIELDS.map((f) => [f.key, f]));

export function isIdentityKey(key) {
  return BY_KEY.has(String(key || '').toLowerCase());
}

export function identityField(key) {
  return BY_KEY.get(String(key || '').toLowerCase()) || null;
}

/**
 * Does `value` belong in the personal field `key`?
 *
 * @returns {{ok: boolean, why: string}}  `why` is written to be shown to a person.
 */
export function validateIdentity(key, value) {
  const f = identityField(key);
  if (!f) return { ok: true, why: '' };
  const v = String(value ?? '').trim();
  if (!v) return { ok: false, why: 'empty' };
  const why = f.validate(v);
  return { ok: !why, why };
}

export const IDENTITY_GROUPS = [...new Set(IDENTITY_FIELDS.map((f) => f.group))];
