// Germanized for WooCommerce: German legal product data (delivery times, units/base prices,
// manufacturers for GPSR, price labels, food data). Its taxonomies and term fields are discovered
// generically; this module adds what discovery cannot know: names, field meanings, editor grouping.
const taxonomies = {
  product_delivery_time: 'Lieferzeiten',
  product_unit: 'Einheiten',
  product_manufacturer: 'Hersteller',
  product_price_label: 'Preishinweise',
  product_deposit_type: 'Pfandtypen',
  product_nutrient: 'Naehrwerte',
  product_allergen: 'Allergene',
}

module.exports = {
  id: 'germanized',
  name: 'Germanized',
  description: 'Lieferzeiten, Einheiten, Hersteller, Preishinweise, Pfand, Naehrwerte und Allergene fuer rechtssichere Shops in Deutschland.',
  // Active when the shop exposes at least one Germanized taxonomy.
  detect: ({ taxonomies: found }) => found.some((taxonomy) => taxonomy in taxonomies),
  taxonomyLabels: taxonomies,
  // Product/variation fields that hold a Germanized term, with their taxonomy and editor label.
  termFields: {
    delivery_time: { taxonomy: 'product_delivery_time', label: 'Lieferzeit' },
    unit: { taxonomy: 'product_unit', label: 'Einheit' },
    manufacturer: { taxonomy: 'product_manufacturer', label: 'Hersteller' },
    sale_price_label: { taxonomy: 'product_price_label', label: 'Preishinweis Angebot' },
    sale_price_regular_label: { taxonomy: 'product_price_label', label: 'Preishinweis regulaer' },
  },
  // Germanized stores the cart description as product meta and also returns it as `mini_desc`;
  // writing the meta keeps it in the generic meta_data path. Variations can have their own.
  metaFields: [
    { meta: '_mini_desc', label: 'Warenkorbkurzbeschreibung', type: 'html', scopes: ['product', 'variation'], hint: 'Wird im Bezahlvorgang und in den E-Mails als Kurzbeschreibung des Produkts angezeigt.' },
  ],
  editorSection: 'Germanized',
}
