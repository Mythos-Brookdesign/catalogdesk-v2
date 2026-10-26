export type ProductType = 'simple' | 'variable' | 'variation'
export type SyncState = 'clean' | 'draft' | 'conflict'

export type LocalProduct = {
  id: number
  parentId: number | null
  type: ProductType
  sku: string
  name: string
  status: string
  syncState: SyncState
  productType: string
  payload: Record<string, unknown>
  terms: { taxonomy: string; label: string; name: string }[]
  priceRange: [number, number] | null
  changeState: 'pending' | 'failed' | 'conflict' | null
  changeError: string | null
  changes: Record<string, unknown> | null
  base: Record<string, unknown> | null
  remote: Record<string, unknown> | null
}
export type ProductChangeCounts = { pending: number; failed: number; conflict: number }
export type ProductTermField = { scope: 'product' | 'variation'; field: string; multiple: boolean; taxonomy: string; label: string; hierarchical: boolean; section: string | null; editable: boolean; terms: TaxonomyTermOption[] }
export type ProductMetaField = {
  field: string; meta: string; label: string; type: 'text' | 'textarea' | 'html' | 'url' | 'select' | 'flags' | 'primaryTerm' | 'image' | 'mediaId'; section: string; module: string; scopes: ('product' | 'variation')[]
  recommended?: number; minimum?: number; hint?: string; of?: string; ofLabel?: string; group?: string; empty?: string[]; hidden?: boolean; idField?: string; imageField?: string; options?: { value: string; label: string }[]
}
export type ProductPreview = { type: 'search-snippet'; module: string; section: string; title: string | null; description: string | null }
export type ProductEditorOptions = { termFields: ProductTermField[]; shippingClasses: { slug: string; name: string }[]; metaFields: ProductMetaField[]; previews: ProductPreview[] }
export type ProductChange = { productId: number; values: Record<string, unknown>; terms: Record<string, number[] | number> }
export type ProductSyncResult = { synced: number; failed: number; conflicts: number; offline: boolean; counts: ProductChangeCounts }
export type ProductChangeResult = { queued: boolean; sync: ProductSyncResult | null; outcome: 'success' | 'failure' | 'conflict' | null; conflicts: string[]; error: string | null }

export type WorkspaceSummary = {
  shopCount: number
  latestShopUrl: string | null
  latestImportedAt: string | null
  products: number
  simple: number
  variable: number
  variations: number
}

export type ProductQuery = {
  shopUrl?: string
  query?: string
  type?: string
  page?: number
  pageSize?: number
}

export type ProductPage = {
  products: LocalProduct[]
  total: number
  page: number
  pageSize: number
  currency?: string | null
  changeCounts?: ProductChangeCounts
}

export type CatalogUser = {
  id: string
  firstName: string
  lastName: string
  email: string
  username: string
  role: 'admin' | 'employee'
  permissions: MenuSection[]
}
export type MenuSection = 'dashboard' | 'products' | 'orders' | 'customers' | 'settings' | 'users' | 'shop' | 'taxonomies' | 'sync' | 'history' | 'plugins' | 'media'
export type UserInput = AdminProfile & { id?: string; role: CatalogUser['role']; permissions: MenuSection[] }
// Image as WooCommerce stores it on a product; a negative ID is an upload that waits for the shop.
export type ProductImage = { id: number; src: string; name: string; alt: string }
export type MediaItem = { id: number; src: string; thumb: string; alt: string; name: string }
export type MediaFieldKey = 'title' | 'alt' | 'caption' | 'description'
export type MediaChangeCounts = { pending: number; failed: number; conflict: number }
// Item of the local media library copy, with queued edits applied.
export type MediaLibraryItem = {
  id: number; title: string; alt: string; caption: string; description: string; filename: string; mime: string
  width: number | null; height: number | null; filesize: number | null; sourceUrl: string; thumbUrl: string
  uploadedAt: string | null; modifiedAt: string | null; editable: boolean; usage?: number
  // Set for uploads that have not reached WordPress yet (negative ID, thumbUrl is a local preview).
  upload?: 'pending' | 'failed'; createdAt?: string
  changeState: 'pending' | 'failed' | 'conflict' | null; changeError: string | null; changeOperation?: 'update' | 'delete' | null; blockedBy?: MediaPlace[] | null
  changes: Partial<Record<MediaFieldKey, string>> | null; base: Partial<Record<MediaFieldKey, string>> | null; remote: Partial<Record<MediaFieldKey, string>> | null
}
export type MediaUsage = { productId: number | null; parentId: number | null; termId?: number; name: string; role: string }
// A place in WordPress that still uses an image (found right before deleting it).
export type MediaPlace = { kind: string; title: string; where: string; link?: string }
export type MediaLibraryState = { imported: boolean; importedAt: string | null; syncedAt: string | null; lastModified: string | null; trash: boolean | null; count: number; readOnly: number; uploads: number; changeCounts: MediaChangeCounts }
export type MediaListResult = MediaLibraryState & { items: MediaLibraryItem[]; total: number; page: number; pageSize: number; canEdit: boolean }
export type MediaFilter = 'all' | 'unused' | 'noAlt' | 'changed' | 'pending'
export type MediaProgress = { label: string; page: number; pages: number }
export type PendingMedia = { id: number; name: string; thumbnail: string | null; state: 'pending' | 'failed'; error: string | null }
export type UserResult<Value> = { ok: true; value: Value } | { ok: false; error: string }

