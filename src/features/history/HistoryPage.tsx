import { Fragment, useEffect, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, History, RefreshCw, Search } from 'lucide-react'
import type { AuditCategory, AuditEntry, AuditPage, AuditQuery } from '../../types/desktop'
import { useNotify } from '../../components/notifications/notifications'
import './HistoryPage.css'

const pageSize = 100
const categories: Record<AuditCategory, string> = {
  auth: 'Anmeldung', users: 'Benutzer', settings: 'Einstellungen', shop: 'Shopverbindung',
  taxonomies: 'Taxonomien', sync: 'Synchronisation', catalog: 'Katalog',
}
const detailLabels: Record<string, string> = {
  shop: 'Shop', error: 'Fehler', reason: 'Grund', productCount: 'Produkte', taxonomies: 'Taxonomien', transfers: 'Uebertragungen',
  discarded: 'Verworfene Aenderung', deleted: 'Geloeschter Datensatz', taxonomy: 'Taxonomie', key: 'Schluessel', terms: 'Begriffe',
  readable: 'Lesbar', term: 'Begriff', operation: 'Aktion', termId: 'ID', result: 'Ergebnis', name: 'Name', email: 'E-Mail', role: 'Rolle',
}
const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'medium' })
const time = new Intl.DateTimeFormat('de-DE', { timeStyle: 'medium' })

