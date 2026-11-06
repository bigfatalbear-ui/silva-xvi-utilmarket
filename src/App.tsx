import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  BarChart3, Barcode, Building2, Check, ChevronDown, Cloud, CloudOff, CreditCard,
  LogOut, Menu, Minus, Package, Pencil, Plus, Printer, RefreshCw, Search, Settings,
  ShieldCheck, ShoppingBasket, Trash2, UserPlus, Wifi, X
} from 'lucide-react'
import type { PaymentMethod, Product, Sale, ShopSettings, UserRole } from './types'
import { DEFAULT_SETTINGS } from './types'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import { addSale, getLocalSettings, listProducts, listRecentSales, saveLocalSettings, saveProducts } from './lib/localDb'
import { refreshProducts, syncNow } from './lib/sync'
import { connectThermalPrinter, prepareReceiptPrint, printReceipt } from './lib/printing'
import { signProductImages, uploadProductImage } from './lib/storage'

type UserInfo = {
  id: string
  tenant_id: string
  nome: string
  perfil: UserRole
  nome_fantasia: string
  status_licenca: string
  expira_em: string
  plano: string
}
type View = 'pdv' | 'produtos' | 'vendas' | 'configuracoes'
type BasketLine = { product: Product; quantity: number }
type ManagedCompany = {
  id: string
  nome_fantasia: string
  status_licenca: 'ativa' | 'bloqueada' | 'teste'
  expira_em: string
  plano: string
  total_usuarios: number
  total_vendas: number
}
type AdminAuditEntry = {
  id: number
  action: string
  company_name: string | null
  actor_email: string | null
  created_at: string
}
const formatMoney = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const cachedUserKey = (userId: string) => `utilmarket:session:${userId}`

function getCachedUser(userId: string): UserInfo | null {
  try {
    const user = JSON.parse(localStorage.getItem(cachedUserKey(userId)) ?? 'null') as UserInfo | null
    if (!user || user.id !== userId || user.status_licenca !== 'ativa') return null
    if (user.expira_em && new Date(user.expira_em).getTime() < Date.now()) return null
    return user
  } catch { return null }
}

export default function App() {
  const [user, setUser] = useState<UserInfo | null>(null)
  const [checking, setChecking] = useState(true)
  const [blocked, setBlocked] = useState('')
  const [view, setView] = useState<View>('pdv')
  const [products, setProducts] = useState<Product[]>([])
  const [sales, setSales] = useState<Sale[]>([])
  const [settings, setSettings] = useState<ShopSettings>({ ...DEFAULT_SETTINGS, tenant_id: '' })
  const [online, setOnline] = useState(navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  const [toast, setToast] = useState('')
  const [platformAdmin, setPlatformAdmin] = useState(false)

  const loadWorkspace = useCallback(async (tenantId: string) => {
    const [cachedProducts, cachedSettings] = await Promise.all([
      listProducts(tenantId),
      getLocalSettings(tenantId)
    ])
    setProducts(await signProductImages(cachedProducts))
    setSales(await listRecentSales(tenantId))
    if (cachedSettings) setSettings(cachedSettings)
    else setSettings({ ...DEFAULT_SETTINGS, tenant_id: tenantId })
    if (navigator.onLine && supabase) {
      try {
        await refreshProducts(tenantId)
        const { data: remoteSettings, error: settingsError } = await supabase
          .from('configuracoes')
          .select('tenant_id,cabecalho_nota,rodape_nota,cor_primaria,cor_secundaria,logotipo_url,largura_papel_mm')
          .eq('tenant_id', tenantId)
          .maybeSingle()
        if (settingsError) throw settingsError
        if (remoteSettings && cachedSettings?.local_sync_status !== 'pendente') {
          const remote = { ...DEFAULT_SETTINGS, ...remoteSettings } as ShopSettings
          setSettings(remote)
          await saveLocalSettings(tenantId, remote, 'sincronizada')
        } else if (!remoteSettings && !cachedSettings) {
          await saveLocalSettings(tenantId, { ...DEFAULT_SETTINGS, tenant_id: tenantId }, 'sincronizada')
        }
        const { data: remoteSales, error: salesError } = await supabase
          .from('vendas')
          .select('id,tenant_id,itens,valor_total,forma_pagamento,troco,data_hora')
          .eq('tenant_id', tenantId)
          .order('data_hora', { ascending: false })
          .limit(50)
        if (salesError) throw salesError
        if (remoteSales) {
          const remote = remoteSales.map(sale => ({ ...sale, status_sync: 'sincronizada' as const }))
          const pending = await listRecentSales(tenantId)
          const byId = new Map([...remote, ...pending.filter(sale => sale.status_sync !== 'sincronizada')].map(sale => [sale.id, sale]))
          setSales([...byId.values()].sort((a, b) => b.data_hora.localeCompare(a.data_hora)))
        }
      } catch (error) {
        setToast(error instanceof Error ? error.message : 'Falha ao atualizar os dados da empresa.')
      }
    }
    setProducts(await signProductImages(await listProducts(tenantId)))
  }, [])

  const checkSession = useCallback(async () => {
    if (!supabase) { setChecking(false); return }
    setChecking(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setUser(null); setPlatformAdmin(false); setChecking(false); return }
    const { data: isPlatformAdmin } = await supabase.rpc('is_platform_admin')
    if (isPlatformAdmin === true) {
      setPlatformAdmin(true)
      setBlocked('')
      setUser(null)
      setChecking(false)
      return
    }
    setPlatformAdmin(false)
    const { data: member, error } = await supabase.from('usuarios')
      .select('id,tenant_id,perfil,empresas(nome_fantasia,status_licenca,expira_em,plano)')
      .eq('id', session.user.id).maybeSingle()
    if (error || !member) {
      const cached = !navigator.onLine ? getCachedUser(session.user.id) : null
      if (cached) {
        setBlocked('')
        setUser(cached)
        await loadWorkspace(cached.tenant_id)
        setChecking(false)
        return
      }
      setBlocked('Não foi possível validar seu usuário e a licença da empresa. Verifique a conexão ou fale com o administrador.')
      setUser(null); setChecking(false); return
    }
    const company = Array.isArray(member.empresas) ? member.empresas[0] : member.empresas
    if (!company || company.status_licenca !== 'ativa' || !company.expira_em || new Date(company.expira_em).getTime() < Date.now()) {
      localStorage.removeItem(cachedUserKey(session.user.id))
      setBlocked('A licença da sua empresa está inativa ou vencida. Entre em contato com o administrador.')
      setUser(null); setChecking(false); return
    }
    setBlocked('')
    const nextUser = {
      id: member.id,
      tenant_id: member.tenant_id,
      nome: session.user.email ?? 'Usuário',
      perfil: member.perfil as UserRole,
      ...company
    }
    localStorage.setItem(cachedUserKey(nextUser.id), JSON.stringify(nextUser))
    if (nextUser.perfil !== 'gerente') setView('pdv')
    setUser(nextUser)
    await loadWorkspace(member.tenant_id)
    setChecking(false)
  }, [loadWorkspace])

  useEffect(() => {
    void checkSession()
    if (!supabase) return
    const { data: listener } = supabase.auth.onAuthStateChange(() => { void checkSession() })
    return () => listener.subscription.unsubscribe()
  }, [checkSession])

  useEffect(() => {
    const setConnection = () => setOnline(navigator.onLine)
    window.addEventListener('online', setConnection)
    window.addEventListener('offline', setConnection)
    return () => {
      window.removeEventListener('online', setConnection)
      window.removeEventListener('offline', setConnection)
    }
  }, [])

  useEffect(() => {
    if (!user || !online) return
    let active = true
    const sync = async () => {
      setSyncing(true)
      try {
        const { data: company, error: licenseError } = await supabase!
          .from('empresas')
          .select('status_licenca,expira_em')
          .eq('id', user.tenant_id)
          .maybeSingle()
        if (licenseError) throw licenseError
        if (!company || company.status_licenca !== 'ativa' || new Date(company.expira_em).getTime() < Date.now()) {
          if (active) {
            localStorage.removeItem(cachedUserKey(user.id))
            setBlocked('A licença da sua empresa está inativa ou vencida. Entre em contato com o administrador.')
            setUser(null)
          }
          return
        }
        await syncNow(user.tenant_id)
        if (active) setProducts(await signProductImages(await listProducts(user.tenant_id)))
        if (active) setSales(await listRecentSales(user.tenant_id))
        const currentSettings = await getLocalSettings(user.tenant_id)
        if (active && currentSettings) setSettings(currentSettings)
      } catch (error) {
        if (active) setToast(error instanceof Error ? error.message : 'Falha ao sincronizar com o Supabase.')
      } finally { if (active) setSyncing(false) }
    }
    void sync()
    const timer = window.setInterval(() => { void sync() }, 60_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [user, online])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3500)
    return () => window.clearTimeout(timer)
  }, [toast])

  const logout = async () => {
    if (user) localStorage.removeItem(cachedUserKey(user.id))
    await supabase?.auth.signOut()
    setUser(null)
    setPlatformAdmin(false)
    setSales([])
  }

  if (!isSupabaseConfigured) return <SetupScreen />
  if (checking) return <div className="loading-screen"><div className="loader" />Validando acesso…</div>
  if (platformAdmin) return <PlatformAdminApp onLogout={logout} />
  if (blocked) return <LoginCard blocked={blocked} onSuccess={checkSession} />
  if (!user) return <LoginCard onSuccess={checkSession} />

  return <Workspace
    user={user} view={view} setView={setView} products={products} setProducts={setProducts}
    sales={sales} setSales={setSales} settings={settings} setSettings={setSettings}
    online={online} syncing={syncing} onLogout={logout} notify={setToast} toast={toast}
  />
}

