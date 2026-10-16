import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, CloudOff, DownloadCloud, LoaderCircle, Pencil, Plus, RefreshCw, Save, Search, Tags, Trash2, Undo2, X } from 'lucide-react'
import type {
  TaxonomyImportProgress, TaxonomyOverview, TaxonomySummary, TaxonomySyncResult, TaxonomyTerm, TaxonomyTermOption, TaxonomyTermPage, TermFields,
} from '../../types/desktop'
import { useNotify, type Notify } from '../../components/notifications/notifications'
import { findDuplicate } from './termNames'
import './TaxonomiesPage.css'

const pageSize = 100
const groups: { title: string; kind: TaxonomySummary['kind'] }[] = [
  { title: 'WOOCOMMERCE', kind: 'core' },
  { title: 'PLUGINS & EIGENE', kind: 'custom' },
  { title: 'ATTRIBUTE', kind: 'attribute' },
]
const stateLabels = { create: 'Neu', update: 'Geaendert', delete: 'Wird geloescht' } as const
type Draft = { termId?: number; fields: TermFields }

function notifySync(notify: Notify, sync: TaxonomySyncResult | null, subject: string) {
  if (!sync) notify.info('Lokal gespeichert', { message: `${subject} wird uebertragen, sobald die laufende Shopaktion beendet ist.`, key: 'taxonomy-sync' })
  else if (sync.offline) notify.warning('Offline gespeichert', { message: `${subject} wird automatisch uebertragen, sobald der Shop erreichbar ist.`, key: 'taxonomy-sync' })
  else if (sync.failed) notify.error('Vom Shop abgelehnt', { message: 'Der Grund steht beim betroffenen Begriff in der Liste.', key: 'taxonomy-sync' })
  else notify.success('Im Shop gespeichert', { message: sync.pendingChanges ? `${subject} wurde uebertragen. Weitere Aenderungen warten noch.` : `${subject} wurde uebertragen.`, key: 'taxonomy-sync' })
}

