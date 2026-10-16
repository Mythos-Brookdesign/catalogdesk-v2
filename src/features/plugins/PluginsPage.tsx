import { useEffect, useState } from 'react'
import { Puzzle } from 'lucide-react'
import type { PluginModule } from '../../types/desktop'
import { useNotify } from '../../components/notifications/notifications'
import './PluginsPage.css'

function stateLabel(entry: PluginModule, checked: boolean) {
  if (entry.active) return 'Aktiv'
  if (!entry.detected) return checked ? 'Im Shop nicht erkannt' : 'Noch nicht geprueft'
  return entry.licensed ? 'Ausgeschaltet' : 'Nicht freigeschaltet'
}

export function PluginsPage() {
  const desktop = window.catalogDesk
  const notify = useNotify()
  const [shopUrl, setShopUrl] = useState<string | null>(null)
  const [modules, setModules] = useState<PluginModule[] | null>(null)
  const [checked, setChecked] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.listModules().then((result) => {
      if (cancelled) return
      if (!result.ok) { notify.error('Plugins nicht geladen', { message: result.error, key: 'plugins-load' }); return }
      setShopUrl(result.value.shopUrl); setChecked(result.value.checked); setModules(result.value.modules)
    }).catch(() => { if (!cancelled) notify.error('Plugins nicht geladen', { message: 'Die lokale Datenbank hat nicht geantwortet.', key: 'plugins-load' }) })
    return () => { cancelled = true }
  }, [desktop, notify])

  async function toggle(entry: PluginModule) {
    if (!desktop || switching) return
    setSwitching(entry.id)
    try {
      const result = await desktop.setModuleEnabled(entry.id, !entry.enabled)
      if (!result.ok) throw new Error(result.error)
      setModules((current) => current?.map((module) => module.id === entry.id ? result.value : module) ?? null)
      notify.success(`Modul ${result.value.name} ${result.value.enabled ? 'eingeschaltet' : 'ausgeschaltet'}`, {
        message: result.value.enabled ? 'Taxonomien und Felder des Moduls sind wieder sichtbar.' : 'Taxonomien und Felder des Moduls sind ausgeblendet. Die Daten bleiben gespeichert.',
        key: `module-${entry.id}`,
      })
    } catch (reason) { notify.error('Modul nicht umgeschaltet', { message: reason instanceof Error ? reason.message : undefined }) }
    finally { setSwitching(null) }
  }

  return <main className="section-page plugins-page">
    <header className="plugins-heading">
      <h1>Plugins</h1>
      <p>Module ergaenzen den Grundumfang um Wissen ueber bestimmte WordPress-Plugins. Sie werden beim Import von Taxonomien oder Produkten automatisch erkannt und lassen sich pro Shop ein- und ausschalten.</p>
      {shopUrl && <p className="plugins-shop">Shop: {shopUrl}{!checked && ' · noch nicht geprueft, bitte Taxonomien oder Produkte importieren'}</p>}
    </header>
    {!desktop && <p role="status">Plugins sind nur in der Desktop-App verfuegbar.</p>}
    {modules && <section aria-label="Plugin-Module">
      <ul className="plugins-list">{modules.map((entry) => <li key={entry.id}>
        <Puzzle size={18} />
        <div><strong>{entry.name}</strong><span>{entry.description}</span></div>
        <span className="module-controls">
          <span className={`module-state ${entry.active ? 'active' : entry.detected && !entry.licensed ? 'detected' : ''}`}>{stateLabel(entry, checked)}</span>
          <button type="button" role="switch" className="module-switch" aria-checked={entry.detected && entry.licensed && entry.enabled} aria-label={`Modul ${entry.name}`}
            title={!entry.detected ? 'Das Plugin wurde in diesem Shop nicht erkannt.' : !entry.licensed ? 'Dieses Modul ist nicht freigeschaltet.' : entry.enabled ? 'Modul ausschalten' : 'Modul einschalten'}
            disabled={!desktop || !entry.detected || !entry.licensed || switching !== null} onClick={() => void toggle(entry)}><span /></button>
        </span>
      </li>)}</ul>
    </section>}
  </main>
}
