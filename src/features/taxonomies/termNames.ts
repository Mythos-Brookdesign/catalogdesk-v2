// Mirrors electron/term-names.cjs for instant feedback; Main checks again before saving.
export const nameKey = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE')

export function slugify(value: string) {
  return value.trim().toLocaleLowerCase('de-DE')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function findDuplicate<Term extends { id: number; name: string; slug?: string }>(terms: Term[], name: string, slug = '', ignoreId?: number): Term | null {
  if (!name.trim()) return null
  const key = nameKey(name)
  const wanted = (slug.trim() || slugify(name)).toLowerCase()
  return terms.find((term) => term.id !== ignoreId && (nameKey(term.name) === key || (Boolean(wanted) && (term.slug ?? '').toLowerCase() === wanted))) ?? null
}
