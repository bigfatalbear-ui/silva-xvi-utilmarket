import PouchDB from 'pouchdb-browser'
import type { Product, Sale, ShopSettings } from '../types'

type StoredDocument = {
  _id: string
  _rev?: string
  doc_type: 'produto' | 'venda' | 'configuracao'
  tenant_id: string
  [key: string]: unknown
}

const database = new PouchDB<StoredDocument>('silva-xvi-utilmarket')

async function writeDocument(document: StoredDocument) {
  let revision: string | undefined
  try {
    revision = (await database.get(document._id))._rev
  } catch (error) {
    if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error
  }
  await database.put({ ...document, ...(revision ? { _rev: revision } : {}) })
}

export async function listProducts(tenantId: string): Promise<Product[]> {
  const result = await database.allDocs({
    include_docs: true,
    startkey: `produto:${tenantId}:`,
    endkey: `produto:${tenantId}:\uffff`
  })
  return result.rows.flatMap(({ doc }) => doc?.doc_type === 'produto' ? [doc as unknown as Product] : [])
}

export async function saveProducts(tenantId: string, products: Product[]) {
  await Promise.all(products.map(({ imagem_url: _imageUrl, ...product }) => writeDocument({
    ...product,
    tenant_id: tenantId,
    _id: `produto:${tenantId}:${product.id}`,
    doc_type: 'produto'
  })))
}

export async function addSale(tenantId: string, sale: Sale) {
  await writeDocument({
    ...sale,
    _id: `venda:${tenantId}:${sale.id}`,
    doc_type: 'venda',
    tenant_id: tenantId
  })
}

export async function listPendingSales(tenantId: string): Promise<Sale[]> {
  const result = await database.allDocs({
    include_docs: true,
    startkey: `venda:${tenantId}:`,
    endkey: `venda:${tenantId}:\uffff`
  })
  return result.rows.flatMap(({ doc }) =>
    doc?.doc_type === 'venda' && doc.status_sync !== 'sincronizada' ? [doc as unknown as Sale] : []
  )
}

export async function listRecentSales(tenantId: string): Promise<Sale[]> {
  const result = await database.allDocs({
    include_docs: true,
    startkey: `venda:${tenantId}:`,
    endkey: `venda:${tenantId}:\uffff`
  })
  return result.rows.flatMap(({ doc }) => doc?.doc_type === 'venda' ? [doc as unknown as Sale] : [])
    .sort((a, b) => b.data_hora.localeCompare(a.data_hora))
    .slice(0, 50)
}

export async function markSaleSynced(tenantId: string, saleId: string, serverSale?: Partial<Sale>) {
  const id = `venda:${tenantId}:${saleId}`
  const sale = await database.get(id)
  await database.put({ ...sale, ...serverSale, status_sync: 'sincronizada', erro_sync: undefined })
}

export async function markSaleError(tenantId: string, saleId: string, message: string) {
  const id = `venda:${tenantId}:${saleId}`
  const sale = await database.get(id)
  await database.put({ ...sale, status_sync: 'erro', erro_sync: message })
}

export async function getLocalSettings(tenantId: string): Promise<ShopSettings | null> {
  try {
    return await database.get<ShopSettings & StoredDocument>(`configuracao:${tenantId}`)
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null
    throw error
  }
}

export async function saveLocalSettings(
  tenantId: string,
  settings: ShopSettings,
  status: NonNullable<ShopSettings['local_sync_status']> = 'pendente'
) {
  await writeDocument({
    ...settings,
    tenant_id: tenantId,
    _id: `configuracao:${tenantId}`,
    doc_type: 'configuracao',
    local_sync_status: status
  })
}
