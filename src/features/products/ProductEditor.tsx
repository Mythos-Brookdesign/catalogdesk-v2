import { useMemo, useState } from 'react'
import { LoaderCircle, Plus, Save, Search, X } from 'lucide-react'
import type { LocalProduct as ProductSummary, ProductEditorOptions, ProductTermField, TaxonomyTermOption } from '../../types/desktop'
import { findDuplicate } from '../taxonomies/termNames'
import { ModuleFields } from './ModuleFields'
import { metaValue } from './model'
import { productTypeLabels } from './model'
import { RichTextField } from './RichTextField'

type Values = {
  name: string; sku: string; status: string; short_description: string; description: string
  regular_price: string; sale_price: string; manage_stock: boolean; stock_quantity: string; stock_status: string
  weight: string; length: string; width: string; height: string; shipping_class: string
}
type Terms = Record<string, number[]>

const text = (value: unknown) => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value))
const termIds = (value: unknown): number[] => Array.isArray(value)
  ? value.map((entry) => Number(entry?.id)).filter((id) => id > 0)
  : value && typeof value === 'object' && Number((value as { id?: unknown }).id) > 0 ? [Number((value as { id: unknown }).id)] : []

function initialValues(payload: Record<string, unknown>): Values {
  const dimensions = (payload.dimensions ?? {}) as Record<string, unknown>
  return {
    name: text(payload.name), sku: text(payload.sku), status: text(payload.status) || 'publish',
    short_description: text(payload.short_description), description: text(payload.description),
    regular_price: text(payload.regular_price).replace('.', ','), sale_price: text(payload.sale_price).replace('.', ','),
    manage_stock: payload.manage_stock === true, stock_quantity: typeof payload.stock_quantity === 'number' ? String(payload.stock_quantity) : '',
    stock_status: text(payload.stock_status) || 'instock',
    weight: text(payload.weight).replace('.', ','), length: text(dimensions.length).replace('.', ','), width: text(dimensions.width).replace('.', ','), height: text(dimensions.height).replace('.', ','),
    shipping_class: text(payload.shipping_class),
  }
}

export type NewTerm = { name: string; parent: number }

// Small layer above the editor: creates a term in the field's taxonomy right away (like on the taxonomy page).
function NewTermLayer({ field, onCancel, onCreate }: { field: ProductTermField; onCancel: () => void; onCreate: (term: NewTerm) => Promise<void> }) {
  const [name, setName] = useState('')
  const [parent, setParent] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const duplicate = findDuplicate(field.terms, name)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (busy || duplicate || !name.trim()) return
    setBusy(true); setError('')
    try { await onCreate({ name: name.trim(), parent }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Begriff konnte nicht angelegt werden.'); setBusy(false) }
  }
  return <div className="taxonomy-modal-backdrop term-layer-backdrop"><section className="taxonomy-modal term-layer" role="dialog" aria-modal="true" aria-labelledby="new-term-title">
    <header><h2 id="new-term-title">Neuer Begriff: {field.label}</h2><button type="button" className="icon-button" aria-label="Schliessen" disabled={busy} onClick={onCancel}><X size={18} /></button></header>
    <form onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy}>
        <label className="auth-field"><span>Name</span><input required maxLength={200} autoFocus aria-invalid={Boolean(duplicate)} value={name} onChange={(event) => setName(event.target.value)} /></label>
        {duplicate && <p className="auth-error" role="alert">Ein Begriff „{duplicate.name}“ existiert in {field.label} bereits.</p>}
        {field.hierarchical && <label className="auth-field"><span>Uebergeordneter Begriff</span><select value={parent} onChange={(event) => setParent(Number(event.target.value))}>
          <option value={0}>Keiner (oberste Ebene)</option>
          {field.terms.map((term) => <option key={term.id} value={term.id}>{'\u00a0\u00a0'.repeat(term.depth)}{term.name}</option>)}
        </select></label>}
        <p className="taxonomy-hint">Der Begriff wird sofort in der Taxonomie angelegt und diesem Produkt zugeordnet.</p>
      </fieldset>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <footer><button type="button" className="button" disabled={busy} onClick={onCancel}>Abbrechen</button><button className="button primary" disabled={busy || !name.trim() || Boolean(duplicate)}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Anlegen</button></footer>
    </form>
  </section></div>
}

