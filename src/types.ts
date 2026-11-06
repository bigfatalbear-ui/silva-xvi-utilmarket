export type UserRole = 'gerente' | 'operador_caixa'
export type LicenseStatus = 'ativa' | 'bloqueada' | 'teste'
export type PaymentMethod = 'Dinheiro' | 'Cartão' | 'PIX' | 'Fiado'
export type SyncStatus = 'pendente' | 'sincronizada' | 'erro'

export type Product = {
  id: string
  tenant_id: string
  nome: string
  codigo_barras: string | null
  preco_custo: number
  preco_venda: number
  estoque_minimo: number
  quantidade_atual: number
  ativo: boolean
  updated_at?: string
  imagem_path?: string | null
  imagem_url?: string | null
  local_sync_status?: SyncStatus
  local_sync_error?: string
}

export type SaleItem = {
  produto_id: string
  codigo_barras: string | null
  nome: string
  quantidade: number
  preco_unitario: number
  subtotal: number
}

export type Sale = {
  id: string
  tenant_id: string
  itens: SaleItem[]
  valor_total: number
  forma_pagamento: PaymentMethod
  troco: number
  data_hora: string
  status_sync: SyncStatus
  erro_sync?: string
}

export type ShopSettings = {
  tenant_id: string
  cabecalho_nota: string
  rodape_nota: string
  cor_primaria: string
  cor_secundaria: string
  logotipo_url: string
  largura_papel_mm: 58 | 80
  local_sync_status?: 'pendente' | 'sincronizada'
}

export const DEFAULT_SETTINGS: Omit<ShopSettings, 'tenant_id'> = {
  cabecalho_nota: '',
  rodape_nota: 'Obrigado pela preferência!',
  cor_primaria: '#183c32',
  cor_secundaria: '#e1ae62',
  logotipo_url: '',
  largura_papel_mm: 80
}

export type Company = {
  id: string
  nome_fantasia: string
  status_licenca: LicenseStatus
  expira_em: string | null
  plano: string
}
