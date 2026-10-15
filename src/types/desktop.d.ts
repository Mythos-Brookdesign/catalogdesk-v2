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
  payload: Record<string, unknown>
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
  type?: 'all' | ProductType
  page?: number
  pageSize?: number
}

export type ProductPage = {
  products: LocalProduct[]
  total: number
  page: number
  pageSize: number
}

export type CatalogUser = {
  id: string
  firstName: string
  lastName: string
  email: string
  username: string
  role: 'admin' | 'editor' | 'reader'
}

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

declare global {
  interface Window {
    catalogDesk?: {
      authState: () => Promise<AuthState>
      bootstrapAdmin: (profile: AdminProfile) => Promise<AuthResult>
      login: (credentials: { username: string; password: string }) => Promise<AuthResult>
      logout: () => Promise<boolean>
      workspaceSummary: () => Promise<WorkspaceSummary>
      listProducts: (query?: ProductQuery) => Promise<ProductPage>
    }
  }
}
