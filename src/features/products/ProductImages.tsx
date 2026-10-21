import { useEffect, useId, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Clock, ImageOff, ImagePlus, LoaderCircle, Search, Upload, X } from 'lucide-react'
import type { MediaItem, PendingMedia, ProductImage } from '../../types/desktop'
import { acceptedImageTypes, imageSource, useFileDrop, useImageUpload, type PendingMap } from './media'

const accepted = acceptedImageTypes.join(',')

function Thumb({ image, pending, size = 'medium' }: { image: Pick<ProductImage, 'id' | 'src' | 'name'>; pending: PendingMap; size?: 'small' | 'medium' }) {
  const src = imageSource(image, pending)
  const waiting = image.id < 0 ? pending.get(image.id) : null
  return <span className={`image-thumb ${size}`}>
    {src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} /> : <ImageOff size={size === 'small' ? 14 : 20} aria-hidden="true" />}
    {image.id < 0 && <span className={`image-badge ${waiting?.state === 'failed' ? 'failed' : 'waiting'}`} title={waiting?.error ?? 'Wird beim naechsten Abgleich in die Mediathek hochgeladen.'}>
      {waiting?.state === 'failed' ? 'Fehler' : <><Clock size={10} />Upload</>}
    </span>}
  </span>
}

// Media library of the shop plus uploads from the computer. Uploads are queued locally and can be used right away.
export function MediaPicker({ multiple, pending, onPendingAdded, onSelect, onCancel }: {
  multiple: boolean; pending: PendingMap; onPendingAdded: (entry: PendingMedia) => void
  onSelect: (images: ProductImage[]) => void; onCancel: () => void
}) {
  const desktop = window.catalogDesk
  const titleId = useId()
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MediaItem[]>([])
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [canUpload, setCanUpload] = useState<boolean | null>(null)
  const [selected, setSelected] = useState<ProductImage[]>([])
  const { upload, uploading } = useImageUpload(onPendingAdded)
  // Uploaded images are selected right away.
  const uploadAndSelect = async (files: File[]) => {
    const added = await upload(files)
    if (added.length) setSelected((current) => (multiple ? [...current, ...added] : [added[0]]))
  }
  const { active: dropping, dropProps } = useFileDrop((files) => { void uploadAndSelect(files) }, canUpload === false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.listMediaLibrary({ search: query, page }).then((result) => {
      if (cancelled) return
      if (!result.ok) { setError(result.error); return }
      setError('')
      setItems((current) => (page === 1 ? result.value.items : [...current, ...result.value.items.filter((item) => !current.some((entry) => entry.id === item.id))]))
      setPages(result.value.pages); setCanUpload(result.value.canUpload)
    }).catch(() => { if (!cancelled) setError('Die Mediathek konnte nicht geladen werden.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [desktop, query, page])

  function toggle(image: ProductImage) {
    const chosen = selected.some((entry) => entry.id === image.id)
    if (!multiple) setSelected(chosen ? [] : [image])
    else setSelected(chosen ? selected.filter((entry) => entry.id !== image.id) : [...selected, image])
  }

  const pendingList = [...pending.values()].filter((entry) => entry.state === 'pending')
  const tile = (image: ProductImage, thumb: React.ReactNode, label: string) => {
    const position = selected.findIndex((entry) => entry.id === image.id)
    return <li key={image.id}>
      <button type="button" className={`media-tile${position >= 0 ? ' selected' : ''}`} aria-pressed={position >= 0} title={label} onClick={() => toggle(image)}>
        {thumb}
        {position >= 0 && <span className="media-check">{multiple ? position + 1 : <Check size={12} />}</span>}
        <span className="media-name">{label}</span>
      </button>
    </li>
  }

  return <div className="taxonomy-modal-backdrop term-layer-backdrop"><section className="taxonomy-modal media-picker" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <header><h2 id={titleId}>{multiple ? 'Bilder auswaehlen' : 'Bild auswaehlen'}</h2><button type="button" className="icon-button" aria-label="Schliessen" onClick={onCancel}><X size={18} /></button></header>
    <div className="media-toolbar">
      {/* No <form>: the picker lives inside the product form, and Enter must search, not save the product. */}
      <div className="search-box" role="search">
        <Search size={14} /><input aria-label="Mediathek durchsuchen (Enter)" placeholder="Mediathek durchsuchen" value={search} onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setLoading(true); setPage(1); setQuery(search.trim()) } }} />
      </div>
      <label className={`button media-upload${canUpload === false ? ' disabled' : ''}`} title={canUpload === false ? 'Zum Hochladen unter Shopverbindung ein Anwendungspasswort hinterlegen.' : 'JPG, PNG, GIF oder WebP, hoechstens 20 MB'}>
        {uploading ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}Vom Computer hochladen
        <input type="file" accept={accepted} multiple={multiple} disabled={canUpload === false} onChange={(event) => { void uploadAndSelect([...(event.target.files ?? [])]); event.target.value = '' }} />
      </label>
    </div>
    {canUpload === false
      ? <p className="taxonomy-hint">Hochladen ist erst moeglich, wenn unter Shopverbindung ein WordPress-Benutzer mit Anwendungspasswort hinterlegt ist.</p>
      : <p className="taxonomy-hint">Bilder lassen sich auch aus dem Finder hierher ziehen.</p>}
    <div className={`media-body drop-zone${dropping ? ' drop-active' : ''}`} {...dropProps}>
      {dropping && <span className="drop-hint" aria-hidden="true"><Upload size={18} />Loslassen zum Hochladen</span>}
      {pendingList.length > 0 && <>
        <h3 className="media-heading">Vorgemerkt, wird beim naechsten Abgleich hochgeladen</h3>
        <ul className="media-grid">{pendingList.map((entry) => tile({ id: entry.id, src: '', name: entry.name, alt: '' }, <Thumb image={{ id: entry.id, src: '', name: entry.name }} pending={pending} />, entry.name))}</ul>
      </>}
      <h3 className="media-heading">Mediathek</h3>
      {error && <p className="media-status" role="status">{error}</p>}
      {!error && !loading && !items.length && <p className="media-status" role="status">{query ? `Keine Bilder zu „${query}“.` : 'Die Mediathek enthaelt noch keine Bilder.'}</p>}
      <ul className="media-grid">{items.map((item) => tile({ id: item.id, src: item.src, name: item.name, alt: item.alt }, <span className="image-thumb medium"><img src={item.thumb} alt="" loading="lazy" decoding="async" /></span>, item.name || `Bild #${item.id}`))}</ul>
      {loading && <p className="media-status" role="status"><LoaderCircle className="spin" size={14} />Mediathek wird geladen ...</p>}
      {!loading && !error && page < pages && <button type="button" className="button media-more" onClick={() => { setLoading(true); setPage(page + 1) }}>Weitere Bilder laden</button>}
    </div>
    <footer>
      <span className="media-count">{selected.length ? `${selected.length} ausgewaehlt` : ''}</span>
      <button type="button" className="button" onClick={onCancel}>Abbrechen</button>
      <button type="button" className="button primary" disabled={!selected.length || uploading > 0} onClick={() => onSelect(selected)}><Check size={16} />Uebernehmen</button>
    </footer>
  </section></div>
}

function AltText({ image, onChange }: { image: ProductImage; onChange: (alt: string) => void }) {
  return <label className="auth-field image-alt">
    <span>Alt-Text fuer „{image.name || (image.id < 0 ? 'neues Bild' : `Bild #${image.id}`)}“</span>
    <input maxLength={1000} value={image.alt} placeholder="Was ist auf dem Bild zu sehen?" onChange={(event) => onChange(event.target.value)} />
    <small className="taxonomy-hint">Der Alt-Text gehoert zum Bild in der Mediathek und gilt ueberall, wo es verwendet wird. Ueber WooCommerce laesst er sich aendern, aber nicht leeren.</small>
  </label>
}

// Product image (first) and gallery: add from the media library or computer, reorder by drag or arrows, remove, alt text.
export function ImageListField({ label, images, pending, onPendingAdded, onChange, onAppend, disabled = false }: {
  label: string; images: ProductImage[]; pending: PendingMap; onPendingAdded: (entry: PendingMedia) => void
  onChange: (images: ProductImage[]) => void; onAppend: (images: ProductImage[]) => void; disabled?: boolean
}) {
  const labelId = useId()
  const [picking, setPicking] = useState(false)
  const [active, setActive] = useState<number | null>(null)
  const [dragged, setDragged] = useState<number | null>(null)
  const current = images.find((image) => image.id === active) ?? null
  const { upload, uploading } = useImageUpload(onPendingAdded)
  // Files dropped from the desktop are appended to the list as it is when their upload is queued.
  const { active: dropping, dropProps } = useFileDrop((files) => {
    void upload(files).then((added) => { if (added.length) onAppend(added) })
  }, disabled)
  function move(from: number, to: number) {
    if (to < 0 || to >= images.length || from === to) return
    const next = [...images]
    const [image] = next.splice(from, 1)
    next.splice(to, 0, image)
    onChange(next)
  }
  return <div className="auth-field image-field">
    <span id={labelId}>{label}</span>
    <ul className={`image-list drop-zone${dropping ? ' drop-active' : ''}`} aria-labelledby={labelId} {...dropProps}>
      {images.map((image, index) => <li key={image.id} className={`${active === image.id ? 'active' : ''}${dragged === index ? ' dragging' : ''}`} draggable={!disabled}
        onDragStart={() => setDragged(index)} onDragEnd={() => setDragged(null)} onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); if (dragged !== null) move(dragged, index); setDragged(null) }}>
        <button type="button" className="image-select" aria-pressed={active === image.id} disabled={disabled} title="Alt-Text bearbeiten" onClick={() => setActive(active === image.id ? null : image.id)}>
          <Thumb image={image} pending={pending} />
        </button>
        {index === 0 && <span className="image-role">Produktbild</span>}
        <span className="image-actions">
          <button type="button" className="icon-button" aria-label={`${image.name || 'Bild'} nach vorne`} disabled={disabled || index === 0} onClick={() => move(index, index - 1)}><ArrowLeft size={13} /></button>
          <button type="button" className="icon-button" aria-label={`${image.name || 'Bild'} nach hinten`} disabled={disabled || index === images.length - 1} onClick={() => move(index, index + 1)}><ArrowRight size={13} /></button>
          <button type="button" className="icon-button" aria-label={`${image.name || 'Bild'} entfernen`} disabled={disabled} onClick={() => { onChange(images.filter((entry) => entry.id !== image.id)); if (active === image.id) setActive(null) }}><X size={13} /></button>
        </span>
      </li>)}
      <li className="image-add"><button type="button" className="image-add-button" disabled={disabled} onClick={() => setPicking(true)}>
        {uploading ? <LoaderCircle className="spin" size={20} /> : <ImagePlus size={20} />}{dropping ? 'Hier ablegen' : 'Bilder hinzufuegen'}
      </button></li>
    </ul>
    <small className="taxonomy-hint">Das erste Bild ist das Produktbild, die weiteren bilden die Galerie. Reihenfolge per Ziehen oder mit den Pfeilen aendern. Neue Bilder einfach aus dem Finder hierher ziehen.</small>
    {current && <AltText image={current} onChange={(alt) => onChange(images.map((image) => (image.id === current.id ? { ...image, alt } : image)))} />}
    {picking && <MediaPicker multiple pending={pending} onPendingAdded={onPendingAdded} onCancel={() => setPicking(false)}
      onSelect={(chosen) => { onChange([...images, ...chosen.filter((image) => !images.some((entry) => entry.id === image.id))]); setPicking(false) }} />}
  </div>
}

