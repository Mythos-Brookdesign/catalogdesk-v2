import { useState } from 'react'
import {
  Boxes,
  ChevronDown,
  CircleHelp,
  Database,
  GitCompareArrows,
  Settings,
  ShoppingBag,
  Tags,
  UsersRound,
} from 'lucide-react'
import './App.css'
import { ProductsPage } from './features/products/ProductsPage'

function App() {
  const desktop = window.catalogDesk
  const [activeSection, setActiveSection] = useState('products')

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Hauptnavigation">
        <div className="app-brand">
          <span className="brand-mark">C</span>
          <span>
            <strong>CatalogDesk</strong>
            <small>PRODUCT WORKSPACE</small>
          </span>
        </div>
        <div className="sidebar-caption">ARBEITSBEREICH</div>
        <nav className="app-nav">
          <button
            className={activeSection === 'products' ? 'active' : ''}
            onClick={() => setActiveSection('products')}
          >
            <Boxes size={17} />Produkte
          </button>
          <button disabled title="Bestellverwaltung folgt in einer späteren Phase">
            <ShoppingBag size={17} />Bestellungen
          </button>
          <button disabled title="Kundenverwaltung folgt nach Datenschutz- und Rollenmodell">
            <UsersRound size={17} />Kunden
          </button>
        </nav>
        <div className="sidebar-caption secondary-caption">EINSTELLUNGEN</div>
        <nav className="app-nav">
          <button disabled title="Allgemeine Einstellungen folgen als eigener Bereich">
            <Settings size={17} />Einstellungen
          </button>
          <button disabled title="Taxonomiepflege folgt im Produktbereich">
            <Tags size={17} />Taxonomien
          </button>
          <button disabled title="Synchronisation folgt nach dem lokalen Produktmodell">
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
            <span>CatalogDesk</span><ChevronDown size={13} /><strong>Produkte</strong>
          </div>
          <div className="topbar-tools">
            <span className="connection-state"><span className="status-dot" />Offline bereit</span>
            <button className="icon-button" aria-label="Hilfe" title="Hilfe"><CircleHelp size={17} /></button>
          </div>
        </header>
        {activeSection === 'products' && <ProductsPage desktop={desktop} />}
      </div>
    </div>
  )
}

export default App
