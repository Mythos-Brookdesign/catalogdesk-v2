import { useEffect, useState } from 'react'
import { Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import type { CatalogUser, MenuSection, UserInput } from '../../types/desktop'
import { useNotify } from '../../components/notifications/notifications'
import './UsersPage.css'

const sections: [MenuSection, string][] = [
  ['dashboard', 'Dashboard'], ['products', 'Produkte'], ['orders', 'Bestellungen'],
  ['customers', 'Kunden'], ['settings', 'Einstellungen'], ['users', 'Benutzer'],
  ['shop', 'Shopverbindung'], ['taxonomies', 'Taxonomien'], ['sync', 'Synchronisation'],
]
const emptyUser: UserInput = { firstName: '', lastName: '', email: '', username: '', password: '', role: 'employee', permissions: ['dashboard'] }

export function UsersPage({ currentUser }: { currentUser?: CatalogUser }) {
  const desktop = window.catalogDesk
  const notify = useNotify()
  const canManage = currentUser?.role === 'admin'
  const [users, setUsers] = useState<CatalogUser[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<UserInput | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [deleting, setDeleting] = useState<CatalogUser | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.listUsers().then((result) => {
      if (cancelled) return
      if (result.ok) setUsers(result.value)
      else notify.error('Benutzer nicht geladen', { message: result.error, key: 'users-load' })
      setLoading(false)
    }).catch(() => {
      if (!cancelled) { notify.error('Benutzer nicht geladen', { message: 'Die lokale Datenbank hat nicht geantwortet.', key: 'users-load' }); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [desktop, notify])

  async function refresh() {
    const result = await desktop!.listUsers()
    if (!result.ok) throw new Error(result.error)
    setUsers(result.value)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!draft || !desktop || busy || !canManage) return
    if (draft.password !== confirmation) { setError('Die Passwoerter stimmen nicht ueberein.'); return }
    setBusy(true); setError('')
    try {
      const { password, ...profile } = draft
      const result = await desktop.saveUser({ ...profile, ...(password ? { password } : {}) })
      if (!result.ok) throw new Error(result.error)
      setDraft(null)
      if (result.value !== currentUser?.id) await refresh()
      notify.success(draft.id ? 'Benutzer gespeichert' : 'Benutzer angelegt', { message: `${draft.firstName} ${draft.lastName} (${draft.username})` })
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Speichern fehlgeschlagen.') }
    finally { setBusy(false) }
  }

  async function remove() {
    if (!deleting || !desktop || busy || !canManage) return
    setBusy(true); setError('')
    try {
      const result = await desktop.deleteUser(deleting.id)
      if (!result.ok) throw new Error(result.error)
      if (deleting.id !== currentUser?.id) await refresh()
      setDeleting(null); notify.success('Benutzer geloescht', { message: `${deleting.firstName} ${deleting.lastName} (${deleting.username})` })
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Loeschen fehlgeschlagen.') }
    finally { setBusy(false) }
  }

  const adminCount = users.filter((user) => user.role === 'admin').length
  return <main className="section-page users-page">
    <header className="users-heading"><h1>Benutzer</h1>{canManage && <button className="button primary" disabled={busy} onClick={() => { setDraft({ ...emptyUser }); setConfirmation(''); setError('') }}><Plus size={16} />Benutzer anlegen</button>}</header>
    {loading ? <p role="status">Benutzer werden geladen ...</p> : <div className="users-table-scroll"><table className="users-table"><thead><tr><th>Name</th><th>Benutzername</th><th>E-Mail</th><th>Rolle</th><th>Berechtigungen</th>{canManage && <th>Aktionen</th>}</tr></thead><tbody>{users.map((user) => <tr key={user.id}>
      <td>{user.firstName} {user.lastName}</td><td>{user.username}</td><td>{user.email}</td><td>{user.role === 'admin' ? 'Admin' : 'Mitarbeiter'}</td>
      <td>{user.role === 'admin' ? 'Alle Bereiche' : sections.filter(([key]) => user.permissions.includes(key)).map(([, title]) => title).join(', ') || 'Keine Bereiche'}</td>
      {canManage && <td className="users-actions"><button className="icon-button" aria-label={`Bearbeiten: ${user.username}`} title="Benutzer bearbeiten" onClick={() => { setDraft({ ...user, password: '' }); setConfirmation(''); setError('') }}><Pencil size={16} /></button><button className="icon-button" aria-label={`Loeschen: ${user.username}`} title={user.role === 'admin' && adminCount === 1 ? 'Der letzte Admin kann nicht geloescht werden' : 'Benutzer loeschen'} disabled={user.role === 'admin' && adminCount === 1} onClick={() => { setDeleting(user); setError('') }}><Trash2 size={16} /></button></td>}
    </tr>)}</tbody></table></div>}
    {draft && <div className="users-modal-backdrop"><section className="users-modal" role="dialog" aria-modal="true" aria-labelledby="user-form-title">
      <header className="users-heading"><h2 id="user-form-title">{draft.id ? 'Benutzer bearbeiten' : 'Benutzer anlegen'}</h2><button className="icon-button" aria-label="Schliessen" disabled={busy} onClick={() => setDraft(null)}><X size={18} /></button></header>
      <form onSubmit={(event) => void save(event)}>
        <div className="user-profile-grid">{(['firstName', 'lastName', 'email', 'username'] as const).map((key) => <label className="auth-field" key={key}><span>{{ firstName: 'Vorname', lastName: 'Name', email: 'E-Mail', username: 'Benutzername' }[key]}</span><input required disabled={busy} type={key === 'email' ? 'email' : 'text'} minLength={key === 'username' ? 3 : 1} maxLength={key === 'email' ? 254 : key === 'username' ? 32 : 80} pattern={key === 'username' ? '[A-Za-z0-9._-]+' : undefined} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></label>)}</div>
        <label className="auth-field"><span>Rolle</span><select aria-label="Rolle" disabled={busy || (Boolean(draft.id) && draft.id === users.find((user) => user.role === 'admin')?.id && adminCount === 1)} value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as UserInput['role'] })}><option value="admin">Admin</option><option value="employee">Mitarbeiter</option></select></label>
        {draft.role === 'employee' && <fieldset className="user-permissions" disabled={busy}><legend>Menueberechtigungen</legend>{sections.map(([key, title]) => <label key={key}><input type="checkbox" checked={draft.permissions.includes(key)} onChange={(event) => setDraft({ ...draft, permissions: event.target.checked ? [...draft.permissions, key] : draft.permissions.filter((permission) => permission !== key) })} />{title}</label>)}</fieldset>}
        <label className="auth-field"><span>{draft.id ? 'Neues Passwort (optional)' : 'Passwort'}</span><input type="password" minLength={8} maxLength={128} required={!draft.id} autoComplete="new-password" disabled={busy} value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} /></label>
        <label className="auth-field"><span>Passwort wiederholen</span><input type="password" minLength={8} maxLength={128} required={Boolean(draft.password) || !draft.id} autoComplete="new-password" disabled={busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <footer className="users-actions"><button className="button" type="button" disabled={busy} onClick={() => setDraft(null)}>Abbrechen</button><button className="button primary" disabled={busy || draft.password !== confirmation}><Save size={16} />Speichern</button></footer>
      </form>
    </section></div>}
    {deleting && <div className="users-modal-backdrop"><section className="users-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-user-title"><h2 id="delete-user-title">Benutzer loeschen?</h2><p>{deleting.firstName} {deleting.lastName} ({deleting.username}) wird dauerhaft geloescht.</p>{error && <p className="auth-error" role="alert">{error}</p>}<footer className="users-actions"><button className="button" disabled={busy} onClick={() => setDeleting(null)}>Abbrechen</button><button className="button primary" disabled={busy} onClick={() => void remove()}><Trash2 size={16} />Endgueltig loeschen</button></footer></section></div>}
  </main>
}