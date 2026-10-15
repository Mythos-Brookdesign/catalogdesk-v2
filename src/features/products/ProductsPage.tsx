import { useEffect, useState } from 'react'
import { Boxes, ChevronDown, CircleAlert, Search, SlidersHorizontal } from 'lucide-react'
import type { ProductPage, ProductQuery, ProductSummary } from './model'
import type { WorkspaceSummary } from '../../types/desktop'
import './ProductsPage.css'

type DesktopApi = NonNullable<Window['catalogDesk']>

export function ProductsPage({ desktop }: { desktop?: DesktopApi }) {
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null)
  const [page, setPage] = useState<ProductPage | null>(null)
  const [query, setQuery] = useState('')
  const [type, setType] = useState<ProductQuery['type']>('all')
  const [selected, setSelected] = useState<ProductSummary | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    Promise.all([desktop.workspaceSummary(), desktop.listProducts({ query, type, page: 0, pageSize: 50 })])
      .then(([workspace, products]) => {
        if (cancelled) return
        setSummary(workspace)
        setPage(products)
        setError('')
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Lokaler Katalog nicht verfuegbar.')
      })
    return () => { cancelled = true }
  }, [desktop, query, type])

  return (
    <main className="products-page">
      <header className="products-heading">
        <div>
          <span className="eyebrow">LOKALER KATALOG</span>
          <h1>Produkte</h1>
          <p>{summary ? `${summary.products.toLocaleString('de-DE')} Produkte · ${summary.variable} variable · ${summary.variations} Varianten` : 'SQLite-Arbeitsbereich'}</p>
        </div>
      </header>

      <section className="products-toolbar" aria-label="Produktfilter">
        <label className="search-box">
          <Search size={16} />
          <input aria-label="Produkte suchen" placeholder="Name oder Artikelnummer" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="type-filter">
          <SlidersHorizontal size={15} />
          <select aria-label="Produkttyp" value={type} onChange={(event) => setType(event.target.value as ProductQuery['type'])}>
            <option value="all">Alle Typen</option>
            <option value="simple">Einfach</option>
            <option value="variable">Variabel</option>
            <option value="variation">Varianten</option>
          </select>
          <ChevronDown size={14} />
        </label>
      </section>

      {error && <div className="workspace-error" role="alert"><CircleAlert size={17} />{error}</div>}
      <section className="products-table-wrap" aria-label="Produktliste">
        <div className="products-table-head">
          <span>Produkt</span><span>SKU</span><span>Typ</span><span>Status</span>
        </div>
        {page?.products.length ? (
          <div className="products-list">
            {page.products.map((product) => (
              <button className={`product-row ${selected?.id === product.id ? 'selected' : ''}`} key={`${product.id}-${product.type}`} onClick={() => setSelected(product)}>
                <span className="product-name"><Boxes size={17} /><strong>{product.parentId ? `↳ ${product.name}` : product.name || 'Unbenanntes Produkt'}</strong></span>
                <span className="product-sku">{product.sku || '—'}</span>
                <span className="product-type">{product.type}</span>
                <span className={`sync-state ${product.syncState}`}>{product.syncState === 'clean' ? 'Lokal' : product.syncState === 'draft' ? 'Entwurf' : 'Konflikt'}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="products-empty">
            <Boxes size={25} strokeWidth={1.5} />
            <h2>{error ? 'Katalog konnte nicht geladen werden' : 'Noch keine Produkte lokal gespeichert'}</h2>
            <p>Der Produktbereich ist direkt an SQLite gebunden. Importierte Produkte und Varianten erscheinen hier als Familien mit ihren Zuordnungen.</p>
          </div>
        )}
      </section>
      {selected && <aside className="product-inspector"><span className="eyebrow">PRODUKTDETAIL</span><strong>{selected.name}</strong><code>{selected.sku || 'Ohne SKU'}</code><span>{selected.type}{selected.parentId ? ` · Elternprodukt ${selected.parentId}` : ''}</span></aside>}
      <footer className="products-footer"><span>Lokaler Arbeitsbereich</span><span>{page ? `Seite ${page.page + 1} · ${page.total.toLocaleString('de-DE')} Datensätze` : 'Verbinde mit lokaler Datenbank …'}</span></footer>
    </main>
  )
}