function SetupScreen() {
  return <div className="login-page"><section className="login-card setup-card">
    <Brand />
    <span className="eyebrow">CONFIGURAÇÃO NECESSÁRIA</span>
    <h1>Conecte seu Supabase</h1>
    <p>Adicione <code>VITE_SUPABASE_URL</code> e <code>VITE_SUPABASE_ANON_KEY</code> ao arquivo <code>.env</code> e reinicie o aplicativo.</p>
    <p className="muted">O acesso ao sistema exige autenticação e validação da licença configurada no banco.</p>
  </section><AuthorshipNotice /></div>
}

function Brand() {
  return <div className="brand-lockup"><div className="brand-mark">M</div><div><strong>SILVA XVI</strong><span>utilmarket</span></div></div>
}

function LoginCard({ blocked, onSuccess }: { blocked?: string; onSuccess: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(blocked ?? '')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase) return
    setError(''); setBusy(true)
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (authError) setError('E-mail ou senha inválidos. Confira seus dados e tente novamente.')
    else onSuccess()
  }

  return <div className="login-page"><section className="login-card">
    <Brand /><span className="eyebrow">GESTÃO PARA O SEU COMÉRCIO</span>
    <h1>Entre na sua conta</h1><p>Acesse seu caixa, produtos e vendas.</p>
    {error && <div className="alert" role="alert">{error}</div>}
    <form onSubmit={submit} className="form-stack">
      <label>E-mail<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} placeholder="voce@empresa.com" /></label>
      <label>Senha<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="Sua senha" /></label>
      <button className="button primary full" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
    </form>
    <p className="login-foot">Precisa de acesso? Fale com o administrador da sua empresa.</p>
  </section><AuthorshipNotice /></div>
}

function AuthorshipNotice() {
  return <footer className="authorship-notice">
    <span>© {new Date().getFullYear()} Fabio Silva dos Anjos. SILVA XVI utilmarket. Todos os direitos reservados.</span>
    <span>Reprodução, distribuição ou adaptação somente mediante autorização.</span>
    <span>Contato: <a href="https://wa.me/5571999383974">WhatsApp (71) 99938-3974</a> · <a href="mailto:fabiosilvaanjos@live.com">fabiosilvaanjos@live.com</a></span>
  </footer>
}

