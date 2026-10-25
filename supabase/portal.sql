-- Portal do cliente: cole tudo no Supabase em SQL Editor > New query e clique em Run.
-- (Pode rodar de novo sempre que este arquivo mudar.)
-- O cliente entra com e-mail e senha (cada cliente pode ter vários logins) e vê só as OS dele:
-- a que está em andamento e o histórico. Aparecem situação, datas, máquina, falha,
-- causa, solução, testes, cuidados, fotos e horários.
-- O valor total aparece só depois que a OS está finalizada.
-- Valores por item, materiais, CPF, telefone e assinatura não aparecem.
-- As senhas ficam guardadas embaralhadas (bcrypt): nem você consegue ler depois.
-- A senha que você cria é provisória: no primeiro acesso o cliente cria a senha dele.
-- A sessão termina ao fechar a aba do portal (e vence sozinha depois de 30 minutos sem uso).

create extension if not exists pgcrypto with schema extensions;

drop function if exists public.portal_os(text);
drop index if exists public.docs_portal;

-- Lê um número guardado como número ou texto ("1,5"); o que não for número vale 0
create or replace function public.portal_num(j jsonb) returns numeric
language plpgsql immutable as $$
begin
  if jsonb_typeof(j) = 'number' then return (j #>> '{}')::numeric; end if;
  if jsonb_typeof(j) = 'string' then return replace(j #>> '{}', ',', '.')::numeric; end if;
  return 0;
exception when others then return 0;
end $$;

-- Mesmo cálculo do app: materiais + horas × valor da hora + km × valor do km
-- (OS faturada usa os valores congelados nela; as outras, os valores atuais de Ajustes)
create or replace function public.portal_total(a jsonb, cfg jsonb) returns numeric
language sql immutable as $$
  select round(
    coalesce((select sum(public.portal_num(p->'qtd') * public.portal_num(p->'valor'))
              from jsonb_array_elements(jsonb_path_query_array(a, '$.pecas[*]')) p), 0)
    + public.portal_num(a->'horas') * public.portal_num(case when a->>'status' = 'faturado' and a ? 'valorHora' and a->'valorHora' <> 'null' then a->'valorHora' else cfg->'valorHora' end)
    + public.portal_num(a->'km') * public.portal_num(case when a->>'status' = 'faturado' and a ? 'valorHora' and a->'valorHora' <> 'null' then a->'valorKm' else cfg->'valorKm' end),
  2);
$$;

-- Logins do portal: cada cliente pode ter vários (um por e-mail).
-- A versão anterior (um login por cliente, com o token na mesma tabela) é trocada uma única vez;
-- os acessos criados nela precisam ser criados de novo no app.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'portal_acesso' and column_name = 'token') then
    drop table public.portal_acesso cascade;
  end if;
end $$;
drop function if exists public.portal_definir_acesso(text, text, text);
drop function if exists public.portal_remover_acesso(text);
drop function if exists public.portal_cliente(text);

create table if not exists public.portal_acesso (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  cliente_id text not null,
  login text not null unique,           -- e-mail em minúsculas
  senha text not null,                  -- bcrypt
  trocar boolean not null default true, -- true = senha provisória; o portal pede uma senha nova
  criado_em timestamptz not null default now()
);
create index if not exists portal_acesso_cliente on public.portal_acesso (owner, cliente_id);
alter table public.portal_acesso enable row level security;
revoke all on public.portal_acesso from anon, authenticated;
-- o app só lê os logins (sem senha); criar, resetar e remover passa pelas funções abaixo
grant select (id, owner, cliente_id, login, criado_em, trocar) on public.portal_acesso to authenticated;
drop policy if exists "acessos do dono" on public.portal_acesso;
create policy "acessos do dono" on public.portal_acesso for select to authenticated using (owner = auth.uid());

-- Sessões abertas no portal. A página guarda o token só enquanto a aba está aberta;
-- no servidor a sessão vence depois de 30 minutos sem uso (a página aberta renova a cada minuto).
create table if not exists public.portal_sessao (
  token text primary key,
  acesso_id uuid not null references public.portal_acesso(id) on delete cascade,
  visto timestamptz not null default now()
);
alter table public.portal_sessao enable row level security;
revoke all on public.portal_sessao from anon, authenticated;

create or replace function public.portal_novo_token() returns text
language sql volatile set search_path = public, extensions as $$
  select translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_');
$$;

-- Devolve o login da sessão (e renova o prazo); nulo se venceu ou não existe
create or replace function public.portal_sessao_acesso(p_token text) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare a uuid;
begin
  update portal_sessao set visto = now()
   where token = p_token and visto > now() - interval '30 minutes'
   returning acesso_id into a;
  return a;
end $$;

-- App: cria um login (p_id nulo) ou troca o e-mail e reseta a senha de um login existente
create or replace function public.portal_definir_acesso(p_cliente text, p_login text, p_senha text, p_id uuid default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare l text := lower(trim(coalesce(p_login, ''))); r uuid;
begin
  if auth.uid() is null then raise exception 'Entre na sua conta'; end if;
  if l !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Digite um e-mail válido'; end if;
  if length(coalesce(p_senha, '')) < 6 then raise exception 'A senha precisa ter pelo menos 6 caracteres'; end if;
  if not exists (select 1 from docs where owner = auth.uid() and col = 'clientes' and id = p_cliente and not deleted) then
    raise exception 'Cliente não encontrado. Espere o app enviar os dados e tente de novo.';
  end if;
  if exists (select 1 from portal_acesso where login = l and id is distinct from p_id) then
    raise exception 'Esse e-mail já tem login no portal';
  end if;
  if p_id is null then
    insert into portal_acesso (owner, cliente_id, login, senha) values (auth.uid(), p_cliente, l, crypt(p_senha, gen_salt('bf')))
    returning id into r;
  else
    update portal_acesso set login = l, senha = crypt(p_senha, gen_salt('bf')), trocar = true
     where id = p_id and owner = auth.uid() and cliente_id = p_cliente returning id into r;
    if r is null then raise exception 'Login não encontrado'; end if;
    delete from portal_sessao where acesso_id = r;  -- desconecta quem estava dentro
  end if;
  return r;
end $$;

-- App: remove um login (quem estava dentro sai)
create or replace function public.portal_remover_acesso(p_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from portal_acesso where id = p_id and owner = auth.uid();
$$;

-- Portal: confere e-mail e senha e abre uma sessão
create or replace function public.portal_entrar(p_login text, p_senha text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare a uuid; t text;
begin
  delete from portal_sessao where visto < now() - interval '30 minutes';
  select id into a from portal_acesso
   where login = lower(trim(coalesce(p_login, ''))) and senha = crypt(coalesce(p_senha, ''), senha);
  if a is null then perform pg_sleep(1); return null; end if;  -- atrasa quem tenta adivinhar senhas
  t := portal_novo_token();
  insert into portal_sessao (token, acesso_id) values (t, a);
  return t;
end $$;

-- Portal: encerra a sessão (botão Sair)
create or replace function public.portal_sair(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from portal_sessao where token = p_token;
$$;

-- Portal: o cliente troca a senha provisória pela dele (as outras sessões desse login saem)
create or replace function public.portal_nova_senha(p_token text, p_senha text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare a uuid := public.portal_sessao_acesso(p_token);
begin
  if a is null then return null; end if;
  if length(coalesce(p_senha, '')) < 6 then raise exception 'A senha precisa ter pelo menos 6 caracteres'; end if;
  update portal_acesso set senha = crypt(p_senha, gen_salt('bf')), trocar = false where id = a;
  delete from portal_sessao where acesso_id = a and token <> p_token;
  return p_token;
end $$;

create or replace function public.portal_cliente(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare a uuid := public.portal_sessao_acesso(p_token);
begin
  if a is null then return null; end if;
  return (select jsonb_build_object(
    'cliente', c.data->'nome', 'fazenda', c.data->'fazenda',
    'empresa', g.data->'nome', 'telefone', g.data->'telefone',
    'pasta', c.owner, 'trocarSenha', pa.trocar,
    'os', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'numero', a.data->'numero', 'data', a.data->'data', 'status', a.data->'status', 'tipo', a.data->'tipo',
        'atualizadoEm', a.data->'atualizadoEm', 'assinadoEm', a.data#>'{assinatura,em}',
        'falha', a.data->'problema', 'causa', a.data->'causa', 'solucao', a.data->'descricao', 'cuidados', a.data->'recomendacao',
        'fotosFalha', jsonb_path_query_array(a.data, '$.fotosProblema[*]'),
        'fotos', jsonb_path_query_array(a.data, '$.fotos[*]'),
        'testes', (select coalesce(jsonb_agg(jsonb_build_object('desc', t->'desc', 'fotos', jsonb_path_query_array(t, '$.fotos[*]'))), '[]')
                   from jsonb_array_elements(jsonb_path_query_array(a.data, '$.testes[*]')) t),
        'apontamentos', (select coalesce(jsonb_agg(jsonb_build_object('tipo', x->'tipo', 'ini', x->'ini', 'fim', x->'fim', 'motivo', x->'motivo')), '[]')
                         from jsonb_array_elements(jsonb_path_query_array(a.data, '$.apontamentos[*]')) x),
        'total', case when a.data->>'status' in ('concluido', 'faturado') then public.portal_total(a.data, coalesce(g.data, '{}')) end,
        'maquina', nullif(concat_ws(' ', m.data->>'tipo', m.data->>'marca', m.data->>'modelo'), ''), 'serie', m.data->'serie'
      ) order by a.data->>'data' desc, a.data->'numero' desc nulls last), '[]')
      from public.docs a
      left join public.docs m on m.owner = a.owner and m.col = 'maquinas' and m.id = a.data->>'maquinaId' and not m.deleted
      where a.owner = c.owner and a.col = 'atendimentos' and not a.deleted and a.data->>'clienteId' = c.id)
  )
  from public.portal_acesso pa
  join public.docs c on c.owner = pa.owner and c.col = 'clientes' and c.id = pa.cliente_id and not c.deleted
  left join public.docs g on g.owner = c.owner and g.col = 'config' and g.id = 'geral'
  where pa.id = a);
end $$;

-- Fotos: o portal só consegue abrir as fotos de falha, testes e serviço das OS de clientes com login
create or replace function public.portal_foto(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.docs a
    join public.portal_acesso pa on pa.owner = a.owner and pa.cliente_id = a.data->>'clienteId'
    where a.owner::text = split_part(p_name, '/', 1) and a.col = 'atendimentos' and not a.deleted
      and (coalesce(a.data->'fotos' ? split_part(p_name, '/', 2), false)
        or coalesce(a.data->'fotosProblema' ? split_part(p_name, '/', 2), false)
        or jsonb_path_exists(a.data, '$.testes[*].fotos[*] ? (@ == $f)', jsonb_build_object('f', split_part(p_name, '/', 2))))
  );
$$;

revoke all on function public.portal_novo_token() from public;
revoke all on function public.portal_sessao_acesso(text) from public;
revoke all on function public.portal_cliente(text) from public;
revoke all on function public.portal_entrar(text, text) from public;
revoke all on function public.portal_sair(text) from public;
revoke all on function public.portal_nova_senha(text, text) from public;
revoke all on function public.portal_definir_acesso(text, text, text, uuid) from public;
revoke all on function public.portal_remover_acesso(uuid) from public;
revoke all on function public.portal_foto(text) from public;
grant execute on function public.portal_cliente(text) to anon, authenticated;
grant execute on function public.portal_entrar(text, text) to anon, authenticated;
grant execute on function public.portal_sair(text) to anon, authenticated;
grant execute on function public.portal_nova_senha(text, text) to anon, authenticated;
grant execute on function public.portal_foto(text) to anon, authenticated;
grant execute on function public.portal_definir_acesso(text, text, text, uuid) to authenticated;
grant execute on function public.portal_remover_acesso(uuid) to authenticated;

drop policy if exists "fotos do portal" on storage.objects;
create policy "fotos do portal" on storage.objects for select to anon
  using (bucket_id = 'fotos' and public.portal_foto(name));