function AddTermButton({ field, onAdd }: { field: ProductTermField; onAdd?: () => void }) {
  if (!onAdd) return null
  return <button type="button" className="icon-button term-add" aria-label={`Neuer Begriff: ${field.label}`} title={`Neuen Begriff in ${field.label} anlegen`} onClick={onAdd}><Plus size={14} /></button>
}

function TermPicker({ field, selected, onChange, onAdd }: { field: ProductTermField; selected: number[]; onChange: (ids: number[]) => void; onAdd?: () => void }) {
  const [filter, setFilter] = useState('')
  const visible = field.terms.filter((term) => !filter || term.path.toLowerCase().includes(filter.toLowerCase()))
  if (!field.multiple) return <div className="auth-field term-single">
    <span className="term-field-label"><label htmlFor={`term-${field.scope}-${field.field}`}>{field.label}</label><AddTermButton field={field} onAdd={onAdd} /></span>
    <select id={`term-${field.scope}-${field.field}`} value={selected[0] ?? 0} onChange={(event) => onChange(Number(event.target.value) ? [Number(event.target.value)] : [])}>
      <option value={0}>— keine —</option>
      {field.terms.map((term) => <option key={term.id} value={term.id}>{'\u00a0\u00a0'.repeat(term.depth)}{term.name}</option>)}
    </select>
  </div>
  return <fieldset className="product-term-picker">
    <legend><span className="term-field-label">{field.label}{selected.length ? ` (${selected.length})` : ''}<AddTermButton field={field} onAdd={onAdd} /></span></legend>
    {field.terms.length > 12 && <label className="search-box"><Search size={14} /><input aria-label={`${field.label} filtern`} placeholder="Filtern" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>}
    <div className="product-term-options">
      {visible.map((term) => <label key={term.id} style={{ paddingLeft: filter ? 0 : term.depth * 16 }}>
        <input type="checkbox" checked={selected.includes(term.id)} onChange={(event) => onChange(event.target.checked ? [...selected, term.id] : selected.filter((id) => id !== term.id))} />
        {filter ? term.path : term.name}
      </label>)}
      {!visible.length && <span className="taxonomy-hint">Keine Begriffe.</span>}
    </div>
  </fieldset>
}

