// Yoast SEO: search appearance of products. Yoast stores its values as product meta
// (_yoast_wpseo_*), which the WooCommerce REST API returns and accepts in `meta_data`.
// Variations have no SEO data of their own in Yoast, so all fields are product-only.
const robotsIndex = [
  { value: '', label: 'Standard (Einstellung der Website)' },
  { value: '2', label: 'Ja, in Suchergebnissen zeigen' },
  { value: '1', label: 'Nein, nicht in Suchergebnissen zeigen' },
]
const robotsFollow = [
  { value: '', label: 'Ja, Links folgen' },
  { value: '1', label: 'Nein, Links nicht folgen' },
]
// Stored comma-separated; older Yoast versions store "-" for none.
const robotsAdvanced = [
  { value: 'noimageindex', label: 'Keine Bilder indexieren' },
  { value: 'noarchive', label: 'Keine Archivkopie (Cache)' },
  { value: 'nosnippet', label: 'Kein Textausschnitt' },
]
const cornerstone = [
  { value: '', label: 'Nein' },
  { value: '1', label: 'Ja' },
]
const schemaPageTypes = [
  { value: '', label: 'Standard (Einstellung der Website)' },
  ...['WebPage', 'ItemPage', 'AboutPage', 'FAQPage', 'QAPage', 'ProfilePage', 'ContactPage', 'MedicalWebPage', 'CollectionPage', 'CheckoutPage', 'RealEstateListing', 'SearchResultsPage']
    .map((value) => ({ value, label: value })),
]

module.exports = {
  id: 'yoast-seo',
  name: 'Yoast SEO',
  // Plugin folder in the shop's plugin list (system status), e.g. to tell "deactivated" from "not installed".
  plugin: 'wordpress-seo',
  description: 'SEO-Titel, Meta-Beschreibung, Fokus-Keyphrase, Social-Vorschautexte, Indexierung, Schema und Hauptkategorie mit Google-Vorschau.',
  detect: ({ namespaces }) => namespaces.includes('yoast/v1'),
  editorSection: 'Yoast SEO',
  metaFields: [
    { meta: '_yoast_wpseo_title', label: 'SEO-Titel', type: 'text', recommended: 60, hint: 'Leer: Vorlage der Website (meist Produktname - Seitenname). Platzhalter wie %%title%% sind erlaubt.' },
    { meta: '_yoast_wpseo_metadesc', label: 'Meta-Beschreibung', type: 'textarea', recommended: 156, minimum: 120 },
    { meta: '_yoast_wpseo_focuskw', label: 'Fokus-Keyphrase', type: 'text' },
    { meta: '_yoast_wpseo_is_cornerstone', label: 'Cornerstone-Inhalt', type: 'select', options: cornerstone, hint: 'Die wichtigsten Seiten der Website; Yoast empfiehlt, oft intern auf sie zu verlinken.' },
    { meta: '_yoast_wpseo_primary_product_cat', label: 'Hauptkategorie', type: 'primaryTerm', of: 'categories', ofLabel: 'Kategorien', hint: 'Wird in Breadcrumbs und Permalinks verwendet.' },
    { meta: '_yoast_wpseo_primary_product_brand', label: 'Hauptmarke', type: 'primaryTerm', of: 'brands', ofLabel: 'Marken', hint: 'Nur bei mehreren Marken noetig.' },
    // Social: what Facebook, LinkedIn and others (Open Graph) and X show when the product is shared.
    { meta: '_yoast_wpseo_opengraph-title', group: 'Social', label: 'Social-Titel', type: 'text', recommended: 60, hint: 'Leer: SEO-Titel. Platzhalter wie %%title%% sind erlaubt.' },
    { meta: '_yoast_wpseo_opengraph-description', group: 'Social', label: 'Social-Beschreibung', type: 'textarea', recommended: 200, hint: 'Leer: Meta-Beschreibung.' },
    { meta: '_yoast_wpseo_twitter-title', group: 'Social', label: 'X-Titel', type: 'text', recommended: 70, hint: 'Leer: Social-Titel.' },
    { meta: '_yoast_wpseo_twitter-description', group: 'Social', label: 'X-Beschreibung', type: 'textarea', recommended: 200, hint: 'Leer: Social-Beschreibung.' },
    { meta: '_yoast_wpseo_meta-robots-noindex', group: 'Erweitert', label: 'In Suchergebnissen zeigen', type: 'select', options: robotsIndex },
    { meta: '_yoast_wpseo_meta-robots-nofollow', group: 'Erweitert', label: 'Links folgen', type: 'select', options: robotsFollow },
    { meta: '_yoast_wpseo_meta-robots-adv', group: 'Erweitert', label: 'Weitere Robots-Angaben', type: 'flags', options: robotsAdvanced, empty: ['-'] },
    { meta: '_yoast_wpseo_canonical', group: 'Erweitert', label: 'Kanonische URL', type: 'url', hint: 'Nur setzen, wenn eine andere Seite die Hauptversion ist.' },
    { meta: '_yoast_wpseo_bctitle', group: 'Erweitert', label: 'Breadcrumb-Titel', type: 'text' },
    { meta: '_yoast_wpseo_schema_page_type', group: 'Erweitert', label: 'Seitentyp (Schema)', type: 'select', options: schemaPageTypes },
  ],
  // Search result preview built by the core from these fields.
  preview: { type: 'search-snippet', title: '_yoast_wpseo_title', description: '_yoast_wpseo_metadesc' },
}
