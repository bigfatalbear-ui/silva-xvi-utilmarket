import { supabase } from './supabase'
import type { Product } from '../types'

export async function uploadProductImage(empresaId: string, productId: string, file: File) {
  if (!supabase) throw new Error('Supabase não configurado.')
  const extension = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'image'
  const path = `${empresaId}/${productId}-${crypto.randomUUID()}.${extension}`
  const { error } = await supabase.storage.from('produtos').upload(path, file, { contentType: file.type })
  if (error) throw error
  return path
}

export async function signProductImages(products: Product[]) {
  if (!supabase || !navigator.onLine) return products
  return Promise.all(products.map(async product => {
    if (!product.imagem_path) return product
    const { data } = await supabase!.storage.from('produtos').createSignedUrl(product.imagem_path, 3600)
    return { ...product, imagem_url: data?.signedUrl ?? null }
  }))
}
