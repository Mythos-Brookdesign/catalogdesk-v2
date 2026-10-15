import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, CircleAlert, DownloadCloud, LoaderCircle, Search, Tags } from 'lucide-react'
import type { TaxonomyImportProgress, TaxonomyOverview, TaxonomySummary, TaxonomyTermPage } from '../../types/desktop'
import './TaxonomiesPage.css'

const pageSize = 100
const groups: { title: string; kind: TaxonomySummary['kind'] }[] = [
  { title: 'WOOCOMMERCE', kind: 'core' },
  { title: 'PLUGINS & EIGENE', kind: 'custom' },
  { title: 'ATTRIBUTE', kind: 'attribute' },
]

export function TaxonomiesPage() {
  const desktop = window.catalogDesk
  const [overview, setOverview] = useState<TaxonomyOverview | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [loaded, setLoaded] = useState<(TaxonomyTermPage & { taxonomy: string }) | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<TaxonomyImportProgress | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const current = overview?.taxonomies.find((entry) => entry.taxonomy === selected) ?? null
  const terms = loaded?.taxonomy === selected ? loaded : null

  function show(next: TaxonomyOverview) {
    setOverview(next)
    setSelected((previous) => next.taxonomies.some((entry) => entry.taxonomy === previous) ? previous : next.taxonomies[0]?.taxonomy ?? null)
  }

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.taxonomyOverview().then((result) => {
      if (cancelled) return
      if (result.ok) show(result.value)
      else setError(result.error)
    }).catch(() => { if (!cancelled) setError('Taxonomien konnten nicht geladen werden.') })
    return () => { cancelled = true }
  }, [desktop])

  useEffect(() => desktop?.onTaxonomyImportProgress(setProgress), [desktop])

  useEffect(() => {
    if (!desktop || !selected) return
    let cancelled = false
    desktop.listTaxonomyTerms({ taxonomy: selected, query, page, pageSize }).then((result) => {
      if (cancelled) return
      if (result.ok) setLoaded({ ...result.value, taxonomy: selected })
      else setError(result.error)
    }).catch(() => { if (!cancelled) setError('Begriffe konnten nicht geladen werden.') })
    return () => { cancelled = true }
  }, [desktop, selected, query, page, overview])

  async function runImport() {
    if (!desktop || importing) return
    setImporting(true); setError(''); setNotice(''); setProgress(null)
    try {
      const result = await desktop.importTaxonomies()
      if (!result.ok) throw new Error(result.error)
      show(result.value)
      const termCount = result.value.taxonomies.reduce((sum, entry) => sum + entry.termCount, 0)
      setNotice(`${result.value.taxonomies.length} Taxonomien mit ${termCount.toLocaleString('de-DE')} Begriffen importiert.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Import fehlgeschlagen.') }
    finally { setImporting(false); setProgress(null) }
  }

  function choose(taxonomy: string) { setSelected(taxonomy); setQuery(''); setPage(0) }

  const pages = terms ? Math.max(1, Math.ceil(terms.total / terms.pageSize)) : 1
  return <main className="section-page taxonomies-page">
    <header className="taxonomies-heading">
      <div>
        <h1>Taxonomien</h1>
        <p>{overview?.importedAt ? `${overview.shopUrl} · Importiert ${new Date(overview.importedAt).toLocaleString('de-DE')}` : 'Alle Produkt-Taxonomien des Shops: WooCommerce, Plugins, eigene Taxonomien und Attribute.'}</p>
      </div>
      <button className="button primary" disabled={!desktop || importing} onClick={() => void runImport()}>
        {importing ? <LoaderCircle className="spin" size={16} /> : <DownloadCloud size={16} />}Taxonomien importieren
      </button>
    </header>
    {!desktop && <p role="status">Der Import ist nur in der Desktop-App verfuegbar.</p>}
    {importing && <p className="taxonomies-progress" role="status"><LoaderCircle className="spin" size={16} />{progress ? `${progress.label} wird geladen ... (${Math.min(progress.completed + 1, progress.total)}/${progress.total})` : 'Import wird gestartet ...'}</p>}
    {error && <p className="workspace-error" role="alert"><CircleAlert size={17} />{error}</p>}
    {notice && <p className="taxonomies-notice" role="status">{notice}</p>}

    {overview && !overview.taxonomies.length ? <div className="products-empty">
      <Tags size={25} strokeWidth={1.5} />
      <h2>Noch keine Taxonomien importiert</h2>
      <p>Der Import erkennt automatisch alle Produkt-Taxonomien, die der Shop ueber seine REST-API bereitstellt, inklusive Plugin- und eigener Taxonomien sowie globaler Attribute, und speichert sie ueber die gespeicherte Shopverbindung und speichert sie in der lokalen Datenbank. Der Shop wird dabei nicht veraendert.</p>
    </div> : overview && <div className="taxonomies-layout">
      <nav className="taxonomies-list" aria-label="Taxonomien">
        {groups.map(({ title, kind }) => {
          const entries = overview.taxonomies.filter((entry) => entry.kind === kind)
          if (!entries.length) return null
          return <div key={title}>
            <span className="eyebrow">{title}</span>
            {entries.map((entry) => <button key={entry.taxonomy} className={entry.taxonomy === selected ? 'active' : ''} aria-current={entry.taxonomy === selected ? 'true' : undefined} onClick={() => choose(entry.taxonomy)}>
              <span>{entry.label}</span>
              <small title={entry.available ? undefined : 'Beim letzten Import nicht lesbar'}>{entry.available ? '' : '! '}{entry.termCount.toLocaleString('de-DE')}</small>
            </button>)}
          </div>
        })}
      </nav>
      {current && <section className="taxonomy-terms" aria-labelledby="taxonomy-terms-title">
        <header>
          <div><h2 id="taxonomy-terms-title">{current.label}</h2><code>{current.taxonomy}</code></div>
          <label className="search-box"><Search size={16} /><input aria-label="Begriffe suchen" placeholder="Name oder Slug" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} /></label>
        </header>
        {!current.available && <p className="taxonomy-hint" role="note">Die Begriffe dieser Taxonomie waren beim letzten Import ueber die REST-API nicht lesbar. Bereits gespeicherte Begriffe bleiben erhalten.</p>}
        <div className="taxonomy-table-scroll"><table className="taxonomy-table">
            <thead><tr><th>Name</th><th>Slug</th><th className="numeric">Produkte</th><th className="numeric">ID</th></tr></thead>
            <tbody>
              {terms?.terms.map((term) => <tr key={term.id}>
                <td>{query && current.hierarchical ? term.path : <span style={{ paddingLeft: term.depth * 18 }}>{term.depth ? '↳ ' : ''}{term.name}</span>}</td>
                <td><code>{term.slug}</code></td>
                <td className="numeric">{term.count.toLocaleString('de-DE')}</td>
                <td className="numeric">{term.id}</td>
              </tr>)}
              {terms && !terms.terms.length && <tr><td colSpan={4} className="taxonomy-hint">{query ? 'Keine passenden Begriffe.' : 'Keine Begriffe vorhanden.'}</td></tr>}
            </tbody>
          </table></div>
        {terms && terms.total > terms.pageSize && <footer className="taxonomy-pager">
          <span>{terms.total.toLocaleString('de-DE')} Begriffe · Seite {terms.page + 1} von {pages}</span>
          <button className="icon-button" aria-label="Vorherige Seite" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button>
          <button className="icon-button" aria-label="Naechste Seite" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button>
        </footer>}
      </section>}
    </div>}
  </main>
}
