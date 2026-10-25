-- Portal do cliente: cole tudo no Supabase em SQL Editor > New query e clique em Run (uma vez).
-- O cliente abre o link da OS e vê só o andamento: situação, datas, falha, causa, solução,
-- testes, cuidados e fotos do serviço. Valores, materiais, CPF, telefone e assinatura não aparecem.
-- Só funciona para a OS que recebeu um link no app; sem o código do link nada é mostrado.

create index if not exists docs_portal on public.docs ((data->>'portal')) where col = 'atendimentos';

create or replace function public.portal_os(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'numero', a.data->'numero', 'data', a.data->'data', 'status', a.data->'status', 'tipo', a.data->'tipo',
    'atualizadoEm', a.data->'atualizadoEm', 'assinadoEm', a.data#>'{assinatura,em}',
    'falha', a.data->'problema', 'causa', a.data->'causa', 'solucao', a.data->'descricao', 'cuidados', a.data->'recomendacao',
    'fotosFalha', jsonb_path_query_array(a.data, '$.fotosProblema[*]'),
    'fotos', jsonb_path_query_array(a.data, '$.fotos[*]'),
    'testes', (select coalesce(jsonb_agg(jsonb_build_object('desc', t->'desc', 'fotos', jsonb_path_query_array(t, '$.fotos[*]'))), '[]')
               from jsonb_array_elements(jsonb_path_query_array(a.data, '$.testes[*]')) t),
    'apontamentos', (select coalesce(jsonb_agg(jsonb_build_object('tipo', x->'tipo', 'ini', x->'ini', 'fim', x->'fim', 'motivo', x->'motivo')), '[]')
                     from jsonb_array_elements(jsonb_path_query_array(a.data, '$.apontamentos[*]')) x),
    'cliente', c.data->'nome', 'fazenda', c.data->'fazenda',
    'maquina', nullif(concat_ws(' ', m.data->>'tipo', m.data->>'marca', m.data->>'modelo'), ''), 'serie', m.data->'serie',
    'empresa', g.data->'nome', 'telefone', g.data->'telefone',
    'pasta', a.owner
  )
  from public.docs a
  left join public.docs c on c.owner = a.owner and c.col = 'clientes' and c.id = a.data->>'clienteId' and not c.deleted
  left join public.docs m on m.owner = a.owner and m.col = 'maquinas' and m.id = a.data->>'maquinaId' and not m.deleted
  left join public.docs g on g.owner = a.owner and g.col = 'config' and g.id = 'geral'
  where a.col = 'atendimentos' and not a.deleted and length(p_token) >= 20 and a.data->>'portal' = p_token
  limit 1;
$$;

-- Fotos: o portal só consegue abrir as fotos de falha, testes e serviço de uma OS com link
create or replace function public.portal_foto(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.docs a
    where a.owner::text = split_part(p_name, '/', 1) and a.col = 'atendimentos' and not a.deleted
      and coalesce(a.data->>'portal', '') <> ''
      and (coalesce(a.data->'fotos' ? split_part(p_name, '/', 2), false)
        or coalesce(a.data->'fotosProblema' ? split_part(p_name, '/', 2), false)
        or jsonb_path_exists(a.data, '$.testes[*].fotos[*] ? (@ == $f)', jsonb_build_object('f', split_part(p_name, '/', 2))))
  );
$$;

revoke all on function public.portal_os(text) from public;
revoke all on function public.portal_foto(text) from public;
grant execute on function public.portal_os(text) to anon, authenticated;
grant execute on function public.portal_foto(text) to anon, authenticated;

drop policy if exists "fotos do portal" on storage.objects;
create policy "fotos do portal" on storage.objects for select to anon
  using (bucket_id = 'fotos' and public.portal_foto(name));