function PlatformAdminApp({ onLogout }: { onLogout: () => void }) {
  const [companies, setCompanies] = useState<ManagedCompany[]>([])
  const [audit, setAudit] = useState<AdminAuditEntry[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<ManagedCompany | null>(null)
  const [linking, setLinking] = useState<ManagedCompany | null>(null)
  const [companyFormOpen, setCompanyFormOpen] = useState(false)
  const [companyName, setCompanyName] = useState('')
  const [plan, setPlan] = useState('gratuito')
  const [licenseStatus, setLicenseStatus] = useState<ManagedCompany['status_licenca']>('teste')
  const [expiration, setExpiration] = useState(() => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10))
  const [memberEmail, setMemberEmail] = useState('')
  const [memberRole, setMemberRole] = useState<UserRole>('gerente')

  const loadAdminData = useCallback(async () => {
    if (!supabase) return
    setBusy(true)
    setError('')
    const [companyResult, auditResult] = await Promise.all([
      supabase.rpc('platform_list_companies'),
      supabase.rpc('platform_list_audit')
    ])
    if (companyResult.error) setError(`Não foi possível carregar os comércios: ${companyResult.error.message}`)
    else setCompanies((companyResult.data ?? []) as ManagedCompany[])
    if (auditResult.error) setError(current => current
      ? `${current} · Falha ao carregar auditoria: ${auditResult.error.message}`
      : `Falha ao carregar auditoria: ${auditResult.error.message}`)
    else setAudit((auditResult.data ?? []) as AdminAuditEntry[])
    setBusy(false)
  }, [])

  useEffect(() => { void loadAdminData() }, [loadAdminData])

  const filteredCompanies = companies.filter(company =>
    `${company.nome_fantasia} ${company.plano} ${company.status_licenca}`.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR'))
  )
  const activeCount = companies.filter(company => company.status_licenca === 'ativa' && new Date(company.expira_em).getTime() >= Date.now()).length
  const trialCount = companies.filter(company => company.status_licenca === 'teste').length
  const blockedCount = companies.filter(company => company.status_licenca === 'bloqueada' || new Date(company.expira_em).getTime() < Date.now()).length

  const resetCompanyForm = () => {
    setCompanyFormOpen(false)
    setCompanyName('')
    setPlan('gratuito')
    setLicenseStatus('teste')
    setExpiration(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10))
    setEditing(null)
  }
  const openEdit = (company: ManagedCompany) => {
    setCompanyFormOpen(true)
    setEditing(company)
    setCompanyName(company.nome_fantasia)
    setPlan(company.plano)
    setLicenseStatus(company.status_licenca)
    setExpiration(new Date(company.expira_em).toISOString().slice(0, 10))
  }
  const saveCompany = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError('')
    setNotice('')
    const expiresAt = new Date(`${expiration}T23:59:59`).toISOString()
    const result = editing
      ? await supabase.rpc('platform_update_company', {
          p_tenant_id: editing.id,
          p_nome_fantasia: companyName.trim(),
          p_status_licenca: licenseStatus,
          p_expira_em: expiresAt,
          p_plano: plan.trim()
        })
      : await supabase.rpc('platform_create_company', {
          p_nome_fantasia: companyName.trim(),
          p_status_licenca: licenseStatus,
          p_expira_em: expiresAt,
          p_plano: plan.trim()
        })
    setBusy(false)
    if (result.error) { setError(`Não foi possível salvar o comércio: ${result.error.message}`); return }
    setNotice(editing ? 'Comércio atualizado.' : 'Comércio cadastrado. Vincule um usuário para liberar o primeiro acesso.')
    resetCompanyForm()
    await loadAdminData()
  }
  const linkMember = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || !linking) return
    setBusy(true)
    setError('')
    setNotice('')
    const result = await supabase.rpc('platform_add_member', {
      p_tenant_id: linking.id,
      p_email: memberEmail.trim(),
      p_perfil: memberRole
    })
    setBusy(false)
    if (result.error) { setError(`Não foi possível vincular o usuário: ${result.error.message}`); return }
    setNotice(`Usuário vinculado a ${linking.nome_fantasia}.`)
    setLinking(null)
    setMemberEmail('')
    await loadAdminData()
  }
  const updateStatus = async (company: ManagedCompany) => {
    if (!supabase) return
    const nextStatus: ManagedCompany['status_licenca'] = company.status_licenca === 'ativa' ? 'bloqueada' : 'ativa'
    setBusy(true)
    setError('')
    const result = await supabase.rpc('platform_update_company', {
      p_tenant_id: company.id,
      p_nome_fantasia: company.nome_fantasia,
      p_status_licenca: nextStatus,
      p_expira_em: company.expira_em,
      p_plano: company.plano
    })
    setBusy(false)
    if (result.error) { setError(`Não foi possível alterar a licença: ${result.error.message}`); return }
    setNotice(nextStatus === 'ativa' ? 'Licença ativada.' : 'Comércio suspenso.')
    await loadAdminData()
  }

  return <div className="platform-admin-shell">
    <aside className="platform-admin-sidebar">
      <div className="sidebar-brand"><Brand /></div>
      <div className="admin-identity"><div className="admin-identity-icon"><ShieldCheck size={19} /></div><div><strong>Administração</strong><small>Plataforma SILVA XVI</small></div></div>
      <div className="admin-sidebar-note"><span className="connection-dot" /> Acesso administrativo validado</div>
      <button className="nav-item logout" onClick={onLogout}><LogOut size={18} />Sair da conta</button>
    </aside>
    <main className="platform-admin-main">
      <header className="platform-admin-header">
        <div><span className="breadcrumb">PAINEL DA PLATAFORMA</span><h1>Comércios</h1><p>Gerencie adesões, planos e licenças em um único lugar.</p></div>
        <button className="button primary" onClick={() => { resetCompanyForm(); setCompanyFormOpen(true); setLinking(null) }}><Plus size={17} /> Novo comércio</button>
      </header>
      <div className="platform-admin-content">
        {error && <div className="alert" role="alert">{error}</div>}
        {notice && <div className="admin-notice" role="status">{notice}</div>}
        <section className="admin-metrics">
          <article><span>Total de comércios</span><strong>{companies.length}</strong><Building2 size={20} /></article>
          <article><span>Licenças ativas</span><strong>{activeCount}</strong><Check size={20} /></article>
          <article><span>Em período de teste</span><strong>{trialCount}</strong><Wifi size={20} /></article>
          <article><span>Bloqueados ou vencidos</span><strong>{blockedCount}</strong><CloudOff size={20} /></article>
        </section>
        <section className="admin-table-card">
          <div className="admin-table-toolbar">
            <div><h2>Todos os comércios</h2><p>{filteredCompanies.length} de {companies.length} registros</p></div>
            <div className="admin-toolbar-actions">
              <label className="searchbox compact"><Search size={16} /><input aria-label="Buscar comércio" placeholder="Buscar comércio…" value={query} onChange={event => setQuery(event.target.value)} /></label>
              <button className="icon-button admin-refresh" aria-label="Atualizar lista" disabled={busy} onClick={() => void loadAdminData()}><RefreshCw size={17} /></button>
            </div>
          </div>
          <div className="table-scroll">
            <table><thead><tr><th>COMÉRCIO</th><th>PLANO</th><th>LICENÇA</th><th>VENCIMENTO</th><th>USUÁRIOS</th><th>VENDAS</th><th>AÇÕES</th></tr></thead>
              <tbody>{filteredCompanies.map(company => {
                const expired = new Date(company.expira_em).getTime() < Date.now()
                const currentStatus = expired ? 'Vencida' : company.status_licenca === 'ativa' ? 'Ativa' : company.status_licenca === 'teste' ? 'Teste' : 'Suspensa'
                return <tr key={company.id}>
                  <td><div className="admin-company-name"><div><Building2 size={16} /></div><span><strong>{company.nome_fantasia}</strong><small>{company.id}</small></span></div></td>
                  <td>{company.plano}</td>
                  <td><span className={`status-pill ${currentStatus === 'Ativa' ? '' : 'pending'} ${currentStatus === 'Suspensa' || currentStatus === 'Vencida' ? 'admin-status-blocked' : ''}`}>{currentStatus}</span></td>
                  <td>{new Date(company.expira_em).toLocaleDateString('pt-BR')}</td>
                  <td>{company.total_usuarios}</td><td>{company.total_vendas}</td>
                  <td><div className="admin-row-actions"><button className="row-action" aria-label={`Editar ${company.nome_fantasia}`} title="Editar comércio" onClick={() => openEdit(company)}><Pencil size={14} /></button><button className="row-action" aria-label={`Vincular usuário a ${company.nome_fantasia}`} title="Vincular usuário existente" onClick={() => { setLinking(company); setEditing(null) }}><UserPlus size={14} /></button><button className="admin-status-action" disabled={busy || currentStatus === 'Vencida'} onClick={() => void updateStatus(company)}>{company.status_licenca === 'ativa' ? 'Suspender' : 'Ativar'}</button></div></td>
                </tr>
              })}</tbody>
            </table>
            {!filteredCompanies.length && <div className="table-empty">{companies.length ? 'Nenhum comércio corresponde à busca.' : 'Nenhum comércio cadastrado.'}</div>}
          </div>
        </section>
        <section className="admin-audit-card">
          <div className="admin-audit-heading"><div><h2>Atividade administrativa</h2><p>Alterações recentes de licença, plano e usuários.</p></div><span>{audit.length} eventos</span></div>
          {audit.length ? <div className="admin-audit-list">{audit.map(entry => <article key={entry.id}><span className="admin-audit-marker"><Check size={13} /></span><div><strong>{entry.action.replace(/\./g, ' ')}</strong><p>{entry.company_name ?? 'Comércio removido'} · {entry.actor_email ?? 'Administrador'} · {new Date(entry.created_at).toLocaleString('pt-BR')}</p></div></article>)}</div> : <div className="table-empty">Ações administrativas registradas aparecerão aqui.</div>}
        </section>
        <AuthorshipNotice />
      </div>
      {companyFormOpen && <div className="admin-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) resetCompanyForm() }}>
        <section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-company-title">
          <div className="admin-modal-heading"><div><span className="eyebrow">GESTÃO DE ADESÕES</span><h2 id="admin-company-title">{editing ? 'Editar comércio' : 'Novo comércio'}</h2></div><button className="icon-button" aria-label="Fechar" onClick={resetCompanyForm}><X size={18} /></button></div>
          <form className="admin-form" onSubmit={saveCompany}>
            <label>Nome do comércio<input required maxLength={120} value={companyName} onChange={event => setCompanyName(event.target.value)} placeholder="Ex.: Mercado Central" /></label>
            <div className="form-grid"><label>Plano<input required maxLength={80} value={plan} onChange={event => setPlan(event.target.value)} /></label><label>Status da licença<select value={licenseStatus} onChange={event => setLicenseStatus(event.target.value as ManagedCompany['status_licenca'])}><option value="teste">Em teste</option><option value="ativa">Ativa</option><option value="bloqueada">Suspensa</option></select></label></div>
            <label>Vencimento da licença<input required type="date" value={expiration} onChange={event => setExpiration(event.target.value)} /></label>
            {!editing && <p className="admin-form-hint">Depois de cadastrar, crie ou convide o usuário em Supabase Authentication e use “Vincular usuário” para conceder acesso ao comércio.</p>}
            <div className="admin-modal-actions"><button type="button" className="button secondary" onClick={resetCompanyForm}>Cancelar</button><button className="button primary" disabled={busy}>{busy ? 'Salvando…' : editing ? 'Salvar alterações' : 'Cadastrar comércio'}</button></div>
          </form>
        </section>
      </div>}
      {linking && <div className="admin-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setLinking(null) }}>
        <section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-member-title">
          <div className="admin-modal-heading"><div><span className="eyebrow">ACESSO AO COMÉRCIO</span><h2 id="admin-member-title">Vincular usuário</h2><p>{linking.nome_fantasia}</p></div><button className="icon-button" aria-label="Fechar" onClick={() => setLinking(null)}><X size={18} /></button></div>
          <form className="admin-form" onSubmit={linkMember}>
            <label>E-mail cadastrado no Supabase Auth<input required type="email" value={memberEmail} onChange={event => setMemberEmail(event.target.value)} placeholder="usuario@empresa.com" /></label>
            <label>Perfil no comércio<select value={memberRole} onChange={event => setMemberRole(event.target.value as UserRole)}><option value="gerente">Gerente</option><option value="operador_caixa">Operador de caixa</option></select></label>
            <p className="admin-form-hint">O usuário precisa existir em Authentication no mesmo projeto Supabase. Gerentes administram o catálogo e as configurações; operadores acessam o caixa e as vendas.</p>
            <div className="admin-modal-actions"><button type="button" className="button secondary" onClick={() => setLinking(null)}>Cancelar</button><button className="button primary" disabled={busy}>{busy ? 'Vinculando…' : 'Vincular usuário'}</button></div>
          </form>
        </section>
      </div>}
    </main>
  </div>
}

