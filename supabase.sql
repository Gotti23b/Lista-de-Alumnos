-- Comedor French — esquema Supabase
-- Este archivo refleja la base conectada al index.html.

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  apellido text not null,
  nombre text not null,
  curso text default '',
  retira_comedor boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id bigint generated always as identity primary key,
  dia text not null,
  student_id uuid not null,
  apellido text not null,
  nombre text not null,
  curso text default '',
  tipo text not null default 'reingreso',
  ts bigint not null,
  hora text not null,
  metodo text not null default 'manual',
  created_at timestamptz not null default now(),
  registrado_por text not null default ''
);

create unique index if not exists events_dia_student_unique
  on public.events (dia, student_id);

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'preceptor'
    check (role in ('director','preceptor','secretaria')),
  created_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  actor_email text not null default '',
  accion text not null,
  detalle text not null default ''
);

create table if not exists public.app_config (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.students enable row level security;
alter table public.events enable row level security;
alter table public.user_roles enable row level security;
alter table public.audit_log enable row level security;
alter table public.app_config enable row level security;

create or replace function public.is_director()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = 'director'
  );
$$;

create or replace function public.can_registrar()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role in ('director','preceptor')
  );
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_roles (user_id, email, role)
  values (new.id, coalesce(new.email, ''), 'preceptor')
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.user_roles (user_id, email, role)
select id, coalesce(email, ''), 'preceptor'
from auth.users
on conflict (user_id) do update set email = excluded.email;

-- Alumnos: cualquier usuario autenticado puede leer; solo Director escribe.
drop policy if exists "allow all - students" on public.students;
drop policy if exists "students select" on public.students;
create policy "students select" on public.students
  for select using (auth.uid() is not null);
drop policy if exists "students write director" on public.students;
create policy "students write director" on public.students
  for insert with check (public.is_director());
drop policy if exists "students update director" on public.students;
create policy "students update director" on public.students
  for update using (public.is_director()) with check (public.is_director());
drop policy if exists "students delete director" on public.students;
create policy "students delete director" on public.students
  for delete using (public.is_director());

-- Reingresos: cualquier usuario autenticado puede leer; Director y Preceptor registran/deshacen.
drop policy if exists "allow all - events" on public.events;
drop policy if exists "events select" on public.events;
create policy "events select" on public.events
  for select using (auth.uid() is not null);
drop policy if exists "events insert" on public.events;
create policy "events insert" on public.events
  for insert with check (public.can_registrar());
drop policy if exists "events delete" on public.events;
create policy "events delete" on public.events
  for delete using (public.can_registrar());

-- Roles.
drop policy if exists "user_roles select" on public.user_roles;
create policy "user_roles select" on public.user_roles
  for select using (user_id = auth.uid() or public.is_director());
drop policy if exists "user_roles update director" on public.user_roles;
create policy "user_roles update director" on public.user_roles
  for update using (public.is_director()) with check (public.is_director());
drop policy if exists "user_roles delete director" on public.user_roles;
create policy "user_roles delete director" on public.user_roles
  for delete using (public.is_director());

-- Auditoría.
drop policy if exists "audit insert" on public.audit_log;
create policy "audit insert" on public.audit_log
  for insert with check (auth.uid() is not null);
drop policy if exists "audit select director" on public.audit_log;
create policy "audit select director" on public.audit_log
  for select using (public.is_director());

-- Configuración compartida.
drop policy if exists "config select" on public.app_config;
create policy "config select" on public.app_config
  for select using (auth.uid() is not null);
drop policy if exists "config write director" on public.app_config;
create policy "config write director" on public.app_config
  for all using (public.is_director()) with check (public.is_director());

-- Los RPC internos no quedan expuestos públicamente.
revoke execute on function public.is_director() from public, anon, authenticated;
revoke execute on function public.can_registrar() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.is_director() to authenticated;
grant execute on function public.can_registrar() to authenticated;

-- Realtime.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='students') then
    alter publication supabase_realtime add table public.students;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='events') then
    alter publication supabase_realtime add table public.events;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_roles') then
    alter publication supabase_realtime add table public.user_roles;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='audit_log') then
    alter publication supabase_realtime add table public.audit_log;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='app_config') then
    alter publication supabase_realtime add table public.app_config;
  end if;
end $$;
