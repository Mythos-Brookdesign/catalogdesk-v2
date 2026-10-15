export type ProductType = 'simple' | 'variable' | 'variation'
export type SyncState = 'clean' | 'draft' | 'conflict'

export type ProductSummary = {
  id: number
  parentId: number | null
  type: ProductType
  sku: string
  name: string
  status: string
  syncState: SyncState
}

export type ProductQuery = {
  shopUrl?: string
  query?: string
  type?: 'all' | ProductType
  page?: number
  pageSize?: number
}

export type ProductPage = {
  products: ProductSummary[]
  total: number
  page: number
  pageSize: number
}
