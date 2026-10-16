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

module.exports = {
  id: 'yoast-seo',
  name: 'Yoast SEO',
  description: 'SEO-Titel, Meta-Beschreibung, Fokus-Keyphrase, Indexierung und Hauptkategorie mit Google-Vorschau.',
  detect: ({ namespaces }) => namespaces.includes('yoast/v1'),
  editorSection: 'Yoast SEO',
  metaFields: [
    { meta: '_yoast_wpseo_title', label: 'SEO-Titel', type: 'text', recommended: 60, hint: 'Leer: Vorlage der Website (meist Produktname - Seitenname). Platzhalter wie %%title%% sind erlaubt.' },
    { meta: '_yoast_wpseo_metadesc', label: 'Meta-Beschreibung', type: 'textarea', recommended: 156, minimum: 120 },
    { meta: '_yoast_wpseo_focuskw', label: 'Fokus-Keyphrase', type: 'text' },
    { meta: '_yoast_wpseo_canonical', label: 'Kanonische URL', type: 'url', hint: 'Nur setzen, wenn eine andere Seite die Hauptversion ist.' },
    { meta: '_yoast_wpseo_bctitle', label: 'Breadcrumb-Titel', type: 'text' },
    { meta: '_yoast_wpseo_meta-robots-noindex', label: 'In Suchergebnissen zeigen', type: 'select', options: robotsIndex },
    { meta: '_yoast_wpseo_meta-robots-nofollow', label: 'Links folgen', type: 'select', options: robotsFollow },
    { meta: '_yoast_wpseo_primary_product_cat', label: 'Hauptkategorie', type: 'primaryTerm', of: 'categories', hint: 'Wird in Breadcrumbs und Permalinks verwendet.' },
  ],
  // Search result preview built by the core from these fields.
  preview: { type: 'search-snippet', title: '_yoast_wpseo_title', description: '_yoast_wpseo_metadesc' },
}