export type AuthState = {
  setupRequired: boolean
  user: CatalogUser | null
}

export type AuthResult =
  | { ok: true; user: CatalogUser }
  | { ok: false; error: string }

export type AdminProfile = {
  firstName: string
  lastName: string
  email: string
  username: string
  password: string
}
export type ShopConnectionInput = { url: string; consumerKey: string; consumerSecret: string; wpUser: string; wpAppPassword: string }
export type ShopConnectionCheck = { url: string; productCount: number; checkedAt: string; media: { ok: true; user: string } | { ok: false; error: string } | null }
export type Theme = 'light' | 'dark'
export type ProductImportProgress = { step: 'taxonomies' | 'products' | 'variations' | 'saving'; label: string; completed: number; total: number }
export type TaxonomyKind = 'core' | 'custom' | 'attribute'
export type TaxonomySummary = {
  taxonomy: string
  kind: TaxonomyKind
  label: string
  route: string
  hierarchical: boolean
  available: boolean
  attribute: { id: number; type: string; orderBy: string; hasArchives: boolean } | null
  importedAt: string
  termCount: number
  editable: boolean
  pendingCount: number
  failedCount: number
}
export type TaxonomyOverview = { shopUrl: string | null; importedAt: string | null; taxonomies: TaxonomySummary[]; pendingChanges?: number; failedChanges?: number }
export type TermState = 'clean' | 'create' | 'update' | 'delete'
export type TaxonomyTerm = {
  id: number; name: string; slug: string; parentId: number; count: number; menuOrder: number; description: string
  path: string; depth: number; state: TermState; changeState: 'pending' | 'failed' | null; error: string | null
}
export type TermFields = { name: string; slug: string; parent: number; description: string }
export type TaxonomyTermChange =
  | { taxonomy: string; operation: 'create'; fields: TermFields }
  | { taxonomy: string; operation: 'update'; termId: number; fields: TermFields }
  | { taxonomy: string; operation: 'delete'; termId: number }
export type TaxonomySyncResult = { synced: number; failed: number; offline: boolean; pendingChanges: number; failedChanges: number }
export type TaxonomyTermOption = { id: number; name: string; slug: string; path: string; depth: number }
export type PluginModule = { id: string; name: string; description: string; detected: boolean; inactive: boolean; licensed: boolean; enabled: boolean; active: boolean; detectedAt: string | null }
export type AuditCategory = 'auth' | 'users' | 'settings' | 'shop' | 'taxonomies' | 'sync' | 'catalog'
export type AuditChange = { field: string; before: unknown; after: unknown }
export type AuditEntry = {
  id: number; occurredAt: string; category: AuditCategory; action: string; summary: string
  outcome: 'success' | 'failure'; source: 'user' | 'system'
  userId: string | null; username: string | null; userName: string | null
  targetType: string | null; targetId: string | null; targetLabel: string | null; shopUrl: string | null
  details: ({ changes?: AuditChange[] } & Record<string, unknown>) | null
}
export type AuditQuery = { query?: string; category?: AuditCategory; userId?: string; outcome?: 'success' | 'failure'; from?: string; to?: string; page?: number; pageSize?: number }
export type AuditPage = { entries: AuditEntry[]; total: number; page: number; pageSize: number; users: { id: string; name: string | null; username: string | null }[] }
export type TaxonomyTermQuery = { taxonomy: string; query?: string; page?: number; pageSize?: number }
export type TaxonomyTermPage = { terms: TaxonomyTerm[]; total: number; page: number; pageSize: number }
export type TaxonomyImportProgress = { label: string; completed: number; total: number }

