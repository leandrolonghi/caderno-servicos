-- Portal do cliente: cole tudo no Supabase em SQL Editor > New query e clique em Run.
-- (Pode rodar de novo sempre que este arquivo mudar.)
-- O cliente entra com usuário e senha que você cria no app e vê só as OS dele:
-- a que está em andamento e o histórico. Aparecem situação, datas, máquina, falha,
-- causa, solução, testes, cuidados, fotos e horários.
-- O valor total aparece só depois que a OS está finalizada.
-- Valores por item, materiais, CPF, telefone e assinatura não aparecem.
-- As senhas ficam guardadas embaralhadas (bcrypt): nem você consegue ler depois.

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

-- Acessos ao portal: um por cliente. O token é a "sessão" guardada no aparelho do cliente;
-- trocar a senha ou remover o acesso gera outro token e desconecta os aparelhos.
create table if not exists public.portal_acesso (
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  cliente_id text not null,
  login text not null unique,
  senha text not null,
  token text not null unique,
  criado_em timestamptz not null default now(),
  primary key (owner, cliente_id)
);
alter table public.portal_acesso enable row level security;
revoke all on public.portal_acesso from anon, authenticated;
-- o app só lê quem tem acesso (sem senha nem token); criar e remover passa pelas funções abaixo
grant select (owner, cliente_id, login, criado_em) on public.portal_acesso to authenticated;
drop policy if exists "acessos do dono" on public.portal_acesso;
create policy "acessos do dono" on public.portal_acesso for select to authenticated using (owner = auth.uid());

-- Usuário = só os números (telefone ou CPF/CNPJ) ou o texto em minúsculas
create or replace function public.portal_login_norm(p text) returns text
language sql immutable as $$
  select case when regexp_replace(coalesce(p, ''), '[0-9 ()./+-]', '', 'g') = ''
              then regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') else lower(trim(p)) end;
$$;

-- App: cria o acesso ou troca a senha
create or replace function public.portal_definir_acesso(p_cliente text, p_login text, p_senha text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare l text := public.portal_login_norm(p_login);
begin
  if auth.uid() is null then raise exception 'Entre na sua conta'; end if;
  if length(l) < 3 then raise exception 'Usuário muito curto'; end if;
  if length(coalesce(p_senha, '')) < 6 then raise exception 'A senha precisa ter pelo menos 6 caracteres'; end if;
  if not exists (select 1 from docs where owner = auth.uid() and col = 'clientes' and id = p_cliente and not deleted) then
    raise exception 'Cliente não encontrado. Espere o app enviar os dados e tente de novo.';
  end if;
  if exists (select 1 from portal_acesso where login = l and not (owner = auth.uid() and cliente_id = p_cliente)) then
    raise exception 'Esse usuário já é de outro cliente';
  end if;
  insert into portal_acesso (owner, cliente_id, login, senha, token)
  values (auth.uid(), p_cliente, l, crypt(p_senha, gen_salt('bf')), translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_'))
  on conflict (owner, cliente_id) do update
    set login = excluded.login, senha = excluded.senha, token = excluded.token;
  return l;
end $$;

-- App: remove o acesso (o cliente não entra mais)
create or replace function public.portal_remover_acesso(p_cliente text) returns void
language sql security definer set search_path = public as $$
  delete from portal_acesso where owner = auth.uid() and cliente_id = p_cliente;
$$;

-- Portal: confere usuário e senha e devolve o token da sessão
create or replace function public.portal_entrar(p_login text, p_senha text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text;
begin
  select token into t from portal_acesso
   where login = public.portal_login_norm(p_login) and senha = crypt(coalesce(p_senha, ''), senha);
  if t is null then perform pg_sleep(1); end if;  -- atrasa quem tenta adivinhar senhas
  return t;
end $$;

create or replace function public.portal_cliente(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'cliente', c.data->'nome', 'fazenda', c.data->'fazenda',
    'empresa', g.data->'nome', 'telefone', g.data->'telefone',
    'pasta', c.owner,
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
  where pa.token = p_token
  limit 1;
$$;

-- Fotos: o portal só consegue abrir as fotos de falha, testes e serviço das OS de clientes com link
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

revoke all on function public.portal_cliente(text) from public;
revoke all on function public.portal_entrar(text, text) from public;
revoke all on function public.portal_definir_acesso(text, text, text) from public;
revoke all on function public.portal_remover_acesso(text) from public;
grant execute on function public.portal_entrar(text, text) to anon, authenticated;
grant execute on function public.portal_definir_acesso(text, text, text) to authenticated;
grant execute on function public.portal_remover_acesso(text) to authenticated;
revoke all on function public.portal_foto(text) from public;
grant execute on function public.portal_cliente(text) to anon, authenticated;
grant execute on function public.portal_foto(text) to anon, authenticated;

drop policy if exists "fotos do portal" on storage.objects;
create policy "fotos do portal" on storage.objects for select to anon
  using (bucket_id = 'fotos' and public.portal_foto(name));
