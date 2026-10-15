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
  role: 'admin' | 'employee'
  permissions: MenuSection[]
}
export type MenuSection = 'dashboard' | 'products' | 'orders' | 'customers' | 'settings' | 'users' | 'shop' | 'taxonomies' | 'sync'
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
    }
  }
}
