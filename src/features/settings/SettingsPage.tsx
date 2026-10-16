import { useEffect, useState } from 'react'
import { Eye, EyeOff, LoaderCircle, PlugZap, Save, Trash2 } from 'lucide-react'
import { useNotify } from '../../components/notifications/notifications'
import './SettingsPage.css'

function canonicalUrl(value: string) {
  try {
    const url = new URL(value.trim())
    url.pathname = url.pathname.replace(/\/+$/, '') + '/'
    return url.toString()
  } catch { return '' }
}

export function ShopConnectionPage() {
  const desktop = window.catalogDesk
  const notify = useNotify()
  const [url, setUrl] = useState('')
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  const [consumerKey, setConsumerKey] = useState('')
  const [consumerSecret, setConsumerSecret] = useState('')
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(Boolean(desktop))
  const [action, setAction] = useState<'save' | 'test' | 'delete' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const busy = loading || action !== null
  const reuse = Boolean(savedUrl && canonicalUrl(url) === savedUrl && !consumerKey && !consumerSecret)
  const canSubmit = Boolean(url.trim() && (reuse || (consumerKey && consumerSecret)))

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.shopConnection().then((result) => {
      if (cancelled) return
      if (result.ok) { setSavedUrl(result.value?.url ?? null); setUrl(result.value?.url ?? '') }
      else notify.error('Shopverbindung nicht geladen', { message: result.error })
    }).catch(() => {
      if (!cancelled) notify.error('Shopverbindung nicht geladen', { message: 'Die gespeicherte Verbindung konnte nicht gelesen werden.' })
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [desktop, notify])

  async function run(operation: 'save' | 'test' | 'delete') {
    if (!desktop || busy) return
    setAction(operation)
    try {
      const input = { url: url.trim(), consumerKey: consumerKey.trim(), consumerSecret: consumerSecret.trim() }
      if (operation === 'save') {
        const result = await desktop.saveShopConnection(input)
        if (!result.ok) throw new Error(result.error)
        setSavedUrl(result.value.url); setUrl(result.value.url)
        setConsumerKey(''); setConsumerSecret(''); setVisible(false)
        notify.success('Shopverbindung gespeichert', { message: result.value.url, key: 'shop' })
      } else if (operation === 'test') {
        const result = await desktop.testShopConnection(reuse ? null : input)
        if (!result.ok) throw new Error(result.error)
        notify.success('Verbindung erfolgreich', { message: `${result.value.productCount.toLocaleString('de-DE')} Produkte in der WooCommerce-API · ${result.value.url}`, key: 'shop' })
      } else {
        const result = await desktop.deleteShopConnection()
        if (!result.ok) throw new Error(result.error)
        setSavedUrl(null); setUrl(''); setConsumerKey(''); setConsumerSecret(''); setVisible(false)
        setConfirmDelete(false); notify.info('Shopverbindung entfernt', { message: 'Die API-Schluessel wurden lokal geloescht. Katalogdaten bleiben erhalten.', key: 'shop' })
      }
    } catch (reason) {
      const title = { save: 'Nicht gespeichert', test: 'Verbindung fehlgeschlagen', delete: 'Nicht entfernt' }[operation]
      notify.error(title, { message: reason instanceof Error ? reason.message : 'Shopaktion fehlgeschlagen.', key: 'shop' })
    }
    finally { setAction(null) }
  }

  return <main className="section-page settings-page">
    <header><h1>Shopverbindung</h1></header>
    <section className="shop-settings" aria-labelledby="shop-settings-title">
      <div className="shop-settings-heading"><div><h2 id="shop-settings-title">WooCommerce-Shop</h2><p>{savedUrl ? `Gespeichert: ${savedUrl}` : 'Noch keine Shopverbindung gespeichert.'}</p></div>{savedUrl && <button className="icon-button" title="Shopverbindung entfernen" aria-label="Shopverbindung entfernen" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={17} /></button>}</div>
      {!desktop && <p role="status">Shopverbindungen sind nur in der Desktop-App verfuegbar.</p>}
      {loading && <p role="status">Shopverbindung wird geladen ...</p>}
      <form onSubmit={(event) => { event.preventDefault(); void run('save') }}>
        <fieldset disabled={!desktop || busy} className="shop-settings-fields">
          <label className="auth-field"><span>Shopadresse (HTTPS)</span><input required type="url" maxLength={2048} placeholder="https://shop.example" autoComplete="off" spellCheck={false} value={url} onChange={(event) => { setUrl(event.target.value) }} /></label>
          <label className="auth-field"><span>Consumer Key</span><input required={!reuse} type={visible ? 'text' : 'password'} maxLength={43} pattern="ck_[a-f0-9]{40}" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={reuse ? 'Gespeichert' : 'ck_...'} value={consumerKey} onChange={(event) => { setConsumerKey(event.target.value) }} /></label>
          <label className="auth-field"><span>Consumer Secret</span><input required={!reuse} type={visible ? 'text' : 'password'} maxLength={43} pattern="cs_[a-f0-9]{40}" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={reuse ? 'Gespeichert' : 'cs_...'} value={consumerSecret} onChange={(event) => { setConsumerSecret(event.target.value) }} /></label>
          <div className="shop-settings-actions"><button className="icon-button" type="button" title={visible ? 'Schluessel verbergen' : 'Schluessel anzeigen'} aria-label={visible ? 'Schluessel verbergen' : 'Schluessel anzeigen'} aria-pressed={visible} onClick={() => setVisible((current) => !current)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            <button className="button" type="button" disabled={!canSubmit} onClick={() => void run('test')}><PlugZap size={16} />Verbindung pruefen</button>
            <button className="button primary" type="submit" disabled={!canSubmit}><Save size={16} />Verbindung speichern</button>
          </div>
        </fieldset>
      </form>
      {action && <p className="shop-settings-progress" role="status"><LoaderCircle className="spin" size={16} />{action === 'test' ? 'WooCommerce wird geprueft ...' : action === 'save' ? 'Verbindung wird gespeichert ...' : 'Verbindung wird entfernt ...'}</p>}
      {confirmDelete && <div className="shop-settings-confirm" role="alertdialog" aria-labelledby="remove-shop-title"><h3 id="remove-shop-title">Shopverbindung entfernen?</h3><p>Die gespeicherten API-Schluessel werden lokal entfernt. Katalogdaten und der WooCommerce-Shop bleiben unveraendert.</p><div className="shop-settings-actions"><button className="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Abbrechen</button><button className="button primary" disabled={busy} onClick={() => void run('delete')}><Trash2 size={16} />Verbindung endgueltig entfernen</button></div></div>}
    </section>
  </main>
}