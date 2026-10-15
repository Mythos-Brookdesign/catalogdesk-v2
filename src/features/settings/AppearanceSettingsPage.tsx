import { useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import type { Theme } from '../../types/desktop'
import './SettingsPage.css'

export function AppearanceSettingsPage() {
  const desktop = window.catalogDesk
  const [theme, setTheme] = useState<Theme>(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function changeTheme(next: Theme) {
    if (busy || next === theme) return
    const previous = theme
    setBusy(true); setError('')
    document.documentElement.dataset.theme = next
    setTheme(next)
    try {
      if (desktop) {
        const result = await desktop.setTheme(next)
        if (!result.ok) throw new Error(result.error)
      }
    } catch (reason) {
      document.documentElement.dataset.theme = previous
      setTheme(previous)
      setError(reason instanceof Error ? reason.message : 'Farbschema konnte nicht gespeichert werden.')
    }
    finally { setBusy(false) }
  }

  return <main className="section-page settings-page">
    <header><h1>Einstellungen</h1></header>
    <section className="appearance-settings" aria-labelledby="appearance-title">
      <h2 id="appearance-title">Darstellung</h2>
      <fieldset className="theme-options" disabled={busy}>
        <legend>Farbschema</legend>
        <label className={`theme-option ${theme === 'light' ? 'selected' : ''}`}><input type="radio" name="theme" value="light" checked={theme === 'light'} onChange={() => void changeTheme('light')} /><Sun size={17} />Hell</label>
        <label className={`theme-option ${theme === 'dark' ? 'selected' : ''}`}><input type="radio" name="theme" value="dark" checked={theme === 'dark'} onChange={() => void changeTheme('dark')} /><Moon size={17} />Dunkel</label>
      </fieldset>
      {error && <p className="auth-error" role="alert">{error}</p>}
    </section>
  </main>
}