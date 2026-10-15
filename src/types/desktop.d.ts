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

declare global {
  interface Window {
    catalogDesk?: {
      workspaceSummary: () => Promise<WorkspaceSummary>
      listProducts: (query?: ProductQuery) => Promise<ProductPage>
    }
  }
}
