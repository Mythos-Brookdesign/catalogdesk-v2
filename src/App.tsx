import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Boxes,
  ChevronDown,
  CircleHelp,
  Database,
  GitCompareArrows,
  History,
  LayoutDashboard,
  LogOut,
  PlugZap,
  Puzzle,
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
import { ShopConnectionPage } from './features/settings/SettingsPage'
import { AppearanceSettingsPage } from './features/settings/AppearanceSettingsPage'
import { TaxonomiesPage } from './features/taxonomies/TaxonomiesPage'
import { HistoryPage } from './features/history/HistoryPage'
import { PluginsPage } from './features/plugins/PluginsPage'
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
  | 'history'
  | 'plugins'

const sectionTitles: Record<Section, string> = {
  dashboard: 'Dashboard',
  products: 'Produkte',
  orders: 'Bestellungen',
  customers: 'Kunden',
  settings: 'Einstellungen',
  users: 'Benutzer',
  shop: 'Shopverbindung',
  plugins: 'Plugins',
  taxonomies: 'Taxonomien',
  sync: 'Synchronisation',
  history: 'Historie',
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
      { section: 'plugins', icon: Puzzle },
      { section: 'taxonomies', icon: Tags },
      { section: 'sync', icon: GitCompareArrows },
      { section: 'history', icon: History },
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
  const [shopUrl, setShopUrl] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.shopConnection()
      .then((result) => { if (!cancelled && result.ok) setShopUrl(result.value?.url ?? null) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [desktop])

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
        {shopUrl === null && activeSection !== 'shop' && (
          <div className="shop-missing-banner" role="status">
            <PlugZap size={17} />
            <span>
              <strong>Noch keine Shopverbindung eingerichtet.</strong>
              {canAccess('shop')
                ? ' Verbinde zuerst deinen WooCommerce-Shop unter „Shopverbindung“, um Produkte zu importieren und zu synchronisieren.'
                : ' Ein Administrator muss zuerst den WooCommerce-Shop unter „Shopverbindung“ verbinden.'}
            </span>
            {canAccess('shop') && (
              <button className="button primary" onClick={() => setActiveSection('shop')}>
                Shopverbindung öffnen<ArrowRight size={15} />
              </button>
            )}
          </div>
        )}
        {!firstSection && <main className="section-page"><h1>Keine Bereiche freigegeben</h1></main>}
        {canAccess(activeSection) && activeSection === 'dashboard' && (
          <DashboardPage
            desktop={desktop}
            canOpenProducts={canAccess('products')}
            onOpenProducts={() => setActiveSection('products')}
          />
        )}
        {canAccess(activeSection) && activeSection === 'products' && <ProductsPage desktop={desktop} canCreateTerms={canAccess('taxonomies')} />}
        {canAccess(activeSection) && activeSection === 'users' && <UsersPage currentUser={currentUser} />}
        {canAccess(activeSection) && activeSection === 'settings' && <AppearanceSettingsPage />}
        {canAccess(activeSection) && activeSection === 'shop' && <ShopConnectionPage onConnectionChange={setShopUrl} />}
        {canAccess(activeSection) && activeSection === 'taxonomies' && <TaxonomiesPage />}
        {canAccess(activeSection) && activeSection === 'history' && <HistoryPage />}
        {canAccess(activeSection) && activeSection === 'plugins' && <PluginsPage />}
        {canAccess(activeSection) && !['dashboard', 'products', 'users', 'settings', 'shop', 'taxonomies', 'history', 'plugins'].includes(activeSection) && (
          <EmptySection title={sectionTitles[activeSection]} />
        )}
      </div>
    </div>
  )
}

export default App
