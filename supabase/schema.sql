-- SILVA XVI utilmarket. Execute no SQL Editor do seu projeto Supabase.
-- Nunca exponha a chave service_role no frontend.

create extension if not exists pgcrypto;

create table if not exists public.empresas (
  id uuid primary key default gen_random_uuid(),
  nome_fantasia text not null,
  status_licenca text not null default 'teste'
    check (status_licenca in ('ativa', 'bloqueada', 'teste')),
  expira_em timestamptz not null,
  plano text not null default 'gratuito',
  created_at timestamptz not null default now()
);

create table if not exists public.usuarios (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.empresas(id) on delete cascade,
  perfil text not null check (perfil in ('gerente', 'operador_caixa')),
  created_at timestamptz not null default now()
);

create table if not exists public.produtos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.empresas(id) on delete cascade,
  codigo_barras text,
  nome text not null,
  preco_custo numeric(12,2) not null default 0 check (preco_custo >= 0),
  preco_venda numeric(12,2) not null check (preco_venda >= 0),
  estoque_minimo integer not null default 0 check (estoque_minimo >= 0),
  quantidade_atual integer not null default 0 check (quantidade_atual >= 0),
  ativo boolean not null default true,
  imagem_path text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, codigo_barras)
);

create table if not exists public.vendas (
  id uuid primary key,
  tenant_id uuid not null references public.empresas(id) on delete cascade,
  data_hora timestamptz not null default now(),
  valor_total numeric(12,2) not null check (valor_total >= 0),
  forma_pagamento text not null check (forma_pagamento in ('Dinheiro', 'Cartão', 'PIX', 'Fiado')),
  troco numeric(12,2) not null default 0 check (troco >= 0),
  itens jsonb not null check (jsonb_typeof(itens) = 'array')
);

create table if not exists public.configuracoes (
  tenant_id uuid primary key references public.empresas(id) on delete cascade,
  cor_primaria text not null default '#183c32',
  cor_secundaria text not null default '#e1ae62',
  cabecalho_nota text not null default '',
  rodape_nota text not null default 'Obrigado pela preferência!',
  logotipo_url text not null default '',
  largura_papel_mm integer not null default 80 check (largura_papel_mm in (58, 80)),
  updated_at timestamptz not null default now()
);

create index if not exists produtos_tenant_nome_idx on public.produtos (tenant_id, nome);
create index if not exists vendas_tenant_data_idx on public.vendas (tenant_id, data_hora desc);

create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.usuarios u
    where u.id = (select auth.uid()) and u.tenant_id = p_tenant_id
  );
$$;

create or replace function public.is_tenant_manager(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.usuarios u
    where u.id = (select auth.uid()) and u.tenant_id = p_tenant_id and u.perfil = 'gerente'
  );
$$;

create or replace function public.license_is_active(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.empresas e
    where e.id = p_tenant_id and e.status_licenca = 'ativa' and e.expira_em >= now()
  );
$$;

revoke all on function public.is_tenant_member(uuid) from public;
revoke all on function public.is_tenant_manager(uuid) from public;
revoke all on function public.license_is_active(uuid) from public;
grant execute on function public.is_tenant_member(uuid) to authenticated;
grant execute on function public.is_tenant_manager(uuid) to authenticated;
grant execute on function public.license_is_active(uuid) to authenticated;

alter table public.empresas enable row level security;
alter table public.usuarios enable row level security;
alter table public.produtos enable row level security;
alter table public.vendas enable row level security;
alter table public.configuracoes enable row level security;

drop policy if exists "Membros consultam sua empresa" on public.empresas;
create policy "Membros consultam sua empresa" on public.empresas
  for select to authenticated using (public.is_tenant_member(id));

drop policy if exists "Usuário consulta seu vínculo" on public.usuarios;
create policy "Usuário consulta seu vínculo" on public.usuarios
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists "Membros consultam produtos licenciados" on public.produtos;
create policy "Membros consultam produtos licenciados" on public.produtos
  for select to authenticated using (
    public.is_tenant_member(tenant_id) and public.license_is_active(tenant_id)
  );
drop policy if exists "Gerentes cadastram produtos licenciados" on public.produtos;
create policy "Gerentes cadastram produtos licenciados" on public.produtos
  for insert to authenticated with check (
    public.is_tenant_manager(tenant_id) and public.license_is_active(tenant_id)
  );
drop policy if exists "Gerentes atualizam produtos licenciados" on public.produtos;
create policy "Gerentes atualizam produtos licenciados" on public.produtos
  for update to authenticated using (
    public.is_tenant_manager(tenant_id) and public.license_is_active(tenant_id)
  ) with check (
    public.is_tenant_manager(tenant_id) and public.license_is_active(tenant_id)
  );

drop policy if exists "Membros consultam vendas licenciadas" on public.vendas;
create policy "Membros consultam vendas licenciadas" on public.vendas
  for select to authenticated using (
    public.is_tenant_member(tenant_id) and public.license_is_active(tenant_id)
  );

drop policy if exists "Membros consultam configurações licenciadas" on public.configuracoes;
create policy "Membros consultam configurações licenciadas" on public.configuracoes
  for select to authenticated using (
    public.is_tenant_member(tenant_id) and public.license_is_active(tenant_id)
  );
drop policy if exists "Gerentes criam configurações licenciadas" on public.configuracoes;
create policy "Gerentes criam configurações licenciadas" on public.configuracoes
  for insert to authenticated with check (
    public.is_tenant_manager(tenant_id) and public.license_is_active(tenant_id)
  );
