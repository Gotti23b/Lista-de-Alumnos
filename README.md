# Comedor French

Aplicación web para controlar el reingreso de los alumnos del Colegio French que se retiran habitualmente en el horario de comedor (12 a 13 hs aprox.), con sincronización en tiempo real entre dispositivos usando Supabase (tu cuenta gratuita alcanza de sobra para esto).

## Los archivos

Son 4 archivos y **los 4 tienen que estar juntos en la misma carpeta** para que la app funcione:

| Archivo | Qué es |
|---|---|
| `index.html` | La estructura de las pantallas. **Acá adentro va la configuración de Supabase** (paso 2). |
| `estilos.css` | Los colores, tamaños y la disposición de todo. |
| `app.js` | Toda la lógica: voz, registros, reportes, login, permisos. |
| `escudo.png` | El escudo del colegio. |

Además vienen dos archivos que **no** se suben a GitHub porque no son parte de la página:

| Archivo | Qué es |
|---|---|
| `funcion-supabase.ts` | El código que se pega una sola vez en el panel de Supabase para poder crear usuarios desde la app (Paso 3d). |
| `README.md` | Esta documentación. Podés subirlo igual para tenerlo a mano. |

**Regla simple para no equivocarte:** cada vez que recibas una versión nueva, subí los 4 archivos juntos reemplazando los anteriores, aunque solo haya cambiado uno. Así nunca te queda una versión mezclada.

## La pestaña Configuración

Todo lo que se puede ajustar está ahí, dividido en dos grupos según a quién afecta:

**Este dispositivo** — lo ve y lo cambia cualquiera, y vale solo para ese celular, tablet o computadora:

- **Tema**: automático, claro u oscuro. "Automático" sigue lo que tenga configurado el dispositivo.
- **Tamaño de letra**: normal, grande o muy grande, para leer de lejos en la tablet de la puerta.
- **Sonido al registrar**: un pitido corto al marcar un reingreso, para no depender de mirar la pantalla en un lugar con ruido. Viene apagado.

**Del colegio** — solo lo ve y lo cambia el Director, y vale para todos los dispositivos a la vez:

- **Horario del comedor**: define cuándo la app muestra "horario de comedor" y, sobre todo, **desde qué hora avisa de los que no volvieron**. Antes estaba fijo de 12 a 13 dentro del código.
- **Reconocimiento de voz**: qué tan seguro tiene que estar para registrar solo sin preguntarte. Si notás que se equivoca de alumno, pasalo a "ante la duda, preguntar"; si te cansa que pregunte de más, pasalo a "registrar solo más seguido".
- **Contacto de preceptoría**: el WhatsApp y el mail a los que van los botones del aviso.

Además, solo para el Director: **copia de seguridad** (baja un Excel con toda la nómina y todos los reingresos), **usuarios y roles**, e **historial de cambios**.

## Cómo se manejan las contraseñas

No se manda ningún mail. Todo pasa por el Director:

- **Alta**: en Configuración → Usuarios y roles, ponés el email, una contraseña inicial y el rol. Le pasás esos datos a la persona por WhatsApp o en mano. **La primera vez que entra, la app la obliga a elegir una contraseña propia** antes de dejarla usar nada — así la que vos elegiste deja de servir.
- **Si alguien se la olvida**: tocás "Blanquear clave" en su fila, ponés una nueva y se la pasás. También le va a pedir cambiarla al entrar.
- **Cada uno puede cambiar la suya** cuando quiera, con el botón "Clave" de la barra lateral.
- **Si alguien deja el colegio**: "Dar de baja". No puede entrar más, pero su nombre sigue figurando en el historial para que los registros viejos se entiendan. Se puede reactivar después.

Antes había un "¿Olvidaste tu contraseña?" que mandaba un mail. Se sacó porque el correo incorporado de Supabase está limitado a **2 mensajes por hora** y la propia documentación aclara que no sirve para uso real: el mail podía no llegar nunca. El blanqueo por parte del Director es instantáneo y no depende de nada.

