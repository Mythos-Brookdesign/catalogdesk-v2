import { useCallback, useEffect, useState } from 'react'
import { Boxes, ChevronDown, ChevronLeft, ChevronRight, CloudOff, DownloadCloud, LoaderCircle, Pencil, RefreshCw, Search, SlidersHorizontal, Undo2, X } from 'lucide-react'
import { productFieldLabels, productPrice, productFieldValue, productStatusLabels, productStock, productTypeLabels, type ProductPage, type ProductSummary } from './model'
import type { ProductChangeResult, ProductEditorOptions, ProductImportProgress, ProductTermField, TaxonomyTermOption, WorkspaceSummary } from '../../types/desktop'
import { ProductEditor, type NewTerm } from './ProductEditor'
import { toProductImage } from './media'
import { CachedImage } from './ProductImages'
import { useNotify } from '../../components/notifications/notifications'
import './ProductsPage.css'

type DesktopApi = NonNullable<Window['catalogDesk']>

function Price({ product, currency }: { product: ProductSummary; currency?: string | null }) {
  const price = productPrice(product, currency)
  if (price.kind === 'none') return <span className="price-empty">—</span>
  if (price.kind === 'range') return <span className="price-range">{price.min} – {price.max}</span>
  if (price.kind === 'sale') return <span className="price-sale"><del aria-label={`Regulaerer Preis ${price.regular}`}>{price.regular}</del><strong aria-label={`Angebotspreis ${price.sale}`}>{price.sale}</strong></span>
  return <span>{price.price}</span>
}
const pageSize = 50

// Product image (or variation image) in the list; queued edits are already merged into the payload.
function ProductThumb({ product }: { product: ProductSummary }) {
  const image = toProductImage(product.parentId ? product.payload.image : Array.isArray(product.payload.images) ? product.payload.images[0] : null)
  if (!image || image.id < 0 || !image.src) return product.parentId ? null : <span className="product-thumb empty"><Boxes size={15} /></span>
  return <span className="product-thumb"><CachedImage id={image.id} fallback={image.src} /></span>
}

