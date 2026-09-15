-- =============================================================================
--  COMEDOR FRENCH — INSTALACIÓN COMPLETA
--  Reemplaza a los pasos 1, 3, 3b y 3c del README, todos juntos.
--
--  Se puede correr las veces que quieras: no borra datos ni tira errores aunque
--  ya hayas ejecutado partes antes. Pegalo entero en el SQL Editor de Supabase
--  y tocá Run.
--
--  (La función para crear usuarios desde la app es aparte: es el Paso 3d del
--   README, se publica desde Edge Functions y no es SQL.)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. TABLAS
-- -----------------------------------------------------------------------------

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  apellido text not null,
  nombre text not null,
  curso text default '',
  retira_comedor boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists events (
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
  unique (dia, student_id)
);

create table if not exists user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'preceptor' check (role in ('director','preceptor','secretaria')),
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  actor_email text not null default '',
  accion text not null,
  detalle text not null default ''
);

create table if not exists app_config (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- 2. COLUMNAS QUE SE FUERON AGREGANDO
-- -----------------------------------------------------------------------------

alter table events     add column if not exists registrado_por     text default '';
alter table user_roles add column if not exists activo             boolean not null default true;
alter table user_roles add column if not exists debe_cambiar_clave boolean not null default false;
alter table user_roles add column if not exists ultimo_ingreso     timestamptz;


-- -----------------------------------------------------------------------------
-- 3. SEGURIDAD ACTIVADA EN TODAS LAS TABLAS
-- -----------------------------------------------------------------------------

alter table students   enable row level security;
alter table events     enable row level security;
alter table user_roles enable row level security;
alter table audit_log  enable row level security;
alter table app_config enable row level security;


-- -----------------------------------------------------------------------------
-- 4. FUNCIONES DE PERMISOS
--    Se consultan desde las reglas de más abajo. Van antes que las reglas
--    porque las reglas las necesitan ya creadas.
-- -----------------------------------------------------------------------------

-- ¿El usuario que está pidiendo algo sigue dado de alta?
create or replace function esta_activo()
returns boolean language sql security definer set search_path = public stable as $$
  select coalesce((select activo from user_roles where user_id = auth.uid()), false);
$$;

create or replace function is_director()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from user_roles
    where user_id = auth.uid() and role = 'director' and activo
  );
$$;

create or replace function can_registrar()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from user_roles
    where user_id = auth.uid() and role in ('director','preceptor') and activo
  );
$$;

-- Cada usuario anota su propio ingreso y marca que ya cambió la clave.
-- Son funciones (y no permiso de escritura sobre la tabla) para que nadie pueda
-- aprovechar ese permiso y cambiarse el rol a Director.
create or replace function registrar_ingreso()
returns void language sql security definer set search_path = public as $$
  update user_roles set ultimo_ingreso = now() where user_id = auth.uid();
$$;

create or replace function marcar_clave_cambiada()
returns void language sql security definer set search_path = public as $$
  update user_roles set debe_cambiar_clave = false where user_id = auth.uid();
$$;

-- Cuando se crea una cuenta, le arma automáticamente la fila con rol Preceptor.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_roles (user_id, email, role)
  values (new.id, coalesce(new.email, ''), 'preceptor')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Suma las cuentas que ya existían antes de que estuviera el disparador.
insert into user_roles (user_id, email, role)
select id, coalesce(email, ''), 'preceptor' from auth.users
on conflict (user_id) do nothing;


-- -----------------------------------------------------------------------------
-- 5. REGLAS DE ACCESO
--    Se borran primero (incluidas las viejas y abiertas) y se crean de nuevo,
--    así el resultado es siempre el mismo sin importar qué había antes.
-- -----------------------------------------------------------------------------

-- Alumnos: los ve cualquiera dado de alta; los modifica solo el Director.
drop policy if exists "allow all - students"     on students;
drop policy if exists "students select"          on students;
drop policy if exists "students write director"  on students;
drop policy if exists "students update director" on students;
drop policy if exists "students delete director" on students;

create policy "students select"          on students for select using (esta_activo());
create policy "students write director"  on students for insert with check (is_director());
create policy "students update director" on students for update using (is_director()) with check (is_director());
create policy "students delete director" on students for delete using (is_director());

-- Reingresos: los ve cualquiera dado de alta; los registra Director o Preceptor.
drop policy if exists "allow all - events" on events;
drop policy if exists "events select"      on events;
drop policy if exists "events insert"      on events;
drop policy if exists "events delete"      on events;

create policy "events select" on events for select using (esta_activo());
create policy "events insert" on events for insert with check (can_registrar());
create policy "events delete" on events for delete using (can_registrar());

-- Usuarios: cada uno ve su propia fila; el Director ve y administra todas.
drop policy if exists "user_roles select"          on user_roles;
drop policy if exists "user_roles update director" on user_roles;
drop policy if exists "user_roles delete director" on user_roles;

create policy "user_roles select"          on user_roles for select using (user_id = auth.uid() or is_director());
create policy "user_roles update director" on user_roles for update using (is_director()) with check (is_director());
create policy "user_roles delete director" on user_roles for delete using (is_director());

-- Historial de cambios: escribe cualquiera dado de alta, lo lee solo el Director.
drop policy if exists "audit insert"          on audit_log;
drop policy if exists "audit select director" on audit_log;

create policy "audit insert"          on audit_log for insert with check (esta_activo());
create policy "audit select director" on audit_log for select using (is_director());

-- Configuración del colegio: la lee cualquiera, la cambia solo el Director.
drop policy if exists "config select"         on app_config;
drop policy if exists "config write director" on app_config;

create policy "config select"         on app_config for select using (esta_activo());
create policy "config write director" on app_config for all using (is_director()) with check (is_director());


-- -----------------------------------------------------------------------------
-- 6. SINCRONIZACIÓN EN VIVO
--    Con el DO block no da error aunque las tablas ya estén publicadas.
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['students','events','user_roles','audit_log','app_config'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- -----------------------------------------------------------------------------
-- 7. VERIFICACIÓN
--    Al terminar, esto te muestra cómo quedó todo. Fijate que "directores_activos"
--    sea al menos 1: si es 0, corré la línea del final.
-- -----------------------------------------------------------------------------

select
  (select count(*) from user_roles)                                   as usuarios,
  (select count(*) from user_roles where role = 'director' and activo) as directores_activos,
  (select count(*) from students)                                     as alumnos,
  (select count(*) from events)                                       as reingresos,
  (select count(*) from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public')    as tablas_en_vivo;


-- =============================================================================
--  SI "directores_activos" DIO 0, O SI NO PODÉS ENTRAR A LA APP:
--  descomentá la línea de abajo (sacale los dos guiones del principio),
--  poné tu mail, y corré solo esa línea.
-- =============================================================================

-- update user_roles set role = 'director', activo = true where email = 'TU-MAIL@ejemplo.com';