drop policy if exists "Gerentes atualizam configurações licenciadas" on public.configuracoes;
create policy "Gerentes atualizam configurações licenciadas" on public.configuracoes
  for update to authenticated using (
    public.is_tenant_manager(tenant_id) and public.license_is_active(tenant_id)
  ) with check (
    public.is_tenant_manager(tenant_id) and public.license_is_active(tenant_id)
  );

create or replace function public.registrar_venda(
  p_sale_id uuid,
  p_forma_pagamento text,
  p_troco numeric,
  p_itens jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_status text;
  v_expira_em timestamptz;
  v_product record;
  v_item jsonb;
  v_quantity integer;
  v_unit_price numeric(12,2);
  v_items jsonb := '[]'::jsonb;
  v_total numeric(12,2) := 0;
  v_sale public.vendas%rowtype;
  v_existing public.vendas%rowtype;
begin
  select u.tenant_id into v_tenant_id
  from public.usuarios u
  where u.id = (select auth.uid());
  if v_tenant_id is null then raise exception 'Usuário sem empresa vinculada'; end if;

  select e.status_licenca, e.expira_em into v_status, v_expira_em
  from public.empresas e where e.id = v_tenant_id;
  if v_status is distinct from 'ativa' or v_expira_em < now() then
    raise exception 'Licença da empresa inativa ou vencida';
  end if;

  if p_sale_id is null then raise exception 'Identificador da venda inválido'; end if;
  if p_forma_pagamento is null or p_forma_pagamento not in ('Dinheiro', 'Cartão', 'PIX', 'Fiado') then
    raise exception 'Forma de pagamento inválida';
  end if;
  if p_troco is null or p_troco < 0 then raise exception 'Valor de troco inválido'; end if;
  if p_forma_pagamento <> 'Dinheiro' and p_troco <> 0 then raise exception 'Troco só pode ser informado para pagamento em dinheiro'; end if;
  if jsonb_typeof(p_itens) is distinct from 'array'
     or jsonb_array_length(p_itens) < 1 or jsonb_array_length(p_itens) > 200 then
    raise exception 'A venda deve conter entre 1 e 200 itens';
  end if;

  select v.* into v_existing
  from public.vendas v where v.id = p_sale_id and v.tenant_id = v_tenant_id;
  if found then return to_jsonb(v_existing); end if;

  for v_item in select value from jsonb_array_elements(p_itens)
  loop
    v_quantity := (v_item ->> 'quantidade')::integer;
    if v_quantity is null or v_quantity < 1 then raise exception 'Quantidade inválida'; end if;
    v_unit_price := (v_item ->> 'preco_unitario')::numeric;
    if v_unit_price is null or v_unit_price < 0 then raise exception 'Preço do item inválido'; end if;
    select p.id, p.nome, p.codigo_barras, p.quantidade_atual
      into v_product
      from public.produtos p
      where p.id = (v_item ->> 'produto_id')::uuid
        and p.tenant_id = v_tenant_id and p.ativo
      for update;
    if not found then raise exception 'Produto não encontrado ou inativo'; end if;
    if v_product.quantidade_atual < v_quantity then raise exception 'Estoque insuficiente para %', v_product.nome; end if;

    update public.produtos
      set quantidade_atual = quantidade_atual - v_quantity, updated_at = now()
      where id = v_product.id;
    v_total := v_total + (v_unit_price * v_quantity);
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'produto_id', v_product.id,
      'codigo_barras', v_product.codigo_barras,
      'nome', v_product.nome,
      'quantidade', v_quantity,
      'preco_unitario', v_unit_price,
      'subtotal', v_unit_price * v_quantity
    ));
  end loop;

  insert into public.vendas (id, tenant_id, valor_total, forma_pagamento, troco, itens)
    values (p_sale_id, v_tenant_id, v_total, p_forma_pagamento, p_troco, v_items)
    returning * into v_sale;
  return to_jsonb(v_sale);
end;
$$;

revoke all on function public.registrar_venda(uuid, text, numeric, jsonb) from public;
grant execute on function public.registrar_venda(uuid, text, numeric, jsonb) to authenticated;

grant select on public.empresas, public.usuarios to authenticated;
grant select, insert, update on public.produtos, public.configuracoes to authenticated;
grant select on public.vendas to authenticated;

insert into storage.buckets (id, name, public)
values ('produtos', 'produtos', false), ('logos-empresas', 'logos-empresas', true)
on conflict (id) do nothing;

drop policy if exists "Membros leem imagens da empresa" on storage.objects;
create policy "Membros leem imagens da empresa" on storage.objects
  for select to authenticated using (
    bucket_id = 'produtos'
    and public.is_tenant_member(((storage.foldername(name))[1])::uuid)
    and public.license_is_active(((storage.foldername(name))[1])::uuid)
  );
drop policy if exists "Gerentes enviam imagens da empresa" on storage.objects;
create policy "Gerentes enviam imagens da empresa" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'produtos'
    and public.is_tenant_manager(((storage.foldername(name))[1])::uuid)
    and public.license_is_active(((storage.foldername(name))[1])::uuid)
  );
drop policy if exists "Leitura pública de logotipos" on storage.objects;
create policy "Leitura pública de logotipos" on storage.objects
  for select to public using (bucket_id = 'logos-empresas');
drop policy if exists "Gerentes enviam logotipos" on storage.objects;
create policy "Gerentes enviam logotipos" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'logos-empresas'
    and public.is_tenant_manager(((storage.foldername(name))[1])::uuid)
    and public.license_is_active(((storage.foldername(name))[1])::uuid)
  );