export function ProductsPage({ desktop, canCreateTerms = false }: { desktop?: DesktopApi; canCreateTerms?: boolean }) {
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null)
  const [page, setPage] = useState<ProductPage | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [type, setType] = useState('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editing, setEditing] = useState<ProductSummary | null>(null)
  const [editorOptions, setEditorOptions] = useState<ProductEditorOptions | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [resolutions, setResolutions] = useState<Record<string, 'mine' | 'shop'>>({})
  const [version, setVersion] = useState(0)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<ProductImportProgress | null>(null)
  const notify = useNotify()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    Promise.all([desktop.workspaceSummary(), desktop.listProducts({ query, type, page: pageIndex, pageSize })])
      .then(([workspace, products]) => {
        if (cancelled) return
        setSummary(workspace)
        setPage(products)
        setFailed(false)
      })
      .catch((reason) => {
        if (cancelled) return
        setFailed(true)
        notify.error('Katalog nicht geladen', { message: reason instanceof Error ? reason.message : 'Lokaler Katalog nicht verfuegbar.', key: 'products-load' })
      })
    return () => { cancelled = true }
  }, [desktop, query, type, pageIndex, version, notify])

  useEffect(() => desktop?.onProductImportProgress(setProgress), [desktop])
  const reload = useCallback(() => setVersion((value) => value + 1), [])
  useEffect(() => desktop?.onProductsChanged(reload), [desktop, reload])

  const selected = page?.products.find((product) => product.id === selectedId) ?? null
  function select(product: ProductSummary) { setSelectedId(product.id); setResolutions({}) }
  const fieldLabel = (field: string) => productFieldLabels[field] ?? editorOptions?.termFields.find((entry) => entry.field === field)?.label ?? editorOptions?.metaFields.find((entry) => entry.field === field)?.label ?? field

  const sync = useCallback(async (retryFailed = false, quiet = false) => {
    if (!desktop) return
    setSyncing(true)
    try {
      const result = await desktop.syncProducts(retryFailed)
      if (!result.ok) throw new Error(result.error)
      const { synced, failed: rejected, conflicts, offline } = result.value
      if (offline) { if (!quiet) notify.warning('Shop nicht erreichbar', { message: 'Die Aenderungen bleiben gespeichert und werden spaeter uebertragen.', key: 'products-sync' }) }
      else if (conflicts) notify.warning('Konflikt mit dem Shop', { message: `${conflicts} ${conflicts === 1 ? 'Produkt wurde' : 'Produkte wurden'} inzwischen im Shop geaendert. Bitte in der Liste entscheiden.`, key: 'products-sync' })
      else if (rejected) notify.error('Synchronisation teilweise abgelehnt', { message: `${synced} uebertragen, ${rejected} vom Shop abgelehnt. Details stehen beim Produkt.`, key: 'products-sync' })
      else if (synced || !quiet) notify.success('Synchronisiert', { message: `${synced} ${synced === 1 ? 'Produktaenderung' : 'Produktaenderungen'} uebertragen.`, key: 'products-sync' })
    } catch (reason) { if (!quiet) notify.error('Synchronisation fehlgeschlagen', { message: reason instanceof Error ? reason.message : undefined, key: 'products-sync' }) }
    finally { setSyncing(false); reload() }
  }, [desktop, notify, reload])

  // Push queued edits as soon as the network returns.
  useEffect(() => {
    const online = () => void sync(false, true)
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [sync])

  // The editor opens only with its options loaded: its term selection starts from them, and an
  // empty selection would otherwise look like removed categories.
  async function openEditor(product: ProductSummary) {
    if (!desktop) return
    setFormError('')
    if (!editorOptions) {
      const result = await desktop.productEditorOptions()
      if (!result.ok) { notify.error('Bearbeitung nicht moeglich', { message: result.error }); return }
      setEditorOptions(result.value)
    }
    setEditing(product)
  }

  function notifyChange(name: string, result: ProductChangeResult) {
    if (!result.queued) notify.info('Keine Aenderung', { message: `„${name}“ entspricht dem Stand im Shop.`, key: 'product-change' })
    else if (!result.sync) notify.info('Lokal gespeichert', { message: `„${name}“ wird uebertragen, sobald die laufende Shopaktion beendet ist.`, key: 'product-change' })
    else if (result.outcome === 'success') notify.success('Im Shop gespeichert', { message: `„${name}“ wurde uebertragen.`, key: 'product-change' })
    else if (result.outcome === 'conflict') notify.warning('Konflikt mit dem Shop', { message: `${result.conflicts.map(fieldLabel).join(', ')} wurde im Shop inzwischen geaendert. Bitte beim Produkt entscheiden.`, key: 'product-change' })
    else if (result.outcome === 'failure') notify.error('Vom Shop abgelehnt', { message: result.error ?? undefined, key: 'product-change' })
    else notify.warning('Offline gespeichert', { message: `„${name}“ wird automatisch uebertragen, sobald der Shop erreichbar ist.`, key: 'product-change' })
  }

  async function save(values: Record<string, unknown>, terms: Record<string, number[] | number>) {
    if (!desktop || !editing || busy) return
    if (!Object.keys(values).length && !Object.keys(terms).length) { setEditing(null); return }
    setBusy(true); setFormError('')
    try {
      const result = await desktop.changeProduct({ productId: editing.id, values, terms })
      if (!result.ok) throw new Error(result.error)
      notifyChange(String(values.name ?? editing.name), result.value)
      setEditing(null)
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : 'Speichern fehlgeschlagen.') }
    finally { setBusy(false); reload() }
  }

  // Creates a term from the product editor through the same queue as the taxonomy page (checks, offline, history).
  async function createTerm(field: ProductTermField, term: NewTerm): Promise<TaxonomyTermOption> {
    if (!desktop) throw new Error('Nur in der Desktop-App verfuegbar.')
    const result = await desktop.changeTaxonomyTerm({ taxonomy: field.taxonomy, operation: 'create', fields: { name: term.name, slug: '', parent: field.hierarchical ? term.parent : 0, description: '' } })
    if (!result.ok) throw new Error(result.error)
    const parent = field.terms.find((entry) => entry.id === term.parent)
    const created: TaxonomyTermOption = { id: result.value.termId, name: term.name, slug: '', path: parent ? `${parent.path} › ${term.name}` : term.name, depth: parent ? parent.depth + 1 : 0 }
    // Every field of the same taxonomy (e.g. both price labels) offers the new term right away.
    setEditorOptions((current) => current && { ...current, termFields: current.termFields.map((entry) => entry.taxonomy === field.taxonomy ? { ...entry, terms: [...entry.terms, created] } : entry) })
    const synced = result.value.sync && !result.value.sync.offline && result.value.termId > 0
    if (synced) notify.success('Begriff angelegt', { message: `„${term.name}“ wurde in ${field.label} im Shop angelegt.`, key: 'product-term' })
    else notify.warning('Begriff lokal angelegt', { message: `„${term.name}“ wird in ${field.label} uebertragen, sobald der Shop erreichbar ist. Das Produkt folgt danach.`, key: 'product-term' })
    return created
  }

  async function discard(product: ProductSummary) {
    if (!desktop) return
    const result = await desktop.discardProductChange(product.id)
    if (!result.ok) notify.error('Nicht verworfen', { message: result.error })
    else notify.info('Aenderung verworfen', { message: `„${product.name}“ entspricht wieder dem Stand im Shop.`, key: 'product-change' })
    reload()
  }

  async function resolve(product: ProductSummary) {
    if (!desktop) return
    setBusy(true)
    try {
      const result = await desktop.resolveProductConflict({ productId: product.id, name: product.name, resolutions })
      if (!result.ok) throw new Error(result.error)
      setResolutions({})
      if (result.value && !result.value.offline && !result.value.conflicts && !result.value.failed) notify.success('Konflikt geloest', { message: `„${product.name}“ ist wieder synchron.`, key: 'product-change' })
      else notify.info('Konflikt geloest', { message: `„${product.name}“ wird mit deiner Entscheidung uebertragen.`, key: 'product-change' })
    } catch (reason) { notify.error('Konflikt nicht geloest', { message: reason instanceof Error ? reason.message : undefined }) }
    finally { setBusy(false); reload() }
  }

  async function runImport() {
    if (!desktop || importing) return
    setImporting(true); setProgress(null)
    try {
      const result = await desktop.importProducts()
      if (!result.ok) throw new Error(result.error)
      const parents = result.value.products - result.value.variations
      notify.success('Produkte importiert', {
        message: `${parents.toLocaleString('de-DE')} Produkte und ${result.value.variations.toLocaleString('de-DE')} Varianten aus ${result.value.latestShopUrl ?? 'dem Shop'} gespeichert.`,
        key: 'products-import',
      })
      setSelectedId(null); setEditorOptions(null); setPageIndex(0); setVersion((value) => value + 1)
    } catch (reason) {
      notify.error('Produktimport fehlgeschlagen', { message: reason instanceof Error ? reason.message : undefined, key: 'products-import' })
    } finally { setImporting(false); setProgress(null) }
  }

  const pages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1
  const counts = page?.changeCounts ?? { pending: 0, failed: 0, conflict: 0 }
  const stateLabel = (product: ProductSummary) => product.changeState === 'conflict' ? 'Konflikt' : product.changeState === 'failed' ? 'Abgelehnt' : product.changeState ? 'Geaendert' : null
  const percent = progress && progress.total ? Math.round((progress.completed / progress.total) * 100) : 0
  return (
    <main className="products-page">
      <header className="products-heading">
        <div>
          <span className="eyebrow">LOKALER KATALOG</span>
          <h1>Produkte</h1>
          <p>{summary?.products
            ? `${(summary.products - summary.variations).toLocaleString('de-DE')} Produkte · ${summary.variable.toLocaleString('de-DE')} variabel · ${summary.variations.toLocaleString('de-DE')} Varianten${summary.latestImportedAt ? ` · Importiert ${new Date(summary.latestImportedAt).toLocaleString('de-DE')}` : ''}`
            : 'Noch kein Produktimport'}</p>
        </div>
        <button className="button primary" disabled={!desktop || importing} onClick={() => void runImport()}>
          {importing ? <LoaderCircle className="spin" size={16} /> : <DownloadCloud size={16} />}Produkte importieren
        </button>
      </header>

      {importing && <div className="products-import-progress" role="status">
        <span><LoaderCircle className="spin" size={15} />{progress?.label ?? 'Import wird gestartet ...'}</span>
        <div className="products-progress-track" aria-hidden="true"><div style={{ width: `${progress?.step === 'saving' ? 100 : percent}%` }} /></div>
      </div>}

      {(counts.pending > 0 || counts.failed > 0 || counts.conflict > 0) && <div className="taxonomy-sync-bar" role="status">
        <CloudOff size={16} />
        <span>{[counts.pending && `${counts.pending} ${counts.pending === 1 ? 'Produktaenderung wartet' : 'Produktaenderungen warten'} auf Uebertragung`, counts.conflict && `${counts.conflict} mit Konflikt`, counts.failed && `${counts.failed} vom Shop abgelehnt`].filter(Boolean).join(' · ')}</span>
        {counts.pending > 0 && <button className="button" disabled={syncing || importing} onClick={() => void sync()}><RefreshCw className={syncing ? 'spin' : ''} size={15} />Jetzt synchronisieren</button>}
        {counts.failed > 0 && <button className="button" disabled={syncing || importing} onClick={() => void sync(true)}><RefreshCw size={15} />Erneut versuchen</button>}
      </div>}

      <section className="products-toolbar" aria-label="Produktfilter">
        <label className="search-box">
          <Search size={16} />
          <input aria-label="Produkte suchen" placeholder="Name oder Artikelnummer" value={query} onChange={(event) => { setQuery(event.target.value); setPageIndex(0) }} />
        </label>
        <label className="type-filter">
          <SlidersHorizontal size={15} />
          <select aria-label="Produkttyp" value={type} onChange={(event) => { setType(event.target.value); setPageIndex(0) }}>
            <option value="all">Alle Typen</option>
            {Object.entries(productTypeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <ChevronDown size={14} />
        </label>
      </section>

      <section className="products-table-wrap" aria-label="Produktliste">
        <div className="products-table-head">
          <span>Produkt</span><span>SKU</span><span>Typ</span><span>Preis</span><span>Lager</span><span>Status</span><span className="visually-hidden">Bearbeiten</span>
        </div>
        {page?.products.length ? (
          <div className="products-list">
            {page.products.map((product) => (
              // The row shows the details; the pencil opens the editor directly.
              <div className={`product-row ${selectedId === product.id ? 'selected' : ''} ${product.parentId ? 'variation' : ''}`} key={product.id} onClick={() => select(product)}>
                <span className="product-name">{product.parentId && <span className="product-branch">↳</span>}<ProductThumb product={product} /><button className="product-name-button" aria-pressed={selectedId === product.id} onClick={(event) => { event.stopPropagation(); select(product) }}>{product.name || 'Unbenanntes Produkt'}</button>{stateLabel(product) && <span className={`term-state ${product.changeState === 'pending' ? 'update' : 'failed'}`}>{stateLabel(product)}</span>}</span>
                <span className="product-sku">{product.sku || '—'}</span>
                <span className="product-type">{productTypeLabels[product.productType] ?? product.productType}</span>
                <span className="product-price"><Price product={product} currency={page.currency} /></span>
                <span className="product-stock">{productStock(product.payload)}</span>
                <span className={`product-status ${product.status}`}>{productStatusLabels[product.status] ?? product.status}</span>
                <span className="product-edit">
                  <button className="icon-button" aria-label={`Bearbeiten: ${product.name}`} title={product.changeState === 'conflict' ? 'Zuerst den Konflikt in den Details loesen' : 'Bearbeiten'}
                    disabled={product.changeState === 'conflict'} onClick={(event) => { event.stopPropagation(); select(product); void openEditor(product) }}><Pencil size={15} /></button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="products-empty">
            <Boxes size={25} strokeWidth={1.5} />
            <h2>{failed ? 'Katalog konnte nicht geladen werden' : query || type !== 'all' ? 'Keine passenden Produkte' : 'Noch keine Produkte lokal gespeichert'}</h2>
            <p>{query || type !== 'all' ? 'Suche oder Filter anpassen.' : '„Produkte importieren“ laedt alle Produkte und Varianten mit ihren Kategorien, Attributen und Plugin-Taxonomien aus dem verbundenen WooCommerce-Shop in die lokale Datenbank.'}</p>
          </div>
        )}
      </section>

      {selected && <aside className="product-inspector" aria-label="Produktdetail">
        <header>
          <div><span className="eyebrow">{selected.parentId ? `VARIANTE VON #${selected.parentId}` : 'PRODUKTDETAIL'}</span><strong>{selected.name}</strong></div>
          <div className="product-inspector-actions">
            {selected.changes && <button className="button" onClick={() => void discard(selected)}><Undo2 size={15} />Aenderung verwerfen</button>}
            <button className="button primary" disabled={selected.changeState === 'conflict'} title={selected.changeState === 'conflict' ? 'Zuerst den Konflikt loesen' : undefined} onClick={() => void openEditor(selected)}><Pencil size={15} />Bearbeiten</button>
            <button className="icon-button" aria-label="Detail schliessen" onClick={() => setSelectedId(null)}><X size={16} /></button>
          </div>
        </header>
        {selected.changeError && <p className="term-error" role="note">{selected.changeError}</p>}
        {selected.changeState === 'conflict' && selected.remote && <section className="product-conflict" aria-label="Konflikt loesen">
          <strong>Diese Felder wurden im Shop geaendert, seit du sie bearbeitet hast. Was soll gelten?</strong>
          <table className="history-changes">
            <thead><tr><th>Feld</th><th>Vorher</th><th>Im Shop jetzt</th><th>Deine Aenderung</th></tr></thead>
            <tbody>{Object.entries(selected.remote).map(([field, remote]) => <tr key={field}>
              <td>{fieldLabel(field)}</td>
              <td className="before">{productFieldValue(field, selected.base?.[field])}</td>
              <td><label className="product-conflict-choice"><input type="radio" name={`conflict-${field}`} checked={resolutions[field] === 'shop'} onChange={() => setResolutions({ ...resolutions, [field]: 'shop' })} />{productFieldValue(field, remote)}</label></td>
              <td><label className="product-conflict-choice"><input type="radio" name={`conflict-${field}`} checked={resolutions[field] === 'mine'} onChange={() => setResolutions({ ...resolutions, [field]: 'mine' })} />{productFieldValue(field, selected.changes?.[field])}</label></td>
            </tr>)}</tbody>
          </table>
          <button className="button primary" disabled={busy || Object.keys(selected.remote).some((field) => !resolutions[field])} onClick={() => void resolve(selected)}>Entscheidung uebernehmen</button>
        </section>}
        {selected.changes && selected.changeState !== 'conflict' && <section className="product-pending" aria-label="Vorgemerkte Aenderungen">
          <strong>{selected.changeState === 'failed' ? 'Nicht uebertragene Aenderungen' : 'Vorgemerkte Aenderungen'}</strong>
          <table className="history-changes">
            <thead><tr><th>Feld</th><th>Im Shop</th><th>Neu</th></tr></thead>
            <tbody>{Object.entries(selected.changes).map(([field, value]) => <tr key={field}><td>{fieldLabel(field)}</td><td className="before">{productFieldValue(field, selected.base?.[field])}</td><td className="after">{productFieldValue(field, value)}</td></tr>)}</tbody>
          </table>
        </section>}
        <dl>
          <dt>ID</dt><dd>{selected.id}</dd>
          <dt>SKU</dt><dd>{selected.sku || '—'}</dd>
          <dt>Typ</dt><dd>{productTypeLabels[selected.productType] ?? selected.productType}</dd>
          <dt>Status</dt><dd>{productStatusLabels[selected.status] ?? selected.status}</dd>
          <dt>Preis</dt><dd><Price product={selected} currency={page?.currency} /></dd>
          <dt>Lager</dt><dd>{productStock(selected.payload)}</dd>
          {Object.entries(selected.terms.reduce<Record<string, string[]>>((groups, term) => ({ ...groups, [term.label]: [...(groups[term.label] ?? []), term.name] }), {}))
            .map(([label, names]) => <div key={label} className="product-inspector-term"><dt>{label}</dt><dd>{names.join(', ')}</dd></div>)}
        </dl>
      </aside>}
      {editing && editorOptions && <ProductEditor product={editing} options={editorOptions} busy={busy} error={formError} onCancel={() => setEditing(null)} onSave={(values, terms) => void save(values, terms)} onCreateTerm={canCreateTerms ? createTerm : undefined}
        siteName={(() => { try { return summary?.latestShopUrl ? new URL(summary.latestShopUrl).host : '' } catch { return '' } })()} />}
      <footer className="products-footer">
        <span>Lokaler Arbeitsbereich</span>
        <span className="products-pager">
          {page ? `Seite ${page.page + 1} von ${pages} · ${page.total.toLocaleString('de-DE')} Datensätze` : 'Verbinde mit lokaler Datenbank …'}
          {page && page.total > page.pageSize && <>
            <button className="icon-button" aria-label="Vorherige Seite" disabled={pageIndex === 0} onClick={() => setPageIndex(pageIndex - 1)}><ChevronLeft size={15} /></button>
            <button className="icon-button" aria-label="Naechste Seite" disabled={pageIndex + 1 >= pages} onClick={() => setPageIndex(pageIndex + 1)}><ChevronRight size={15} /></button>
          </>}
        </span>
      </footer>
    </main>
  )
}