export function ProductEditor({ product, options, busy, error, onCancel, onSave, onCreateTerm, siteName = '' }: {
  product: ProductSummary
  siteName?: string
  options: ProductEditorOptions
  busy: boolean
  error: string
  onCancel: () => void
  onSave: (values: Record<string, unknown>, terms: Record<string, number[] | number>) => void
  // Missing when the user may not edit taxonomies.
  onCreateTerm?: (field: ProductTermField, term: NewTerm) => Promise<TaxonomyTermOption>
}) {
  const [addingTo, setAddingTo] = useState<ProductTermField | null>(null)
  const variation = product.parentId !== null
  const initial = useMemo(() => initialValues(product.payload), [product])
  const termFields = options.termFields.filter((field) => field.scope === (variation ? 'variation' : 'product'))
  const initialTerms = useMemo<Terms>(() => Object.fromEntries(options.termFields.map((field) => [field.field, termIds(product.payload[field.field])])), [options, product])
  const [values, setValues] = useState(initial)
  const metaFields = options.metaFields.filter((field) => field.scopes.includes(variation ? 'variation' : 'product'))
  const initialMeta = useMemo(() => Object.fromEntries(options.metaFields.map((field) => [field.field, metaValue(product.payload, field.field)])), [options, product])
  const [meta, setMeta] = useState<Record<string, string>>(initialMeta)
  const [terms, setTerms] = useState<Terms>(initialTerms)
  const set = <Key extends keyof Values>(key: Key, value: Values[Key]) => setValues({ ...values, [key]: value })

  function submit(event: React.FormEvent) {
    event.preventDefault()
    // Only fields the user actually changed are sent; the main process validates them again.
    const changed: Record<string, unknown> = {}
    for (const key of ['name', 'sku', 'status', 'short_description', 'description', 'regular_price', 'sale_price', 'weight', 'shipping_class', 'manage_stock', 'stock_status'] as const)
      if (values[key] !== initial[key] && !(variation && (key === 'name' || key === 'short_description'))) changed[key] = values[key]
    if (values.stock_quantity !== initial.stock_quantity) changed.stock_quantity = values.stock_quantity.trim() === '' ? null : Number(values.stock_quantity)
    for (const field of metaFields) if ((meta[field.field] ?? '') !== (initialMeta[field.field] ?? '')) changed[field.field] = meta[field.field] ?? ''
    if (['length', 'width', 'height'].some((key) => values[key as keyof Values] !== initial[key as keyof Values]))
      changed.dimensions = { length: values.length, width: values.width, height: values.height }
    const changedTerms: Record<string, number[] | number> = {}
    for (const field of termFields) {
      const next = [...(terms[field.field] ?? [])].sort()
      if (next.join(',') !== [...(initialTerms[field.field] ?? [])].sort().join(',')) changedTerms[field.field] = field.multiple ? next : next[0] ?? 0
    }
    onSave(changed, changedTerms)
  }

  return <div className="taxonomy-modal-backdrop"><section className="taxonomy-modal product-editor" role="dialog" aria-modal="true" aria-labelledby="product-editor-title">
    <header>
      <div><span className="eyebrow">{variation ? `VARIANTE VON #${product.parentId}` : (productTypeLabels[product.productType] ?? product.productType).toUpperCase()}</span><h2 id="product-editor-title">{variation ? product.name : 'Produkt bearbeiten'}</h2></div>
      <button className="icon-button" aria-label="Schliessen" disabled={busy} onClick={onCancel}><X size={18} /></button>
    </header>
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <section className="product-editor-section" aria-label="Allgemein">
          <h3>Allgemein</h3>
          {!variation && <label className="auth-field"><span>Name</span><input required maxLength={1000} value={values.name} onChange={(event) => set('name', event.target.value)} /></label>}
          <div className="product-editor-grid">
            <label className="auth-field"><span>Artikelnummer</span><input maxLength={100} spellCheck={false} value={values.sku} onChange={(event) => set('sku', event.target.value)} /></label>
            <label className="auth-field"><span>Status</span><select value={values.status} onChange={(event) => set('status', event.target.value)}>
              <option value="publish">Veroeffentlicht</option>
              {!variation && <><option value="draft">Entwurf</option><option value="pending">Ausstehend</option></>}
              <option value="private">Privat</option>
            </select></label>
          </div>
          {!variation && <RichTextField label="Kurzbeschreibung" compact disabled={busy} value={values.short_description} onChange={(html) => set('short_description', html)} />}
          <RichTextField label="Beschreibung" compact={variation} disabled={busy} value={values.description} onChange={(html) => set('description', html)} />
        </section>
        {product.productType !== 'variable' && product.productType !== 'grouped' && <section className="product-editor-section" aria-label="Preise">
          <h3>Preise</h3>
          <div className="product-editor-grid">
            <label className="auth-field"><span>Regulaerer Preis</span><input inputMode="decimal" placeholder="0,00" value={values.regular_price} onChange={(event) => set('regular_price', event.target.value)} /></label>
            <label className="auth-field"><span>Angebotspreis</span><input inputMode="decimal" placeholder="leer = kein Angebot" value={values.sale_price} onChange={(event) => set('sale_price', event.target.value)} /></label>
          </div>
        </section>}
        <section className="product-editor-section" aria-label="Lager">
          <h3>Lager</h3>
          <label className="product-editor-check"><input type="checkbox" checked={values.manage_stock} onChange={(event) => set('manage_stock', event.target.checked)} />Bestand verwalten</label>
          <div className="product-editor-grid">
            {values.manage_stock
              ? <label className="auth-field"><span>Bestand</span><input type="number" step={1} value={values.stock_quantity} onChange={(event) => set('stock_quantity', event.target.value)} /></label>
              : <label className="auth-field"><span>Lagerstatus</span><select value={values.stock_status} onChange={(event) => set('stock_status', event.target.value)}>
                <option value="instock">Vorraetig</option><option value="outofstock">Nicht vorraetig</option><option value="onbackorder">Lieferrueckstand</option>
              </select></label>}
          </div>
        </section>
        <section className="product-editor-section" aria-label="Versand">
          <h3>Versand</h3>
          <div className="product-editor-grid four">
            <label className="auth-field"><span>Gewicht</span><input inputMode="decimal" value={values.weight} onChange={(event) => set('weight', event.target.value)} /></label>
            <label className="auth-field"><span>Laenge</span><input inputMode="decimal" value={values.length} onChange={(event) => set('length', event.target.value)} /></label>
            <label className="auth-field"><span>Breite</span><input inputMode="decimal" value={values.width} onChange={(event) => set('width', event.target.value)} /></label>
            <label className="auth-field"><span>Hoehe</span><input inputMode="decimal" value={values.height} onChange={(event) => set('height', event.target.value)} /></label>
          </div>
          <label className="auth-field"><span>Versandklasse</span><select value={values.shipping_class} onChange={(event) => set('shipping_class', event.target.value)}>
            <option value="">{variation ? 'Wie Elternprodukt' : 'Keine Versandklasse'}</option>
            {options.shippingClasses.map((entry) => <option key={entry.slug} value={entry.slug}>{entry.name}</option>)}
          </select></label>
        </section>
        {/* Core term fields under "Zuordnungen"; fields of plugin modules in their own section (e.g. Germanized). */}
        {[...new Set(termFields.map((field) => field.section))].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b))).map((section) => <section key={section ?? 'core'} className="product-editor-section" aria-label={section ?? 'Zuordnungen'}>
          <h3>{section ?? 'Zuordnungen'}</h3>
          <div className="product-editor-terms">
            {termFields.filter((field) => field.section === section).map((field) => <TermPicker key={field.field} field={field} selected={terms[field.field] ?? []} onChange={(ids) => setTerms({ ...terms, [field.field]: ids })}
              onAdd={onCreateTerm && field.editable ? () => setAddingTo(field) : undefined} />)}
          </div>
        </section>)}
        {metaFields.length > 0 && <ModuleFields fields={metaFields} previews={variation ? [] : options.previews} values={meta} onChange={(field, value) => setMeta({ ...meta, [field]: value })}
          termFields={options.termFields.filter((field) => field.scope === 'product')} selectedTerms={terms} productName={values.name || product.name} shortDescription={values.short_description}
          permalink={typeof product.payload.permalink === 'string' ? product.payload.permalink : ''} siteName={siteName} disabled={busy} />}
      </fieldset>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <footer><button className="button" type="button" disabled={busy} onClick={onCancel}>Abbrechen</button><button className="button primary" disabled={busy || (!variation && !values.name.trim())}>{busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Speichern</button></footer>
    </form>
      {addingTo && onCreateTerm && <NewTermLayer field={addingTo} onCancel={() => setAddingTo(null)} onCreate={async (term) => {
        const created = await onCreateTerm(addingTo, term)
        // Select the new term: added to a list, or replacing the single value.
        setTerms((current) => ({ ...current, [addingTo.field]: addingTo.multiple ? [...(current[addingTo.field] ?? []), created.id] : [created.id] }))
        setAddingTo(null)
      }} />}
  </section></div>
}
