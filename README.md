# Comedor French

Aplicación web de una sola página (`index.html`) para controlar el reingreso de los alumnos del Colegio French que se retiran habitualmente en el horario de comedor (12 a 13 hs aprox.), con sincronización en tiempo real entre dispositivos usando Supabase (tu cuenta gratuita ya alcanza de sobra para esto).

## Por qué subirla a GitHub Pages

Dentro de la vista previa de Claude, el micrófono queda bloqueado por las políticas de permisos del navegador. Publicando este mismo archivo como un sitio propio en GitHub Pages, la página se abre como un sitio normal (con su propio candado HTTPS) y el navegador pide permiso de micrófono con total normalidad.

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

**Sobre la seguridad:** las políticas de arriba dejan la lectura y escritura abiertas a quien tenga el link de la página (sin usuario ni contraseña) — es lo más simple para un uso interno como este. Los datos son nombre, apellido, curso y horarios de reingreso; nada especialmente sensible, pero es dato personal de menores igual, así que si en algún momento querés restringirlo con un login, decime y lo agregamos.

## Paso 2 — Copiar la URL y la clave a la app

1. En Supabase, andá a **Project Settings** (el ícono de engranaje) → **API**.
2. Copiá el valor de **Project URL** (algo como `https://abcdefghij.supabase.co`).
3. Copiá el valor de **anon public** (una clave larga que empieza con `eyJ...`). Esta clave está pensada para ser pública — no es un secreto, la protección la dan las políticas del paso 1.
4. Abrí el archivo `index.html` con un editor de texto (el Bloc de notas alcanza) y buscá este bloque, cerca del principio:

```js
window.SUPABASE_CONFIG = {
  url: "",     // ej: "https://abcdefghij.supabase.co"
  anonKey: ""  // la "anon public" key de tu proyecto de Supabase
};
```

5. Pegá tu URL y tu clave entre las comillas, y guardá el archivo.

## Paso 3 — Publicar en GitHub Pages (sin usar la terminal)

1. Andá a [github.com](https://github.com) y creá una cuenta si no tenés (es gratis).
2. Arriba a la derecha, tocá el **+** y elegí **New repository**. Ponele un nombre, por ejemplo `comedor-french`, dejalo en **Public**, y tocá **Create repository**.
3. Dentro del repositorio recién creado, tocá **Add file → Upload files**.
4. Arrastrá el archivo `index.html` (ya con la URL y la clave pegadas) a la página, y tocá **Commit changes**.
5. Andá a la pestaña **Settings** del repositorio → en el menú de la izquierda **Pages**.
6. En "Build and deployment" → **Source**, elegí **Deploy from a branch**. En **Branch**, elegí `main` y la carpeta `/ (root)`. Tocá **Save**.
7. Esperá uno o dos minutos y actualizá la página: GitHub te va a mostrar el link de tu sitio, algo como `https://tu-usuario.github.io/comedor-french/`.
8. Abrí ese link desde cada tablet o celular que vayan a usar en la puerta del comedor. La primera vez, el navegador va a pedir permiso de micrófono — aceptalo.

### Con git, si lo preferís

```bash
git init
git add index.html
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

Cada vez que Claude te dé una versión nueva del `index.html`: pegá de nuevo tu URL y tu clave de Supabase en el bloque `SUPABASE_CONFIG` (si el archivo nuevo no las trae puestas), y subilo reemplazando el anterior — **Add file → Upload files** (elegís "Replace" si te lo pregunta), o `git add index.html && git commit -m "actualización" && git push`. GitHub Pages se actualiza solo, en general en menos de un minuto. Las tablas de Supabase no hace falta volver a crearlas.
