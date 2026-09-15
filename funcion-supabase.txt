// =============================================================================
//  Comedor French — función "admin-usuarios"
//  Se pega y se publica desde el panel de Supabase (Edge Functions → Deploy a
//  new function → Via Editor). Ver el Paso 3d del README.
//
//  POR QUÉ EXISTE ESTA FUNCIÓN:
//  Crear usuarios requiere la clave de administrador de Supabase, que saltea
//  todas las reglas de seguridad de la base. Esa clave NO puede vivir en app.js,
//  porque app.js es un archivo público: cualquiera que abra el código fuente de
//  la página se la llevaría y tendría acceso total a los datos. Acá, en cambio,
//  la clave queda del lado del servidor de Supabase y nunca sale de ahí.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROLES = ["director", "preceptor", "secretaria"];
const BANEO_LARGO = "876000h"; // ~100 años: equivale a dejar la cuenta inhabilitada

function responder(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const claveAdmin = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, claveAdmin, { auth: { persistSession: false } });

    // ---- 1) Quién está llamando ----
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!token) return responder({ error: "Falta la sesión." }, 401);

    const { data: datosUsuario, error: errUsuario } = await admin.auth.getUser(token);
    if (errUsuario || !datosUsuario?.user) return responder({ error: "Sesión inválida o vencida." }, 401);
    const quienLlama = datosUsuario.user;

    // ---- 2) ¿Tiene permiso? ----
    // El rol se consulta acá, en el servidor. Nunca se confía en lo que mande
    // la página: si no, cualquiera podría decir "soy director" y crear cuentas.
    const { data: filaRol } = await admin
      .from("user_roles")
      .select("role, activo")
      .eq("user_id", quienLlama.id)
      .maybeSingle();

    if (!filaRol || filaRol.role !== "director" || filaRol.activo === false) {
      return responder({ error: "Solo un Director activo puede administrar usuarios." }, 403);
    }

    const cuerpo = await req.json().catch(() => ({}));
    const accion = String(cuerpo.accion || "");

    // ---- 3) Crear un usuario nuevo ----
    if (accion === "crear") {
      const email = String(cuerpo.email || "").trim().toLowerCase();
      const password = String(cuerpo.password || "");
      const role = ROLES.includes(cuerpo.role) ? cuerpo.role : "preceptor";

      if (!email.includes("@")) return responder({ error: "El email no parece válido." }, 400);
      if (password.length < 6) return responder({ error: "La contraseña tiene que tener al menos 6 caracteres." }, 400);

      const { data: creado, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // no hace falta que confirme por mail: lo da de alta el Director
      });
      if (error) {
        const msg = /already|registered|exists/i.test(error.message)
          ? "Ya existe un usuario con ese email."
          : error.message;
        return responder({ error: msg }, 400);
      }

      // El disparador de la base ya creó la fila con rol "preceptor";
      // acá le ponemos el rol elegido y lo marcamos para que cambie la clave.
      const { error: errRol } = await admin.from("user_roles").upsert(
        {
          user_id: creado.user!.id,
          email,
          role,
          activo: true,
          debe_cambiar_clave: true,
        },
        { onConflict: "user_id" },
      );
      if (errRol) return responder({ error: "Se creó la cuenta pero falló al asignar el rol: " + errRol.message }, 500);

      return responder({ ok: true, mensaje: "Usuario creado." });
    }

    // ---- 4) Blanquear la contraseña de alguien ----
    if (accion === "blanquear") {
      const userId = String(cuerpo.user_id || "");
      const password = String(cuerpo.password || "");
      if (!userId) return responder({ error: "Falta indicar el usuario." }, 400);
      if (password.length < 6) return responder({ error: "La contraseña tiene que tener al menos 6 caracteres." }, 400);

      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return responder({ error: error.message }, 400);

      await admin.from("user_roles").update({ debe_cambiar_clave: true }).eq("user_id", userId);
      return responder({ ok: true, mensaje: "Contraseña cambiada." });
    }

    // ---- 5) Dar de baja o reactivar ----
    if (accion === "desactivar" || accion === "activar") {
      const userId = String(cuerpo.user_id || "");
      if (!userId) return responder({ error: "Falta indicar el usuario." }, 400);
      if (userId === quienLlama.id) {
        return responder({ error: "No podés darte de baja a vos mismo." }, 400);
      }

      const dandoDeBaja = accion === "desactivar";
      const { error } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: dandoDeBaja ? BANEO_LARGO : "none",
      });
      if (error) return responder({ error: error.message }, 400);

      await admin.from("user_roles").update({ activo: !dandoDeBaja }).eq("user_id", userId);
      return responder({ ok: true, mensaje: dandoDeBaja ? "Usuario dado de baja." : "Usuario reactivado." });
    }

    return responder({ error: "Acción desconocida: " + accion }, 400);
  } catch (e) {
    return responder({ error: String((e as Error)?.message || e) }, 500);
  }
});
