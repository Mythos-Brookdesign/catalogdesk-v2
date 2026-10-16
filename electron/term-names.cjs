// Comparable forms of term names, for the rule "a term exists only once per taxonomy".
// The renderer mirrors this in src/features/taxonomies/termNames.ts for instant feedback.
const nameKey = (value) => String(value).normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE')

// Close to WordPress' sanitize_title with German locale: umlauts become ae/oe/ue, ß becomes ss.
function slugify(value) {
  return String(value).trim().toLocaleLowerCase('de-DE')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// The existing term a new or renamed one would duplicate, or null.
function findDuplicate(terms, { name, slug = '' }, ignoreId = null) {
  const key = nameKey(name)
  const wanted = (slug || slugify(name)).toLowerCase()
  return terms.find((term) => term.id !== ignoreId && (nameKey(term.name) === key || (wanted && String(term.slug ?? '').toLowerCase() === wanted))) ?? null
}

module.exports = { nameKey, slugify, findDuplicate }
