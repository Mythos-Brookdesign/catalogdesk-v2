import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Boxes,
  CircleAlert,
  Layers3,
  PackageCheck,
  PlugZap,
  RefreshCw,
} from 'lucide-react'
import type { WorkspaceSummary } from '../../types/desktop'
import './DashboardPage.css'

type DesktopApi = NonNullable<Window['catalogDesk']>

export function DashboardPage({
  desktop,
  onOpenProducts,
}: {
  desktop?: DesktopApi
  onOpenProducts: () => void
}) {
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop
      .workspaceSummary()
      .then((result) => {
        if (!cancelled) {
          setSummary(result)
          setError('')
        }
      })
      .catch((reason) => {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : 'Dashboarddaten konnten nicht geladen werden.',
          )
      })
    return () => {
      cancelled = true
    }
  }, [desktop])

  const metrics = [
    { label: 'Produkte', value: summary?.simple ?? 0, icon: Boxes },
    { label: 'Variable Produkte', value: summary?.variable ?? 0, icon: Layers3 },
    { label: 'Varianten', value: summary?.variations ?? 0, icon: PackageCheck },
  ]

  return (
    <main className="dashboard-page">
      <header className="dashboard-heading">
        <div>
          <span className="eyebrow">ARBEITSBEREICH</span>
          <h1>Dashboard</h1>
          <p>Dein lokaler WooCommerce-Katalog auf einen Blick.</p>
        </div>
        <button className="button primary" onClick={onOpenProducts}>
          Produkte öffnen <ArrowRight size={15} />
        </button>
      </header>

      {error && (
        <div className="dashboard-error" role="alert">
          <CircleAlert size={17} />{error}
        </div>
      )}

      <section className="dashboard-metrics" aria-label="Katalogübersicht">
        {metrics.map(({ label, value, icon: Icon }) => (
          <article className="metric" key={label}>
            <div className="metric-head"><span>{label}</span><Icon size={17} /></div>
            <strong>{value.toLocaleString('de-DE')}</strong>
          </article>
        ))}
      </section>

      <section className="dashboard-overview">
        <div className="overview-heading">
          <div>
            <span className="eyebrow">DATENQUELLE</span>
            <h2>Shopkatalog</h2>
          </div>
          <span className={`source-status ${summary?.shopCount ? 'connected' : ''}`}>
            <span className="status-dot" />
            {summary?.shopCount ? 'Importiert' : 'Noch kein Shopimport'}
          </span>
        </div>
        {summary?.latestShopUrl ? (
          <dl className="source-details">
            <div><dt>Shop</dt><dd>{summary.latestShopUrl}</dd></div>
            <div>
              <dt>Letzter lokaler Import</dt>
              <dd>{summary.latestImportedAt ? new Date(summary.latestImportedAt).toLocaleString('de-DE') : '—'}</dd>
            </div>
            <div><dt>Gespeicherte Datensätze</dt><dd>{summary.products.toLocaleString('de-DE')}</dd></div>
          </dl>
        ) : (
          <div className="source-empty">
            <PlugZap size={19} />
            <div><strong>Der lokale Katalog ist noch leer</strong><span>Verbinde einen Shop und importiere Produkte, um hier den Arbeitsstand zu sehen.</span></div>
          </div>
        )}
      </section>

      <section className="dashboard-next" aria-label="Nächste Schritte">
        <div><RefreshCw size={17} /><span>Shopverbindung und Synchronisation werden im V2-Arbeitsbereich eingerichtet.</span></div>
        <span className="dashboard-local">Alle angezeigten Daten stammen aus der lokalen SQLite-Datenbank.</span>
      </section>
    </main>
  )
}
