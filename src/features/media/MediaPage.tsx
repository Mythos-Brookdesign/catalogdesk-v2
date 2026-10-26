import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, CloudOff, Images, LoaderCircle, RefreshCw, Save, Search, Trash2, Undo2, Upload, X } from 'lucide-react'
import type { MediaFieldKey, MediaFilter, MediaLibraryItem, MediaListResult, MediaProgress, MediaUsage } from '../../types/desktop'
import { useNotify } from '../../components/notifications/notifications'
import { acceptedImageTypes, useFileDrop, useImageUpload } from '../products/media'
import { CachedImage } from '../products/ProductImages'
import '../products/ProductsPage.css'
import './MediaPage.css'

const fields: [MediaFieldKey, string][] = [['title', 'Titel'], ['alt', 'Alt-Text'], ['caption', 'Beschriftung'], ['description', 'Beschreibung']]
const filters: [MediaFilter, string][] = [['all', 'Alle Bilder'], ['pending', 'Noch nicht in WordPress'], ['unused', 'Nicht verwendet'], ['noAlt', 'Ohne Alt-Text'], ['changed', 'Mit vorgemerkter Aenderung']]
const pageSize = 60
const dateTime = (value: string | null) => (value ? new Date(value).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '—')
const fileSize = (bytes: number | null) => (bytes === null ? '—' : bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.round(bytes / 1024)} KB`)


// Local preview of a pending upload, or the cached thumbnail of a media library item.
function ItemImage({ item }: { item: MediaLibraryItem }) {
  if (item.upload) return item.thumbUrl ? <img src={item.thumbUrl} alt="" /> : <Upload size={20} aria-hidden="true" />
  return <CachedImage id={item.id} fallback={item.thumbUrl} />
}

function changeLabel(item: MediaLibraryItem) {
  if (item.upload) return item.upload === 'failed' ? 'Upload fehlgeschlagen' : 'Wartet auf Upload'
  if (item.changeOperation === 'delete') return item.blockedBy?.length ? 'Loeschen angehalten' : item.changeState === 'failed' ? 'Loeschen fehlgeschlagen' : 'Wird geloescht'
  return item.changeState === 'conflict' ? 'Konflikt' : item.changeState === 'failed' ? 'Fehler' : item.changeState === 'pending' ? 'Vorgemerkt' : null
}

// Deleting is final in WordPress: the confirmation names every product the image is removed from.
function DeleteConfirm({ item, trash, onCancel, onConfirm, busy }: { item: MediaLibraryItem & { usedIn: MediaUsage[] }; trash: boolean | null; onCancel: () => void; onConfirm: () => void; busy: boolean }) {
  const products = [...new Map(item.usedIn.filter((entry) => entry.productId).map((entry) => [entry.productId, entry])).values()]
  const terms = item.usedIn.filter((entry) => !entry.productId)
  return <div className="media-confirm" role="alertdialog" aria-labelledby="media-delete-title" aria-describedby="media-delete-text">
    <h3 id="media-delete-title">{item.upload ? 'Vorgemerkten Upload loeschen?' : 'Bild endgueltig loeschen?'}</h3>
    <p id="media-delete-text">{item.upload
      ? 'Das Bild wird nicht hochgeladen und die lokale Datei entfernt.'
      : trash
        ? 'Das Bild wird in den WordPress-Papierkorb verschoben und laesst sich dort 30 Tage lang wiederherstellen.'
        : trash === false
          ? 'Das Bild wird endgueltig aus der WordPress-Mediathek geloescht. Der Medien-Papierkorb ist in diesem WordPress aus, das laesst sich nicht rueckgaengig machen.'
          : 'Ist in WordPress der Medien-Papierkorb aktiv (MEDIA_TRASH), landet das Bild dort. Sonst wird es endgueltig geloescht und laesst sich nicht wiederherstellen.'}</p>
    {products.length > 0 && <>
      <p>Es wird vorher aus {products.length === 1 ? 'diesem Produkt' : `diesen ${products.length} Produkten`} entfernt:</p>
      <ul>{products.map((entry) => <li key={entry.productId}>{entry.parentId ? '↳ ' : ''}{entry.name || `#${entry.productId}`}</li>)}</ul>
    </>}
    {terms.length > 0 && <p>Ausserdem ist es das Bild von {terms.map((entry) => `„${entry.name}“`).join(', ')}. Das bleibt bestehen, deshalb haelt CatalogDesk das Loeschen an und fragt erneut.</p>}
    {!item.upload && <p className="media-confirm-note">Vor dem Loeschen prueft CatalogDesk in WordPress Beitraege, Seiten, Bloecke, Templates, Beitragsbilder, Logo und Website-Icon. Wird das Bild dort verwendet, wird nicht geloescht. Nicht pruefbar sind Page Builder (z. B. Elementor), Theme-Einstellungen und Widgets.</p>}
    <div className="media-confirm-actions">
      <button type="button" className="button" disabled={busy} onClick={onCancel}>Abbrechen</button>
      <button type="button" className="button danger" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{products.length ? 'Entfernen und loeschen' : 'Endgueltig loeschen'}</button>
    </div>
  </div>
}

