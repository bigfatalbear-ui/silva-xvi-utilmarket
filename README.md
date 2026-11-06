# SILVA XVI utilmarket

Frente de caixa PWA em português para mercearias e pequenos comércios. A aplicação é hospedada como arquivos estáticos no GitHub Pages; Supabase fornece autenticação, banco de dados e Storage, enquanto PouchDB/IndexedDB mantém catálogo, configurações e vendas no dispositivo para uso offline.

## Autoria e direitos

O SILVA XVI utilmarket é de autoria de Fabio Silva dos Anjos. Todos os direitos reservados. Este repositório e o aplicativo não concedem licença para copiar, modificar, distribuir, sublicenciar ou explorar comercialmente o código, a marca ou os materiais do projeto. Solicitações de autorização: [fabiosilvaanjos@live.com](mailto:fabiosilvaanjos@live.com) ou [WhatsApp (71) 99938-3974](https://wa.me/5571999383974). Consulte [`LICENSE`](LICENSE).

## Funcionalidades

- Login pelo Supabase Auth e bloqueio quando a licença não está `ativa` ou já expirou.
- Isolamento multi-tenant por `tenant_id`, com Row Level Security nas tabelas e no Storage.
- PDV com foco para leitor USB de código de barras, busca local e atalhos: **F2** buscar, **F3** limpar carrinho, **F4** finalizar, **F6** alternar pagamento e **Esc** limpar a busca.
- Carrinho, formas de pagamento (Dinheiro, Cartão, PIX e Fiado), cálculo de troco e comprovante configurável para bobina de 58 mm ou 80 mm.
- Gravação local da venda antes de tentar sincronizar. Ao recuperar a conexão, a aplicação envia vendas pendentes pela função SQL transacional `registrar_venda` e atualiza o estoque/catálogo do dispositivo.
- Impressão ESC/POS por Web Serial ou WebUSB em navegadores compatíveis; a janela de impressão do navegador é a alternativa.
- PWA instalável e shell de navegação armazenado pelo service worker.

> Uma aplicação estática no navegador não consegue proteger segredos nem impedir adulteração local. A chave `anon` é pública e deve ser limitada por RLS; nunca publique `service_role`. A licença é verificada no login, nas policies e na função de venda. Um dispositivo desconectado não recebe revogações até voltar à rede. Vendas registradas em vários dispositivos offline podem conflitar com o estoque; confira os erros de sincronização.

## Desenvolvimento

Requisitos: Node.js 20+ e npm.

```sh
npm ci
cp .env.example .env
# Preencha as duas variáveis do Supabase em .env
npm run dev
```

Para validar localmente:

```sh
npm run typecheck
npm run build
```

Sem `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`, o app mostra a tela de configuração e não libera acesso de demonstração.

## Supabase

1. Crie um projeto Supabase e execute [`supabase/schema.sql`](supabase/schema.sql) no SQL Editor.
2. Crie os usuários em **Authentication → Users** e cadastre a empresa e o vínculo do usuário. Exemplo para o SQL Editor, substituindo os valores:

   ```sql
   insert into public.empresas (nome_fantasia, status_licenca, expira_em, plano)
   values ('Mercadinho Silva', 'ativa', now() + interval '1 year', 'gratuito')
   returning id;

   -- Use o UUID retornado e o UUID do usuário criado no Supabase Auth:
   insert into public.usuarios (id, tenant_id, perfil)
   values ('UUID-DO-USUARIO-AUTH', 'UUID-DA-EMPRESA', 'gerente');
   ```

3. Configure localmente `.env` com o endereço do projeto e a chave **anon/publishable**:

   ```env
   VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
   VITE_SUPABASE_ANON_KEY=SUA-CHAVE-ANON-PUBLICA
   ```

   `.env` é ignorado pelo Git; não adicione credenciais ao código ou ao repositório. O app exige `status_licenca = 'ativa'` e `expira_em` no futuro; o status `teste` não libera o caixa.

4. As imagens dos produtos usam o bucket privado `produtos` e caminhos iniciados pelo UUID da empresa. O bucket público `logos-empresas` é opcional para logotipos; informe no app a URL pública do arquivo em Configurações. O arquivo SQL cria os buckets e policies necessários.
5. Os projetos gratuitos do Supabase têm limites de uso e podem pausar após períodos de inatividade conforme as regras vigentes do serviço. Consulte o painel e a documentação do Supabase para limites atuais, backups e retenção antes de usar em operação comercial.

## Administração da plataforma

O painel de administração da plataforma é separado do acesso de gerente de cada comércio. Ele permite listar comércios, consultar quantidade de usuários e vendas, cadastrar empresas, alterar plano/licença/vencimento, suspender ou reativar acesso, vincular usuários já existentes no Supabase Auth e consultar a auditoria das alterações. Nenhuma chave `service_role` é usada no navegador: as operações passam por funções SQL `SECURITY DEFINER` que verificam `auth.uid()` contra `platform_admins`.

Depois de executar ou atualizar `supabase/schema.sql` (em um projeto já existente, reexecute o script idempotente para criar as tabelas e funções administrativas), crie o usuário administrador em **Authentication → Users** e conceda a função de plataforma pelo SQL Editor usando o UUID desse usuário:

```sql
insert into public.platform_admins (user_id)
values ('UUID-DO-USUARIO-ADMIN')
on conflict (user_id) do nothing;
```

Essa tabela não concede escrita/leitura direta ao cliente. Não crie uma tela pública para inserir administradores: a concessão deve ser feita por uma pessoa com acesso confiável ao projeto Supabase. O administrador entra pelo login normal do aplicativo e, após a validação pelo banco, recebe o painel da plataforma em vez do caixa.

Para cadastrar um comércio, use **Novo comércio**. Em seguida, crie ou convide o usuário em **Authentication → Users**; no painel, escolha **Vincular usuário**, informe o mesmo e-mail e atribua o perfil. O vínculo só aceita usuários existentes e ainda não associados a outro comércio. Ativação, suspensão, mudança de plano/vencimento e vínculos são registrados em `platform_admin_audit`.

## Operação offline e impressoras

O primeiro login e a carga inicial do catálogo precisam de conexão. Depois disso, o navegador pode abrir a sessão validada e vender com o catálogo que já está armazenado naquele dispositivo. Vendas e novos produtos ficam em fila local e são sincronizados periodicamente quando a rede volta. Cada dispositivo tem seu próprio IndexedDB; alterações offline não são compartilhadas até sincronizar.

Em **Configurações**, conecte a impressora para autorizar Web Serial/WebUSB. A autorização e o suporte dependem do navegador e do dispositivo; use a impressão do navegador se não houver uma impressora ESC/POS compatível. O comprovante é não fiscal e não substitui emissão fiscal.

## Configurar a URL final do GitHub Pages

O workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) executa typecheck/build em cada push na branch `main` e publica `dist` na branch `gh-pages`. O caminho base é definido no build pelo nome do repositório.

1. Em **Settings → Secrets and variables → Actions**, crie os secrets `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
2. Em **Settings → Actions → General → Workflow permissions**, permita leitura e escrita do conteúdo para o `GITHUB_TOKEN`.
3. Faça push para `main` ou execute manualmente o workflow em **Actions**.
4. Em **Settings → Pages**, selecione **Deploy from a branch**, branch `gh-pages` e pasta `/(root)`. Após o primeiro deploy, o endereço será `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`.
5. No Supabase, acesse **Authentication → URL Configuration** e configure a **Site URL** com esse endereço e a **Redirect URL** `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/**` (além de `http://localhost:5173/**` para desenvolvimento).

Após alterar secrets, execute novamente o workflow para incorporá-los ao build estático. Os valores `VITE_*` são visíveis no navegador; use somente a chave pública `anon`, nunca `service_role`.
