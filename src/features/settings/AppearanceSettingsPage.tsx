import { useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import type { Theme } from '../../types/desktop'
import { useNotify } from '../../components/notifications/notifications'
import './SettingsPage.css'

export function AppearanceSettingsPage() {
  const desktop = window.catalogDesk
  const [theme, setTheme] = useState<Theme>(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const [busy, setBusy] = useState(false)
  const notify = useNotify()

  async function changeTheme(next: Theme) {
    if (busy || next === theme) return
    const previous = theme
    setBusy(true)
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
      notify.error('Farbschema nicht gespeichert', { message: reason instanceof Error ? reason.message : 'Bitte erneut versuchen.', key: 'theme' })
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
    </section>
  </main>
}