## Por qué subirla a GitHub Pages

Dentro de la vista previa de Claude, el micrófono queda bloqueado por las políticas de permisos del navegador. Publicando estos archivos como un sitio propio en GitHub Pages, la página se abre como un sitio normal (con su propio candado HTTPS) y el navegador pide permiso de micrófono con total normalidad.

## Paso 1 — Crear las tablas en Supabase

1. Entrá a [supabase.com](https://supabase.com) y abrí (o creá) tu proyecto.
2. En el menú de la izquierda, andá a **SQL Editor** → **New query**.
3. Pegá exactamente esto y tocá **Run**:

```sql
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

alter table students enable row level security;
alter table events enable row level security;

create policy "allow all - students" on students for all using (true) with check (true);
create policy "allow all - events" on events for all using (true) with check (true);

alter publication supabase_realtime add table students, events;
```

Esto crea las dos tablas, habilita que la app pueda leer/escribir en ellas, y activa la sincronización en tiempo real.

**Sobre la seguridad:** las políticas de arriba dejan, por ahora, la lectura y escritura abiertas a quien tenga el link de la página (sin usuario ni contraseña) — es el punto de partida más simple. Los datos son nombre, apellido, curso y horarios de reingreso; nada especialmente sensible, pero es dato personal de menores igual. Si querés cerrar el acceso con usuario y contraseña por rol, seguí el **Paso 3** más abajo (las políticas de este paso quedan reemplazadas por las del Paso 3).

## Paso 2 — Copiar la URL y la clave a la app

**Los archivos que te entrego ya vienen con tu URL y tu clave puestas**, así que normalmente podés saltear este paso. Está acá por si alguna vez tenés que cambiarlas.

1. En Supabase, andá a **Project Settings** (el ícono de engranaje) → **API**.
2. Copiá el valor de **Project URL** (algo como `https://abcdefghij.supabase.co`).
3. Copiá la clave pública (la **publishable** `sb_publishable_...`, o la **anon public** `eyJ...` si tu proyecto usa el formato viejo). Está pensada para ser pública — no es un secreto, la protección la dan las políticas del paso 1.
4. Abrí el archivo `index.html` con un editor de texto (el Bloc de notas alcanza). Ahora es un archivo corto, así que lo vas a encontrar enseguida cerca del principio:

```js
window.SUPABASE_CONFIG = {
  url: "",     // ej: "https://abcdefghij.supabase.co"
  anonKey: ""  // la "anon public" key de tu proyecto de Supabase
};
```

5. Pegá tu URL y tu clave entre las comillas, y guardá el archivo.

## Paso 3 — Roles y contraseñas (opcional pero recomendado)

Por defecto, cualquiera con el link puede usar la app. Si preferís que solo entre gente autorizada, con usuario y contraseña, seguí estos pasos (una sola vez):

1. En Supabase, andá de nuevo a **SQL Editor** → **New query**, pegá esto y tocá **Run**:

```sql
create table if not exists user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'preceptor' check (role in ('director','preceptor','secretaria')),
  created_at timestamptz not null default now()
);

alter table user_roles enable row level security;

create or replace function is_director()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = 'director');
$$;

create or replace function can_registrar()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role in ('director','preceptor'));
$$;

drop policy if exists "user_roles select" on user_roles;
create policy "user_roles select" on user_roles for select using (user_id = auth.uid() or is_director());
drop policy if exists "user_roles update director" on user_roles;
create policy "user_roles update director" on user_roles for update using (is_director()) with check (is_director());
drop policy if exists "user_roles delete director" on user_roles;
create policy "user_roles delete director" on user_roles for delete using (is_director());

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_roles (user_id, email, role) values (new.id, coalesce(new.email, ''), 'preceptor')
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- Si ya habías creado alguna cuenta antes de correr esto, esta línea las suma:
insert into user_roles (user_id, email, role)
select id, coalesce(email, ''), 'preceptor' from auth.users
on conflict (user_id) do nothing;

drop policy if exists "allow all - students" on students;
drop policy if exists "students select" on students;
create policy "students select" on students for select using (auth.uid() is not null);
drop policy if exists "students write director" on students;
create policy "students write director" on students for insert with check (is_director());
drop policy if exists "students update director" on students;
create policy "students update director" on students for update using (is_director()) with check (is_director());
drop policy if exists "students delete director" on students;
create policy "students delete director" on students for delete using (is_director());

drop policy if exists "allow all - events" on events;
drop policy if exists "events select" on events;
create policy "events select" on events for select using (auth.uid() is not null);
drop policy if exists "events insert" on events;
create policy "events insert" on events for insert with check (can_registrar());
drop policy if exists "events delete" on events;
create policy "events delete" on events for delete using (can_registrar());
```

Esto crea la tabla de roles, hace que cualquier cuenta nueva entre por defecto como **Preceptor**, y cierra el acceso: para ver o tocar cualquier cosa ahora hace falta estar logueado.

2. Andá a **Authentication → Users** (menú de la izquierda) → **Add user** → creá tu propia cuenta con tu email y una contraseña.
3. Volvé al **SQL Editor** y corré esto UNA sola vez, reemplazando el mail por el tuyo, para que tu cuenta quede como **Director** (el único rol que puede asignar roles a los demás):

```sql
update user_roles set role = 'director' where email = 'TU-MAIL@ejemplo.com';
```

4. Listo. Ahora la app te va a pedir email y contraseña al entrar. Desde **Configuración → Usuarios y roles** (esa sección solo la ve el Director) podés cambiarle el rol a cualquier cuenta creada:
   - **Director**: acceso total (nómina, reportes, borrar, y esta pestaña de usuarios).
   - **Preceptor**: solo la pestaña Comedor, para registrar reingresos.
   - **Secretaría**: solo la pestaña Reportes, para consultar.

Para dar de alta a alguien nuevo: repetí el paso 2 (**Authentication → Users → Add user**) con su email y una contraseña, pasale esos datos, y asignale el rol desde **Configuración → Usuarios y roles** (aparece ahí apenas creás la cuenta).

**Importante:** no te saques a vos mismo el rol de Director si sos el único que lo tiene — nadie más va a poder asignar roles y habría que volver a arreglarlo por SQL.

## Paso 3b — Historial, trazabilidad y contacto de preceptoría

Este bloque agrega tres cosas: que cada reingreso guarde **quién lo registró**, un **historial de cambios** (quién agregó o borró alumnos, quién cambió roles), y dónde guardar el **contacto de preceptoría** para los avisos. Pegalo en el **SQL Editor** y tocá **Run**:

```sql
-- 1) Cada reingreso guarda qué usuario lo marcó
alter table events add column if not exists registrado_por text default '';

-- 2) Historial de cambios
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  actor_email text not null default '',
  accion text not null,
  detalle text not null default ''
);
alter table audit_log enable row level security;

drop policy if exists "audit insert" on audit_log;
create policy "audit insert" on audit_log for insert with check (auth.uid() is not null);
drop policy if exists "audit select director" on audit_log;
create policy "audit select director" on audit_log for select using (is_director());

-- 3) Configuración compartida (contacto de preceptoría para los avisos)
create table if not exists app_config (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);
alter table app_config enable row level security;

drop policy if exists "config select" on app_config;
create policy "config select" on app_config for select using (auth.uid() is not null);
drop policy if exists "config write director" on app_config;
create policy "config write director" on app_config for all using (is_director()) with check (is_director());

-- 4) Sincronización en vivo también para estas tablas
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_roles') then
    alter publication supabase_realtime add table user_roles;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='audit_log') then
    alter publication supabase_realtime add table audit_log;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='app_config') then
    alter publication supabase_realtime add table app_config;
  end if;
end $$;
```

El teléfono de WhatsApp y el mail de preceptoría se cargan después desde la app, en **Configuración → Del colegio** (solo lo ve y lo edita el Director).

## Paso 3c — Estado de los usuarios

Agrega tres datos a cada usuario: si está activo, si tiene que cambiar la contraseña, y cuándo entró por última vez. Pegalo en el **SQL Editor** y tocá **Run**:

```sql
alter table user_roles add column if not exists activo boolean not null default true;
alter table user_roles add column if not exists debe_cambiar_clave boolean not null default false;
alter table user_roles add column if not exists ultimo_ingreso timestamptz;

-- Cada usuario puede anotar su propio ingreso y marcar que ya cambió la clave,
-- pero SIN poder tocar su rol ni el de nadie (por eso son funciones y no permisos
-- de escritura directa sobre la tabla).
create or replace function registrar_ingreso()
returns void language sql security definer set search_path = public as $$
  update user_roles set ultimo_ingreso = now() where user_id = auth.uid();
$$;

create or replace function marcar_clave_cambiada()
returns void language sql security definer set search_path = public as $$
  update user_roles set debe_cambiar_clave = false where user_id = auth.uid();
$$;

-- Un usuario dado de baja no puede leer ni escribir nada, aunque tuviera sesión abierta.
create or replace function esta_activo()
returns boolean language sql security definer set search_path = public stable as $$
  select coalesce((select activo from user_roles where user_id = auth.uid()), false);
$$;

create or replace function is_director()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = 'director' and activo);
$$;

create or replace function can_registrar()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role in ('director','preceptor') and activo);
$$;

drop policy if exists "students select" on students;
create policy "students select" on students for select using (esta_activo());
drop policy if exists "events select" on events;
create policy "events select" on events for select using (esta_activo());
```

## Paso 3d — Crear usuarios desde la app (la función de Supabase)

Sin este paso, las cuentas hay que crearlas a mano desde **Authentication → Users**. Con este paso, el Director las crea desde la propia app.

**Por qué hace falta una función y no se resuelve dentro de la app:** crear usuarios exige la clave de administrador de Supabase, que saltea todas las reglas de seguridad de la base. Esa clave no puede estar en `app.js`, porque es un archivo público: cualquiera que abra el código fuente de la página se la llevaría y tendría acceso total a los datos de los chicos. La función corre del lado de Supabase, así que la clave nunca sale de ahí.

1. En Supabase, menú de la izquierda → **Edge Functions**.
2. Tocá **Deploy a new function** → **Via Editor**.
3. En el nombre poné exactamente: `admin-usuarios` (con guion, en minúsculas — si le ponés otro nombre la app no la encuentra).
4. Borrá todo el código de ejemplo que viene y pegá el contenido del archivo **`funcion-supabase.ts`** que viene junto con la app.
5. Tocá **Deploy function** y esperá unos segundos.

Listo. No hace falta configurar ninguna clave: Supabase le pasa la suya automáticamente a sus propias funciones.

**Sobre el costo:** el plan gratuito incluye 500.000 ejecuciones por mes. Crear usuarios son unas pocas por año, así que es gratis en la práctica.

### Si la app dice que no puede contactar la función

Probá en este orden:

1. **Que el nombre sea exactamente `admin-usuarios`.** Sin mayúsculas, con guion. Si la creaste con otro nombre, borrala y volvé a crearla bien: la app la busca por ese nombre exacto.
2. **Que tenga la última versión del código.** La primera versión que entregué tenía una lista incompleta de cabeceras permitidas y el navegador bloqueaba la llamada antes de que saliera. Abrí la función en el editor de Supabase, borrá todo y pegá de nuevo el `funcion-supabase.ts` actual.
3. **Revisá los registros.** En Edge Functions → tu función → pestaña **Logs**. Si ahí no aparece ninguna llamada, la petición ni siquiera llegó (problema de nombre o de cabeceras). Si aparece con error, el mensaje te dice qué pasó.
4. **Si sigue sin andar**, en la configuración de la función buscá la opción **Verify JWT** y desactivala. Es seguro: la función verifica por su cuenta quién la llama y que sea Director activo, no depende de esa validación previa.

El mensaje de error de la app ahora incluye el detalle técnico al final — si tenés que consultarlo, pasalo completo.

## Paso 4 — Publicar en GitHub Pages (sin usar la terminal)

1. Andá a [github.com](https://github.com) y creá una cuenta si no tenés (es gratis).
2. Arriba a la derecha, tocá el **+** y elegí **New repository**. Ponele un nombre, por ejemplo `comedor-french`, dejalo en **Public**, y tocá **Create repository**.
3. Dentro del repositorio recién creado, tocá **Add file → Upload files**.
4. Seleccioná **los 4 archivos juntos** (`index.html`, `estilos.css`, `app.js` y `escudo.png`) y arrastralos a la página de una sola vez. Tocá **Commit changes**. Podés sumar el `README.md` también.
   > **Importante:** los 4 archivos van sueltos en la raíz del repositorio, no dentro de una carpeta. Si los subís dentro de una carpeta, la dirección del sitio cambia y el `index.html` no encuentra a los demás.
5. Andá a la pestaña **Settings** del repositorio → en el menú de la izquierda **Pages**.
6. En "Build and deployment" → **Source**, elegí **Deploy from a branch**. En **Branch**, elegí `main` y la carpeta `/ (root)`. Tocá **Save**.
7. Esperá uno o dos minutos y actualizá la página: GitHub te va a mostrar el link de tu sitio, algo como `https://tu-usuario.github.io/comedor-french/`.
8. Abrí ese link desde cada tablet o celular que vayan a usar en la puerta del comedor. La primera vez, el navegador va a pedir permiso de micrófono — aceptalo.

### Con git, si lo preferís

```bash
git init
git add index.html estilos.css app.js escudo.png README.md
git commit -m "Comedor French"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/comedor-french.git
git push -u origin main
```

Después seguí desde el paso 5 de arriba para activar GitHub Pages.

## Cómo saber que está sincronizando de verdad

Abrí la página en dos dispositivos (o dos pestañas) a la vez, agregá un alumno o marcá un reingreso en uno, y debería aparecer solo, sin recargar, en el otro en un segundo o dos. Si en cambio ves el aviso "Modo local" en la parte de arriba de la página, algo del Paso 1 o el Paso 2 no quedó bien (revisá la URL, la clave, y que el script SQL se haya ejecutado sin errores).

## Un detalle a tener en cuenta con el plan gratuito de Supabase

Un proyecto gratuito de Supabase se pausa automáticamente si pasa **una semana sin actividad** (por ejemplo, en vacaciones de invierno o de verano). No se borra nada: cuando vuelvan a usarlo, entrás al panel de Supabase y lo reactivás con un clic, gratis.

## Actualizar la página más adelante

Cada vez que Claude te dé una versión nueva:

1. **Subí los 4 archivos juntos**, reemplazando los anteriores — **Add file → Upload files**, arrastrás los 4 y **Commit changes** (o `git add -A && git commit -m "actualización" && git push`).
2. Listo. GitHub Pages se actualiza solo, en general en menos de un minuto. Las tablas de Supabase no hace falta volver a crearlas, y la URL y la clave ya vienen puestas.

Subí siempre los 4 aunque solo haya cambiado uno: es más rápido que ponerte a mirar cuál cambió, y así nunca te queda una versión mezclada.

**Si en las tablets seguís viendo la versión vieja:** los navegadores guardan copias de los archivos para no bajarlos cada vez. Para forzar la actualización, en la tablet tocá recargar manteniendo apretado y elegí "recargar sin caché", o cerrá y volvé a abrir la pestaña. Los archivos llevan una marca de versión en la dirección (`app.js?v=20260913`) justamente para que esto casi nunca haga falta.