function MediaDetail({ mediaId, canEdit, trash, onChanged, onClose }: { mediaId: number; canEdit: boolean; trash: boolean | null; onChanged: () => void; onClose: () => void }) {
  const desktop = window.catalogDesk
  const notify = useNotify()
  const [item, setItem] = useState<(MediaLibraryItem & { usedIn: MediaUsage[] }) | null>(null)
  const [values, setValues] = useState<Record<MediaFieldKey, string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [resolutions, setResolutions] = useState<Partial<Record<MediaFieldKey, 'mine' | 'shop'>>>({})
  const [version, setVersion] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.mediaDetail(mediaId).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        // A pending upload that reached WordPress meanwhile is no longer here: close instead of failing.
        if (mediaId < 0) onClose()
        else notify.error('Bild nicht geladen', { message: result.error, key: 'media-detail' })
        return
      }
      setItem(result.value)
      setValues({ title: result.value.title, alt: result.value.alt, caption: result.value.caption, description: result.value.description })
      setResolutions({})
    }).catch(() => { if (!cancelled) notify.error('Bild nicht geladen', { message: 'Die lokale Datenbank hat nicht geantwortet.', key: 'media-detail' }) })
    return () => { cancelled = true }
  }, [desktop, mediaId, version, notify, onClose])

  if (!item || !values) return <aside className="media-detail" aria-busy="true"><p className="media-status"><LoaderCircle className="spin" size={14} />Bild wird geladen ...</p></aside>
  const name = item.title || item.filename
  const deleting = item.changeOperation === 'delete'
  const editable = canEdit && item.editable && item.changeState !== 'conflict' && !deleting
  const dirty = fields.some(([key]) => values[key] !== item[key])
  const refresh = () => { setVersion((value) => value + 1); onChanged() }

  async function save() {
    if (!desktop || !values || !item) return
    setBusy(true)
    try {
      const changed = Object.fromEntries(fields.filter(([key]) => values[key] !== item[key]).map(([key]) => [key, values[key]]))
      const result = await desktop.changeMedia(item.id, changed)
      if (!result.ok) throw new Error(result.error)
      const { outcome } = result.value
      if (!result.value.queued) notify.info('Keine Aenderung', { message: `„${name}“ entspricht wieder dem Stand in WordPress.`, key: 'media-change' })
      else if (outcome === 'success') notify.success('Bild gespeichert', { message: `„${name}“ wurde in WordPress aktualisiert.`, key: 'media-change' })
      else if (outcome === 'conflict') notify.warning('Konflikt', { message: `„${name}“ wurde in WordPress geaendert. Bitte unten entscheiden.`, key: 'media-change' })
      else if (outcome === 'failure') notify.error('Von WordPress abgelehnt', { message: result.value.error ?? `„${name}“ wurde nicht gespeichert.`, key: 'media-change' })
      else notify.warning('Lokal vorgemerkt', { message: `„${name}“ wird uebertragen, sobald WordPress erreichbar ist.`, key: 'media-change' })
    } catch (reason) { notify.error('Nicht gespeichert', { message: reason instanceof Error ? reason.message : undefined }) }
    finally { setBusy(false); refresh() }
  }

  async function discard() {
    if (!desktop || !item) return
    const result = await desktop.discardMediaChange(item.id)
    if (!result.ok) notify.error('Nicht verworfen', { message: result.error })
    else notify.info('Aenderung verworfen', { message: `„${name}“ entspricht wieder dem Stand in WordPress.`, key: 'media-change' })
    refresh()
  }

  async function resolve() {
    if (!desktop || !item) return
    setBusy(true)
    try {
      const result = await desktop.resolveMediaConflict(item.id, name, resolutions)
      if (!result.ok) throw new Error(result.error)
      notify.success('Konflikt geloest', { message: `„${name}“ wird mit deiner Entscheidung uebertragen.`, key: 'media-change' })
    } catch (reason) { notify.error('Konflikt nicht geloest', { message: reason instanceof Error ? reason.message : undefined }) }
    finally { setBusy(false); refresh() }
  }

  async function remove() {
    if (!desktop || !item) return
    setBusy(true)
    try {
      const result = await desktop.deleteMedia(item.id)
      if (!result.ok) throw new Error(result.error)
      const { removedFrom, outcome, trashed } = result.value
      const from = removedFrom.length ? ` Aus ${removedFrom.length === 1 ? `„${removedFrom[0].name}“` : `${removedFrom.length} Produkten`} entfernt.` : ''
      if (!result.value.queued) notify.info('Upload geloescht', { message: `„${item.filename}“ wird nicht hochgeladen.${from}`, key: 'media-delete' })
      else if (outcome === 'success') notify.success(trashed ? 'In den Papierkorb verschoben' : 'Bild geloescht', { message: `„${name}“ ${trashed ? 'liegt im WordPress-Papierkorb und laesst sich dort wiederherstellen' : 'wurde endgueltig aus WordPress geloescht'}.${from}`, key: 'media-delete' })
      else if (outcome === 'held') notify.warning('Loeschen angehalten', { message: `„${name}“ wird in WordPress noch verwendet. Die Fundstellen stehen beim Bild.${from}`, key: 'media-delete' })
      else if (outcome === 'failure') notify.error('Nicht geloescht', { message: result.value.error ?? `„${name}“ wurde von WordPress nicht geloescht.`, key: 'media-delete' })
      else notify.warning('Zum Loeschen vorgemerkt', { message: `„${name}“ wird geloescht, sobald die Produkte im Shop aktualisiert sind.${from}`, key: 'media-delete' })
      setConfirmDelete(false)
      if (!result.value.queued || outcome === 'success') { onChanged(); onClose() } else { refresh() }
    } catch (reason) { notify.error('Nicht geloescht', { message: reason instanceof Error ? reason.message : undefined }) }
    finally { setBusy(false) }
  }

  async function forceDelete() {
    if (!desktop || !item) return
    setBusy(true)
    try {
      const result = await desktop.forceDeleteMedia(item.id)
      if (!result.ok) throw new Error(result.error)
      const { outcome, trashed } = result.value
      if (outcome === 'success') { notify.success(trashed ? 'In den Papierkorb verschoben' : 'Bild geloescht', { message: `„${name}“ ${trashed ? 'liegt im WordPress-Papierkorb' : 'wurde endgueltig geloescht'}.`, key: 'media-delete' }); onChanged(); onClose(); return }
      if (outcome === 'failure') notify.error('Nicht geloescht', { message: result.value.error ?? undefined, key: 'media-delete' })
      else notify.warning('Zum Loeschen freigegeben', { message: `„${name}“ wird geloescht, sobald WordPress erreichbar ist.`, key: 'media-delete' })
      refresh()
    } catch (reason) { notify.error('Nicht geloescht', { message: reason instanceof Error ? reason.message : undefined }) }
    finally { setBusy(false) }
  }

  async function cancelDelete() {
    if (!desktop || !item) return
    const result = await desktop.discardMediaChange(item.id)
    if (!result.ok) notify.error('Nicht abgebrochen', { message: result.error })
    else notify.info('Loeschen abgebrochen', { message: `„${name}“ bleibt in WordPress. Aus Produkten entfernte Verwendungen bleiben entfernt.`, key: 'media-delete' })
    refresh()
  }

  async function retryUpload() {
    if (!desktop) return
    const result = await desktop.retryMediaChanges()
    if (!result.ok) notify.error('Nicht hochgeladen', { message: result.error })
    else if (result.value.offline) notify.warning('WordPress nicht erreichbar', { message: 'Das Bild bleibt vorgemerkt.', key: 'media-retry' })
    refresh()
  }

  if (item.upload) return <aside className="media-detail" aria-label={`Upload ${item.filename}`}>
    <header>
      <div><span className="eyebrow">NOCH NICHT IN WORDPRESS</span><h2>{item.filename}</h2></div>
      <button type="button" className="icon-button" aria-label="Details schliessen" onClick={onClose}><X size={18} /></button>
    </header>
    <figure className="media-preview"><ItemImage item={item} /></figure>
    <dl className="media-facts">
      <div><dt>Typ</dt><dd>{item.mime}</dd></div>
      <div><dt>Groesse</dt><dd>{fileSize(item.filesize)}</dd></div>
      <div><dt>Vorgemerkt</dt><dd>{dateTime(item.createdAt ?? null)}</dd></div>
    </dl>
    {item.upload === 'failed'
      ? <div className="media-state failed" role="status"><AlertTriangle size={15} /><span>{item.changeError ?? 'Der Upload wurde abgelehnt.'}</span><button type="button" className="button" onClick={() => void retryUpload()}><RefreshCw size={14} />Erneut versuchen</button></div>
      : <div className="media-state pending" role="status"><CloudOff size={15} /><span>Wird beim naechsten Abgleich in die WordPress-Mediathek hochgeladen. Titel und Alt-Text lassen sich danach bearbeiten.</span></div>}
    <section className="media-usage" aria-label="Verwendet in">
      <h3>Verwendet in</h3>
      {item.usedIn.length
        ? <ul>{item.usedIn.map((entry, index) => <li key={`${entry.productId ?? entry.termId}-${entry.role}-${index}`}><span>{entry.parentId ? '↳ ' : ''}{entry.name || `#${entry.productId ?? entry.termId}`}</span><span className="media-role">{entry.role}</span></li>)}</ul>
        : <p className="taxonomy-hint">Noch in keinem Produkt verwendet.</p>}
    </section>
    {confirmDelete
      ? <DeleteConfirm item={item} trash={trash} busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />
      : <footer className="media-detail-footer"><button type="button" className="button danger-outline" onClick={() => setConfirmDelete(true)}><Trash2 size={14} />Loeschen</button></footer>}
  </aside>

  const conflicts = item.changeState === 'conflict' ? Object.keys(item.remote ?? {}) as MediaFieldKey[] : []
  return <aside className="media-detail" aria-label={`Bild ${name}`}>
    <header>
      <div><span className="eyebrow">BILD #{item.id}</span><h2>{name}</h2></div>
      <button type="button" className="icon-button" aria-label="Details schliessen" onClick={onClose}><X size={18} /></button>
    </header>
    <figure className="media-preview"><ItemImage item={item} /></figure>
    <dl className="media-facts">
      <div><dt>Datei</dt><dd>{item.filename}</dd></div>
      <div><dt>Masse</dt><dd>{item.width && item.height ? `${item.width} x ${item.height} px` : '—'}</dd></div>
      <div><dt>Groesse</dt><dd>{fileSize(item.filesize)}</dd></div>
      <div><dt>Hochgeladen</dt><dd>{dateTime(item.uploadedAt ? `${item.uploadedAt}Z` : null)}</dd></div>
    </dl>

    {deleting && item.blockedBy?.length ? <section className="media-held" aria-label="Loeschen angehalten">
      <h3>Loeschen angehalten: wird in WordPress noch verwendet</h3>
      <ul>{item.blockedBy.map((place, index) => <li key={index}><span>{place.kind}: {place.title}</span><span className="media-role">{place.where}</span></li>)}</ul>
      <p>Wird es trotzdem geloescht, fehlt das Bild an diesen Stellen{trash ? ' (es liegt dann im WordPress-Papierkorb)' : ''}.</p>
      <div className="media-confirm-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void cancelDelete()}><Undo2 size={14} />Loeschen abbrechen</button>
        <button type="button" className="button danger" disabled={busy} onClick={() => void forceDelete()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}Trotzdem loeschen</button>
      </div>
    </section> : deleting && <div className={`media-state ${item.changeState === 'failed' ? 'failed' : 'pending'}`} role="status"><Trash2 size={15} />
      <span>{item.changeState === 'failed' ? item.changeError ?? 'Das Loeschen wurde abgelehnt.' : 'Zum Loeschen vorgemerkt. Wird geloescht, sobald die betroffenen Produkte im Shop aktualisiert sind.'}</span>
      <button type="button" className="button" onClick={() => void cancelDelete()}><Undo2 size={14} />Abbrechen</button></div>}
    {!deleting && item.changeState === 'failed' && <div className="media-state failed" role="status"><AlertTriangle size={15} /><span>{item.changeError ?? 'Die Aenderung wurde abgelehnt.'}</span><button type="button" className="button" onClick={() => void discard()}><Undo2 size={14} />Verwerfen</button></div>}
    {!deleting && item.changeState === 'pending' && <div className="media-state pending" role="status"><CloudOff size={15} /><span>Aenderung vorgemerkt, wird an WordPress uebertragen.</span><button type="button" className="button" onClick={() => void discard()}><Undo2 size={14} />Verwerfen</button></div>}
    {conflicts.length > 0 && <section className="media-conflict" aria-label="Konflikt">
      <h3>In WordPress geaendert</h3>
      <p>Seit deiner Aenderung wurde das Bild in WordPress bearbeitet. Bitte je Feld entscheiden.</p>
      <table className="history-changes">
        <thead><tr><th>Feld</th><th>In WordPress jetzt</th><th>Deine Aenderung</th></tr></thead>
        <tbody>{conflicts.map((field) => <tr key={field}>
          <td>{fields.find(([key]) => key === field)?.[1]}</td>
          <td><label className="product-conflict-choice"><input type="radio" name={`media-conflict-${field}`} checked={resolutions[field] === 'shop'} onChange={() => setResolutions({ ...resolutions, [field]: 'shop' })} />{item.remote?.[field] || '—'}</label></td>
          <td><label className="product-conflict-choice"><input type="radio" name={`media-conflict-${field}`} checked={resolutions[field] === 'mine'} onChange={() => setResolutions({ ...resolutions, [field]: 'mine' })} />{item.changes?.[field] || '—'}</label></td>
        </tr>)}</tbody>
      </table>
      <button type="button" className="button primary" disabled={busy || conflicts.some((field) => !resolutions[field])} onClick={() => void resolve()}>Entscheidung uebernehmen</button>
    </section>}

    <form className="media-fields" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <fieldset disabled={!editable || busy}>
        {fields.map(([key, label]) => <label key={key} className="auth-field">
          <span>{label}</span>
          {key === 'caption' || key === 'description'
            ? <textarea rows={key === 'caption' ? 2 : 4} maxLength={key === 'caption' ? 10_000 : 50_000} value={values[key]} onChange={(event) => setValues({ ...values, [key]: event.target.value })} />
            : <input maxLength={1000} value={values[key]} placeholder={key === 'alt' ? 'Was ist auf dem Bild zu sehen?' : undefined} onChange={(event) => setValues({ ...values, [key]: event.target.value })} />}
        </label>)}
      </fieldset>
      {!canEdit && <p className="taxonomy-hint">Zum Bearbeiten unter Shopverbindung einen WordPress-Benutzer mit Anwendungspasswort hinterlegen.</p>}
      {canEdit && !item.editable && <p className="taxonomy-hint">Dieses Bild wurde ohne Anwendungspasswort gelesen. Bitte die Mediathek abgleichen, dann ist es bearbeitbar.</p>}
      {editable && <footer><button type="button" className="button" disabled={busy || !dirty} onClick={() => setValues({ title: item.title, alt: item.alt, caption: item.caption, description: item.description })}>Zuruecksetzen</button>
        <button className="button primary" disabled={busy || !dirty}>{busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Speichern</button></footer>}
    </form>

    <section className="media-usage" aria-label="Verwendet in">
      <h3>Verwendet in</h3>
      {item.usedIn.length
        ? <ul>{item.usedIn.map((entry, index) => <li key={`${entry.productId ?? entry.termId}-${entry.role}-${index}`}><span>{entry.parentId ? '↳ ' : ''}{entry.name || `#${entry.productId ?? entry.termId}`}</span><span className="media-role">{entry.role}</span></li>)}</ul>
        : <p className="taxonomy-hint">In keinem importierten Produkt und keiner Kategorie verwendet. Beitraege und Seiten prueft CatalogDesk beim Loeschen.</p>}
    </section>
    {!deleting && canEdit && (confirmDelete
      ? <DeleteConfirm item={item} trash={trash} busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />
      : <footer className="media-detail-footer"><button type="button" className="button danger-outline" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />Bild loeschen</button></footer>)}
  </aside>
}

