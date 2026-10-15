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
  const [activeSection, setActiveSection] = useState<Section>('dashboard')

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Hauptnavigation">
        <button
          className="app-brand app-brand-button"
          onClick={() => setActiveSection('dashboard')}
          title="Dashboard öffnen"
        >
          <span className="brand-mark">C</span>
          <span>
            <strong>CatalogDesk</strong>
            <small>PRODUCT WORKSPACE</small>
          </span>
        </button>
        <div className="sidebar-caption">ARBEITSBEREICH</div>
        <nav className="app-nav">
          <button
            className={activeSection === 'dashboard' ? 'active' : ''}
            onClick={() => setActiveSection('dashboard')}
          >
            <LayoutDashboard size={17} />Dashboard
          </button>
          <button
            className={activeSection === 'products' ? 'active' : ''}
            onClick={() => setActiveSection('products')}
          >
            <Boxes size={17} />Produkte
          </button>
          <button className={activeSection === 'orders' ? 'active' : ''} onClick={() => setActiveSection('orders')}>
            <ShoppingBag size={17} />Bestellungen
          </button>
          <button className={activeSection === 'customers' ? 'active' : ''} onClick={() => setActiveSection('customers')}>
            <UsersRound size={17} />Kunden
          </button>
        </nav>
        <div className="sidebar-caption secondary-caption">EINSTELLUNGEN</div>
        <nav className="app-nav">
          <button className={activeSection === 'settings' ? 'active' : ''} onClick={() => setActiveSection('settings')}>
            <Settings size={17} />Einstellungen
          </button>
          <button className={activeSection === 'users' ? 'active' : ''} onClick={() => setActiveSection('users')}>
            <UserRound size={17} />Benutzer
          </button>
          <button className={activeSection === 'shop' ? 'active' : ''} onClick={() => setActiveSection('shop')}>
            <PlugZap size={17} />Shopverbindung
          </button>
          <button className={activeSection === 'taxonomies' ? 'active' : ''} onClick={() => setActiveSection('taxonomies')}>
            <Tags size={17} />Taxonomien
          </button>
          <button className={activeSection === 'sync' ? 'active' : ''} onClick={() => setActiveSection('sync')}>
            <GitCompareArrows size={17} />Synchronisation
          </button>
        </nav>
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
        {activeSection === 'dashboard' && (
          <DashboardPage
            desktop={desktop}
            onOpenProducts={() => setActiveSection('products')}
          />
        )}
        {activeSection === 'products' && <ProductsPage desktop={desktop} />}
        {!['dashboard', 'products'].includes(activeSection) && (
          <EmptySection title={sectionTitles[activeSection]} />
        )}
      </div>
    </div>
  )
}

export default App
