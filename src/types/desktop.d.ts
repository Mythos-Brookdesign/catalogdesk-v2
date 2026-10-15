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
}

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
export type MenuSection = 'dashboard' | 'products' | 'orders' | 'customers' | 'settings' | 'users' | 'shop' | 'taxonomies' | 'sync' | 'history'
export type UserInput = AdminProfile & { id?: string; role: CatalogUser['role']; permissions: MenuSection[] }
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
export type ShopConnectionInput = { url: string; consumerKey: string; consumerSecret: string }
export type ShopConnectionCheck = { url: string; productCount: number; checkedAt: string }
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
export type TaxonomyTermOption = { id: number; path: string; depth: number }
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
      shopConnection: () => Promise<UserResult<{ url: string } | null>>
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
      logout: () => Promise<boolean>
      workspaceSummary: () => Promise<WorkspaceSummary>
      listProducts: (query?: ProductQuery) => Promise<ProductPage>
      importProducts: () => Promise<UserResult<WorkspaceSummary & { relations: number; unresolved: number }>>
      onProductImportProgress: (listener: (progress: ProductImportProgress) => void) => () => void
      importTaxonomies: () => Promise<UserResult<TaxonomyOverview>>
      taxonomyOverview: () => Promise<UserResult<TaxonomyOverview>>
      listTaxonomyTerms: (query: TaxonomyTermQuery) => Promise<UserResult<TaxonomyTermPage>>
      taxonomyTermOptions: (taxonomy: string) => Promise<UserResult<TaxonomyTermOption[]>>
      changeTaxonomyTerm: (change: TaxonomyTermChange) => Promise<UserResult<{ termId: number; sync: TaxonomySyncResult | null }>>
      discardTaxonomyChange: (ref: { taxonomy: string; termId: number }) => Promise<UserResult<boolean>>
      syncTaxonomies: (retryFailed?: boolean) => Promise<UserResult<TaxonomySyncResult>>
      onTaxonomiesChanged: (listener: () => void) => () => void
      listAudit: (query: AuditQuery) => Promise<UserResult<AuditPage>>
      onAuditAppended: (listener: () => void) => () => void
      onTaxonomyImportProgress: (listener: (progress: TaxonomyImportProgress) => void) => () => void
    }
  }
}