function Workspace(props: {
  user: UserInfo; view: View; setView: (view: View) => void; products: Product[]; setProducts: (products: Product[]) => void
  sales: Sale[]; setSales: (sales: Sale[]) => void; settings: ShopSettings; setSettings: (settings: ShopSettings) => void
  online: boolean; syncing: boolean; onLogout: () => void; notify: (message: string) => void; toast: string
}) {
  const [mobileMenu, setMobileMenu] = useState(false)
  const pages = [
    { id: 'pdv' as const, label: 'Frente de caixa', icon: ShoppingBasket },
    { id: 'produtos' as const, label: 'Produtos', icon: Package },
    { id: 'vendas' as const, label: 'Vendas', icon: BarChart3 },
    { id: 'configuracoes' as const, label: 'Configurações', icon: Settings }
  ]
  const activePage = pages.find(page => page.id === props.view) ?? pages[0]
  const descriptions: Record<View, string> = {
    pdv: 'Realize suas vendas de forma rápida e eficiente.',
    produtos: 'Gerencie o catálogo e acompanhe seu estoque.',
    vendas: 'Acompanhe as movimentações do seu comércio.',
    configuracoes: 'Personalize seu comércio e o comprovante.'
  }
  const title = activePage.label
  return <div className="app-shell" style={{ '--accent': props.settings.cor_primaria, '--accent-secondary': props.settings.cor_secundaria } as React.CSSProperties}>
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
      <div className="sidebar-brand"><Brand /><button className="icon-button mobile-close" onClick={() => setMobileMenu(false)} aria-label="Fechar menu"><X size={18} /></button></div>
      <div className="shop-chip"><div className="shop-avatar">{props.user.nome_fantasia.slice(0, 1).toUpperCase()}</div><div><strong>{props.user.nome_fantasia}</strong><small>{props.user.plano}</small></div><ChevronDown size={16} /></div>
      <small className="nav-caption">MENU PRINCIPAL</small>
      <nav>{pages.filter(page => props.user.perfil === 'gerente' || (page.id !== 'produtos' && page.id !== 'configuracoes')).map(page => <button key={page.id} className={`nav-item ${props.view === page.id ? 'active' : ''}`} onClick={() => { props.setView(page.id); setMobileMenu(false) }}><page.icon size={19} /><span>{page.label}</span></button>)}</nav>
      <div className="sidebar-bottom"><div className={`connection ${props.online ? 'connected' : ''}`}><span className="connection-dot" />{props.online ? 'Conectado' : 'Modo offline'}<span className="connection-extra">{props.syncing ? 'Sincronizando' : '·'}</span></div><button className="nav-item logout" onClick={props.onLogout}><LogOut size={18} />Sair da conta</button></div>
    </aside>
    {mobileMenu && <button className="scrim" onClick={() => setMobileMenu(false)} aria-label="Fechar menu" />}
    <main className="main-area">
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="Abrir menu" onClick={() => setMobileMenu(true)}><Menu size={21} /></button><div className="page-heading-icon"><activePage.icon size={25} /></div><div className="page-heading-copy"><span className="breadcrumb">SILVA XVI · UTILMARKET</span><h1>{title}</h1><p>{descriptions[props.view]}</p></div>
        <div className="top-actions"><div className={`sync-pill ${props.online ? '' : 'offline'}`}>{props.online ? <Wifi size={15} /> : <CloudOff size={15} />}{props.online ? 'Online' : 'Offline'}</div><div className="user-chip"><div className="user-avatar">{props.user.nome.slice(0, 1).toUpperCase()}</div><span>{props.user.nome}</span><button aria-label="Sair" title="Sair" onClick={props.onLogout}><LogOut size={15} /></button></div></div>
      </header>
      <div className="page-content">
        {props.view === 'pdv' && <PosPage {...props} />}
        {props.view === 'produtos' && props.user.perfil === 'gerente' && <ProductsPage {...props} />}
        {props.view === 'vendas' && <SalesPage sales={props.sales} />}
        {props.view === 'configuracoes' && props.user.perfil === 'gerente' && <SettingsPage {...props} />}
        <AuthorshipNotice />
      </div>
      {props.toast && <div className="toast" role="status">{props.toast}</div>}
    </main>
  </div>
}