// One image (variation image, social images). `withAlt` for product images whose alt text WooCommerce sets.
export function SingleImageField({ label, image, pending, onPendingAdded, onChange, disabled = false, withAlt = false, hint }: {
  label: string; image: ProductImage | null; pending: PendingMap; onPendingAdded: (entry: PendingMedia) => void
  onChange: (image: ProductImage | null) => void; disabled?: boolean; withAlt?: boolean; hint?: string
}) {
  const labelId = useId()
  const [picking, setPicking] = useState(false)
  const { upload, uploading } = useImageUpload(onPendingAdded)
  const { active: dropping, dropProps } = useFileDrop((files) => {
    void upload(files.slice(0, 1)).then(([added]) => { if (added) onChange(added) })
  }, disabled)
  return <div className="auth-field image-field">
    <span id={labelId}>{label}</span>
    <div className={`single-image drop-zone${dropping ? ' drop-active' : ''}`} aria-labelledby={labelId} role="group" title="Bild auswaehlen oder aus dem Finder hierher ziehen" {...dropProps}>
      {uploading ? <span className="image-thumb medium"><LoaderCircle className="spin" size={20} aria-hidden="true" /></span>
        : image ? <Thumb image={image} pending={pending} /> : <span className="image-thumb medium empty"><ImageOff size={20} aria-hidden="true" /></span>}
      <span className="single-image-actions">
        <button type="button" className="button" disabled={disabled} onClick={() => setPicking(true)}><ImagePlus size={15} />{image ? 'Bild aendern' : 'Bild waehlen'}</button>
        {image && <button type="button" className="button" disabled={disabled} onClick={() => onChange(null)}><X size={15} />Entfernen</button>}
      </span>
    </div>
    {hint && <small className="taxonomy-hint">{hint}</small>}
    {withAlt && image && <AltText image={image} onChange={(alt) => onChange({ ...image, alt })} />}
    {picking && <MediaPicker multiple={false} pending={pending} onPendingAdded={onPendingAdded} onCancel={() => setPicking(false)}
      onSelect={([chosen]) => { onChange(chosen ?? null); setPicking(false) }} />}
  </div>
}