declare global {
  interface Window {
    catalogDesk?: {
      getTheme: () => Promise<UserResult<Theme>>
      setTheme: (theme: Theme) => Promise<UserResult<Theme>>
      shopConnection: () => Promise<UserResult<{ url: string; wpUser: string | null } | null>>
      saveShopConnection: (input: ShopConnectionInput) => Promise<UserResult<{ url: string }>>
      testShopConnection: (input: ShopConnectionInput | null) => Promise<UserResult<ShopConnectionCheck>>
      deleteShopConnection: () => Promise<UserResult<boolean>>
      onAuthExpired: (listener: () => void) => () => void
      listUsers: () => Promise<UserResult<CatalogUser[]>>
      saveUser: (input: Omit<UserInput, 'password'> & { password?: string }) => Promise<UserResult<string>>
      deleteUser: (id: string) => Promise<UserResult<boolean>>
      authState: () => Promise<AuthState>
      bootstrapAdmin: (profile: AdminProfile) => Promise<AuthResult>
      login: (credentials: { username: string; password: string }) => Promise<AuthResult>
      developmentLogin: () => Promise<AuthResult>
      logout: () => Promise<boolean>
      workspaceSummary: () => Promise<WorkspaceSummary>
      listProducts: (query?: ProductQuery) => Promise<ProductPage>
      importProducts: () => Promise<UserResult<WorkspaceSummary & { relations: number; unresolved: number }>>
      onProductImportProgress: (listener: (progress: ProductImportProgress) => void) => () => void
      changeProduct: (change: ProductChange) => Promise<UserResult<ProductChangeResult>>
      syncProducts: (retryFailed?: boolean) => Promise<UserResult<ProductSyncResult>>
      discardProductChange: (productId: number) => Promise<UserResult<boolean>>
      resolveProductConflict: (resolution: { productId: number; name: string; resolutions: Record<string, 'mine' | 'shop'> }) => Promise<UserResult<ProductSyncResult | null>>
      productEditorOptions: () => Promise<UserResult<ProductEditorOptions>>
      onProductsChanged: (listener: () => void) => () => void
      importTaxonomies: () => Promise<UserResult<TaxonomyOverview>>
      taxonomyOverview: () => Promise<UserResult<TaxonomyOverview>>
      listTaxonomyTerms: (query: TaxonomyTermQuery) => Promise<UserResult<TaxonomyTermPage>>
      taxonomyTermOptions: (taxonomy: string) => Promise<UserResult<TaxonomyTermOption[]>>
      changeTaxonomyTerm: (change: TaxonomyTermChange) => Promise<UserResult<{ termId: number; sync: TaxonomySyncResult | null }>>
      discardTaxonomyChange: (ref: { taxonomy: string; termId: number }) => Promise<UserResult<boolean>>
      syncTaxonomies: (retryFailed?: boolean) => Promise<UserResult<TaxonomySyncResult>>
      onTaxonomiesChanged: (listener: () => void) => () => void
      listAudit: (query: AuditQuery) => Promise<UserResult<AuditPage>>
      listModules: () => Promise<UserResult<{ shopUrl: string | null; checked: boolean; modules: PluginModule[] }>>
      setModuleEnabled: (moduleId: string, enabled: boolean) => Promise<UserResult<PluginModule>>
      detectModules: () => Promise<UserResult<{ shopUrl: string | null; checked: boolean; modules: PluginModule[]; changes: { added: string[]; deactivated: string[]; removed: string[] } }>>
      listMediaLibrary: (query: { search?: string; page?: number }) => Promise<UserResult<{ items: MediaItem[]; page: number; pages: number; canUpload: boolean }>>
      listPendingMedia: () => Promise<UserResult<PendingMedia[]>>
      uploadMedia: (file: { name: string; type: string; data: Uint8Array }) => Promise<UserResult<PendingMedia>>
      listMedia: (query: { query?: string; filter?: MediaFilter; page?: number; pageSize?: number }) => Promise<UserResult<MediaListResult>>
      mediaDetail: (mediaId: number) => Promise<UserResult<MediaLibraryItem & { usedIn: MediaUsage[] }>>
      syncMediaLibrary: (full?: boolean) => Promise<UserResult<MediaLibraryState & { stored: number; removed: number; changed: number; full: boolean; sync: { synced: number; failed: number; conflicts: number; offline: boolean } | null }>>
      changeMedia: (mediaId: number, values: Partial<Record<MediaFieldKey, string>>) => Promise<UserResult<{ queued: boolean; outcome: 'success' | 'failure' | 'conflict' | null; conflicts: string[]; error: string | null }>>
      discardMediaChange: (mediaId: number) => Promise<UserResult<true>>
      resolveMediaConflict: (mediaId: number, name: string, resolutions: Partial<Record<MediaFieldKey, 'mine' | 'shop'>>) => Promise<UserResult<true>>
      deleteMedia: (mediaId: number) => Promise<UserResult<{ queued: boolean; removedFrom: { productId: number; parentId: number | null; name: string }[]; outcome: 'success' | 'failure' | 'held' | null; trashed: boolean | null; places: MediaPlace[]; error: string | null }>>
      forceDeleteMedia: (mediaId: number) => Promise<UserResult<{ outcome: 'success' | 'failure' | 'held' | null; trashed: boolean | null; error: string | null }>>
      retryMediaChanges: () => Promise<UserResult<{ synced: number; failed: number; conflicts: number; offline: boolean }>>
      onMediaChanged: (listener: () => void) => () => void
      onMediaProgress: (listener: (progress: MediaProgress) => void) => () => void
      onAuditAppended: (listener: () => void) => () => void
      onTaxonomyImportProgress: (listener: (progress: TaxonomyImportProgress) => void) => () => void
    }
  }
}
