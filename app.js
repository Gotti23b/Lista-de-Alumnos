(function () {
  "use strict";

  /* ============ helpers ============ */
  function normalize(s) {
    return (s || "")
      .toString()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    let prev = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
      const cur = [i];
      for (let j = 1; j <= bl; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[bl];
  }
  function tokenSim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length >= 3 && (a.includes(b) || b.includes(a))) return 0.88;
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    return Math.max(0, 1 - dist / maxLen);
  }
  function scoreStudent(transcriptNorm, student) {
    const tTokens = transcriptNorm.split(" ").filter(Boolean);
    if (!tTokens.length) return 0;
    const apeTokens = normalize(student.apellido).split(" ").filter(Boolean);
    const nomTokens = normalize(student.nombre).split(" ").filter(Boolean);
    function bestAgainst(tokens) {
      let best = 0;
      tokens.forEach((st) => {
        tTokens.forEach((tt) => { best = Math.max(best, tokenSim(st, tt)); });
      });
      return best;
    }
    const apeScore = apeTokens.length ? apeTokens.reduce((s, t) => s + bestAgainst([t]), 0) / apeTokens.length : 0;
    const nomScore = nomTokens.length ? nomTokens.reduce((s, t) => s + bestAgainst([t]), 0) / nomTokens.length : 0;
    return apeScore * 0.6 + nomScore * 0.4;
  }
  function fmtHora(d) {
    // hour12:false fuerza el formato de 24 hs que se usa acá (13:05, no "1:05 p. m.")
    return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function diaStr(d) {
    return d.toLocaleDateString("sv-SE");
  }
  function escapeHtml(s) {
    return (s || "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(msg, kind) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.className = "toast" + (kind ? " " + kind : "");
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
  }
  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2));
  }

  /* ============ state ============ */
  const state = {
    students: new Map(),      // id -> {id, apellido, nombre, curso, retiraComedor}
    dayEvents: [],            // reingreso entries for the currently-watched "today" doc
    reportEvents: [],         // reingreso entries for the report date
    clientId: uid(),
    todayDia: diaStr(new Date()),
    reportDesde: diaStr(new Date()),
    reportHasta: diaStr(new Date()),
    pendingCandidates: [],
    lastRegistered: null,     // { studentId, apellido, nombre, dia, ts } — para poder deshacer
    currentRole: null,        // "director" | "preceptor" | "secretaria" — solo con Supabase configurado
    currentEmail: null,
    studentsLoaded: false,    // para no avisar antes de tener los datos cargados
    dayLoaded: false,
    cursoFilter: "",          // "" = todos los cursos
    kiosk: false,
    micContinuo: false,
    config: {},               // { whatsapp, email } — contacto de preceptoría
    auditList: [],
    alertAvisadaDia: null,    // para avisar una sola vez por día pasadas las 13
  };

  /* ============ tabs ============ */
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });
  function setTab(tab) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.dataset.tabPanel !== tab; });
    if (tab === "reportes") renderReport();
    if (tab === "usuarios") renderUsers();
  }
  document.getElementById("btnEmptyImport") && document.getElementById("btnEmptyImport").addEventListener("click", () => {
    setTab("alumnos");
    openImport();
  });

  /* ============ clock ============ */
  function tickClock() {
    const now = new Date();
    document.getElementById("clockTime").textContent = fmtHora(now);
    const hour = now.getHours();
    const badge = document.getElementById("horarioBadge");
    if (hour === 12) {
      badge.className = "badge good";
      badge.innerHTML = '<span class="badge-dot"></span>Horario de comedor (12–13 h)';
    } else {
      badge.className = "badge neutral";
      badge.innerHTML = '<span class="badge-dot"></span>Fuera del horario de comedor';
    }
    const newDia = diaStr(now);
    if (newDia !== state.todayDia) {
      state.todayDia = newDia;
      watchToday();
    }
    renderRetiroList();
  }
  tickClock();
  setInterval(tickClock, 15000);

  /* ============ backend: base compartida (Claude) o local (localStorage) ============ */
  const LS_STUDENTS_KEY = "comedorFrench:students";
  const LS_AUDIT_KEY = "comedorFrench:audit";
  const LS_CONFIG_KEY = "comedorFrench:config";
  const LS_EVENTS_PREFIX = "comedorFrench:events:";
  function lsEventsKey(dia) { return LS_EVENTS_PREFIX + dia; }
  function readLS(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function writeLS(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  function createLocalBackend() {
    let studentListeners = [];
    let dayListeners = {};
    let auditListeners = [];
    let configListeners = [];
    function notifyAudit() {
      const list = readLS(LS_AUDIT_KEY, []).slice().reverse();
      auditListeners.forEach((cb) => cb(list));
    }
    function currentStudents() {
      const map = readLS(LS_STUDENTS_KEY, {});
      return Object.keys(map).map((id) => Object.assign({ id }, map[id]));
    }
    function notifyStudents() { studentListeners.forEach((cb) => cb(currentStudents())); }
    function notifyDay(dia) {
      const data = readLS(lsEventsKey(dia), { dia, entries: [] });
      (dayListeners[dia] || []).forEach((cb) => cb(Array.isArray(data.entries) ? data.entries : []));
    }
    window.addEventListener("storage", (ev) => {
      if (ev.key === LS_STUDENTS_KEY) notifyStudents();
      else if (ev.key && ev.key.indexOf("comedorFrench:events:") === 0) notifyDay(ev.key.slice("comedorFrench:events:".length));
    });
    return {
      mode: "local",
      watchStudents(cb) {
        studentListeners.push(cb);
        cb(currentStudents());
        return () => { studentListeners = studentListeners.filter((f) => f !== cb); };
      },
      async addStudent(data) {
        const map = readLS(LS_STUDENTS_KEY, {});
        map[uid()] = data;
        writeLS(LS_STUDENTS_KEY, map);
        notifyStudents();
      },
      async updateStudent(id, patch) {
        const map = readLS(LS_STUDENTS_KEY, {});
        if (!map[id]) return;
        map[id] = Object.assign({}, map[id], patch);
        writeLS(LS_STUDENTS_KEY, map);
        notifyStudents();
      },
      async deleteStudent(id) {
        const map = readLS(LS_STUDENTS_KEY, {});
        delete map[id];
        writeLS(LS_STUDENTS_KEY, map);
        notifyStudents();
      },
      watchDay(dia, cb) {
        dayListeners[dia] = dayListeners[dia] || [];
        dayListeners[dia].push(cb);
        const data = readLS(lsEventsKey(dia), { dia, entries: [] });
        cb(Array.isArray(data.entries) ? data.entries : []);
        return () => { dayListeners[dia] = (dayListeners[dia] || []).filter((f) => f !== cb); };
      },
      async appendEvent(dia, entry) {
        const key = lsEventsKey(dia);
        const data = readLS(key, { dia, entries: [] });
        const entries = Array.isArray(data.entries) ? data.entries.slice() : [];
        entries.push(entry);
        const ok = writeLS(key, { dia, entries });
        if (ok) notifyDay(dia);
        return ok;
      },
      async removeEvent(dia, matcher) {
        const key = lsEventsKey(dia);
        const data = readLS(key, { dia, entries: [] });
        const entries = (Array.isArray(data.entries) ? data.entries : []).filter((e) => !(e.studentId === matcher.studentId && e.ts === matcher.ts));
        const ok = writeLS(key, { dia, entries });
        if (ok) notifyDay(dia);
        return ok;
      },
      async clearAllStudents() {
        writeLS(LS_STUDENTS_KEY, {});
        notifyStudents();
      },
      async fetchRange(desde, hasta) {
        const out = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || k.indexOf(LS_EVENTS_PREFIX) !== 0) continue;
          const dia = k.slice(LS_EVENTS_PREFIX.length);
          if (dia < desde || dia > hasta) continue;
          const data = readLS(k, { entries: [] });
          (Array.isArray(data.entries) ? data.entries : []).forEach((e) => out.push(Object.assign({ dia }, e)));
        }
        return out;
      },
      async logAudit(entry) {
        const list = readLS(LS_AUDIT_KEY, []);
        list.push(entry);
        writeLS(LS_AUDIT_KEY, list.slice(-200));
        notifyAudit();
        return true;
      },
      watchAudit(cb) {
        auditListeners.push(cb);
        cb(readLS(LS_AUDIT_KEY, []).slice().reverse());
        return () => { auditListeners = auditListeners.filter((f) => f !== cb); };
      },
      watchConfig(cb) {
        configListeners.push(cb);
        cb(readLS(LS_CONFIG_KEY, {}));
        return () => { configListeners = configListeners.filter((f) => f !== cb); };
      },
      async saveConfig(patch) {
        const merged = Object.assign(readLS(LS_CONFIG_KEY, {}), patch);
        writeLS(LS_CONFIG_KEY, merged);
        configListeners.forEach((cb) => cb(merged));
        return true;
      },
    };
  }

  async function withDayLease(ref, dia, mutateEntries) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const lease = await ref.acquire({ holder: state.clientId, ttlMs: 4000 });
        if (lease.acquired) {
          const snap = await ref.get();
          const data = snap.exists ? snap.data() : { dia, entries: [] };
          const entries = mutateEntries(Array.isArray(data.entries) ? data.entries.slice() : []);
          await ref.set({ dia, entries });
          return true;
        }
      } catch (e) { /* retry */ }
      await new Promise((r) => setTimeout(r, 250 + attempt * 200));
    }
    try {
      const snap = await ref.get();
      const data = snap.exists ? snap.data() : { dia, entries: [] };
      const entries = mutateEntries(Array.isArray(data.entries) ? data.entries.slice() : []);
      await ref.set({ dia, entries });
      return true;
    } catch (e) { return false; }
  }

  function createDbBackend(db) {
    const studentsCol = db.collection("students");
    return {
      mode: "shared",
      watchStudents(cb) {
        return studentsCol.onSnapshot((qsnap) => {
          cb(qsnap.docs.map((d) => Object.assign({ id: d.id }, d.data() || {})));
        }, () => switchToLocalBackend());
      },
      async addStudent(data) { await studentsCol.add(data); },
      async updateStudent(id, patch) { await studentsCol.doc(id).update(patch); },
      async deleteStudent(id) { await studentsCol.doc(id).delete(); },
      async clearAllStudents() {
        const qsnap = await studentsCol.get();
        for (const d of qsnap.docs) { await studentsCol.doc(d.id).delete(); }
      },
      watchDay(dia, cb) {
        const ref = db.doc("events/" + dia);
        return ref.onSnapshot((snap) => {
          const data = snap.exists ? snap.data() : {};
          cb(Array.isArray(data.entries) ? data.entries : []);
        });
      },
      async appendEvent(dia, entry) {
        const ref = db.doc("events/" + dia);
        return withDayLease(ref, dia, (entries) => { entries.push(entry); return entries; });
      },
      async removeEvent(dia, matcher) {
        const ref = db.doc("events/" + dia);
        return withDayLease(ref, dia, (entries) => entries.filter((e) => !(e.studentId === matcher.studentId && e.ts === matcher.ts)));
      },
      async fetchRange(desde, hasta) {
        const qsnap = await db.collection("events").get();
        const out = [];
        qsnap.docs.forEach((d) => {
          const dia = d.id;
          if (dia < desde || dia > hasta) return;
          const data = d.data() || {};
          (Array.isArray(data.entries) ? data.entries : []).forEach((e) => out.push(Object.assign({ dia }, e)));
        });
        return out;
      },
      async logAudit(entry) { await db.collection("audit").add(entry); return true; },
      watchAudit(cb) {
        return db.collection("audit").onSnapshot((qs) => {
          const list = qs.docs.map((d) => d.data() || {});
          list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
          cb(list.slice(0, 200));
        });
      },
      watchConfig(cb) {
        return db.doc("config/app").onSnapshot((s) => cb(s.exists ? (s.data() || {}) : {}));
      },
      async saveConfig(patch) {
        const ref = db.doc("config/app");
        const s = await ref.get();
        await ref.set(Object.assign(s.exists ? (s.data() || {}) : {}, patch));
        return true;
      },
    };
  }

  /* ---- Supabase: sincroniza en tiempo real entre dispositivos fuera de Claude ---- */
  function rowToStudent(row) {
    return { id: row.id, apellido: row.apellido || "", nombre: row.nombre || "", curso: row.curso || "", retiraComedor: !!row.retira_comedor };
  }
  function rowToEvent(row) {
    return {
      dia: row.dia,
      studentId: row.student_id, apellido: row.apellido || "", nombre: row.nombre || "",
      curso: row.curso || "", tipo: row.tipo || "reingreso", ts: Number(row.ts), hora: row.hora || "", metodo: row.metodo || "manual",
      registradoPor: row.registrado_por || "",
    };
  }
  function createSupabaseBackend(client) {
    let studentsErrorShown = false;
    function reportError(err, context) {
      console.error("Supabase (" + context + "):", err);
      // Banner permanente, no solo un toast que se va solo: si la base no responde,
      // el que está en la puerta tiene que verlo todo el tiempo.
      setOfflineBanner("Problema de conexión con la base de datos: los registros pueden no estarse guardando. Avisá y revisá la conexión antes de seguir.");
      if (!studentsErrorShown) {
        studentsErrorShown = true;
        toast("No se pudo conectar con Supabase. Revisá la URL, la clave y que hayas ejecutado el script SQL (ver README).", "critical");
      }
    }
    return {
      mode: "supabase",
      watchStudents(cb) {
        let cancelled = false;
        async function loadAndEmit() {
          const { data, error } = await client.from("students").select("*").order("apellido", { ascending: true });
          if (error) { reportError(error, "students"); return; }
          if (!cancelled) cb((data || []).map(rowToStudent));
        }
        loadAndEmit();
        const channel = client.channel("students-changes-" + uid())
          .on("postgres_changes", { event: "*", schema: "public", table: "students" }, loadAndEmit)
          .subscribe();
        return () => { cancelled = true; client.removeChannel(channel); };
      },
      async addStudent(data) {
        const { error } = await client.from("students").insert({
          apellido: data.apellido, nombre: data.nombre, curso: data.curso, retira_comedor: !!data.retiraComedor,
        });
        if (error) reportError(error, "addStudent");
      },
      async updateStudent(id, patch) {
        const row = {};
        if (patch.apellido !== undefined) row.apellido = patch.apellido;
        if (patch.nombre !== undefined) row.nombre = patch.nombre;
        if (patch.curso !== undefined) row.curso = patch.curso;
        if (patch.retiraComedor !== undefined) row.retira_comedor = patch.retiraComedor;
        const { error } = await client.from("students").update(row).eq("id", id);
        if (error) reportError(error, "updateStudent");
      },
      async deleteStudent(id) {
        const { error } = await client.from("students").delete().eq("id", id);
        if (error) reportError(error, "deleteStudent");
      },
      async clearAllStudents() {
        const { error } = await client.from("students").delete().neq("id", "00000000-0000-0000-0000-000000000000");
        if (error) reportError(error, "clearAllStudents");
      },
      watchDay(dia, cb) {
        let cancelled = false;
        async function loadAndEmit() {
          const { data, error } = await client.from("events").select("*").eq("dia", dia).order("ts", { ascending: true });
          if (error) { reportError(error, "events"); return; }
          if (!cancelled) cb((data || []).map(rowToEvent));
        }
        loadAndEmit();
        const channel = client.channel("events-changes-" + uid())
          .on("postgres_changes", { event: "*", schema: "public", table: "events", filter: "dia=eq." + dia }, loadAndEmit)
          .subscribe();
        return () => { cancelled = true; client.removeChannel(channel); };
      },
      async appendEvent(dia, entry) {
        const { error } = await client.from("events").insert({
          dia, student_id: entry.studentId, apellido: entry.apellido, nombre: entry.nombre,
          curso: entry.curso, tipo: entry.tipo, ts: entry.ts, hora: entry.hora, metodo: entry.metodo,
          registrado_por: entry.registradoPor || "",
        });
        if (error && error.code !== "23505") { reportError(error, "appendEvent"); return false; }
        return true;
      },
      async removeEvent(dia, matcher) {
        const { error } = await client.from("events").delete().eq("dia", dia).eq("student_id", matcher.studentId).eq("ts", matcher.ts);
        if (error) { reportError(error, "removeEvent"); return false; }
        return true;
      },
      async fetchRange(desde, hasta) {
        const { data, error } = await client.from("events").select("*")
          .gte("dia", desde).lte("dia", hasta).order("ts", { ascending: true });
        if (error) { reportError(error, "fetchRange"); return []; }
        return (data || []).map(rowToEvent);
      },
      async logAudit(entry) {
        const { error } = await client.from("audit_log").insert({
          actor_email: entry.actorEmail || "", accion: entry.accion, detalle: entry.detalle || "",
        });
        if (error) console.error("audit_log:", error);
        return !error;
      },
      watchAudit(cb) {
        let cancelled = false;
        async function load() {
          const { data, error } = await client.from("audit_log").select("*").order("ts", { ascending: false }).limit(200);
          if (error) { console.error("audit_log list:", error); return; }
          if (!cancelled) {
            cb((data || []).map((r) => ({
              ts: new Date(r.ts).getTime(), actorEmail: r.actor_email || "", accion: r.accion || "", detalle: r.detalle || "",
            })));
          }
        }
        load();
        const ch = client.channel("audit-" + uid())
          .on("postgres_changes", { event: "*", schema: "public", table: "audit_log" }, load).subscribe();
        return () => { cancelled = true; client.removeChannel(ch); };
      },
      watchConfig(cb) {
        let cancelled = false;
        async function load() {
          const { data, error } = await client.from("app_config").select("*");
          if (error) { console.error("app_config:", error); return; }
          const obj = {};
          (data || []).forEach((r) => { obj[r.key] = r.value; });
          if (!cancelled) cb(obj);
        }
        load();
        const ch = client.channel("config-" + uid())
          .on("postgres_changes", { event: "*", schema: "public", table: "app_config" }, load).subscribe();
        return () => { cancelled = true; client.removeChannel(ch); };
      },
      async saveConfig(patch) {
        const rows = Object.keys(patch).map((k) => ({ key: k, value: patch[k] }));
        const { error } = await client.from("app_config").upsert(rows, { onConflict: "key" });
        if (error) { toast("No se pudo guardar la configuración: " + error.message, "critical"); return false; }
        return true;
      },
    };
  }

  /* ---- Roles y login (solo aplica cuando el backend activo es Supabase) ---- */
  const ROLE_LABELS = { director: "Director", preceptor: "Preceptor", secretaria: "Secretaría" };
  const ROLE_TABS = {
    director: ["comedor", "alumnos", "reportes", "usuarios"],
    preceptor: ["comedor"],
    secretaria: ["reportes"],
  };
  let supabaseClient = null;
  let usersUnsub = null;
  let usersList = [];

  function applyRoleUI(role) {
    const allowed = ROLE_TABS[role] || ["comedor"];
    const map = {
      comedor: document.getElementById("tabBtnComedor"),
      alumnos: document.getElementById("tabBtnAlumnos"),
      reportes: document.getElementById("tabBtnReportes"),
      usuarios: document.getElementById("tabBtnUsuarios"),
    };
    let firstAllowed = null;
    Object.keys(map).forEach((key) => {
      const btn = map[key];
      if (!btn) return;
      const ok = allowed.indexOf(key) !== -1;
      btn.hidden = !ok;
      if (ok && !firstAllowed) firstAllowed = key;
    });
    setTab(firstAllowed || "comedor");
  }

  function setUserChip(email, role) {
    const chip = document.getElementById("userChip");
    document.getElementById("userChipEmail").textContent = email || "";
    document.getElementById("userChipRole").textContent = ROLE_LABELS[role] || role || "";
    chip.hidden = false;
  }

  async function fetchOwnRole(client, userId) {
    // El trigger que crea la fila en user_roles corre justo después del login;
    // en la práctica es instantáneo, pero reintentamos un par de veces por las dudas.
    for (let i = 0; i < 5; i++) {
      const { data, error } = await client.from("user_roles").select("role,email").eq("user_id", userId).maybeSingle();
      if (error) { console.error("user_roles:", error); return null; }
      if (data) return data;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  function watchUsers(client) {
    if (usersUnsub) { usersUnsub(); usersUnsub = null; }
    async function loadAndEmit() {
      const { data, error } = await client.from("user_roles").select("id,email,role").order("email", { ascending: true });
      if (error) { console.error("user_roles list:", error); return; }
      usersList = data || [];
      renderUsers();
    }
    loadAndEmit();
    const channel = client.channel("user_roles-changes-" + uid())
      .on("postgres_changes", { event: "*", schema: "public", table: "user_roles" }, loadAndEmit)
      .subscribe();
    usersUnsub = () => client.removeChannel(channel);
  }

  function renderUsers() {
    const table = document.getElementById("usersTable");
    const empty = document.getElementById("usersEmpty");
    const body = document.getElementById("usersBody");
    if (!table) return;
    if (!usersList.length) { table.hidden = true; empty.hidden = false; return; }
    empty.hidden = true; table.hidden = false;
    body.innerHTML = usersList.map((u) => {
      const opts = ["director", "preceptor", "secretaria"].map((r) =>
        '<option value="' + r + '"' + (r === u.role ? " selected" : "") + '>' + ROLE_LABELS[r] + '</option>'
      ).join("");
      return '<tr data-id="' + u.id + '">' +
        '<td>' + escapeHtml(u.email) + '</td>' +
        '<td><select class="role-select role-select-input">' + opts + '</select></td>' +
        '<td class="actions"><button class="btn small primary btn-role-save" disabled>Guardar</button></td>' +
        '</tr>';
    }).join("");
    body.querySelectorAll("tr[data-id]").forEach((tr) => {
      const sel = tr.querySelector(".role-select-input");
      const saveBtn = tr.querySelector(".btn-role-save");
      sel.addEventListener("change", () => { saveBtn.disabled = false; });
      saveBtn.addEventListener("click", async () => {
        const id = tr.dataset.id;
        const newRole = sel.value;
        const u = usersList.find((x) => x.id === id) || { email: id };
        const { error } = await supabaseClient.from("user_roles").update({ role: newRole }).eq("id", id);
        if (error) { toast("No se pudo guardar el rol: " + error.message, "critical"); return; }
        saveBtn.disabled = true;
        audit("Cambio de rol", u.email + " → " + (ROLE_LABELS[newRole] || newRole));
        toast("Rol actualizado.");
        if (u.email === state.currentEmail && newRole !== "director") {
          toast("Te cambiaste tu propio rol: vas a perder el acceso de Director al recargar.", "critical");
        }
      });
    });
  }

  function initSupabaseAuth(client) {
    const gate = document.getElementById("authGate");
    const form = document.getElementById("authForm");
    const newPassForm = document.getElementById("newPassForm");
    const errBox = document.getElementById("authError");
    const submitBtn = document.getElementById("authSubmit");
    const subtitle = document.getElementById("authSubtitle");
    const btnForgot = document.getElementById("btnForgot");
    const btnAuthCancel = document.getElementById("btnAuthCancel");
    let modoPassword = false;   // true mientras se está eligiendo una contraseña nueva

    function showGate(msg) {
      gate.hidden = false;
      if (msg) { errBox.textContent = msg; errBox.hidden = false; } else { errBox.hidden = true; }
    }
    function hideGate() { if (!modoPassword) gate.hidden = true; }

    function modoLogin() {
      modoPassword = false;
      form.hidden = false;
      newPassForm.hidden = true;
      btnForgot.hidden = false;
      btnAuthCancel.hidden = true;
      subtitle.textContent = "Ingresá con tu usuario y contraseña para controlar el comedor.";
      errBox.hidden = true;
    }
    function modoNuevaClave(texto, permiteCancelar) {
      modoPassword = true;
      gate.hidden = false;
      form.hidden = true;
      newPassForm.hidden = false;
      btnForgot.hidden = true;
      btnAuthCancel.hidden = !permiteCancelar;
      subtitle.textContent = texto;
      errBox.hidden = true;
      document.getElementById("newPassword").value = "";
      document.getElementById("newPassword2").value = "";
    }

    btnForgot.addEventListener("click", async () => {
      const email = document.getElementById("authEmail").value.trim();
      if (!email) { showGate("Escribí tu email arriba y volvé a tocar acá: te mandamos un link para cambiar la contraseña."); return; }
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
      if (error) { showGate("No se pudo enviar el mail: " + error.message); return; }
      showGate("Listo: si ese email tiene cuenta, le llega un link para poner una contraseña nueva. Revisá también el correo no deseado.");
    });

    btnAuthCancel.addEventListener("click", () => {
      modoLogin();
      if (state.currentEmail) gate.hidden = true;
    });

    newPassForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const p1 = document.getElementById("newPassword").value;
      const p2 = document.getElementById("newPassword2").value;
      if (p1.length < 6) { showGate("La contraseña tiene que tener al menos 6 caracteres."); return; }
      if (p1 !== p2) { showGate("Las dos contraseñas no coinciden."); return; }
      const btn = document.getElementById("newPassSubmit");
      btn.disabled = true; btn.textContent = "Guardando…";
      const { error } = await client.auth.updateUser({ password: p1 });
      btn.disabled = false; btn.textContent = "Guardar contraseña";
      if (error) { showGate("No se pudo cambiar la contraseña: " + error.message); return; }
      modoPassword = false;
      modoLogin();
      gate.hidden = true;
      toast("Contraseña actualizada.");
    });

    document.getElementById("btnChangePass").addEventListener("click", () => {
      modoNuevaClave("Elegí tu contraseña nueva.", true);
    });

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const email = document.getElementById("authEmail").value.trim();
      const password = document.getElementById("authPassword").value;
      if (!email || !password) return;
      submitBtn.disabled = true;
      submitBtn.textContent = "Ingresando…";
      const { error } = await client.auth.signInWithPassword({ email, password });
      submitBtn.disabled = false;
      submitBtn.textContent = "Ingresar";
      if (error) {
        showGate(error.message === "Invalid login credentials" ? "Email o contraseña incorrectos." : "No se pudo iniciar sesión: " + error.message);
      }
    });

    document.getElementById("btnLogout").addEventListener("click", async () => {
      await client.auth.signOut();
      location.reload();
    });

    return new Promise((resolve) => {
      let resolved = false;
      async function onSignedIn(session) {
        const roleRow = await fetchOwnRole(client, session.user.id);
        if (!roleRow) {
          showGate("Tu usuario inició sesión pero todavía no tiene un rol asignado. Pedile al director que te lo asigne desde la pestaña Usuarios.");
          return;
        }
        hideGate();
        state.currentRole = roleRow.role;
        state.currentEmail = roleRow.email || session.user.email;
        setUserChip(state.currentEmail, state.currentRole);
        applyRoleUI(state.currentRole);
        if (state.currentRole === "director") watchUsers(client);
        if (!resolved) { resolved = true; resolve(); }
      }
      client.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT") { location.reload(); return; }
        if (event === "PASSWORD_RECOVERY") {
          // Llegó desde el link del mail: primero elige la contraseña, después entra.
          modoNuevaClave("Elegí una contraseña nueva para tu cuenta.", false);
          return;
        }
        if (session && session.user) onSignedIn(session);
        else { modoLogin(); showGate(); }
      });
    });
  }

  let backend = null;
  let unsubStudents = null, unsubToday = null, unsubAudit = null, unsubConfig = null;

  /* ---- Estado de la conexión ---- */
  function showFatal(titulo, msg) {
    document.getElementById("fatalTitle").textContent = titulo;
    document.getElementById("fatalMsg").textContent = msg;
    document.getElementById("fatalGate").hidden = false;
  }
  document.getElementById("btnFatalRetry").addEventListener("click", () => location.reload());

  function setOfflineBanner(msg) {
    const el = document.getElementById("offlineBanner");
    if (!msg) { el.hidden = true; return; }
    el.textContent = msg;
    el.hidden = false;
  }
  window.addEventListener("offline", () => {
    setOfflineBanner("Sin internet en este dispositivo. Lo que registres ahora puede no guardarse — revisá el wifi antes de seguir.");
  });
  window.addEventListener("online", () => {
    setOfflineBanner("");
    toast("Conexión restablecida.");
    if (backend) watchToday();
  });

  function setConnBanner(mode) {
    const el = document.getElementById("connBanner");
    if (mode === "shared" || mode === "supabase") { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = "Modo local: la nómina y los movimientos se guardan solo en este navegador (no se comparten entre dispositivos). Para sincronizar en tiempo real entre varios dispositivos, completá la configuración de Supabase al principio del archivo (ver README).";
  }

  function startBackend(b) {
    backend = b;
    setConnBanner(b.mode);
    if (unsubStudents) unsubStudents();
    unsubStudents = backend.watchStudents(onStudentsSnapshot);
    watchToday();

    // El contacto de preceptoría lo necesitan todos (lo usan los botones de aviso).
    if (unsubConfig) unsubConfig();
    if (backend.watchConfig) {
      unsubConfig = backend.watchConfig((cfg) => {
        state.config = cfg || {};
        renderConfig();
        renderRetiroList();
      });
    }
    // El historial solo lo ve el Director (y en modo local/Claude, donde no hay roles).
    const puedeVerAudit = !state.currentRole || state.currentRole === "director";
    if (unsubAudit) { unsubAudit(); unsubAudit = null; }
    if (puedeVerAudit && backend.watchAudit) {
      unsubAudit = backend.watchAudit((list) => { state.auditList = list || []; renderAudit(); });
    }

    // Si el rol ya dejó abierta la pestaña Reportes antes de que existiera el
    // backend, la carga quedó pendiente: la enganchamos ahora.
    const repPanel = document.querySelector('[data-tab-panel="reportes"]');
    if (repPanel && !repPanel.hidden) renderReport();
  }
  function switchToLocalBackend() {
    if (backend && backend.mode === "local") return;
    startBackend(createLocalBackend());
  }

  async function initBackend() {
    if (window.claude && window.claude.use) {
      let db = null;
      try { db = await window.claude.use("db"); } catch (e) { db = null; }
      if (db) { startBackend(createDbBackend(db)); return; }
    }
    const cfg = window.SUPABASE_CONFIG || {};
    if (cfg.url && cfg.anonKey) {
      // Con Supabase configurado NO degradamos en silencio a modo local: si esto
      // falla, alguien podría registrar 40 chicos en un dispositivo suelto sin que
      // nadie los vea. Mejor frenar y avisar.
      if (!window.supabase || !window.supabase.createClient) {
        showFatal("No se pudo cargar la aplicación",
          "No se pudo descargar un componente necesario (la librería de la base de datos). Suele ser falta de internet o que la red del colegio esté bloqueando el acceso. Revisá la conexión y reintentá — no registres reingresos hasta que esto se resuelva, porque no se guardarían.");
        return;
      }
      try {
        const client = window.supabase.createClient(cfg.url, cfg.anonKey);
        supabaseClient = client;
        await initSupabaseAuth(client);
        startBackend(createSupabaseBackend(client));
        return;
      } catch (e) {
        console.error("No se pudo iniciar Supabase:", e);
        showFatal("No se pudo conectar con la base de datos",
          "La aplicación no pudo conectarse al servidor. Revisá la conexión a internet y reintentá. Si sigue igual, avisale al administrador: puede ser un problema de configuración (" + (e && e.message ? e.message : "error desconocido") + ").");
        return;
      }
    }
    startBackend(createLocalBackend());
  }

  function watchToday() {
    if (!backend) return;
    if (unsubToday) unsubToday();
    unsubToday = backend.watchDay(state.todayDia, (entries) => {
      state.dayEvents = entries;
      state.dayLoaded = true;
      renderRetiroList();
      renderStats();
      // Si el reporte abierto incluye hoy, lo refrescamos para que se vea en vivo.
      const repPanel = document.querySelector('[data-tab-panel="reportes"]');
      if (repPanel && !repPanel.hidden &&
          state.reportDesde <= state.todayDia && state.todayDia <= state.reportHasta) {
        loadReport();
      }
    });
  }
  // Los reportes ahora trabajan sobre un rango de fechas, así que se piden de una
  // (no hay suscripción viva a un rango). Si el rango incluye el día de hoy, el
  // watcher de hoy vuelve a pedirlos para que se vea al instante.
  let reportSeq = 0;
  async function loadReport() {
    // El login por roles puede abrir la pestaña Reportes (rol Secretaría) antes de
    // que el backend exista; en ese caso startBackend vuelve a llamar acá.
    if (!backend) return;
    const seq = ++reportSeq;
    let desde = state.reportDesde, hasta = state.reportHasta;
    if (desde > hasta) { const t = desde; desde = hasta; hasta = t; }
    let events = [];
    try {
      events = await backend.fetchRange(desde, hasta);
    } catch (e) {
      console.error("fetchRange:", e);
      toast("No se pudieron cargar los reportes.", "critical");
      return;
    }
    if (seq !== reportSeq) return; // llegó una respuesta vieja, la descartamos
    state.reportEvents = events;
    renderReportOutput();
  }

  function onStudentsSnapshot(arr) {
    state.studentsLoaded = true;
    state.students.clear();
    arr.forEach((data) => {
      state.students.set(data.id, {
        id: data.id,
        apellido: data.apellido || "",
        nombre: data.nombre || "",
        curso: data.curso || "",
        retiraComedor: !!data.retiraComedor,
      });
    });
    renderRoster();
    renderStats();
    renderRetiroList();
  }

  /* ============ writes ============ */
  // Deja constancia de quién hizo qué. Es "best effort": si falla, no frena la acción.
  function audit(accion, detalle) {
    if (!backend || !backend.logAudit) return;
    try {
      backend.logAudit({ ts: Date.now(), actorEmail: state.currentEmail || "", accion: accion, detalle: detalle || "" });
    } catch (e) { console.error("audit:", e); }
  }
  function nombreDe(s) {
    return s.apellido + ", " + s.nombre + (s.curso ? " (" + s.curso + ")" : "");
  }

  async function addStudent(apellido, nombre, curso, retira) {
    await backend.addStudent({ apellido: apellido.trim(), nombre: nombre.trim(), curso: (curso || "").trim(), retiraComedor: !!retira });
  }
  async function updateStudent(id, patch) {
    await backend.updateStudent(id, patch);
  }
  async function deleteStudent(id) {
    await backend.deleteStudent(id);
  }
  async function appendEvent(dia, entry) {
    const ok = await backend.appendEvent(dia, entry);
    if (!ok) toast("No se pudo registrar el reingreso. Probá de nuevo.", "critical");
    return ok;
  }

  function yaVolvioHoy(studentId) {
    return state.dayEvents.find((e) => e.studentId === studentId) || null;
  }

  // En modo continuo el reconocedor puede emitir dos resultados finales casi
  // juntos para la misma persona. Como el evento tarda en volver del servidor,
  // yaVolvioHoy() todavía no lo ve y se registraría dos veces.
  const registrandoAhora = new Set();

  async function registrarMovimiento(student, metodo) {
    if (registrandoAhora.has(student.id)) return;
    const ya = yaVolvioHoy(student.id);
    if (ya) {
      toast(student.apellido + ", " + student.nombre + " ya había reingresado hoy a las " + ya.hora + ".", "warning");
      clearCandidates();
      document.getElementById("manualInput").value = "";
      document.getElementById("manualResults").hidden = true;
      return;
    }
    const now = new Date();
    const dia = diaStr(now);
    const entry = {
      studentId: student.id, apellido: student.apellido, nombre: student.nombre,
      curso: student.curso, tipo: "reingreso", ts: now.getTime(), hora: fmtHora(now), metodo,
      registradoPor: state.currentEmail || "",
    };
    registrandoAhora.add(student.id);
    let ok = false;
    try {
      ok = await appendEvent(dia, entry);
    } finally {
      registrandoAhora.delete(student.id);
    }
    if (ok) {
      state.lastRegistered = { studentId: student.id, apellido: student.apellido, nombre: student.nombre, dia, ts: entry.ts, hora: entry.hora };
      renderLastAction();
      toast("Reingreso registrado: " + student.apellido + ", " + student.nombre);
      clearCandidates();
      document.getElementById("manualInput").value = "";
      document.getElementById("manualResults").hidden = true;
    }
  }

  function renderLastAction() {
    const wrap = document.getElementById("lastActionWrap");
    const last = state.lastRegistered;
    if (!last || last.dia !== state.todayDia) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = '<div class="feed-item" style="border-bottom:none; background:var(--surface-2); border-radius:10px; padding:8px 10px;">' +
      '<span class="feed-name">Último registro: ' + escapeHtml(last.apellido) + ', ' + escapeHtml(last.nombre) + ' (' + escapeHtml(last.hora) + ')</span>' +
      '<button class="btn small subtle" id="btnDeshacerUltimo">Desmarcar</button>' +
      '</div>';
    const btn = document.getElementById("btnDeshacerUltimo");
    if (btn) btn.addEventListener("click", deshacerUltimo);
  }

  async function deshacerUltimo() {
    const last = state.lastRegistered;
    if (!last) return;
    const ok = await backend.removeEvent(last.dia, { studentId: last.studentId, ts: last.ts });
    if (ok) {
      toast("Se deshizo el registro de " + last.apellido + ", " + last.nombre + ".");
      state.lastRegistered = null;
      renderLastAction();
    } else {
      toast("No se pudo deshacer. Probá de nuevo.", "critical");
    }
  }

  /* ============ stats & retiro checklist (Comedor) ============ */
  function retiraStudents() {
    return Array.from(state.students.values()).filter((s) => s.retiraComedor);
  }
  function renderStats() {
    const students = Array.from(state.students.values());
    const retiran = retiraStudents();
    const vueltosIds = new Set(state.dayEvents.map((e) => e.studentId));
    const vueltos = retiran.filter((s) => vueltosIds.has(s.id));
    document.getElementById("statTotal").textContent = students.length;
    document.getElementById("statRetiran").textContent = retiran.length;
    document.getElementById("statVueltos").textContent = vueltos.length;
    document.getElementById("statPendientes").textContent = retiran.length - vueltos.length;
  }

  /* ---- Filtro y resumen por curso ---- */
  function cursosDe(students) {
    const set = new Set(students.map((s) => (s.curso || "").trim()).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
  }

  function renderCursoFilter(todos) {
    const wrap = document.getElementById("cursoFilter");
    if (!wrap) return;
    const cursos = cursosDe(todos);
    if (cursos.length < 2) { wrap.innerHTML = ""; return; }
    const chips = [{ v: "", l: "Todos" }].concat(cursos.map((c) => ({ v: c, l: c })));
    wrap.innerHTML = chips.map((c) =>
      '<button class="curso-chip" data-curso="' + escapeHtml(c.v) + '" aria-pressed="' + (state.cursoFilter === c.v) + '">' + escapeHtml(c.l) + '</button>'
    ).join("");
    wrap.querySelectorAll(".curso-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.cursoFilter = btn.dataset.curso;
        renderRetiroList();
      });
    });
  }

  function renderCursoSummary(todos, vueltosIds) {
    const wrap = document.getElementById("cursoSummary");
    if (!wrap) return;
    const cursos = cursosDe(todos);
    if (cursos.length < 2) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = cursos.map((c) => {
      const delCurso = todos.filter((s) => (s.curso || "").trim() === c);
      const vueltos = delCurso.filter((s) => vueltosIds.has(s.id)).length;
      const completo = vueltos === delCurso.length;
      return '<div class="curso-card"><div class="cc-name">' + escapeHtml(c) + '</div>' +
        '<div class="cc-num"><span class="' + (completo ? "cc-ok" : "cc-pend") + '">' + vueltos + '</span>' +
        ' <span style="font-size:13px;color:var(--muted);">de ' + delCurso.length + ' volvieron</span></div></div>';
    }).join("");
  }

  /* ---- Aviso a preceptoría de los que no volvieron ---- */
  function textoAviso(pendientes) {
    const fecha = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
    const lineas = pendientes.map((s) => "• " + s.apellido + ", " + s.nombre + (s.curso ? " (" + s.curso + ")" : ""));
    return "Colegio French — comedor " + fecha + "\n" +
      "No volvieron del comedor (" + pendientes.length + "):\n" + lineas.join("\n");
  }

  function renderAlert(todos, vueltosIds, pasadoHorario) {
    const wrap = document.getElementById("alertWrap");
    if (!wrap) return;
    const pendientes = todos.filter((s) => !vueltosIds.has(s.id))
      .sort((a, b) => (a.apellido + a.nombre).localeCompare(b.apellido + b.nombre, "es"));

    if (!pasadoHorario || !pendientes.length) { wrap.innerHTML = ""; return; }

    const texto = textoAviso(pendientes);
    const tel = (state.config.whatsapp || "").replace(/[^0-9]/g, "");
    const mail = state.config.email || "";
    const waUrl = "https://wa.me/" + tel + "?text=" + encodeURIComponent(texto);
    const mailUrl = "mailto:" + encodeURIComponent(mail) +
      "?subject=" + encodeURIComponent("Comedor: alumnos que no volvieron") +
      "&body=" + encodeURIComponent(texto);

    wrap.innerHTML = '<div class="alert-panel">' +
      '<h2>Pasó el horario de comedor y ' + (pendientes.length === 1 ? 'falta 1 alumno' : 'faltan ' + pendientes.length + ' alumnos') + '</h2>' +
      '<p class="panel-desc" style="color:var(--ink-2);">Estos alumnos figuran como que se retiran a comedor y todavía no se registró su reingreso. Avisá a preceptoría.</p>' +
      '<div class="alert-names">' + pendientes.map((s) =>
        escapeHtml(s.apellido + ", " + s.nombre) + (s.curso ? ' <span style="color:var(--ink-2)">(' + escapeHtml(s.curso) + ')</span>' : "")
      ).join(" · ") + '</div>' +
      '<div class="alert-actions">' +
        '<button class="btn small" id="btnCopiarAviso">Copiar lista</button>' +
        '<a class="btn small primary" id="btnWhatsapp" href="' + waUrl + '" target="_blank" rel="noopener">Enviar por WhatsApp</a>' +
        (mail ? '<a class="btn small" href="' + mailUrl + '">Enviar por mail</a>' : "") +
      '</div>' +
      (tel || mail ? "" : '<p class="panel-desc" style="margin-top:10px;">Tip: cargá el WhatsApp y el mail de preceptoría en la pestaña Usuarios para que estos botones ya vayan al destinatario correcto.</p>') +
      '</div>';

    const btnCopiar = document.getElementById("btnCopiarAviso");
    if (btnCopiar) {
      btnCopiar.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(texto);
          toast("Lista copiada. Pegala donde la necesites.");
        } catch (e) {
          // Algunos navegadores bloquean el portapapeles: mostramos el texto para copiar a mano.
          const ta = document.createElement("textarea");
          ta.value = texto; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); toast("Lista copiada."); }
          catch (e2) { toast("No se pudo copiar automáticamente. Seleccioná el texto a mano.", "critical"); }
          document.body.removeChild(ta);
        }
      });
    }

    // Un solo aviso por día, y recién cuando ya cargaron nómina y reingresos:
    // si no, avisaría con el número de antes de que llegaran los datos.
    if (state.studentsLoaded && state.dayLoaded && state.alertAvisadaDia !== state.todayDia) {
      state.alertAvisadaDia = state.todayDia;
      toast("Atención: " + pendientes.length + " alumno(s) todavía no volvieron del comedor.", "critical");
    }
  }

  function renderRetiroList() {
    const wrap = document.getElementById("retiroList");
    const todosRetiran = retiraStudents();
    const retiran = state.cursoFilter
      ? todosRetiran.filter((s) => (s.curso || "") === state.cursoFilter)
      : todosRetiran;
    const vueltosIds = new Set(state.dayEvents.map((e) => e.studentId));
    const now = new Date();
    const pasadoHorario = now.getHours() >= 13;

    renderCursoFilter(todosRetiran);
    renderCursoSummary(todosRetiran, vueltosIds);
    renderAlert(todosRetiran, vueltosIds, pasadoHorario);

    if (!retiran.length) {
      wrap.innerHTML = '<div class="feed-empty">' + (state.cursoFilter
        ? 'No hay alumnos de ' + escapeHtml(state.cursoFilter) + ' marcados como "retira a comedor".'
        : 'No hay alumnos marcados como "retira a comedor" todavía. Marcalos desde la pestaña Alumnos.') + '</div>';
    } else {
      const sorted = retiran.slice().sort((a, b) => {
        const av = vueltosIds.has(a.id) ? 1 : 0, bv = vueltosIds.has(b.id) ? 1 : 0;
        if (av !== bv) return av - bv; // pendientes primero
        return (a.apellido + a.nombre).localeCompare(b.apellido + b.nombre, "es");
      });
      wrap.innerHTML = sorted.map((s) => {
        const ev = state.dayEvents.find((e) => e.studentId === s.id);
        let badgeClass, badgeLabel;
        if (ev) { badgeClass = "good"; badgeLabel = "Volvió " + ev.hora; }
        else if (pasadoHorario) { badgeClass = "critical"; badgeLabel = "No volvió"; }
        else { badgeClass = "warning"; badgeLabel = "Pendiente"; }
        const quickBtn = ev ? "" : '<button class="btn small subtle btn-marcar" data-id="' + s.id + '">Marcar vuelto</button>';
        return '<div class="feed-item">' +
          '<span class="feed-name">' + escapeHtml(s.apellido) + ', ' + escapeHtml(s.nombre) + '</span>' +
          '<span class="feed-curso">' + escapeHtml(s.curso || "") + '</span>' +
          '<span class="badge ' + badgeClass + '">' + badgeLabel + '</span>' + quickBtn +
          '</div>';
      }).join("");
      wrap.querySelectorAll(".btn-marcar").forEach((btn) => {
        btn.addEventListener("click", () => {
          const s = state.students.get(btn.dataset.id);
          if (s) registrarMovimiento(s, "manual");
        });
      });
    }

    const otros = state.dayEvents.filter((e) => {
      const s = state.students.get(e.studentId);
      return !s || !s.retiraComedor;
    });
    const otrosWrap = document.getElementById("otrosWrap");
    if (!otros.length) {
      otrosWrap.innerHTML = "";
    } else {
      otrosWrap.innerHTML = '<h3 style="font-size:13px; margin:16px 0 8px; color:var(--ink-2);">Otros reingresos registrados hoy</h3>' +
        otros.slice().sort((a, b) => b.ts - a.ts).map((e) => {
          return '<div class="feed-item"><span class="feed-time">' + escapeHtml(e.hora || "") + '</span>' +
            '<span class="feed-name">' + escapeHtml(e.apellido) + ', ' + escapeHtml(e.nombre) + '</span>' +
            '<span class="feed-curso">' + escapeHtml(e.curso || "") + '</span></div>';
        }).join("");
    }
  }

  /* ============ speech recognition ============ */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById("micBtn");
  const micStatus = document.getElementById("micStatus");
  const micTranscript = document.getElementById("micTranscript");
  let recognition = null, listening = false, manualStop = false;

  /* ---- Modo puerta (kiosco) y micrófono continuo ---- */
  const btnKiosk = document.getElementById("btnKiosk");
  btnKiosk.addEventListener("click", () => {
    state.kiosk = !state.kiosk;
    document.getElementById("app").classList.toggle("kiosk", state.kiosk);
    btnKiosk.setAttribute("aria-pressed", String(state.kiosk));
    btnKiosk.classList.toggle("primary", state.kiosk);
    btnKiosk.textContent = state.kiosk ? "Salir de modo puerta" : "Modo puerta";
    try { localStorage.setItem("comedorFrench:kiosk", state.kiosk ? "1" : "0"); } catch (e) {}
  });
  try {
    if (localStorage.getItem("comedorFrench:kiosk") === "1") btnKiosk.click();
  } catch (e) {}

  const btnMicContinuo = document.getElementById("btnMicContinuo");
  function setMicContinuo(on, aviso) {
    if (state.micContinuo === on) return;
    state.micContinuo = on;
    btnMicContinuo.setAttribute("aria-pressed", String(on));
    btnMicContinuo.classList.toggle("primary", on);
    btnMicContinuo.textContent = on ? "Escucha continua activada" : "Micrófono continuo";
    if (on) {
      toast(aviso || "El micrófono queda escuchando: decí un apellido atrás de otro.");
      if (recognition && !listening) { try { recognition.start(); } catch (e) {} }
    } else if (listening) {
      manualStop = true;
      try { recognition.stop(); } catch (e) {}
    }
  }
  btnMicContinuo.addEventListener("click", () => setMicContinuo(!state.micContinuo));

  if (!SR) {
    micBtn.disabled = true;
    micStatus.textContent = "Reconocimiento de voz no disponible en este navegador. Usá la búsqueda manual.";
  } else {
    recognition = new SR();
    recognition.lang = "es-AR";
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.continuous = false;

    recognition.onstart = () => {
      listening = true;
      micBtn.classList.add("listening");
      micBtn.textContent = "🔴";
      micTranscript.textContent = "";
      // En modo continuo el navegador corta y reanuda la escucha cada pocos
      // segundos. Si hay una elección pendiente en pantalla, NO la borramos:
      // si no, el preceptor se queda sin poder elegir.
      if (state.micContinuo && state.pendingCandidates.length) {
        micStatus.textContent = "Encontré varios parecidos, elegí uno:";
      } else {
        micStatus.textContent = "Escuchando… decí apellido y nombre";
        clearCandidates();
      }
    };
    recognition.onresult = (ev) => {
      let text = "";
      const alts = [];
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        text = r[0].transcript;
        if (r.isFinal) {
          for (let a = 0; a < r.length; a++) alts.push(r[a].transcript);
        }
      }
      micTranscript.textContent = text;
      if (alts.length) handleTranscripts(alts);
    };
    recognition.onerror = (ev) => {
      if (ev.error === "no-speech") {
        // En modo continuo el silencio es lo normal: no tiene sentido avisarlo.
        if (!state.micContinuo) micStatus.textContent = "No se detectó voz. Probá de nuevo.";
      } else if (ev.error === "not-allowed" || ev.error === "service-not-allowed" || ev.error === "audio-capture") {
        // Sin permiso no tiene sentido reintentar en loop: apagamos la escucha continua.
        setMicContinuo(false);
        micStatus.textContent = "El navegador bloqueó el micrófono acá. Si esta página está dentro de Claude, probá abrirla en su propia pestaña, o publicala en tu propio sitio (por ejemplo GitHub Pages) — ahí el micrófono pide permiso normalmente. Mientras tanto usá la búsqueda manual.";
      } else {
        micStatus.textContent = "No se pudo escuchar (" + ev.error + "). Probá de nuevo o buscá manualmente.";
      }
    };
    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove("listening");
      micBtn.textContent = "🎤";
      if (!state.pendingCandidates.length) micStatus.textContent = "Presioná para hablar";
      // En modo continuo el navegador corta la escucha sola cada pocos segundos:
      // la volvemos a arrancar, salvo que el usuario haya frenado a propósito.
      if (state.micContinuo && !manualStop) {
        if (!state.pendingCandidates.length) micStatus.textContent = "Escuchando… (modo continuo)";
        setTimeout(() => {
          if (state.micContinuo && !listening) { try { recognition.start(); } catch (e) {} }
        }, 300);
      }
      manualStop = false;
    };
    micBtn.addEventListener("click", () => {
      if (state.students.size === 0) { toast("Primero cargá la nómina de alumnos.", "critical"); return; }
      if (listening) {
        // Si frenás con el botón del micrófono, también se apaga la escucha
        // continua: si no, el botón quedaría diciendo "activada" sin escuchar.
        if (state.micContinuo) { setMicContinuo(false); }
        else { manualStop = true; recognition.stop(); }
        return;
      }
      try { recognition.start(); } catch (e) { /* already started */ }
    });
  }

  function handleTranscripts(alternatives) {
    const students = Array.from(state.students.values());
    if (!students.length) return;
    let best = new Map(); // id -> best score across alternatives
    alternatives.forEach((alt) => {
      const norm = normalize(alt);
      students.forEach((s) => {
        const sc = scoreStudent(norm, s);
        if (!best.has(s.id) || best.get(s.id) < sc) best.set(s.id, sc);
      });
    });
    const ranked = students.map((s) => ({ s, score: best.get(s.id) || 0 }))
      .filter((r) => r.score > 0.42)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (!ranked.length) {
      micStatus.textContent = "No encontré coincidencias. Probá de nuevo o buscá manualmente.";
      return;
    }
    const top = ranked[0];
    const second = ranked[1];
    const esClaro = top.score >= 0.65 && (!second || top.score - second.score >= 0.18);
    if (esClaro) {
      micStatus.textContent = "Reconocido: " + top.s.apellido + ", " + top.s.nombre;
      clearCandidates();
      registrarMovimiento(top.s, "voz");
      return;
    }
    micStatus.textContent = "Encontré varios parecidos, elegí uno:";
    renderCandidates(ranked.map((r) => r.s));
  }

  function renderCandidates(students) {
    state.pendingCandidates = students;
    const wrap = document.getElementById("candidatesWrap");
    wrap.innerHTML = students.map((s, i) => {
      const ya = yaVolvioHoy(s.id);
      const label = ya ? "Ya volvió " + ya.hora : "Registrar reingreso";
      const cls = ya ? "neutral" : "good";
      return '<button class="candidate-card" data-idx="' + i + '">' +
        '<span><span class="candidate-name">' + escapeHtml(s.apellido) + ', ' + escapeHtml(s.nombre) + '</span>' +
        '<br><span class="candidate-meta">' + escapeHtml(s.curso || "Sin curso") + (s.retiraComedor ? "" : " · no está en la lista de retiro") + '</span></span>' +
        '<span class="badge ' + cls + ' candidate-action">' + label + '</span>' +
        '</button>';
    }).join("");
    wrap.querySelectorAll(".candidate-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = state.pendingCandidates[Number(btn.dataset.idx)];
        if (s) registrarMovimiento(s, "voz");
      });
    });
  }
  function clearCandidates() {
    state.pendingCandidates = [];
    document.getElementById("candidatesWrap").innerHTML = "";
  }

  /* ============ manual search (Comedor) ============ */
  const manualInput = document.getElementById("manualInput");
  const manualResults = document.getElementById("manualResults");
  manualInput.addEventListener("input", () => {
    const q = normalize(manualInput.value);
    if (!q) { manualResults.hidden = true; return; }
    const students = Array.from(state.students.values());
    const matches = students
      .map((s) => ({ s, score: Math.max(scoreStudent(q, s), normalize(s.curso).includes(q) ? 0.5 : 0) }))
      .filter((r) => r.score > 0.3 || normalize(r.s.apellido + " " + r.s.nombre).includes(q))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    if (!matches.length) { manualResults.innerHTML = '<button disabled style="color:var(--muted)">Sin coincidencias</button>'; manualResults.hidden = false; return; }
    manualResults.innerHTML = matches.map((r, i) => {
      const s = r.s;
      const ya = yaVolvioHoy(s.id);
      const tag = ya ? "Ya volvió " + ya.hora : "Registrar reingreso";
      return '<button data-idx="' + i + '">' + escapeHtml(s.apellido) + ', ' + escapeHtml(s.nombre) +
        ' <span class="curso-tag">' + escapeHtml(s.curso || "") + ' · ' + tag + '</span></button>';
    }).join("");
    manualResults._matches = matches.map((r) => r.s);
    manualResults.hidden = false;
    manualResults.querySelectorAll("button[data-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = manualResults._matches[Number(btn.dataset.idx)];
        if (s) registrarMovimiento(s, "manual");
      });
    });
  });
  document.addEventListener("click", (ev) => {
    if (!manualResults.contains(ev.target) && ev.target !== manualInput) manualResults.hidden = true;
  });

  /* ============ Alumnos tab ============ */
  const addForm = document.getElementById("addForm");
  const importForm = document.getElementById("importForm");
  function openAdd() { addForm.classList.add("open"); importForm.classList.remove("open"); }
  function openImport() { importForm.classList.add("open"); addForm.classList.remove("open"); }
  document.getElementById("btnToggleAdd").addEventListener("click", () => addForm.classList.contains("open") ? addForm.classList.remove("open") : openAdd());
  document.getElementById("btnToggleImport").addEventListener("click", () => importForm.classList.contains("open") ? importForm.classList.remove("open") : openImport());
  document.getElementById("btnImportCancel").addEventListener("click", () => importForm.classList.remove("open"));

  function dupKey(s) {
    return normalize((s.apellido || "") + " " + (s.nombre || "") + " " + (s.curso || ""));
  }

  document.getElementById("btnAddSubmit").addEventListener("click", async () => {
    const ap = document.getElementById("addApellido").value.trim();
    const no = document.getElementById("addNombre").value.trim();
    const cu = document.getElementById("addCurso").value.trim();
    const re = document.getElementById("addRetira").checked;
    if (!ap || !no) { toast("Completá apellido y nombre.", "critical"); return; }
    const key = dupKey({ apellido: ap, nombre: no, curso: cu });
    const yaExiste = Array.from(state.students.values()).some((s) => dupKey(s) === key);
    if (yaExiste) { toast("Ya existe un alumno con ese apellido, nombre y curso.", "critical"); return; }
    await addStudent(ap, no, cu, re);
    audit("Alta de alumno", nombreDe({ apellido: ap, nombre: no, curso: cu }));
    document.getElementById("addApellido").value = "";
    document.getElementById("addNombre").value = "";
    document.getElementById("addCurso").value = "";
    document.getElementById("addRetira").checked = false;
    document.getElementById("addApellido").focus();
    toast("Alumno agregado.");
  });

  function parseRetiraFlag(v) {
    const n = normalize(v || "");
    return n === "si" || n === "sí" || n === "true" || n === "1" || n === "x";
  }

  async function importRows(rows) {
    const existing = new Set(Array.from(state.students.values()).map(dupKey));
    let added = 0, invalid = 0, dupes = 0;
    for (const r of rows) {
      const apellido = (r.apellido || "").toString().trim();
      const nombre = (r.nombre || "").toString().trim();
      const curso = (r.curso || "").toString().trim();
      const retira = parseRetiraFlag(r.retira);
      if (!apellido || !nombre) { invalid++; continue; }
      const key = dupKey({ apellido, nombre, curso });
      if (existing.has(key)) { dupes++; continue; }
      existing.add(key);
      await addStudent(apellido, nombre, curso, retira);
      added++;
    }
    // Una sola entrada de auditoría por importación, no una por alumno.
    if (added) audit("Importación de nómina", added + " alumnos agregados");
    return { added, invalid, dupes };
  }
  function importSummaryToast(r) {
    const notas = [];
    if (r.dupes) notas.push(r.dupes + " ya existían (mismo apellido, nombre y curso)");
    if (r.invalid) notas.push(r.invalid + " sin apellido/nombre");
    toast("Se importaron " + r.added + " alumnos" + (notas.length ? " (" + notas.join(", ") + ")" : "") + ".");
  }

  document.getElementById("btnImportSubmit").addEventListener("click", async () => {
    const raw = document.getElementById("importText").value;
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { toast("Pegá al menos un alumno.", "critical"); return; }
    const rows = lines.map((line) => {
      const parts = line.split(",").map((p) => p.trim());
      return { apellido: parts[0] || "", nombre: parts[1] || "", curso: parts[2] || "", retira: parts[3] || "" };
    });
    const result = await importRows(rows);
    document.getElementById("importText").value = "";
    importForm.classList.remove("open");
    importSummaryToast(result);
  });

  document.getElementById("importExcelInput").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (!window.XLSX) { toast("No se pudo cargar el lector de Excel. Probá de nuevo en un momento.", "critical"); ev.target.value = ""; return; }
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rowsRaw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      let dataRows = rowsRaw.filter((r) => r.some((c) => (c || "").toString().trim() !== ""));
      if (dataRows.length && normalize(dataRows[0][0]) === "apellido") dataRows = dataRows.slice(1);
      const rows = dataRows.map((r) => ({ apellido: r[0] || "", nombre: r[1] || "", curso: r[2] || "", retira: r[3] || "" }));
      if (!rows.length) { toast("El Excel no tiene filas para importar.", "critical"); ev.target.value = ""; return; }
      const result = await importRows(rows);
      importForm.classList.remove("open");
      importSummaryToast(result);
    } catch (e) {
      console.error(e);
      toast("No se pudo leer ese archivo. Verificá que sea un .xlsx válido.", "critical");
    }
    ev.target.value = "";
  });

  document.getElementById("btnClearAll").addEventListener("click", () => {
    const wrap = document.getElementById("clearAllConfirm");
    if (!state.students.size) { toast("La nómina ya está vacía."); return; }
    wrap.innerHTML = '<div class="panel-desc" style="background:var(--critical-bg); color:var(--critical); border-radius:10px; padding:10px 12px; margin-top:-6px; margin-bottom:14px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">' +
      '<span>¿Seguro que querés borrar los ' + state.students.size + ' alumnos de la nómina? Esto no borra el historial de reportes.</span>' +
      '<button class="btn small danger" id="btnClearAllYes">Sí, borrar todo</button>' +
      '<button class="btn small subtle" id="btnClearAllNo">Cancelar</button></div>';
    document.getElementById("btnClearAllYes").addEventListener("click", async () => {
      const cuantos = state.students.size;
      wrap.innerHTML = "";
      await backend.clearAllStudents();
      audit("Borrado de toda la nómina", cuantos + " alumnos");
      toast("Se borró toda la nómina.");
    });
    document.getElementById("btnClearAllNo").addEventListener("click", () => { wrap.innerHTML = ""; });
  });

  const rosterSearch = document.getElementById("rosterSearch");
  rosterSearch.addEventListener("input", renderRoster);

  function renderRoster() {
    const students = Array.from(state.students.values()).sort((a, b) => (a.apellido + a.nombre).localeCompare(b.apellido + b.nombre, "es"));
    const table = document.getElementById("rosterTable");
    const empty = document.getElementById("rosterEmpty");
    const body = document.getElementById("rosterBody");

    if (!students.length) { table.hidden = true; empty.hidden = false; body.innerHTML = ""; return; }
    empty.hidden = true;
    table.hidden = false;

    const q = normalize(rosterSearch.value);
    const filtered = q ? students.filter((s) => normalize(s.apellido + " " + s.nombre + " " + s.curso).includes(q)) : students;

    if (!filtered.length) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px;">Sin resultados para "' + escapeHtml(rosterSearch.value) + '"</td></tr>';
      return;
    }

    body.innerHTML = filtered.map((s) => {
      return '<tr data-id="' + s.id + '">' +
        '<td class="c-apellido">' + escapeHtml(s.apellido) + '</td>' +
        '<td class="c-nombre">' + escapeHtml(s.nombre) + '</td>' +
        '<td class="c-curso">' + escapeHtml(s.curso || "—") + '</td>' +
        '<td><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" class="chk-retira" ' + (s.retiraComedor ? "checked" : "") + '> ' + (s.retiraComedor ? '<span class="badge good">Sí</span>' : '<span class="badge neutral">No</span>') + '</label></td>' +
        '<td class="actions"><button class="btn small subtle btn-edit">Editar</button> <button class="btn small danger btn-del">Eliminar</button></td>' +
        '</tr>';
    }).join("");

    body.querySelectorAll(".chk-retira").forEach((chk) => {
      chk.addEventListener("change", async () => {
        const tr = chk.closest("tr");
        const s = state.students.get(tr.dataset.id);
        if (!s) return;
        await updateStudent(s.id, { retiraComedor: chk.checked });
        audit(chk.checked ? "Marcado retira a comedor" : "Desmarcado retira a comedor", nombreDe(s));
      });
    });
    body.querySelectorAll(".btn-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tr = btn.closest("tr");
        const s = state.students.get(tr.dataset.id);
        if (!s) return;
        const cell = tr.querySelector(".actions");
        cell.innerHTML = '<span style="font-size:12.5px;color:var(--ink-2);margin-right:6px;">¿Eliminar?</span>' +
          '<button class="btn small danger btn-del-yes">Sí, eliminar</button> <button class="btn small subtle btn-del-no">Cancelar</button>';
        cell.querySelector(".btn-del-yes").addEventListener("click", async () => {
          await deleteStudent(s.id);
          audit("Baja de alumno", nombreDe(s));
          toast("Alumno eliminado.");
        });
        cell.querySelector(".btn-del-no").addEventListener("click", () => renderRoster());
      });
    });
    body.querySelectorAll(".btn-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tr = btn.closest("tr");
        const s = state.students.get(tr.dataset.id);
        if (!s) return;
        tr.querySelector(".c-apellido").innerHTML = '<input class="edit-input" value="' + escapeHtml(s.apellido) + '" data-field="apellido">';
        tr.querySelector(".c-nombre").innerHTML = '<input class="edit-input" value="' + escapeHtml(s.nombre) + '" data-field="nombre">';
        tr.querySelector(".c-curso").innerHTML = '<input class="edit-input" value="' + escapeHtml(s.curso) + '" data-field="curso">';
        tr.querySelector(".actions").innerHTML = '<button class="btn small primary btn-save">Guardar</button>';
        tr.querySelector(".btn-save").addEventListener("click", async () => {
          const patch = {};
          tr.querySelectorAll("input[data-field]").forEach((inp) => { patch[inp.dataset.field] = inp.value.trim(); });
          if (!patch.apellido || !patch.nombre) { toast("Apellido y nombre no pueden estar vacíos.", "critical"); return; }
          const newKey = dupKey({ apellido: patch.apellido, nombre: patch.nombre, curso: patch.curso !== undefined ? patch.curso : s.curso });
          const chocaConOtro = Array.from(state.students.values()).some((o) => o.id !== s.id && dupKey(o) === newKey);
          if (chocaConOtro) { toast("Ya existe otro alumno con ese apellido, nombre y curso.", "critical"); return; }
          await updateStudent(s.id, patch);
          audit("Edición de alumno", nombreDe(s) + " → " + nombreDe({ apellido: patch.apellido, nombre: patch.nombre, curso: patch.curso }));
          toast("Cambios guardados.");
        });
      });
    });
  }

  /* ============ Reportes tab ============ */
  const inputDesde = document.getElementById("reportDesde");
  const inputHasta = document.getElementById("reportHasta");
  inputDesde.value = state.reportDesde;
  inputHasta.value = state.reportHasta;
  inputDesde.addEventListener("change", () => {
    state.reportDesde = inputDesde.value || diaStr(new Date());
    loadReport();
  });
  inputHasta.addEventListener("change", () => {
    state.reportHasta = inputHasta.value || diaStr(new Date());
    loadReport();
  });
  document.querySelectorAll("[data-range]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const hoy = new Date();
      let desde = new Date(hoy);
      if (btn.dataset.range === "semana") desde.setDate(hoy.getDate() - 6);
      else if (btn.dataset.range === "mes") desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
      state.reportDesde = diaStr(desde);
      state.reportHasta = diaStr(hoy);
      inputDesde.value = state.reportDesde;
      inputHasta.value = state.reportHasta;
      loadReport();
    });
  });
  function renderReport() { loadReport(); }

  function fmtDiaCorto(dia) {
    const p = (dia || "").split("-");
    return p.length === 3 ? p[2] + "/" + p[1] : (dia || "");
  }
  // Días del rango en los que efectivamente se usó el sistema. Sirve de denominador
  // para el resumen por alumno: no tiene sentido contar como "no volvió" un domingo
  // o un día en que nadie registró nada.
  function diasConActividad(events) {
    return Array.from(new Set(events.map((e) => e.dia).filter(Boolean))).sort();
  }

  function renderReportOutput() {
    const events = state.reportEvents.slice().sort((a, b) => a.ts - b.ts);
    const unDia = state.reportDesde === state.reportHasta;
    const dias = diasConActividad(events);

    document.getElementById("repEntradas").textContent = events.length;
    document.getElementById("repAlumnos").textContent = new Set(events.map((e) => e.studentId)).size;

    // Encabezado que sale al imprimir en A4 (en pantalla está oculto)
    document.getElementById("printHeader").innerHTML =
      '<h3 style="font-size:15px;margin-bottom:2px;">Colegio French — control de comedor</h3>' +
      '<p style="font-size:12px;color:#444;margin:0 0 14px;">' +
      (unDia ? "Día " + state.reportDesde : "Del " + state.reportDesde + " al " + state.reportHasta) +
      " · " + events.length + " reingresos · impreso el " + diaStr(new Date()) + "</p>";

    const retiran = retiraStudents();
    const vueltosIds = new Set(events.map((e) => e.studentId));
    // "No volvieron" es claro solo si el rango es un día; en un rango se muestra
    // quién no aparece ni una sola vez en todo el período.
    const noVolvieron = retiran.filter((s) => !vueltosIds.has(s.id))
      .sort((a, b) => (a.apellido + a.nombre).localeCompare(b.apellido + b.nombre, "es"));
    document.getElementById("repNoVolvieron").textContent = noVolvieron.length;

    const nvTable = document.getElementById("noVolvieronTable");
    const nvBody = document.getElementById("noVolvieronBody");
    const nvEmpty = document.getElementById("noVolvieronEmpty");
    if (!noVolvieron.length) {
      nvTable.hidden = true; nvEmpty.hidden = false;
      nvEmpty.textContent = unDia
        ? "Todos los alumnos que se retiran habitualmente a comedor volvieron ese día."
        : "Todos los alumnos que se retiran a comedor volvieron al menos una vez en el período.";
    } else {
      nvEmpty.hidden = true; nvTable.hidden = false;
      nvBody.innerHTML = noVolvieron.map((s) => '<tr><td>' + escapeHtml(s.apellido) + '</td><td>' + escapeHtml(s.nombre) + '</td><td>' + escapeHtml(s.curso || "—") + '</td></tr>').join("");
    }

    renderPorAlumno(events, dias, retiran);

    const table = document.getElementById("reportTable");
    const empty = document.getElementById("reportEmpty");
    const body = document.getElementById("reportBody");
    if (!events.length) {
      table.hidden = true; empty.hidden = false;
      document.getElementById("chartWrap").innerHTML = "";
      return;
    }
    empty.hidden = true; table.hidden = false;
    body.innerHTML = events.slice().reverse().map((e) => {
      return '<tr><td>' + escapeHtml(fmtDiaCorto(e.dia)) + '</td><td>' + escapeHtml(e.hora || "") + '</td>' +
        '<td>' + escapeHtml(e.apellido) + ', ' + escapeHtml(e.nombre) + '</td>' +
        '<td>' + escapeHtml(e.curso || "—") + '</td>' +
        '<td>' + (e.metodo === "voz" ? "Voz" : "Manual") + '</td>' +
        '<td>' + escapeHtml(e.registradoPor || "—") + '</td></tr>';
    }).join("");

    renderChart(events);
  }

  function renderPorAlumno(events, dias, retiran) {
    const table = document.getElementById("porAlumnoTable");
    const body = document.getElementById("porAlumnoBody");
    const empty = document.getElementById("porAlumnoEmpty");
    if (!dias.length || !retiran.length) {
      table.hidden = true; empty.hidden = false;
      empty.textContent = !retiran.length
        ? 'Marcá alumnos como "retira a comedor" en la pestaña Alumnos para ver este resumen.'
        : "Todavía no hay días con actividad registrada en este rango.";
      return;
    }
    empty.hidden = true; table.hidden = false;
    const total = dias.length;
    const filas = retiran.map((s) => {
      const diasVuelto = new Set(events.filter((e) => e.studentId === s.id).map((e) => e.dia));
      const volvio = diasVuelto.size;
      return { s, volvio, falto: total - volvio, pct: Math.round((volvio / total) * 100) };
    }).sort((a, b) => b.falto - a.falto || (a.s.apellido + a.s.nombre).localeCompare(b.s.apellido + b.s.nombre, "es"));

    body.innerHTML = filas.map((f) => {
      const cls = f.pct >= 90 ? "good" : (f.pct >= 60 ? "warning" : "critical");
      return '<tr><td>' + escapeHtml(f.s.apellido) + ', ' + escapeHtml(f.s.nombre) + '</td>' +
        '<td>' + escapeHtml(f.s.curso || "—") + '</td>' +
        '<td>' + f.volvio + ' de ' + total + '</td>' +
        '<td>' + f.falto + '</td>' +
        '<td><span class="badge ' + cls + '">' + f.pct + '%</span></td></tr>';
    }).join("");
  }

  /* ---- Exportar e imprimir ---- */
  document.getElementById("btnExportExcel").addEventListener("click", () => {
    if (!window.XLSX) { toast("No se pudo cargar el generador de Excel. Probá de nuevo en un momento.", "critical"); return; }
    const events = state.reportEvents.slice().sort((a, b) => a.ts - b.ts);
    if (!events.length) { toast("No hay reingresos para exportar en este rango.", "critical"); return; }
    try {
      const wb = XLSX.utils.book_new();
      const hoja1 = events.map((e) => ({
        Fecha: e.dia || "", Hora: e.hora || "", Apellido: e.apellido, Nombre: e.nombre,
        Curso: e.curso || "", "Método": e.metodo === "voz" ? "Voz" : "Manual",
        "Registrado por": e.registradoPor || "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(hoja1), "Reingresos");

      const dias = diasConActividad(events);
      const retiran = retiraStudents();
      if (dias.length && retiran.length) {
        const hoja2 = retiran.map((s) => {
          const v = new Set(events.filter((e) => e.studentId === s.id).map((e) => e.dia)).size;
          return {
            Apellido: s.apellido, Nombre: s.nombre, Curso: s.curso || "",
            "Volvió": v, "No volvió": dias.length - v, "Días con actividad": dias.length,
            "% que volvió": Math.round((v / dias.length) * 100),
          };
        }).sort((a, b) => b["No volvió"] - a["No volvió"]);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(hoja2), "Por alumno");
      }
      XLSX.writeFile(wb, "comedor-french_" + state.reportDesde + "_a_" + state.reportHasta + ".xlsx");
      toast("Excel generado.");
    } catch (e) {
      console.error(e);
      toast("No se pudo generar el Excel acá. Si estás dentro de Claude, probá desde la página publicada.", "critical");
    }
  });

  document.getElementById("btnPrint").addEventListener("click", () => window.print());

  /* ---- Historial de cambios ---- */
  function renderAudit() {
    const table = document.getElementById("auditTable");
    const body = document.getElementById("auditBody");
    const empty = document.getElementById("auditEmpty");
    if (!table) return;
    const list = state.auditList || [];
    if (!list.length) { table.hidden = true; empty.hidden = false; return; }
    empty.hidden = true; table.hidden = false;
    body.innerHTML = list.slice(0, 200).map((a) => {
      const d = new Date(a.ts || 0);
      const cuando = isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-AR") + " " + fmtHora(d);
      return '<tr><td>' + escapeHtml(cuando) + '</td>' +
        '<td>' + escapeHtml(a.actorEmail || "—") + '</td>' +
        '<td>' + escapeHtml(a.accion || "") + '</td>' +
        '<td>' + escapeHtml(a.detalle || "") + '</td></tr>';
    }).join("");
  }

  /* ---- Contacto de preceptoría ---- */
  function renderConfig() {
    const w = document.getElementById("cfgWhatsapp");
    const m = document.getElementById("cfgEmail");
    // No pisamos lo que el usuario está tipeando en ese momento.
    if (w && document.activeElement !== w) w.value = state.config.whatsapp || "";
    if (m && document.activeElement !== m) m.value = state.config.email || "";
  }
  document.getElementById("btnSaveConfig").addEventListener("click", async () => {
    if (!backend || !backend.saveConfig) return;
    const whatsapp = document.getElementById("cfgWhatsapp").value.trim();
    const email = document.getElementById("cfgEmail").value.trim();
    if (email && email.indexOf("@") === -1) { toast("Ese mail no parece válido.", "critical"); return; }
    const ok = await backend.saveConfig({ whatsapp: whatsapp, email: email });
    if (ok) {
      audit("Cambio de contacto de preceptoría", (whatsapp || "sin WhatsApp") + " / " + (email || "sin mail"));
      toast("Contacto de preceptoría guardado.");
    }
  });

  function renderChart(events) {
    const hours = new Set([11, 12, 13, 14]);
    events.forEach((e) => hours.add(new Date(e.ts).getHours()));
    const hourList = Array.from(hours).sort((a, b) => a - b);
    const counts = hourList.map((h) => {
      const inH = events.filter((e) => new Date(e.ts).getHours() === h);
      return { h, reingresos: inH.length };
    });
    const maxVal = Math.max(1, ...counts.map((c) => c.reingresos));

    const W = 640, H = 200, padL = 34, padB = 26, padT = 10, padR = 10;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const groupW = plotW / counts.length;
    const barW = Math.min(34, groupW * 0.5);
    const scaleY = (v) => plotH - (v / maxVal) * plotH;

    let bars = "";
    let gridlines = "";
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = Math.round((maxVal / ticks) * i);
      const y = padT + scaleY(v);
      gridlines += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--border)" stroke-width="1"/>';
      gridlines += '<text x="' + (padL - 8) + '" y="' + (y + 4) + '" font-size="10.5" text-anchor="end" fill="var(--muted)">' + v + '</text>';
    }

    counts.forEach((c, i) => {
      const gx = padL + i * groupW;
      const centerX = gx + groupW / 2;
      const x1 = centerX - barW / 2;
      const y1 = padT + scaleY(c.reingresos);
      const h1 = plotH - scaleY(c.reingresos);
      bars += '<rect class="chart-bar" data-label="' + c.h + ':00 — ' + c.reingresos + ' reingreso' + (c.reingresos === 1 ? '' : 's') + '" x="' + x1 + '" y="' + y1 + '" width="' + barW + '" height="' + Math.max(h1, 0) + '" rx="3" fill="var(--series-1)"></rect>';
      bars += '<text x="' + centerX + '" y="' + (H - 6) + '" font-size="11" text-anchor="middle" fill="var(--muted)">' + c.h + ':00</text>';
    });

    const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:100%;height:auto;font-family:Inter,sans-serif;" role="img" aria-label="Reingresos por hora">' +
      gridlines +
      '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '" stroke="var(--muted)" stroke-width="1"/>' +
      bars +
      '</svg>';

    const wrap = document.getElementById("chartWrap");
    wrap.innerHTML = svg + '<div class="chart-tooltip" id="chartTooltip"></div>';
    const tip = document.getElementById("chartTooltip");
    wrap.querySelectorAll(".chart-bar").forEach((bar) => {
      bar.addEventListener("mousemove", (ev) => {
        const rect = wrap.getBoundingClientRect();
        tip.textContent = bar.dataset.label;
        tip.style.left = (ev.clientX - rect.left) + "px";
        tip.style.top = (ev.clientY - rect.top) + "px";
        tip.classList.add("show");
      });
      bar.addEventListener("mouseleave", () => tip.classList.remove("show"));
    });
  }

  /* ============ boot ============ */
  initBackend();
  renderRoster();
  renderStats();
  renderRetiroList();
})();
