import { Fragment } from 'react'
import type { PendingMedia, ProductMetaField, ProductPreview, ProductTermField } from '../../types/desktop'
import { RichTextField } from './RichTextField'
import { SingleImageField } from './ProductImages'
import type { PendingMap } from './media'

const plain = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim() ?? ''

function Counter({ value, recommended, minimum }: { value: string; recommended?: number; minimum?: number }) {
  if (!recommended) return null
  const length = value.length
  const state = !length ? 'empty' : length > recommended ? 'long' : minimum && length < minimum ? 'short' : 'good'
  const hint = { empty: 'leer', long: 'zu lang', short: 'eher kurz', good: 'gut' }[state]
  return <span className={`meta-counter ${state}`} aria-live="polite">{length} / {recommended} · {hint}</span>
}

// Yoast's variables resolved with the product's own data; the site's separator and name settings
// are not known to the app, so this is an approximation.
function resolver(productName: string, shortDescription: string, siteName: string) {
  return (template: string) => template
    .replace(/%%title%%/g, productName).replace(/%%sitename%%/g, siteName).replace(/%%sep%%/g, '–')
    .replace(/%%excerpt%%/g, plain(shortDescription)).replace(/%%[a-z_]+%%/g, '').replace(/\s+/g, ' ').trim()
}

function SearchSnippet({ preview, values, productName, shortDescription, permalink, siteName }: {
  preview: ProductPreview; values: Record<string, string>; productName: string; shortDescription: string; permalink: string; siteName: string
}) {
  const resolve = resolver(productName, shortDescription, siteName)
  const title = resolve((preview.title && values[preview.title]) || '%%title%% %%sep%% %%sitename%%')
  const description = resolve((preview.description && values[preview.description]) || '') || plain(shortDescription)
  const cut = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1).trimEnd()} …` : value
  let address = permalink
  try { const url = new URL(permalink); address = `${url.host}${url.pathname.replace(/\/$/, '').split('/').join(' › ')}` } catch { /* keep as is */ }
  return <figure className="search-snippet" aria-label="Google-Vorschau">
    <figcaption>Google-Vorschau (ungefaehr)</figcaption>
    <span className="search-snippet-url">{address || siteName}</span>
    <strong className="search-snippet-title">{cut(title, 60)}</strong>
    <span className="search-snippet-description">{description ? cut(description, 156) : 'Keine Meta-Beschreibung: Google waehlt selbst einen Textausschnitt.'}</span>
  </figure>
}

// Editor sections of plugin modules that store product meta (e.g. Yoast SEO).
export function ModuleFields({ fields, previews, values, onChange, termFields, selectedTerms, productName, shortDescription, permalink, siteName, disabled = false, pending, onPendingAdded }: {
  fields: ProductMetaField[]; previews: ProductPreview[]; values: Record<string, string>; onChange: (field: string, value: string) => void
  termFields: ProductTermField[]; selectedTerms: Record<string, number[]>; productName: string; shortDescription: string; permalink: string; siteName: string; disabled?: boolean
  pending: PendingMap; onPendingAdded: (entry: PendingMedia) => void
}) {
  const sections = [...new Set(fields.map((field) => field.section))]
  // Length hints count what search engines show: the resolved title and description.
  const resolve = resolver(productName, shortDescription, siteName)
  const shown = (field: string, value: string) => {
    const preview = previews.find((entry) => entry.title === field || entry.description === field)
    if (!preview) return value
    return preview.title === field ? resolve(value || '%%title%% %%sep%% %%sitename%%') : resolve(value)
  }
  return <>{sections.map((section) => <section key={section} className="product-editor-section" aria-label={section}>
    <h3>{section}</h3>
    {previews.filter((preview) => preview.section === section).map((preview) => <SearchSnippet key={preview.module} preview={preview} values={values} productName={productName} shortDescription={shortDescription} permalink={permalink} siteName={siteName} />)}
    {fields.filter((field) => field.section === section && !field.hidden).map((field, index, inSection) => {
      const value = values[field.field] ?? ''
      // Sub-heading where a module's field group starts (e.g. Yoast's "Social" and "Erweitert").
      const heading = field.group && field.group !== inSection[index - 1]?.group ? <h4 key={`group-${field.group}`} className="meta-group">{field.group}</h4> : null
      return <Fragment key={field.field}>{heading}{fieldInput(field, value)}</Fragment>
    })}
  </section>)}</>

  function fieldInput(field: ProductMetaField, value: string) {
    if (field.type === 'image' && field.idField) {
      // URL and media ID are always set together; a negative ID is an upload that waits for the shop.
      const id = Number(values[field.idField] ?? '')
      const image = id || value ? { id: id || 0, src: value, name: '', alt: '' } : null
      return <SingleImageField label={field.label} image={image} pending={pending} onPendingAdded={onPendingAdded} disabled={disabled} hint={field.hint}
        onChange={(next) => { onChange(field.field, next && next.id > 0 ? next.src : ''); onChange(field.idField!, next ? String(next.id) : '') }} />
    }
    if (field.type === 'html') return <div className="meta-field">
      <RichTextField label={field.label} compact disabled={disabled} value={value} onChange={(html) => onChange(field.field, html)} />
      {field.hint && <small className="taxonomy-hint">{field.hint}</small>}
    </div>
    const id = `meta-${field.meta}`
    const label = <span className="meta-label"><label htmlFor={id}>{field.label}</label><Counter value={shown(field.field, value)} recommended={field.recommended} minimum={field.minimum} /></span>
    let input
    if (field.type === 'textarea') input = <textarea id={id} rows={3} maxLength={10_000} value={value} onChange={(event) => onChange(field.field, event.target.value)} />
    else if (field.type === 'flags') {
      const checked = value.split(',').map((entry) => entry.trim())
      input = <div id={id} role="group" aria-label={field.label} className="meta-flags">{field.options?.map((option) => <label key={option.value} className="product-editor-check">
        <input type="checkbox" checked={checked.includes(option.value)} onChange={(event) => onChange(field.field, field.options!.filter((entry) => entry.value === option.value ? event.target.checked : checked.includes(entry.value)).map((entry) => entry.value).join(','))} />
        {option.label}
      </label>)}</div>
    } else if (field.type === 'select') input = <select id={id} value={value} onChange={(event) => onChange(field.field, event.target.value)}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    else if (field.type === 'primaryTerm') {
      // Choices are the terms currently selected in the referenced field (e.g. the product's categories).
      const source = termFields.find((entry) => entry.field === field.of)
      const chosen = (selectedTerms[field.of ?? ''] ?? []).map((termId) => source?.terms.find((term) => term.id === termId)).filter((term) => term && term.id > 0)
      input = <select id={id} value={chosen.some((term) => String(term!.id) === value) ? value : ''} onChange={(event) => onChange(field.field, event.target.value)}>
        <option value="">Automatisch</option>
        {chosen.map((term) => <option key={term!.id} value={String(term!.id)}>{term!.name}</option>)}
      </select>
    } else input = <input id={id} type={field.type === 'url' ? 'url' : 'text'} maxLength={10_000} spellCheck={field.type !== 'url'} placeholder={field.type === 'url' ? 'https://...' : undefined} value={value} onChange={(event) => onChange(field.field, event.target.value)} />
    return <div className="auth-field meta-field">{label}{input}{field.hint && <small className="taxonomy-hint">{field.hint}</small>}</div>
  }
}
