import { useEffect, useState } from 'react'
import { Boxes, ChevronDown, ChevronLeft, ChevronRight, DownloadCloud, LoaderCircle, Search, SlidersHorizontal, X } from 'lucide-react'
import { productPrice, productStatusLabels, productStock, productTypeLabels, type ProductPage, type ProductSummary } from './model'
import type { ProductImportProgress, WorkspaceSummary } from '../../types/desktop'
import { useNotify } from '../../components/notifications/notifications'
import './ProductsPage.css'

type DesktopApi = NonNullable<Window['catalogDesk']>
const pageSize = 50

export function ProductsPage({ desktop }: { desktop?: DesktopApi }) {
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null)
  const [page, setPage] = useState<ProductPage | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [type, setType] = useState('all')
  const [selected, setSelected] = useState<ProductSummary | null>(null)
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
      setSelected(null); setPageIndex(0); setVersion((value) => value + 1)
    } catch (reason) {
      notify.error('Produktimport fehlgeschlagen', { message: reason instanceof Error ? reason.message : undefined, key: 'products-import' })
    } finally { setImporting(false); setProgress(null) }
  }

  const pages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1
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
          <span>Produkt</span><span>SKU</span><span>Typ</span><span>Preis</span><span>Lager</span><span>Status</span>
        </div>
        {page?.products.length ? (
          <div className="products-list">
            {page.products.map((product) => (
              <button className={`product-row ${selected?.id === product.id ? 'selected' : ''} ${product.parentId ? 'variation' : ''}`} key={product.id} onClick={() => setSelected(product)}>
                <span className="product-name">{product.parentId ? <span className="product-branch">↳</span> : <Boxes size={17} />}<strong>{product.name || 'Unbenanntes Produkt'}</strong></span>
                <span className="product-sku">{product.sku || '—'}</span>
                <span className="product-type">{productTypeLabels[product.productType] ?? product.productType}</span>
                <span className="product-price">{productPrice(product.payload, page.currency)}</span>
                <span className="product-stock">{productStock(product.payload)}</span>
                <span className={`product-status ${product.status}`}>{productStatusLabels[product.status] ?? product.status}</span>
              </button>
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
          <button className="icon-button" aria-label="Detail schliessen" onClick={() => setSelected(null)}><X size={16} /></button>
        </header>
        <dl>
          <dt>ID</dt><dd>{selected.id}</dd>
          <dt>SKU</dt><dd>{selected.sku || '—'}</dd>
          <dt>Typ</dt><dd>{productTypeLabels[selected.productType] ?? selected.productType}</dd>
          <dt>Status</dt><dd>{productStatusLabels[selected.status] ?? selected.status}</dd>
          <dt>Preis</dt><dd>{productPrice(selected.payload, page?.currency)}</dd>
          <dt>Lager</dt><dd>{productStock(selected.payload)}</dd>
          {Object.entries(selected.terms.reduce<Record<string, string[]>>((groups, term) => ({ ...groups, [term.label]: [...(groups[term.label] ?? []), term.name] }), {}))
            .map(([label, names]) => <div key={label} className="product-inspector-term"><dt>{label}</dt><dd>{names.join(', ')}</dd></div>)}
        </dl>
      </aside>}
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