function PosPage({ user, products, setProducts, sales, setSales, settings, setSettings, online, notify }: {
  user: UserInfo; products: Product[]; setProducts: (products: Product[]) => void; sales: Sale[]; setSales: (sales: Sale[]) => void
  setSettings: (settings: ShopSettings) => void
  settings: ShopSettings; online: boolean; notify: (message: string) => void
}) {
  const [search, setSearch] = useState('')
  const [basket, setBasket] = useState<BasketLine[]>([])
  const [payment, setPayment] = useState<PaymentMethod>('Dinheiro')
  const [amountReceived, setAmountReceived] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const amount = basket.reduce((sum, line) => sum + line.product.preco_venda * line.quantity, 0)
  const change = Math.max(0, Number(amountReceived) - amount)
  const filtered = products.filter(product => product.ativo && `${product.nome} ${product.codigo_barras ?? ''}`.toLowerCase().includes(search.toLowerCase())).slice(0, 24)
  const recentRevenue = sales.reduce((sum, sale) => sum + sale.valor_total, 0)
  const recentItems = sales.reduce((sum, sale) => sum + sale.itens.reduce((itemSum, item) => itemSum + item.quantidade, 0), 0)
  const averageTicket = sales.length ? recentRevenue / sales.length : 0
  const activeProducts = products.filter(product => product.ativo).length

  const addProduct = (product: Product) => {
    const quantityInCart = basket.find(line => line.product.id === product.id)?.quantity ?? 0
    if (quantityInCart >= product.quantidade_atual) {
      notify('Estoque insuficiente para adicionar mais unidades deste produto.')
      return
    }
    setBasket(current => {
      const match = current.find(line => line.product.id === product.id)
      return match ? current.map(line => line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line) : [...current, { product, quantity: 1 }]
    })
    setSearch('')
    inputRef.current?.focus()
  }
  const scan = (event: FormEvent) => {
    event.preventDefault()
    const found = products.find(product => product.codigo_barras === search.trim())
    if (found?.ativo) addProduct(found)
    else if (search.trim()) notify('Código não encontrado no catálogo local.')
  }
  const changeQuantity = (id: string, delta: number) => setBasket(current => current.flatMap(line => line.product.id !== id ? [line] : line.quantity + delta > 0 ? [{ ...line, quantity: line.quantity + delta }] : []))
  const finalize = async () => {
    if (!basket.length || saving) return
    if (payment === 'Dinheiro' && Number(amountReceived) < amount) {
      notify('Informe um valor recebido igual ou maior que o total.')
      return
    }
    setSaving(true)
    const sale: Sale = {
      id: crypto.randomUUID(),
      tenant_id: user.tenant_id,
      itens: basket.map(line => ({
        produto_id: line.product.id,
        codigo_barras: line.product.codigo_barras,
        nome: line.product.nome,
        quantidade: line.quantity,
        preco_unitario: line.product.preco_venda,
        subtotal: line.product.preco_venda * line.quantity
      })),
      valor_total: amount,
      forma_pagamento: payment,
      troco: payment === 'Dinheiro' ? change : 0,
      data_hora: new Date().toISOString(),
      status_sync: 'pendente'
    }
    const printWindow = prepareReceiptPrint()
    let saleSaved = false
    try {
      await addSale(user.tenant_id, sale)
      saleSaved = true
      setSales([sale, ...sales])
      setBasket([])
      setAmountReceived('')
      inputRef.current?.focus()
      try { await printReceipt(sale, settings, user.nome_fantasia, printWindow) } catch (error) {
        notify(error instanceof Error ? error.message : 'Venda salva, mas não foi possível imprimir.')
      }
      const updated = products.map(product => {
        const sold = basket.find(line => line.product.id === product.id)
        return sold ? { ...product, quantidade_atual: Math.max(0, product.quantidade_atual - sold.quantity) } : product
      })
      await saveProducts(user.tenant_id, updated)
      setProducts(updated)
      notify(online ? 'Venda salva no dispositivo; sincronização iniciada.' : 'Venda salva no dispositivo e aguardando conexão.')
      if (online) {
        void syncNow(user.tenant_id)
          .then(async () => {
            setSales(await listRecentSales(user.tenant_id))
            setProducts(await signProductImages(await listProducts(user.tenant_id)))
            const latestSettings = await getLocalSettings(user.tenant_id)
            if (latestSettings) setSettings(latestSettings)
          })
          .catch(error => notify(error instanceof Error ? error.message : 'A venda segue na fila local de sincronização.'))
      }
    } catch (error) {
      if (!saleSaved) printWindow?.close()
      if (saleSaved && online) {
        void syncNow(user.tenant_id).catch(syncError =>
          notify(syncError instanceof Error ? syncError.message : 'A venda segue na fila local de sincronização.')
        )
      }
      notify(saleSaved
        ? `Venda registrada; houve falha ao atualizar o catálogo local: ${error instanceof Error ? error.message : 'erro desconhecido'}.`
        : `Não foi possível salvar a venda neste dispositivo: ${error instanceof Error ? error.message : 'erro desconhecido'}.`)
    } finally { setSaving(false) }
  }

  useEffect(() => {
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === 'F2') { event.preventDefault(); inputRef.current?.focus() }
      if (event.key === 'F3') { event.preventDefault(); setBasket([]); setAmountReceived('') }
      if (event.key === 'F4') { event.preventDefault(); void finalize() }
      if (event.key === 'F6') {
        event.preventDefault()
        const methods: PaymentMethod[] = ['Dinheiro', 'Cartão', 'PIX', 'Fiado']
        setPayment(current => methods[(methods.indexOf(current) + 1) % methods.length])
      }
      if (event.key === 'Escape') { setSearch(''); inputRef.current?.focus() }
    }
    window.addEventListener('keydown', handleKeys)
    return () => window.removeEventListener('keydown', handleKeys)
  }, [amount, amountReceived, basket, payment, products, saving])

  return <div className="pos-page">
    <div className="dashboard-stats" aria-label="Resumo das vendas e do catálogo">
      <article className="dashboard-stat stat-blue"><div className="dashboard-stat-icon"><ShoppingBasket size={21} /></div><div><span>Vendas recentes</span><strong>{formatMoney(recentRevenue)}</strong><small>{sales.length} registros carregados</small></div></article>
      <article className="dashboard-stat stat-purple"><div className="dashboard-stat-icon"><Barcode size={21} /></div><div><span>Itens vendidos</span><strong>{recentItems}</strong><small>na lista de vendas carregada</small></div></article>
      <article className="dashboard-stat stat-green"><div className="dashboard-stat-icon"><Package size={21} /></div><div><span>Produtos ativos</span><strong>{activeProducts}</strong><small>disponíveis no catálogo</small></div></article>
      <article className="dashboard-stat stat-amber"><div className="dashboard-stat-icon"><CreditCard size={21} /></div><div><span>Ticket médio</span><strong>{formatMoney(averageTicket)}</strong><small>sobre os registros carregados</small></div></article>
    </div>
    <div className="pos-layout">
    <section className="catalog-panel">
      <div className="page-intro"><div><span className="eyebrow">CAIXA RÁPIDO</span><h2>Nova venda</h2><p>Busque um produto ou use o leitor de código de barras.</p></div><div className="today-tag"><span className="green-dot" />{online ? 'Sincronização ativa' : 'Vendas offline ativadas'}</div></div>
      <form className="searchbox pos-search" onSubmit={scan}><Search size={19} /><input ref={inputRef} aria-label="Buscar produto ou código de barras" placeholder="Buscar produto ou ler código de barras…" value={search} onChange={event => setSearch(event.target.value)} autoFocus /><kbd>F2</kbd><button aria-label="Localizar"><Barcode size={19} /></button></form>
      <div className="catalog-heading"><h3>Produtos disponíveis</h3><span>{products.length} cadastrados</span></div>
      {filtered.length ? <div className="product-grid">{filtered.map(product => <button className="product-card" key={product.id} onClick={() => addProduct(product)}><div className="product-card-top"><div className="product-art">{product.imagem_url ? <img src={product.imagem_url} alt="" /> : <Package size={20} />}</div><span className={product.quantidade_atual > 0 ? 'stock-tag' : 'stock-tag empty'}>{product.quantidade_atual} un.</span></div><strong>{product.nome}</strong><small>{product.codigo_barras || 'Sem código de barras'}</small><div className="product-card-foot"><b>{formatMoney(product.preco_venda)}</b><span><Plus size={16} /></span></div></button>)}</div> :
        <div className="empty-state"><div className="empty-icon"><Package size={24} /></div><strong>{products.length ? 'Nenhum produto encontrado' : 'Seu catálogo está vazio'}</strong><p>{products.length ? 'Tente outra busca.' : 'Cadastre produtos na seção Produtos para iniciar as vendas.'}</p></div>}
      <div className="shortcut-hint"><span><kbd>F2</kbd> Buscar produto</span><span><kbd>F3</kbd> Limpar carrinho</span><span><kbd>F4</kbd> Finalizar venda</span><span><kbd>F6</kbd> Forma de pagamento</span><span><kbd>Esc</kbd> Limpar busca</span></div>
    </section>
    <aside className="cart-panel">
      <div className="cart-heading"><div><h2>Carrinho</h2><p>{basket.length} {basket.length === 1 ? 'item' : 'itens'} na venda</p></div><div className="cart-icon"><ShoppingBasket size={19} /></div></div>
      <div className="cart-lines">{basket.length ? basket.map(line => <div className="cart-line" key={line.product.id}><div className="cart-product"><strong>{line.product.nome}</strong><small>{formatMoney(line.product.preco_venda)} / un.</small><div className="quantity-control"><button aria-label="Diminuir quantidade" onClick={() => changeQuantity(line.product.id, -1)}><Minus size={13} /></button><b>{line.quantity}</b><button aria-label="Aumentar quantidade" disabled={line.quantity >= line.product.quantidade_atual} onClick={() => changeQuantity(line.product.id, 1)}><Plus size={13} /></button></div></div><div className="line-total">{formatMoney(line.product.preco_venda * line.quantity)}<button className="remove-line" aria-label={`Remover ${line.product.nome}`} onClick={() => setBasket(current => current.filter(item => item.product.id !== line.product.id))}><Trash2 size={14} /></button></div></div>) : <div className="cart-empty"><div className="basket-outline"><ShoppingBasket size={28} /></div><strong>Seu carrinho está vazio</strong><span>Selecione os produtos para adicionar à venda.</span></div>}</div>
      <div className="checkout">
        <label className="payment-select">Forma de pagamento<select value={payment} onChange={event => setPayment(event.target.value as PaymentMethod)}><option>Dinheiro</option><option>Cartão</option><option>PIX</option><option>Fiado</option></select></label>
        {payment === 'Dinheiro' && <label className="payment-select">Valor recebido<input inputMode="decimal" type="number" min={amount} step="0.01" value={amountReceived} onChange={event => setAmountReceived(event.target.value)} placeholder={amount.toFixed(2)} /></label>}
        {payment === 'Dinheiro' && Number(amountReceived) >= amount && <div className="total-row"><span>Troco</span><strong>{formatMoney(change)}</strong></div>}
        <div className="total-row"><span>Total da venda</span><strong>{formatMoney(amount)}</strong></div><button className="button primary finalize-button" disabled={!basket.length || saving || (payment === 'Dinheiro' && Number(amountReceived) < amount)} onClick={() => void finalize()}><CreditCard size={18} />{saving ? 'Salvando…' : 'Finalizar venda'}<kbd>F4</kbd></button><div className="cart-note"><Check size={14} /> Venda salva localmente antes de sincronizar</div></div>
    </aside>
    </div>
  </div>
}

