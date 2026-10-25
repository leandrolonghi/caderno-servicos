-- Caderno de Serviços: cole tudo no Supabase em SQL Editor > New query e clique em Run.
-- Cria a tabela onde ficam OS, clientes, máquinas e ajustes, e a pasta privada das fotos.
-- Cada conta só enxerga os próprios dados.

create table if not exists public.docs (
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (owner, col, id)
);
create index if not exists docs_owner_updated on public.docs (owner, updated_at);

alter table public.docs enable row level security;
drop policy if exists "docs do dono" on public.docs;
create policy "docs do dono" on public.docs for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

create or replace function public.docs_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
  for each row execute function public.docs_touch();

-- Atualiza só os campos enviados (equivale ao "update" do app)
create or replace function public.doc_merge(p_col text, p_id text, p_data jsonb) returns void
language sql security invoker as $$
  insert into public.docs (owner, col, id, data)
  values (auth.uid(), p_col, p_id, p_data || jsonb_build_object('id', p_id))
  on conflict (owner, col, id) do update
    set data = case when docs.deleted then excluded.data else docs.data || excluded.data end,
        deleted = false;
$$;

-- Fotos e arquivos: pasta privada, cada conta na sua subpasta
insert into storage.buckets (id, name, public) values ('fotos', 'fotos', false)
  on conflict (id) do nothing;
drop policy if exists "fotos do dono ler" on storage.objects;
drop policy if exists "fotos do dono enviar" on storage.objects;
drop policy if exists "fotos do dono trocar" on storage.objects;
drop policy if exists "fotos do dono apagar" on storage.objects;
create policy "fotos do dono ler" on storage.objects for select to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "fotos do dono enviar" on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "fotos do dono trocar" on storage.objects for update to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "fotos do dono apagar" on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
