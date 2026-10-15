import { useMemo, useState } from 'react'
import { LoaderCircle, Save, Search, X } from 'lucide-react'
import type { LocalProduct as ProductSummary, ProductEditorOptions, ProductTermField } from '../../types/desktop'
import { productTypeLabels } from './model'

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

function TermPicker({ field, selected, onChange }: { field: ProductTermField; selected: number[]; onChange: (ids: number[]) => void }) {
  const [filter, setFilter] = useState('')
  const visible = field.terms.filter((term) => !filter || term.path.toLowerCase().includes(filter.toLowerCase()))
  if (!field.multiple) return <label className="auth-field"><span>{field.label}</span>
    <select value={selected[0] ?? 0} onChange={(event) => onChange(Number(event.target.value) ? [Number(event.target.value)] : [])}>
      <option value={0}>— keine —</option>
      {field.terms.map((term) => <option key={term.id} value={term.id}>{'  '.repeat(term.depth)}{term.name}</option>)}
    </select>
  </label>
  return <fieldset className="product-term-picker">
    <legend>{field.label}{selected.length ? ` (${selected.length})` : ''}</legend>
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

export function ProductEditor({ product, options, busy, error, onCancel, onSave }: {
  product: ProductSummary
  options: ProductEditorOptions
  busy: boolean
  error: string
  onCancel: () => void
  onSave: (values: Record<string, unknown>, terms: Record<string, number[] | number>) => void
}) {
  const variation = product.parentId !== null
  const initial = useMemo(() => initialValues(product.payload), [product])
  const termFields = options.termFields.filter((field) => field.scope === (variation ? 'variation' : 'product'))
  const initialTerms = useMemo<Terms>(() => Object.fromEntries(options.termFields.map((field) => [field.field, termIds(product.payload[field.field])])), [options, product])
  const [values, setValues] = useState(initial)
  const [terms, setTerms] = useState<Terms>(initialTerms)
  const set = <Key extends keyof Values>(key: Key, value: Values[Key]) => setValues({ ...values, [key]: value })

  function submit(event: React.FormEvent) {
    event.preventDefault()
    // Only fields the user actually changed are sent; the main process validates them again.
    const changed: Record<string, unknown> = {}
    for (const key of ['name', 'sku', 'status', 'short_description', 'description', 'regular_price', 'sale_price', 'weight', 'shipping_class', 'manage_stock', 'stock_status'] as const)
      if (values[key] !== initial[key] && !(variation && (key === 'name' || key === 'short_description'))) changed[key] = values[key]
    if (values.stock_quantity !== initial.stock_quantity) changed.stock_quantity = values.stock_quantity.trim() === '' ? null : Number(values.stock_quantity)
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
          {!variation && <label className="auth-field"><span>Kurzbeschreibung</span><textarea rows={3} value={values.short_description} onChange={(event) => set('short_description', event.target.value)} /></label>}
          <label className="auth-field"><span>Beschreibung</span><textarea rows={variation ? 3 : 6} value={values.description} onChange={(event) => set('description', event.target.value)} /></label>
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
        {termFields.length > 0 && <section className="product-editor-section" aria-label="Zuordnungen">
          <h3>Zuordnungen</h3>
          <div className="product-editor-terms">
            {termFields.map((field) => <TermPicker key={field.field} field={field} selected={terms[field.field] ?? []} onChange={(ids) => setTerms({ ...terms, [field.field]: ids })} />)}
          </div>
        </section>}
      </fieldset>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <footer><button className="button" type="button" disabled={busy} onClick={onCancel}>Abbrechen</button><button className="button primary" disabled={busy || (!variation && !values.name.trim())}>{busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Speichern</button></footer>
    </form>
  </section></div>
}