function format(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein'
  if (Array.isArray(value)) return value.map(format).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function dayLabel(iso: string) {
  const day = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (day.toDateString() === today.toDateString()) return 'Heute'
  if (day.toDateString() === yesterday.toDateString()) return 'Gestern'
  return day.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
}

function Details({ entry }: { entry: AuditEntry }) {
  const { changes, ...rest } = entry.details ?? {}
  const facts = [
    entry.targetLabel && ['Datensatz', entry.targetLabel],
    entry.targetId && ['ID', entry.targetId],
    entry.shopUrl && ['Shop', entry.shopUrl],
    ['Zeitpunkt', dateTime.format(new Date(entry.occurredAt))],
    ['Ausgeloest durch', entry.source === 'system' ? 'System (automatische Synchronisation)' : entry.userName ? `${entry.userName} (${entry.username})` : entry.username ?? '—'],
    ['Vorgang', entry.action],
  ].filter(Boolean) as [string, string][]
  return <div className="history-details">
    <dl>{facts.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>
    {changes && changes.length > 0 && <table className="history-changes">
      <thead><tr><th>Feld</th><th>Vorher</th><th>Nachher</th></tr></thead>
      <tbody>{changes.map((change) => <tr key={change.field}><td>{change.field}</td><td className="before">{format(change.before)}</td><td className="after">{format(change.after)}</td></tr>)}</tbody>
    </table>}
    {Object.entries(rest).map(([key, value]) => Array.isArray(value) && value.every((item) => item && typeof item === 'object')
      ? <div key={key} className="history-detail-list">
        <strong>{detailLabels[key] ?? key}</strong>
        <table className="history-changes">
          <thead><tr>{Object.keys(value[0] ?? {}).map((column) => <th key={column}>{detailLabels[column] ?? column}</th>)}</tr></thead>
          <tbody>{value.map((item, index) => <tr key={index}>{Object.values(item as Record<string, unknown>).map((cell, column) => <td key={column}>{format(cell)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      : value && typeof value === 'object'
        ? <dl key={key}><dt>{detailLabels[key] ?? key}</dt><dd>{Object.entries(value).map(([field, item]) => `${detailLabels[field] ?? field}: ${format(item)}`).join(' · ')}</dd></dl>
        : <dl key={key}><dt>{detailLabels[key] ?? key}</dt><dd>{format(value)}</dd></dl>)}
  </div>
}

export function HistoryPage() {
  const desktop = window.catalogDesk
  const notify = useNotify()
  const [filters, setFilters] = useState<{ query: string; category: '' | AuditCategory; userId: string; outcome: '' | 'success' | 'failure'; from: string; to: string }>({ query: '', category: '', userId: '', outcome: '', from: '', to: '' })
  const [page, setPage] = useState(0)
  const [data, setData] = useState<AuditPage | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    const query: AuditQuery = {
      query: filters.query, page, pageSize,
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(filters.outcome ? { outcome: filters.outcome } : {}),
      // Date inputs are local days; the range includes the whole "to" day.
      ...(filters.from ? { from: new Date(`${filters.from}T00:00:00`).toISOString() } : {}),
      ...(filters.to ? { to: new Date(new Date(`${filters.to}T00:00:00`).getTime() + 86_400_000).toISOString() } : {}),
    }
    desktop.listAudit(query).then((result) => {
      if (cancelled) return
      if (result.ok) setData(result.value)
      else notify.error('Historie nicht geladen', { message: result.error, key: 'history-load' })
    }).catch(() => { if (!cancelled) notify.error('Historie nicht geladen', { message: 'Die lokale Datenbank hat nicht geantwortet.', key: 'history-load' }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [desktop, filters, page, version, notify])

  // New entries appear live while the first page is shown.
  useEffect(() => desktop?.onAuditAppended(() => { if (page === 0) setVersion((value) => value + 1) }), [desktop, page])

  function filter(next: Partial<typeof filters>) { setFilters({ ...filters, ...next }); setPage(0); setOpen(null) }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const active = Object.values(filters).some(Boolean)

  return <main className="section-page history-page">
    <header className="history-heading">
      <div>
        <h1>Historie</h1>
        <p>Wer hat wann was gemacht: Anmeldungen, Benutzer, Einstellungen, Shopverbindung, Importe, Taxonomien und Synchronisation.</p>
      </div>
      <button className="button" disabled={!desktop || loading} onClick={() => { setLoading(true); setVersion((value) => value + 1) }}><RefreshCw className={loading ? 'spin' : ''} size={15} />Aktualisieren</button>
    </header>

    <section className="history-filters" aria-label="Filter">
      <label className="search-box"><Search size={16} /><input aria-label="Historie durchsuchen" placeholder="Aktion, Datensatz oder Benutzer" value={filters.query} onChange={(event) => filter({ query: event.target.value })} /></label>
      <select aria-label="Bereich" value={filters.category} onChange={(event) => filter({ category: event.target.value as AuditCategory | '' })}>
        <option value="">Alle Bereiche</option>
        {Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <select aria-label="Benutzer" value={filters.userId} onChange={(event) => filter({ userId: event.target.value })}>
        <option value="">Alle Benutzer</option>
        {data?.users.map((user) => <option key={user.id} value={user.id}>{user.name ?? user.username}</option>)}
        <option value="system">System</option>
      </select>
      <select aria-label="Ergebnis" value={filters.outcome} onChange={(event) => filter({ outcome: event.target.value as '' | 'success' | 'failure' })}>
        <option value="">Alle Ergebnisse</option>
        <option value="success">Erfolgreich</option>
        <option value="failure">Fehlgeschlagen</option>
      </select>
      <label className="history-date"><span>Von</span><input type="date" aria-label="Von" value={filters.from} max={filters.to || undefined} onChange={(event) => filter({ from: event.target.value })} /></label>
      <label className="history-date"><span>Bis</span><input type="date" aria-label="Bis" value={filters.to} min={filters.from || undefined} onChange={(event) => filter({ to: event.target.value })} /></label>
      {active && <button className="button" onClick={() => filter({ query: '', category: '', userId: '', outcome: '', from: '', to: '' })}>Filter zuruecksetzen</button>}
    </section>

    {!desktop && <p role="status">Die Historie ist nur in der Desktop-App verfuegbar.</p>}
    {data && !data.entries.length ? <div className="products-empty">
      <History size={25} strokeWidth={1.5} />
      <h2>{active ? 'Keine passenden Eintraege' : 'Noch keine Eintraege'}</h2>
      <p>{active ? 'Filter anpassen oder zuruecksetzen.' : 'Ab jetzt wird jede Aktion in CatalogDesk hier protokolliert.'}</p>
    </div> : data && <div className="history-table-scroll"><table className="history-table">
      <thead><tr><th>Uhrzeit</th><th>Benutzer</th><th>Bereich</th><th>Aktion</th><th>Ergebnis</th><th><span className="visually-hidden">Details</span></th></tr></thead>
      <tbody>{data.entries.map((entry, index) => {
        const newDay = index === 0 || new Date(data.entries[index - 1].occurredAt).toDateString() !== new Date(entry.occurredAt).toDateString()
        const expanded = open === entry.id
        return <Fragment key={entry.id}>
          {newDay && <tr className="history-day"><td colSpan={6}>{dayLabel(entry.occurredAt)}</td></tr>}
          <tr className={`history-row ${expanded ? 'expanded' : ''}`} onClick={() => setOpen(expanded ? null : entry.id)}>
            <td className="history-time"><time dateTime={entry.occurredAt} title={dateTime.format(new Date(entry.occurredAt))}>{time.format(new Date(entry.occurredAt))}</time></td>
            <td>{entry.source === 'system' ? <span className="history-system">System</span> : entry.userName ?? entry.username ?? '—'}</td>
            <td><span className={`history-category ${entry.category}`}>{categories[entry.category]}</span></td>
            <td className="history-summary">{entry.summary}</td>
            <td><span className={`history-outcome ${entry.outcome}`}>{entry.outcome === 'success' ? 'Erfolgreich' : 'Fehlgeschlagen'}</span></td>
            <td className="history-toggle"><button className="icon-button" aria-expanded={expanded} aria-label={`Details: ${entry.summary}`} onClick={(event) => { event.stopPropagation(); setOpen(expanded ? null : entry.id) }}>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button></td>
          </tr>
          {expanded && <tr className="history-details-row"><td colSpan={6}><Details entry={entry} /></td></tr>}
        </Fragment>
      })}</tbody>
    </table></div>}
    {data && data.total > data.pageSize && <footer className="taxonomy-pager history-pager">
      <span>{data.total.toLocaleString('de-DE')} Eintraege · Seite {data.page + 1} von {pages}</span>
      <button className="icon-button" aria-label="Vorherige Seite" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button>
      <button className="icon-button" aria-label="Naechste Seite" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button>
    </footer>}
  </main>
}