export function MediaPage() {
  const desktop = window.catalogDesk
  const notify = useNotify()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<MediaFilter>('all')
  const [pages, setPages] = useState(1)
  const [data, setData] = useState<MediaListResult | null>(null)
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<MediaProgress | null>(null)
  // The first visit reads the WordPress media library without a click (once, when online).
  const autoImport = useRef(false)
  const reload = useCallback(() => setVersion((value) => value + 1), [])
  const closeDetail = useCallback(() => setSelected(null), [])
  // Picked images are part of the library right away (as "waiting for upload").
  const { upload, uploading } = useImageUpload(reload)
  const { active: dropping, dropProps } = useFileDrop((files) => { void upload(files).then((added) => { if (added.length) notify.info(added.length === 1 ? 'Bild vorgemerkt' : `${added.length} Bilder vorgemerkt`, { message: 'Sie werden beim naechsten Abgleich in die Mediathek hochgeladen.', key: 'media-upload' }) }) }, data?.canEdit === false)

  const sync = useCallback(async (full = false) => {
    if (!desktop) return
    setSyncing(true); setProgress(null)
    try {
      const result = await desktop.syncMediaLibrary(full)
      if (!result.ok) throw new Error(result.error)
      const { value } = result
      notify.success(value.full ? 'Mediathek importiert' : 'Mediathek abgeglichen', {
        message: value.full ? `${value.count.toLocaleString('de-DE')} Bilder aus WordPress gespeichert.` : `${value.changed.toLocaleString('de-DE')} geaendert, ${value.removed.toLocaleString('de-DE')} entfernt. ${value.count.toLocaleString('de-DE')} Bilder insgesamt.`,
        key: 'media-sync',
      })
      if (value.sync?.failed) notify.warning('Nicht alles uebertragen', { message: `${value.sync.failed} Aenderung(en) wurden von WordPress abgelehnt. Details beim Bild.`, key: 'media-sync-failed' })
    } catch (reason) { notify.error('Abgleich fehlgeschlagen', { message: reason instanceof Error ? reason.message : undefined, key: 'media-sync' }) }
    finally { setSyncing(false); setProgress(null); reload() }
  }, [desktop, notify, reload])

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.listMedia({ query, filter, page: 0, pageSize: pageSize * pages }).then((result) => {
      if (cancelled) return
      if (!result.ok) { notify.error('Mediathek nicht geladen', { message: result.error, key: 'media-load' }); return }
      setData(result.value)
      if (!result.value.imported && !autoImport.current && navigator.onLine) { autoImport.current = true; void sync(false) }
    }).catch(() => { if (!cancelled) notify.error('Mediathek nicht geladen', { message: 'Die lokale Datenbank hat nicht geantwortet.', key: 'media-load' }) })
    return () => { cancelled = true }
  }, [desktop, query, filter, pages, version, notify, sync])
  useEffect(() => desktop?.onMediaChanged(reload), [desktop, reload])
  useEffect(() => desktop?.onMediaProgress(setProgress), [desktop])

  async function retry() {
    if (!desktop) return
    const result = await desktop.retryMediaChanges()
    if (!result.ok) notify.error('Nicht uebertragen', { message: result.error })
    else if (result.value.offline) notify.warning('WordPress nicht erreichbar', { message: 'Die Aenderungen bleiben vorgemerkt.', key: 'media-retry' })
    else notify.info('Erneut uebertragen', { message: `${result.value.synced} uebertragen, ${result.value.failed} abgelehnt, ${result.value.conflicts} mit Konflikt.`, key: 'media-retry' })
    reload()
  }

  const counts = data?.changeCounts
  return <main className="section-page media-page">
    <header className="products-heading">
      <div>
        <span className="eyebrow">LOKALE MEDIATHEK</span>
        <h1>Mediathek</h1>
        <p>{[data?.imported ? `${data.count.toLocaleString('de-DE')} Bilder · zuletzt abgeglichen ${dateTime(data.syncedAt)}` : 'Noch nicht aus WordPress gelesen',
          data?.uploads ? `${data.uploads.toLocaleString('de-DE')} ${data.uploads === 1 ? 'wartet' : 'warten'} auf Upload` : null].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="media-actions">
        {data?.imported && <button type="button" className="button" disabled={syncing} title="Alle Bilder neu aus WordPress lesen" onClick={() => void sync(true)}>Neu einlesen</button>}
        <label className={`button media-upload${data?.canEdit === false ? ' disabled' : ''}`} title={data?.canEdit === false ? 'Zum Hochladen unter Shopverbindung ein Anwendungspasswort hinterlegen.' : 'JPG, PNG, GIF oder WebP, hoechstens 20 MB'}>
          {uploading ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}Hochladen
          <input type="file" accept={acceptedImageTypes.join(',')} multiple disabled={data?.canEdit === false} onChange={(event) => { void upload([...(event.target.files ?? [])]); event.target.value = '' }} />
        </label>
        <button type="button" className="button primary" disabled={syncing} onClick={() => void sync(false)}>
          {syncing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{data?.imported ? 'Mit WordPress abgleichen' : 'Mediathek importieren'}
        </button>
      </div>
    </header>

    {syncing && <p className="media-status" role="status"><LoaderCircle className="spin" size={14} />{progress ? `${progress.label}: Seite ${progress.page} von ${progress.pages}` : 'WordPress wird gelesen ...'}</p>}
    {data?.canEdit === false && <p className="taxonomy-hint">Ansehen und Auswaehlen geht ohne Anmeldung. Zum Bearbeiten und Hochladen unter Shopverbindung einen WordPress-Benutzer mit Anwendungspasswort hinterlegen.</p>}
    {counts && (counts.pending + counts.failed + counts.conflict > 0) && <div className="media-queue" role="status">
      <CloudOff size={15} />
      <span>{[counts.pending && `${counts.pending} vorgemerkt`, counts.failed && `${counts.failed} abgelehnt`, counts.conflict && `${counts.conflict} mit Konflikt`].filter(Boolean).join(' · ')}</span>
      {counts.failed > 0 && <button type="button" className="button" onClick={() => void retry()}><RefreshCw size={14} />Erneut versuchen</button>}
    </div>}

    {data && !data.imported && data.total > 0 && !syncing && <p className="taxonomy-hint">Die WordPress-Mediathek ist noch nicht eingelesen. Unten stehen die Bilder, die CatalogDesk aus den Produkten und eigenen Uploads kennt; „Mediathek importieren“ holt den Rest.</p>}
    {data && !data.imported && !data.total && !data.uploads ? <section className="products-empty">
      <Images size={28} />
      <h2>Mediathek noch nicht importiert</h2>
      <p>Einmal einlesen, danach gleicht CatalogDesk nur noch Aenderungen ab. Bilder und Texte stehen dann auch offline zur Verfuegung.</p>
    </section> : <>
      <section className="products-toolbar" aria-label="Filter">
        <label className="search-box"><Search size={15} /><input aria-label="Bilder suchen" placeholder="Titel, Alt-Text oder Dateiname" value={search}
          onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { setPages(1); setQuery(search.trim()) } }} onBlur={() => { if (search.trim() !== query) { setPages(1); setQuery(search.trim()) } }} /></label>
        <label className="type-filter"><select aria-label="Filter" value={filter} onChange={(event) => { setPages(1); setFilter(event.target.value as MediaFilter) }}>
          {filters.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select><ChevronDown size={14} /></label>
        {data && <span className="media-count">{data.total.toLocaleString('de-DE')} Treffer</span>}
      </section>

      <div className={`media-layout${selected ? ' with-detail' : ''}`}>
        <section className={`media-library drop-zone${dropping ? ' drop-active' : ''}`} aria-label="Bilder" {...dropProps}>
          {dropping && <span className="drop-hint" aria-hidden="true"><Upload size={18} />Loslassen zum Hochladen</span>}
          {data?.items.length ? <ul className="media-grid">{data.items.map((item) => <li key={item.id}>
            <button type="button" className={`media-tile${selected === item.id ? ' selected' : ''}`} aria-pressed={selected === item.id} onClick={() => setSelected(selected === item.id ? null : item.id)}>
              <span className="image-thumb medium"><ItemImage item={item} /></span>
              <span className="media-name">{item.title || item.filename}</span>
              <span className="media-badges">
                {item.usage ? <span className="media-badge">{item.usage}x verwendet</span> : <span className="media-badge muted">Nicht verwendet</span>}
                {!item.upload && !item.alt.trim() && <span className="media-badge warning">Ohne Alt</span>}
                {changeLabel(item) && <span className={`media-badge ${(item.changeState === 'pending' && item.changeOperation !== 'delete') || item.upload === 'pending' ? 'waiting' : 'failed'}`}>{changeLabel(item)}</span>}
              </span>
            </button>
          </li>)}</ul> : data && <p className="media-status">{query || filter !== 'all' ? 'Keine Bilder zu diesem Filter.' : 'Die Mediathek enthaelt keine Bilder.'}</p>}
          {data && data.items.length < data.total && <button type="button" className="button media-more" onClick={() => setPages(pages + 1)}>Weitere Bilder anzeigen</button>}
        </section>
        {selected && <MediaDetail key={selected} mediaId={selected} canEdit={Boolean(data?.canEdit)} trash={data?.trash ?? null} onChanged={reload} onClose={closeDetail} />}
      </div>
    </>}
  </main>
}