function ProductsPage({ user, products, setProducts, online, notify }: { user: UserInfo; products: Product[]; setProducts: (products: Product[]) => void; online: boolean; notify: (message: string) => void }) {
  const [query, setQuery] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [barcode, setBarcode] = useState('')
  const [cost, setCost] = useState('')
  const [price, setPrice] = useState('')
  const [stock, setStock] = useState('')
  const [minimum, setMinimum] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const filtered = products.filter(product => `${product.nome} ${product.codigo_barras ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const startEditing = (product: Product) => {
    setEditingId(product.id)
    setName(product.nome)
    setBarcode(product.codigo_barras ?? '')
    setCost(String(product.preco_custo))
    setPrice(String(product.preco_venda))
    setStock(String(product.quantidade_atual))
    setMinimum(String(product.estoque_minimo))
    setFormOpen(true)
  }
  const resetForm = () => {
    setEditingId(null)
    setName('')
    setBarcode('')
    setCost('')
    setPrice('')
    setStock('')
    setMinimum('')
    setImageFile(null)
    setFormOpen(false)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    const existing = editingId ? products.find(item => item.id === editingId) : undefined
    let product: Product = {
      ...existing,
      id: editingId ?? crypto.randomUUID(),
      tenant_id: user.tenant_id,
      nome: name.trim(),
      codigo_barras: barcode.trim() || null,
      preco_custo: Number(cost) || 0,
      preco_venda: Number(price),
      estoque_minimo: Number(minimum) || 0,
      quantidade_atual: Number(stock) || 0,
      ativo: existing?.ativo ?? true,
      updated_at: new Date().toISOString(),
      imagem_path: existing?.imagem_path ?? null,
      local_sync_status: 'pendente'
    }
    if (!product.nome || !Number.isFinite(product.preco_venda) || product.preco_venda < 0 || product.preco_custo < 0) return
    setSaving(true)
    try {
      if (online && supabase) {
        if (imageFile) {
          product.imagem_path = await uploadProductImage(user.tenant_id, product.id, imageFile)
          product = (await signProductImages([product]))[0]
        }
      }
      const updatedProducts = existing
        ? products.map(item => item.id === product.id ? product : item)
        : [...products, product]
      await saveProducts(user.tenant_id, updatedProducts)
      setProducts(updatedProducts)
      resetForm()
      notify(online ? 'Produto salvo localmente; sincronização iniciada.' : 'Produto salvo localmente e será publicado quando a conexão voltar.')
      if (online) {
        void syncNow(user.tenant_id)
          .then(async () => setProducts(await signProductImages(await listProducts(user.tenant_id))))
          .catch(error => notify(error instanceof Error ? error.message : 'O produto segue pendente de sincronização.'))
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível salvar o produto.')
    }
    finally { setSaving(false) }
  }
  if (user.perfil !== 'gerente') return <div className="content-page"><div className="alert" role="alert">Somente um gerente pode administrar o catálogo.</div></div>
  return <div className="content-page">
    <div className="page-intro"><div><span className="eyebrow">CATÁLOGO</span><h2>Produtos</h2><p>Consulte seu estoque e mantenha o catálogo organizado.</p></div><button className="button primary" onClick={() => { resetForm(); setFormOpen(true) }}><Plus size={17} /> Cadastrar produto</button></div>
    {formOpen && <form className="product-form" onSubmit={save}><div className="form-heading"><strong>{editingId ? 'Editar produto' : 'Novo produto'}</strong><button type="button" className="icon-button" onClick={resetForm} aria-label="Fechar"><X size={18} /></button></div><div className="form-grid"><label>Nome<input required value={name} onChange={event => setName(event.target.value)} placeholder="Ex.: Café 500 g" /></label><label>Código de barras<input value={barcode} onChange={event => setBarcode(event.target.value)} placeholder="Opcional" /></label><label>Preço de custo (R$)<input required type="number" min="0" step="0.01" value={cost} onChange={event => setCost(event.target.value)} /></label><label>Preço de venda (R$)<input required type="number" min="0" step="0.01" value={price} onChange={event => setPrice(event.target.value)} /></label><label>Estoque atual<input type="number" min="0" step="1" value={stock} onChange={event => setStock(event.target.value)} /></label><label>Estoque mínimo<input type="number" min="0" step="1" value={minimum} onChange={event => setMinimum(event.target.value)} /></label><label>Imagem do produto<input type="file" accept="image/*" disabled={!online} onChange={event => setImageFile(event.target.files?.[0] ?? null)} />{!online && <small>Disponível ao conectar à internet.</small>}</label></div><button className="button primary" disabled={saving}>{saving ? 'Salvando…' : editingId ? 'Salvar alterações' : 'Salvar produto'}</button></form>}
    <div className="table-card"><div className="table-toolbar"><div className="searchbox compact"><Search size={17} /><input placeholder="Buscar produto…" value={query} onChange={event => setQuery(event.target.value)} /></div><span>{filtered.length} produtos</span></div><div className="table-scroll"><table><thead><tr><th>PRODUTO</th><th>CÓDIGO</th><th>CUSTO / VENDA</th><th>ESTOQUE</th><th>STATUS</th><th>AÇÕES</th></tr></thead><tbody>{filtered.map(product => <tr key={product.id}><td><div className="table-product"><div className="mini-product">{product.imagem_url ? <img src={product.imagem_url} alt="" /> : <Package size={16} />}</div><strong>{product.nome}</strong></div></td><td>{product.codigo_barras || '—'}</td><td>{formatMoney(product.preco_custo)} / <strong>{formatMoney(product.preco_venda)}</strong></td><td><span className={`stock-pill ${product.quantidade_atual <= product.estoque_minimo ? 'low' : ''}`}>{product.quantidade_atual} un.</span></td><td><span className={`status-pill ${!product.ativo || product.local_sync_status === 'erro' ? 'pending' : ''}`} title={product.local_sync_error}>{product.local_sync_status === 'erro' ? 'Erro na sync' : !product.ativo ? 'Inativo' : product.local_sync_status === 'pendente' ? 'Pendente' : 'Ativo'}</span></td><td><button className="row-action" aria-label={`Editar ${product.nome}`} onClick={() => startEditing(product)}><Pencil size={15} /></button></td></tr>)}</tbody></table>{!filtered.length && <div className="table-empty">Nenhum produto cadastrado.</div>}</div></div>
    <p className="data-note"><Cloud size={15} /> {online ? 'Catálogo sincronizado com a nuvem.' : 'O catálogo exibido foi salvo localmente e será atualizado quando houver conexão.'}</p>
  </div>
}

function SalesPage({ sales }: { sales: Sale[] }) {
  const revenue = sales.reduce((sum, sale) => sum + sale.valor_total, 0)
  return <div className="content-page"><div className="page-intro"><div><span className="eyebrow">MOVIMENTAÇÃO</span><h2>Vendas</h2><p>Acompanhe as vendas registradas neste dispositivo.</p></div></div>
    <div className="stats-row"><div className="stat-card"><span>Vendas carregadas</span><strong>{sales.length}</strong><small>vendas recentes</small></div><div className="stat-card"><span>Faturamento exibido</span><strong>{formatMoney(revenue)}</strong><small>sobre a lista carregada</small></div><div className="stat-card"><span>Pendentes de sync</span><strong>{sales.filter(sale => sale.status_sync !== 'sincronizada').length}</strong><small>aguardando conexão</small></div></div>
    <div className="table-card"><div className="table-toolbar"><strong>Vendas recentes</strong><span>Até 50 registros sincronizados</span></div><div className="table-scroll"><table><thead><tr><th>DATA E HORA</th><th>ITENS</th><th>PAGAMENTO</th><th>TOTAL</th><th>STATUS</th></tr></thead><tbody>{sales.map(sale => <tr key={sale.id}><td>{new Date(sale.data_hora).toLocaleString('pt-BR')}</td><td>{sale.itens.reduce((sum, item) => sum + item.quantidade, 0)} itens</td><td>{sale.forma_pagamento}</td><td><strong>{formatMoney(sale.valor_total)}</strong></td><td><span className={`status-pill ${sale.status_sync !== 'sincronizada' ? 'pending' : ''}`} title={sale.erro_sync}>{sale.status_sync === 'sincronizada' ? 'Sincronizada' : sale.status_sync === 'erro' ? 'Erro na sincronização' : 'Pendente'}</span></td></tr>)}</tbody></table>{!sales.length && <div className="table-empty">As vendas registradas aparecerão aqui.</div>}</div></div>
  </div>
}

function SettingsPage({ user, settings, setSettings, online, notify }: { user: UserInfo; settings: ShopSettings; setSettings: (settings: ShopSettings) => void; online: boolean; notify: (message: string) => void }) {
  const [draft, setDraft] = useState(settings)
  const [printerMessage, setPrinterMessage] = useState('')
  useEffect(() => setDraft(settings), [settings])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    await saveLocalSettings(user.tenant_id, draft, 'pendente')
    if (online && supabase) {
      const { tenant_id, cor_primaria, cor_secundaria, cabecalho_nota, rodape_nota, logotipo_url, largura_papel_mm } = draft
      const { error } = await supabase.from('configuracoes').upsert(
        { tenant_id, cor_primaria, cor_secundaria, cabecalho_nota, rodape_nota, logotipo_url, largura_papel_mm },
        { onConflict: 'tenant_id' }
      )
      if (error) { notify(`Configurações salvas localmente, mas não sincronizadas: ${error.message}`); setSettings(draft); return }
      await saveLocalSettings(user.tenant_id, draft, 'sincronizada')
    }
    setSettings(draft)
    notify(online ? 'Configurações salvas.' : 'Configurações salvas neste dispositivo.')
  }
  if (user.perfil !== 'gerente') return <div className="content-page"><div className="alert" role="alert">Somente um gerente pode alterar as configurações.</div></div>
  return <div className="content-page"><div className="page-intro"><div><span className="eyebrow">PERSONALIZAÇÃO</span><h2>Configurações</h2><p>Personalize seu comércio e o comprovante de venda.</p></div></div>
    <form className="settings-card" onSubmit={save}><div className="settings-section"><div className="settings-icon"><Settings size={19} /></div><div><h3>Dados do comércio</h3><p>Estas informações aparecem no comprovante impresso.</p></div></div>
      <div className="settings-fields"><label>Nome fantasia<input value={user.nome_fantasia} disabled /></label><label>Cabeçalho do comprovante<input value={draft.cabecalho_nota} onChange={event => setDraft({ ...draft, cabecalho_nota: event.target.value })} /></label><label>Rodapé do comprovante<input value={draft.rodape_nota} onChange={event => setDraft({ ...draft, rodape_nota: event.target.value })} /></label><label>URL pública do logotipo<input type="url" value={draft.logotipo_url} onChange={event => setDraft({ ...draft, logotipo_url: event.target.value })} placeholder="https://…" /></label><label>Cor principal<div className="color-control"><input type="color" value={draft.cor_primaria} onChange={event => setDraft({ ...draft, cor_primaria: event.target.value })} /><span>{draft.cor_primaria}</span></div></label><label>Cor secundária<div className="color-control"><input type="color" value={draft.cor_secundaria} onChange={event => setDraft({ ...draft, cor_secundaria: event.target.value })} /><span>{draft.cor_secundaria}</span></div></label><label>Largura do comprovante<select value={draft.largura_papel_mm} onChange={event => setDraft({ ...draft, largura_papel_mm: Number(event.target.value) as ShopSettings['largura_papel_mm'] })}><option value={58}>58 mm</option><option value={80}>80 mm</option></select></label></div>
      <div className="printer-info"><Printer size={17} /><span>{printerMessage || 'Conecte uma impressora ESC/POS compatível. Sem conexão, o sistema usa a janela de impressão do navegador.'}</span><button type="button" className="button secondary" onClick={() => void connectThermalPrinter().then(setPrinterMessage).catch(error => setPrinterMessage(error instanceof Error ? error.message : 'Falha ao conectar a impressora.'))}>Conectar impressora</button></div>
      <button className="button primary"><Check size={17} /> Salvar configurações</button>
    </form>
    <div className="license-card"><div className="license-icon"><Check size={18} /></div><div><strong>Licença {user.status_licenca}</strong><p>Expira em {new Date(user.expira_em).toLocaleDateString('pt-BR')} · Plano {user.plano}</p></div><span className="status-pill">Ativa</span></div>
  </div>
}
