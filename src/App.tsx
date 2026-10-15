import { useState } from 'react'
import {
  Boxes,
  ChevronDown,
  CircleHelp,
  Database,
  GitCompareArrows,
  LayoutDashboard,
  LogOut,
  PlugZap,
  Settings,
  ShoppingBag,
  Tags,
  UserRound,
  UsersRound,
} from 'lucide-react'
import './App.css'
import { ProductsPage } from './features/products/ProductsPage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { UsersPage } from './features/users/UsersPage'
import { SettingsPage } from './features/settings/SettingsPage'
import type { CatalogUser } from './types/desktop'

type Section =
  | 'dashboard'
  | 'products'
  | 'orders'
  | 'customers'
  | 'settings'
  | 'users'
  | 'shop'
  | 'taxonomies'
  | 'sync'

const sectionTitles: Record<Section, string> = {
  dashboard: 'Dashboard',
  products: 'Produkte',
  orders: 'Bestellungen',
  customers: 'Kunden',
  settings: 'Einstellungen',
  users: 'Benutzer',
  shop: 'Shopverbindung',
  taxonomies: 'Taxonomien',
  sync: 'Synchronisation',
}

const menuGroups = [
  {
    title: 'ARBEITSBEREICH',
    entries: [
      { section: 'dashboard', icon: LayoutDashboard },
      { section: 'products', icon: Boxes },
      { section: 'orders', icon: ShoppingBag },
      { section: 'customers', icon: UsersRound },
    ],
  },
  {
    title: 'EINSTELLUNGEN',
    entries: [
      { section: 'settings', icon: Settings },
      { section: 'users', icon: UserRound },
      { section: 'shop', icon: PlugZap },
      { section: 'taxonomies', icon: Tags },
      { section: 'sync', icon: GitCompareArrows },
    ],
  },
] as const

function EmptySection({ title }: { title: string }) {
  return (
    <main className="section-page">
      <header>
        <span className="eyebrow">ARBEITSBEREICH</span>
        <h1>{title}</h1>
      </header>
    </main>
  )
}

function App({
  currentUser,
  onLogout,
}: {
  currentUser?: CatalogUser
  onLogout?: () => void
} = {}) {
  const desktop = window.catalogDesk
  const canAccess = (section: Section) => !currentUser || currentUser.role === 'admin' || currentUser.permissions.includes(section)
  const firstSection = (Object.keys(sectionTitles) as Section[]).find(canAccess)
  const [activeSection, setActiveSection] = useState<Section>(firstSection ?? 'dashboard')

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Hauptnavigation">
        <button
          className="app-brand app-brand-button"
          disabled={!canAccess('dashboard')}
          onClick={() => setActiveSection('dashboard')}
          title="Dashboard öffnen"
        >
          <span className="brand-mark">C</span>
          <span>
            <strong>CatalogDesk</strong>
            <small>PRODUCT WORKSPACE</small>
          </span>
        </button>
        {menuGroups.map((group, index) => {
          const entries = group.entries.filter(({ section }) => canAccess(section))
          if (!entries.length) return null
          return <div key={group.title}>
            <div className={`sidebar-caption ${index ? 'secondary-caption' : ''}`}>{group.title}</div>
            <nav className="app-nav" aria-label={group.title}>
              {entries.map(({ section, icon: Icon }) => <button
                key={section}
                className={activeSection === section ? 'active' : ''}
                aria-current={activeSection === section ? 'page' : undefined}
                aria-label={sectionTitles[section]}
                title={sectionTitles[section]}
                onClick={() => setActiveSection(section)}
              ><Icon size={17} />{sectionTitles[section]}</button>)}
            </nav>
          </div>
        })}
        <footer className="sidebar-status">
          <span className="status-dot" />
          <span><strong>Lokale Datenbank</strong><small>SQLite · V2</small></span>
          <Database size={15} />
        </footer>
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <div className="breadcrumb">
            <span>CatalogDesk</span><ChevronDown size={13} /><strong>{sectionTitles[activeSection]}</strong>
          </div>
          <div className="topbar-tools">
            <span className="connection-state"><span className="status-dot" />Offline bereit</span>
            {currentUser && <span className="user-chip">{currentUser.firstName} {currentUser.lastName}</span>}
            {onLogout && <button className="icon-button" aria-label="Abmelden" title="Abmelden" onClick={onLogout}><LogOut size={17} /></button>}
            <button className="icon-button" aria-label="Hilfe" title="Hilfe"><CircleHelp size={17} /></button>
          </div>
        </header>
        {!firstSection && <main className="section-page"><h1>Keine Bereiche freigegeben</h1></main>}
        {canAccess(activeSection) && activeSection === 'dashboard' && (
          <DashboardPage
            desktop={desktop}
            canOpenProducts={canAccess('products')}
            onOpenProducts={() => setActiveSection('products')}
          />
        )}
        {canAccess(activeSection) && activeSection === 'products' && <ProductsPage desktop={desktop} />}
        {canAccess(activeSection) && activeSection === 'users' && <UsersPage currentUser={currentUser} />}
        {canAccess(activeSection) && ['settings', 'shop'].includes(activeSection) && <SettingsPage key={activeSection} title={sectionTitles[activeSection]} />}
        {canAccess(activeSection) && !['dashboard', 'products', 'users', 'settings', 'shop'].includes(activeSection) && (
          <EmptySection title={sectionTitles[activeSection]} />
        )}
      </div>
    </div>
  )
}

export default App