export function TaxonomiesPage() {
  const desktop = window.catalogDesk
  const notify = useNotify()
  const [overview, setOverview] = useState<TaxonomyOverview | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [loaded, setLoaded] = useState<(TaxonomyTermPage & { taxonomy: string }) | null>(null)
  const [version, setVersion] = useState(0)
  const [importing, setImporting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<TaxonomyImportProgress | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [options, setOptions] = useState<TaxonomyTermOption[]>([])
  // All terms of the taxonomy, for the "exists only once" check while typing.
  const [allTerms, setAllTerms] = useState<TaxonomyTermOption[]>([])
  const [deleting, setDeleting] = useState<TaxonomyTerm | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const current = overview?.taxonomies.find((entry) => entry.taxonomy === selected) ?? null
  const terms = loaded?.taxonomy === selected ? loaded : null
  const reload = useCallback(() => setVersion((value) => value + 1), [])

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
      else notify.error('Taxonomien nicht geladen', { message: result.error, key: 'taxonomy-load' })
    }).catch(() => { if (!cancelled) notify.error('Taxonomien nicht geladen', { message: 'Die lokale Datenbank hat nicht geantwortet.', key: 'taxonomy-load' }) })
    return () => { cancelled = true }
  }, [desktop, version, notify])

  useEffect(() => desktop?.onTaxonomyImportProgress(setProgress), [desktop])
  useEffect(() => desktop?.onTaxonomiesChanged(reload), [desktop, reload])

  useEffect(() => {
    if (!desktop || !selected) return
    let cancelled = false
    desktop.listTaxonomyTerms({ taxonomy: selected, query, page, pageSize }).then((result) => {
      if (cancelled) return
      if (result.ok) setLoaded({ ...result.value, taxonomy: selected })
      else notify.error('Begriffe nicht geladen', { message: result.error, key: 'taxonomy-load' })
    }).catch(() => { if (!cancelled) notify.error('Begriffe nicht geladen', { message: 'Die lokale Datenbank hat nicht geantwortet.', key: 'taxonomy-load' }) })
    return () => { cancelled = true }
  }, [desktop, selected, query, page, version, notify])

  const sync = useCallback(async (retryFailed = false, quiet = false) => {
    if (!desktop) return
    setSyncing(true)
    try {
      const result = await desktop.syncTaxonomies(retryFailed)
      if (!result.ok) throw new Error(result.error)
      const { synced, failed: rejected, offline } = result.value
      if (offline) { if (!quiet) notify.warning('Shop nicht erreichbar', { message: 'Die Aenderungen bleiben gespeichert und werden spaeter uebertragen.', key: 'taxonomy-sync' }) }
      else if (rejected) notify.error('Synchronisation teilweise abgelehnt', { message: `${synced} uebertragen, ${rejected} vom Shop abgelehnt. Details stehen in der Liste.`, key: 'taxonomy-sync' })
      else if (synced || !quiet) notify.success('Synchronisiert', { message: `${synced} ${synced === 1 ? 'Aenderung' : 'Aenderungen'} uebertragen.`, key: 'taxonomy-sync' })
    } catch (reason) { if (!quiet) notify.error('Synchronisation fehlgeschlagen', { message: reason instanceof Error ? reason.message : undefined, key: 'taxonomy-sync' }) }
    finally { setSyncing(false); reload() }
  }, [desktop, reload, notify])

  // Push queued edits as soon as the network returns.
  useEffect(() => {
    const online = () => void sync(false, true)
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [sync])

  async function runImport() {
    if (!desktop || importing) return
    setImporting(true); setProgress(null)
    try {
      const result = await desktop.importTaxonomies()
      if (!result.ok) throw new Error(result.error)
      show(result.value)
      reload()
      const termCount = result.value.taxonomies.reduce((sum, entry) => sum + entry.termCount, 0)
      notify.success('Import abgeschlossen', { message: `${result.value.taxonomies.length} Taxonomien mit ${termCount.toLocaleString('de-DE')} Begriffen importiert.`, key: 'taxonomy-import' })
    } catch (reason) { notify.error('Import fehlgeschlagen', { message: reason instanceof Error ? reason.message : undefined, key: 'taxonomy-import' }) }
    finally { setImporting(false); setProgress(null) }
  }

  async function openForm(term?: TaxonomyTerm) {
    if (!desktop || !current) return
    setFormError('')
    setDraft({ termId: term?.id, fields: { name: term?.name ?? '', slug: term?.slug ?? '', parent: term?.parentId ?? 0, description: term?.description ?? '' } })
    setOptions([]); setAllTerms([])
    const result = await desktop.taxonomyTermOptions(current.taxonomy)
    if (!result.ok) { setFormError(result.error); return }
    setAllTerms(result.value)
    if (!current.hierarchical) return
    // A term cannot become its own descendant: drop it and the subtree that follows it in tree order.
    const index = term ? result.value.findIndex((option) => option.id === term.id) : -1
    if (index < 0) { setOptions(result.value); return }
    const end = result.value.findIndex((option, position) => position > index && option.depth <= result.value[index].depth)
    setOptions([...result.value.slice(0, index), ...(end < 0 ? [] : result.value.slice(end))])
  }

  async function change(run: () => ReturnType<NonNullable<typeof desktop>['changeTaxonomyTerm']>, subject: string, onDone: () => void) {
    setBusy(true); setFormError('')
    try {
      const result = await run()
      if (!result.ok) throw new Error(result.error)
      onDone()
      notifySync(notify, result.value.sync, subject)
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : 'Speichern fehlgeschlagen.') }
    finally { setBusy(false); reload() }
  }

  function save(event: React.FormEvent) {
    event.preventDefault()
    if (!desktop || !current || !draft || busy) return
    const fields = { ...draft.fields, name: draft.fields.name.trim(), slug: draft.fields.slug.trim() }
    void change(() => draft.termId === undefined
      ? desktop.changeTaxonomyTerm({ taxonomy: current.taxonomy, operation: 'create', fields })
      : desktop.changeTaxonomyTerm({ taxonomy: current.taxonomy, operation: 'update', termId: draft.termId, fields }), `„${fields.name}“`, () => setDraft(null))
  }

  function remove() {
    if (!desktop || !current || !deleting || busy) return
    void change(() => desktop.changeTaxonomyTerm({ taxonomy: current.taxonomy, operation: 'delete', termId: deleting.id }), `Das Loeschen von „${deleting.name}“`, () => setDeleting(null))
  }

  async function discard(term: TaxonomyTerm) {
    if (!desktop || !current) return
    const result = await desktop.discardTaxonomyChange({ taxonomy: current.taxonomy, termId: term.id })
    if (!result.ok) notify.error('Nicht verworfen', { message: result.error })
    else notify.info('Aenderung verworfen', { message: `„${term.name}“ entspricht wieder dem Stand im Shop.` })
    reload()
  }

  function choose(taxonomy: string) { setSelected(taxonomy); setQuery(''); setPage(0) }

  const pages = terms ? Math.max(1, Math.ceil(terms.total / terms.pageSize)) : 1
  const duplicate = draft ? findDuplicate(allTerms, draft.fields.name, draft.fields.slug, draft.termId) : null
  const pending = overview?.pendingChanges ?? 0
  const failed = overview?.failedChanges ?? 0
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
    {(pending > 0 || failed > 0) && <div className="taxonomy-sync-bar" role="status">
      <CloudOff size={16} />
      <span>{[pending && `${pending} ${pending === 1 ? 'Aenderung wartet' : 'Aenderungen warten'} auf Uebertragung`, failed && `${failed} vom Shop abgelehnt`].filter(Boolean).join(' · ')}</span>
      {pending > 0 && <button className="button" disabled={syncing || importing} onClick={() => void sync()}><RefreshCw className={syncing ? 'spin' : ''} size={15} />Jetzt synchronisieren</button>}
      {failed > 0 && <button className="button" disabled={syncing || importing} onClick={() => void sync(true)}><RefreshCw size={15} />Erneut versuchen</button>}
    </div>}

    {overview && !overview.taxonomies.length ? <div className="products-empty">
      <Tags size={25} strokeWidth={1.5} />
      <h2>Noch keine Taxonomien importiert</h2>
      <p>Der Import erkennt automatisch alle Produkt-Taxonomien, die der Shop ueber seine REST-API bereitstellt, inklusive Plugin- und eigener Taxonomien sowie globaler Attribute, und speichert sie in der lokalen Datenbank. Der Shop wird dabei nicht veraendert.</p>
    </div> : overview && <div className="taxonomies-layout">
      <nav className="taxonomies-list" aria-label="Taxonomien">
        {groups.map(({ title, kind }) => {
          const entries = overview.taxonomies.filter((entry) => entry.kind === kind)
          if (!entries.length) return null
          return <div key={title}>
            <span className="eyebrow">{title}</span>
            {entries.map((entry) => <button key={entry.taxonomy} className={entry.taxonomy === selected ? 'active' : ''} aria-current={entry.taxonomy === selected ? 'true' : undefined} onClick={() => choose(entry.taxonomy)}>
              <span>{entry.label}</span>
              <small title={entry.available ? undefined : 'Beim letzten Import nicht lesbar'}>{entry.failedCount ? '⚠ ' : entry.pendingCount ? '↻ ' : entry.available ? '' : '! '}{entry.termCount.toLocaleString('de-DE')}</small>
            </button>)}
          </div>
        })}
      </nav>
      {current && <section className="taxonomy-terms" aria-labelledby="taxonomy-terms-title">
        <header>
          <div><h2 id="taxonomy-terms-title">{current.label}</h2><code>{current.taxonomy}</code></div>
          <div className="taxonomy-terms-tools">
            <label className="search-box"><Search size={16} /><input aria-label="Begriffe suchen" placeholder="Name oder Slug" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} /></label>
            {current.editable && <button className="button primary" onClick={() => void openForm()}><Plus size={16} />Begriff hinzufuegen</button>}
          </div>
        </header>
        {!current.available && <p className="taxonomy-hint" role="note">Die Begriffe dieser Taxonomie waren beim letzten Import ueber die REST-API nicht lesbar. Bereits gespeicherte Begriffe bleiben erhalten.</p>}
        {current.available && !current.editable && <p className="taxonomy-hint" role="note">Diese Taxonomie stellt keine WooCommerce-Schnittstelle bereit und kann in CatalogDesk nur gelesen werden.</p>}
        <div className="taxonomy-table-scroll"><table className="taxonomy-table">
          <thead><tr><th>Name</th><th>Slug</th><th className="numeric">Produkte</th><th className="numeric">ID</th>{current.editable && <th className="numeric">Aktionen</th>}</tr></thead>
          <tbody>
            {terms?.terms.map((term) => <tr key={term.id} className={term.state === 'delete' ? 'deleted' : undefined}>
              <td>
                <span className="taxonomy-term-name" style={{ paddingLeft: query && current.hierarchical ? 0 : term.depth * 18 }}>
                  <span className="term-label">{query && current.hierarchical ? term.path : `${term.depth ? '↳ ' : ''}${term.name}`}</span>
                  {term.state !== 'clean' && <span className={`term-state ${term.changeState === 'failed' ? 'failed' : term.state}`}>{term.changeState === 'failed' ? 'Abgelehnt' : stateLabels[term.state]}</span>}
                </span>
                {term.error && <small className="term-error">{term.error}</small>}
              </td>
              <td><code>{term.slug || '—'}</code></td>
              <td className="numeric">{term.count.toLocaleString('de-DE')}</td>
              <td className="numeric">{term.id > 0 ? term.id : '—'}</td>
              {current.editable && <td className="taxonomy-actions">
                {term.state !== 'clean' && <button className="icon-button" aria-label={`Aenderung verwerfen: ${term.name}`} title="Aenderung verwerfen" onClick={() => void discard(term)}><Undo2 size={15} /></button>}
                {term.state !== 'delete' && <>
                  <button className="icon-button" aria-label={`Bearbeiten: ${term.name}`} title="Begriff bearbeiten" onClick={() => void openForm(term)}><Pencil size={15} /></button>
                  <button className="icon-button" aria-label={`Loeschen: ${term.name}`} title="Begriff loeschen" onClick={() => { setDeleting(term); setFormError('') }}><Trash2 size={15} /></button>
                </>}
              </td>}
            </tr>)}
            {terms && !terms.terms.length && <tr><td colSpan={current.editable ? 5 : 4} className="taxonomy-hint">{query ? 'Keine passenden Begriffe.' : 'Keine Begriffe vorhanden.'}</td></tr>}
          </tbody>
        </table></div>
        {terms && terms.total > terms.pageSize && <footer className="taxonomy-pager">
          <span>{terms.total.toLocaleString('de-DE')} Begriffe · Seite {terms.page + 1} von {pages}</span>
          <button className="icon-button" aria-label="Vorherige Seite" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button>
          <button className="icon-button" aria-label="Naechste Seite" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button>
        </footer>}
      </section>}
    </div>}

    {draft && current && <div className="taxonomy-modal-backdrop"><section className="taxonomy-modal" role="dialog" aria-modal="true" aria-labelledby="term-form-title">
      <header><h2 id="term-form-title">{draft.termId === undefined ? `${current.label}: Begriff hinzufuegen` : 'Begriff bearbeiten'}</h2><button className="icon-button" aria-label="Schliessen" disabled={busy} onClick={() => setDraft(null)}><X size={18} /></button></header>
      <form onSubmit={save}>
        <fieldset disabled={busy}>
          <label className="auth-field"><span>Name</span><input required maxLength={200} autoFocus aria-invalid={Boolean(duplicate)} aria-describedby={duplicate ? 'term-duplicate' : undefined} value={draft.fields.name} onChange={(event) => setDraft({ ...draft, fields: { ...draft.fields, name: event.target.value } })} /></label>
          {duplicate && <p id="term-duplicate" className="auth-error" role="alert">Ein Begriff „{duplicate.name}“ existiert in {current.label} bereits.</p>}
          <label className="auth-field"><span>Slug (optional)</span><input maxLength={200} spellCheck={false} placeholder="Wird automatisch aus dem Namen erzeugt" value={draft.fields.slug} onChange={(event) => setDraft({ ...draft, fields: { ...draft.fields, slug: event.target.value } })} /></label>
          {current.hierarchical && <label className="auth-field"><span>Uebergeordneter Begriff</span><select value={draft.fields.parent} onChange={(event) => setDraft({ ...draft, fields: { ...draft.fields, parent: Number(event.target.value) } })}>
            <option value={0}>Keiner (oberste Ebene)</option>
            {options.map((option) => <option key={option.id} value={option.id}>{'  '.repeat(option.depth)}{option.path.split(' › ').at(-1)}</option>)}
          </select></label>}
          <label className="auth-field"><span>Beschreibung (optional)</span><textarea rows={4} maxLength={10_000} value={draft.fields.description} onChange={(event) => setDraft({ ...draft, fields: { ...draft.fields, description: event.target.value } })} /></label>
        </fieldset>
        {formError && <p className="auth-error" role="alert">{formError}</p>}
        <footer><button className="button" type="button" disabled={busy} onClick={() => setDraft(null)}>Abbrechen</button><button className="button primary" disabled={busy || !draft.fields.name.trim() || Boolean(duplicate)}>{busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Speichern</button></footer>
      </form>
    </section></div>}

    {deleting && current && <div className="taxonomy-modal-backdrop"><section className="taxonomy-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-term-title">
      <h2 id="delete-term-title">Begriff loeschen?</h2>
      <p>„{deleting.name}“ wird {deleting.id > 0 ? 'im Shop endgueltig geloescht' : 'verworfen, bevor er den Shop erreicht'}.{deleting.count > 0 ? ` ${deleting.count.toLocaleString('de-DE')} Produkte verlieren diese Zuordnung.` : ''}{current.hierarchical ? ' Unterbegriffe ruecken eine Ebene nach oben.' : ''}</p>
      {formError && <p className="auth-error" role="alert">{formError}</p>}
      <footer><button className="button" disabled={busy} onClick={() => setDeleting(null)}>Abbrechen</button><button className="button primary" disabled={busy} onClick={remove}><Trash2 size={16} />Endgueltig loeschen</button></footer>
    </section></div>}
  </main>
}
