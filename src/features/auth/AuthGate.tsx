import { useEffect, useState } from 'react'
import { KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import App from '../../App'
import type { AuthState } from '../../types/desktop'
import './AuthGate.css'

export function AuthGate() {
  const desktop = window.catalogDesk
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [loading, setLoading] = useState(Boolean(desktop))
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.authState()
      .then((state) => { if (!cancelled) setAuth(state) })
      .catch(() => { if (!cancelled) setError('Lokale Nutzer konnten nicht geladen werden.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [desktop])

  if (!desktop) return <App />
  if (loading || !auth) {
    return <main className="auth-shell"><div className="auth-panel auth-loading"><LoaderCircle className="spin" size={22} /><span>Lokale Anmeldung wird geladen …</span></div></main>
  }
  if (auth.user) {
    return <App currentUser={auth.user} onLogout={async () => {
      await desktop.logout()
      setPassword('')
      setError('')
      setAuth({ setupRequired: false, user: null })
    }} />
  }
  const desktopApi = desktop
  const setupRequired = auth.setupRequired

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = setupRequired
        ? await desktopApi.bootstrapAdmin({ firstName, lastName, email, username, password })
        : await desktopApi.login({ username, password })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setPassword('')
      setAuth({ setupRequired: false, user: result.user })
    } catch {
      setError('Anmeldung fehlgeschlagen. Bitte erneut versuchen.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="auth-title">
        <span className="auth-mark">C</span>
        <span className="eyebrow">CATALOGDESK · LOKALER ARBEITSBEREICH</span>
        <h1 id="auth-title">{setupRequired ? 'Admin einrichten' : 'Anmelden'}</h1>
        <p>{setupRequired ? 'Erstelle das erste Admin-Konto für diesen lokalen Arbeitsbereich.' : 'Melde dich mit deinem lokalen Benutzerkonto an.'}</p>
        <div className="auth-security"><ShieldCheck size={16} /><span>Das Passwort wird lokal gehasht gespeichert.</span></div>
        <form onSubmit={(formEvent) => void submit(formEvent)}>
          {setupRequired && <>
            <label className="auth-field"><span>Vorname</span><input required maxLength={80} autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} /></label>
            <label className="auth-field"><span>Name</span><input required maxLength={80} autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} /></label>
            <label className="auth-field"><span>E-Mail</span><input required type="email" maxLength={254} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          </>}
          <label className="auth-field"><span>Benutzername</span><input required minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" autoComplete="username" autoCapitalize="none" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label className="auth-field"><span>Passwort{setupRequired ? ' · mindestens 8 Zeichen' : ''}</span><input required minLength={8} maxLength={128} type="password" autoComplete={setupRequired ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button className="button primary auth-submit" disabled={busy || !username || password.length < 8 || (setupRequired && (!firstName || !lastName || !email))} type="submit">
            {busy ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={17} />}
            {setupRequired ? 'Admin-Konto anlegen' : 'Anmelden'}
          </button>
        </form>
      </section>
    </main>
  )
}
