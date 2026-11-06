import { isSupabaseConfigured, supabase } from './supabase'
import { getLocalSettings, listPendingSales, listProducts, markSaleError, markSaleSynced, saveLocalSettings, saveProducts } from './localDb'
import type { Product, Sale, SaleItem } from '../types'

export async function refreshProducts(tenantId: string) {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) return
  const { data, error } = await supabase
    .from('produtos')
    .select('id,tenant_id,nome,codigo_barras,preco_custo,preco_venda,estoque_minimo,quantidade_atual,ativo,updated_at,imagem_path')
    .eq('tenant_id', tenantId)
  if (error) throw new Error(`Não foi possível atualizar o catálogo: ${error.message}`)
  if (data) await saveProducts(tenantId, data as Product[])
}

export async function syncSales(tenantId: string) {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) return
  const pendingSales = await listPendingSales(tenantId)
  for (const sale of pendingSales) {
    const { data, error } = await supabase.rpc('registrar_venda', {
      p_sale_id: sale.id,
      p_troco: sale.troco,
      p_forma_pagamento: sale.forma_pagamento,
      p_itens: sale.itens.map(item => ({
        produto_id: item.produto_id,
        quantidade: item.quantidade,
        preco_unitario: item.preco_unitario
      }))
    })
    if (error) {
      await markSaleError(tenantId, sale.id, error.message)
    } else {
      const saved = data && typeof data === 'object' ? data as Record<string, unknown> : {}
      const serverSale: Partial<Sale> = {}
      if (typeof saved.valor_total === 'number' || typeof saved.valor_total === 'string') {
        serverSale.valor_total = Number(saved.valor_total)
      }
      if (Array.isArray(saved.itens)) serverSale.itens = saved.itens as SaleItem[]
      if (typeof saved.data_hora === 'string') serverSale.data_hora = saved.data_hora
      await markSaleSynced(tenantId, sale.id, serverSale)
    }
  }
}

export async function syncNow(tenantId: string) {
  if (!isSupabaseConfigured || !supabase || !navigator.onLine) return

  const cachedProducts = await listProducts(tenantId)
  const pendingSales = await listPendingSales(tenantId)
  const pendingQuantities = new Map<string, number>()
  for (const sale of pendingSales) {
    for (const item of sale.itens) {
      pendingQuantities.set(item.produto_id, (pendingQuantities.get(item.produto_id) ?? 0) + item.quantidade)
    }
  }
  for (const product of cachedProducts.filter(item => item.local_sync_status === 'pendente' || item.local_sync_status === 'erro')) {
    const { error } = await supabase.from('produtos').upsert({
      id: product.id,
      tenant_id: product.tenant_id,
      nome: product.nome,
      codigo_barras: product.codigo_barras,
      preco_custo: product.preco_custo,
      preco_venda: product.preco_venda,
      estoque_minimo: product.estoque_minimo,
      quantidade_atual: product.quantidade_atual + (pendingQuantities.get(product.id) ?? 0),
      ativo: product.ativo,
      imagem_path: product.imagem_path
    }, { onConflict: 'id' })
    await saveProducts(tenantId, [{
      ...product,
      local_sync_status: error ? 'erro' : 'sincronizada',
      local_sync_error: error?.message
    }])
  }

  await syncSales(tenantId)
  await refreshProducts(tenantId)

  const cachedSettings = await getLocalSettings(tenantId)
  if (cachedSettings?.local_sync_status === 'pendente') {
    const { tenant_id, cor_primaria, cor_secundaria, cabecalho_nota, rodape_nota, logotipo_url, largura_papel_mm } = cachedSettings
    const { error } = await supabase.from('configuracoes').upsert(
      { tenant_id, cor_primaria, cor_secundaria, cabecalho_nota, rodape_nota, logotipo_url, largura_papel_mm },
      { onConflict: 'tenant_id' }
    )
    if (error) throw new Error(`Não foi possível sincronizar as configurações: ${error.message}`)
    await saveLocalSettings(tenantId, cachedSettings, 'sincronizada')
  }

  const { data, error } = await supabase
    .from('configuracoes')
    .select('tenant_id,cor_primaria,cor_secundaria,cabecalho_nota,rodape_nota,logotipo_url,largura_papel_mm')
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (error) throw new Error(`Não foi possível atualizar as configurações: ${error.message}`)
  if (data) await saveLocalSettings(
    tenantId,
    { ...data, largura_papel_mm: data.largura_papel_mm === 58 ? 58 : 80 },
    'sincronizada'
  )
}
