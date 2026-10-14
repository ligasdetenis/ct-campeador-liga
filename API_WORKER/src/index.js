var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
import { DurableObject } from "cloudflare:workers";
var STATE_KEY = "ct-campeador:state";
var USERS_KEY = "ct-campeador:users";
var PROFILES_KEY = "ct-campeador:profiles";
var MESSAGES_KEY = "ct-campeador:messages";
var ADMIN_PREFS_KEY = "ct-campeador:admin-prefs";
var SESSION_SECURITY_VERSION = 2;
var SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
var LOGIN_WINDOW_MS = 15 * 60 * 1e3;
var LOGIN_BLOCK_MS = 15 * 60 * 1e3;
var LOGIN_USER_MAX_FAILURES = 5;
var LOGIN_MAX_FAILURES = 30;
var ALLOWED_ORIGINS = /* @__PURE__ */ new Set([
  "https://ligasdetenis.github.io"
]);
var BookingCoordinator = class extends DurableObject {
  static {
    __name(this, "BookingCoordinator");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        match_id TEXT PRIMARY KEY,
        slot_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS login_guard (
        guard_key TEXT PRIMARY KEY,
        failures INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER NOT NULL DEFAULT 0
      )
    `);
  }
  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ authenticated: false });
      return new Response(null, { status: 101, webSocket: client });
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "");
    if (action === "ping") {
      return doJson({ ok: true, durableObject: "online" });
    }
    if (action === "broadcast") {
      const event = body.event && typeof body.event === "object" ? body.event : null;
      if (!event) return doJson({ ok: false, error: "Falta evento" }, 400);

      const recipients = Array.isArray(body.recipients)
        ? new Set(body.recipients.map((x) => normalize(x)).filter(Boolean))
        : null;
      const includeAdmins = body.includeAdmins === true;
      let sent = 0;

      for (const ws of this.ctx.getWebSockets()) {
        let attachment = {};
        try { attachment = ws.deserializeAttachment() || {}; } catch (_) {}
        if (!attachment.authenticated) continue;

        const allowed =
          !recipients ||
          recipients.has(normalize(attachment.name)) ||
          (includeAdmins && attachment.role === "admin");
        if (!allowed) continue;

        try {
          ws.send(JSON.stringify({ type: "event", event }));
          sent++;
        } catch (_) {}
      }
      return doJson({ ok: true, sent });
    }
    if (action === "loginGate") {
      const key = String(body.key || "").slice(0, 180);
      const now = Date.now();
      const row = this.sql.exec(
        "SELECT failures, window_start, blocked_until FROM login_guard WHERE guard_key = ? LIMIT 1",
        key
      ).toArray()[0];
      const blockedUntil = Number(row?.blocked_until || 0);
      if (blockedUntil > now) {
        return doJson({ ok: true, allowed: false, retryAfter: Math.max(1, Math.ceil((blockedUntil - now) / 1e3)) });
      }
      return doJson({ ok: true, allowed: true });
    }
    if (action === "loginFailure") {
      const key = String(body.key || "").slice(0, 180);
      const now = Date.now();
      const row = this.sql.exec(
        "SELECT failures, window_start, blocked_until FROM login_guard WHERE guard_key = ? LIMIT 1",
        key
      ).toArray()[0];
      let failures = Number(row?.failures || 0);
      let windowStart = Number(row?.window_start || 0);
      let blockedUntil = Number(row?.blocked_until || 0);
      if (!windowStart || now - windowStart > LOGIN_WINDOW_MS) {
        failures = 0;
        windowStart = now;
        blockedUntil = 0;
      }
      failures += 1;
      const maxFailures = Math.max(1, Number(body.maxFailures || LOGIN_MAX_FAILURES));
      if (failures >= maxFailures) blockedUntil = now + LOGIN_BLOCK_MS;
      this.sql.exec(
        `INSERT INTO login_guard (guard_key, failures, window_start, blocked_until) VALUES (?, ?, ?, ?)
         ON CONFLICT(guard_key) DO UPDATE SET failures=excluded.failures, window_start=excluded.window_start, blocked_until=excluded.blocked_until`,
        key,
        failures,
        windowStart,
        blockedUntil
      );
      return doJson({ ok: true, failures, blocked: blockedUntil > now, retryAfter: blockedUntil > now ? Math.ceil((blockedUntil - now) / 1e3) : 0 });
    }
    if (action === "loginSuccess") {
      const key = String(body.key || "").slice(0, 180);
      this.sql.exec("DELETE FROM login_guard WHERE guard_key = ?", key);
      return doJson({ ok: true });
    }
    if (action === "list") {
      const rows = this.sql.exec(
        "SELECT match_id, payload FROM reservations ORDER BY updated_at ASC"
      ).toArray();
      const reservations = {};
      for (const row of rows) {
        try {
          reservations[row.match_id] = JSON.parse(row.payload);
        } catch {
        }
      }
      return doJson({ ok: true, reservations });
    }
    if (action === "get") {
      const matchId = String(body.matchId || "");
      const rows = this.sql.exec(
        "SELECT payload FROM reservations WHERE match_id = ? LIMIT 1",
        matchId
      ).toArray();
      let reservation = null;
      if (rows[0]) {
        try {
          reservation = JSON.parse(rows[0].payload);
        } catch {
        }
      }
      return doJson({ ok: true, reservation });
    }
    if (action === "reserve") {
      const matchId = String(body.matchId || "");
      const slotId = String(body.slotId || "");
      const reservation = body.reservation || {};
      if (!matchId || !slotId) {
        return doJson({ ok: false, error: "Faltan datos de la reserva" }, 400);
      }
      try {
        const result = this.ctx.storage.transactionSync(() => {
          const occupied = this.sql.exec(
            "SELECT match_id FROM reservations WHERE slot_id = ? LIMIT 1",
            slotId
          ).toArray()[0];
          if (occupied && occupied.match_id !== matchId) {
            const err = new Error("Esa pista acaba de ser reservada por otro partido.");
            err.code = "SLOT_TAKEN";
            throw err;
          }
          const payload = JSON.stringify(reservation);
          const now = (/* @__PURE__ */ new Date()).toISOString();
          this.sql.exec(
            `INSERT INTO reservations (match_id, slot_id, payload, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(match_id) DO UPDATE SET
               slot_id = excluded.slot_id,
               payload = excluded.payload,
               updated_at = excluded.updated_at`,
            matchId,
            slotId,
            payload,
            now
          );
          return reservation;
        });
        return doJson({ ok: true, reservation: result });
      } catch (error) {
        const msg = error?.message || String(error);
        return doJson({ ok: false, error: msg }, msg.includes("acaba de ser reservada") ? 409 : 500);
      }
    }
    if (action === "cancel") {
      const matchId = String(body.matchId || "");
      if (!matchId) return doJson({ ok: false, error: "Falta el partido" }, 400);
      this.sql.exec("DELETE FROM reservations WHERE match_id = ?", matchId);
      return doJson({ ok: true });
    }
    return doJson({ ok: false, error: `Acci\xF3n DO desconocida: ${action}` }, 400);
  }

  async webSocketMessage(ws, message) {
    let payload = {};
    try {
      payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch (_) {
      try { ws.send(JSON.stringify({ type: "error", error: "Mensaje no válido." })); } catch (_) {}
      return;
    }

    let attachment = {};
    try { attachment = ws.deserializeAttachment() || {}; } catch (_) {}

    if (!attachment.authenticated) {
      if (payload.type !== "auth") {
        try { ws.close(1008, "Autenticación requerida"); } catch (_) {}
        return;
      }
      const token = String(payload.token || "").trim();
      if (!token) {
        try { ws.close(1008, "Token requerido"); } catch (_) {}
        return;
      }
      const raw = await this.env.DATA.get(`session:${token}`);
      if (!raw) {
        try { ws.close(1008, "Sesión no válida"); } catch (_) {}
        return;
      }
      try {
        const session = JSON.parse(raw);
        if (session.securityVersion !== SESSION_SECURITY_VERSION) throw new Error("Sesión caducada");
        ws.serializeAttachment({
          authenticated: true,
          name: String(session.name || ""),
          role: String(session.role || "player")
        });
        ws.send(JSON.stringify({ type: "ready" }));
      } catch (_) {
        try { ws.close(1008, "Sesión no válida"); } catch (_) {}
      }
      return;
    }

    if (payload.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong", at: Date.now() })); } catch (_) {}
    }
  }

  webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (_) {}
  }
};
var index_default = {
  async fetch(request, env) {
    const corsHeaders = corsHeadersFor(request);
    if (!isAllowedOrigin(request)) {
      return json({ ok: false, error: "Origen no autorizado" }, 403, corsHeaders);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    try {
      const requestUrl = new URL(request.url);
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/realtime" &&
        (request.headers.get("Upgrade") || "").toLowerCase() === "websocket"
      ) {
        const stub = env.BOOKINGS.getByName("ct-campeador-reservas-global");
        return stub.fetch(request);
      }

      if (request.method === "GET") {
        let kv = "online";
        let durableObject = "online";
        let error = null;
        try {
          await env.DATA.get(STATE_KEY);
        } catch (e) {
          kv = "ERROR";
          error = e?.message || String(e);
        }
        try {
          const ping = await bookingCall(env, { action: "ping" });
          if (!ping.ok) throw new Error(ping.error || "Durable Object no disponible");
        } catch (e) {
          durableObject = "ERROR";
          error = error || e?.message || String(e);
        }
        return json({
          ok: kv === "online" && durableObject === "online",
          service: "CT Campeador API",
          worker: "online",
          kv,
          durableObject,
          version: "2.6.7-push-deeplinks",
          error
        }, kv === "online" && durableObject === "online" ? 200 : 500, corsHeaders);
      }
      if (request.method !== "POST") {
        return json({ ok: false, error: "M\xE9todo no permitido" }, 405, corsHeaders);
      }
      const body = await request.json().catch(() => ({}));
      const action = String(body.action || "").trim();
      if (action === "ping") {
        const ping = await bookingCall(env, { action: "ping" });
        return json({ ok: true, message: "CT Campeador conectado", durableObject: ping.durableObject, version: "2.6.7-push-deeplinks" }, 200, corsHeaders);
      }
      if (action === "login") {
        const gateKey = loginGuardKey(request);
        const name = String(body.name || "").trim();
        const pin = String(body.pin || "").trim();
        const specificGateKey = loginAttemptKey(request, name || pin);
        const gate = await checkLoginGates(env, [gateKey, specificGateKey]);
        if (!gate.allowed) return json({ ok: false, error: `Demasiados intentos para este acceso. Prueba de nuevo en ${Math.ceil(gate.retryAfter / 60)} min.` }, 429, { ...corsHeaders, "Retry-After": String(gate.retryAfter) });
        if (!name || !/^(?:\d{4}|\d{6})$/.test(pin)) return json({ ok: false, error: "Nombre y PIN v\xE1lidos obligatorios" }, 400, corsHeaders);
        const users = await getUsers(env);
        if (!users.length) return json({ ok: false, error: "No hay usuarios configurados. Contacta con el administrador." }, 503, corsHeaders);
        const user = users.find((u) => normalize(u.name) === normalize(name) && String(u.pin) === pin && u.active !== false);
        if (!user) {
          await registerLoginFailure(env, gateKey, specificGateKey);
          return json({ ok: false, error: "Nombre o PIN incorrecto" }, 401, corsHeaders);
        }
        await clearLoginGates(env, [gateKey, specificGateKey]);
        const token = await createSession(env, user);
        return json({ ok: true, token, user: { name: user.name, role: user.role || "player" } }, 200, corsHeaders);
      }
      if (action === "loginPin") {
        const gateKey = loginGuardKey(request);
        const pin = String(body.pin || "").trim();
        const specificGateKey = loginAttemptKey(request, pin);
        const gate = await checkLoginGates(env, [gateKey, specificGateKey]);
        if (!gate.allowed) return json({ ok: false, error: `Demasiados intentos para este PIN. Prueba de nuevo en ${Math.ceil(gate.retryAfter / 60)} min.` }, 429, { ...corsHeaders, "Retry-After": String(gate.retryAfter) });
        if (!/^(?:\d{4}|\d{6})$/.test(pin)) {
          return json({ ok: false, error: "Introduce un PIN v\xE1lido de 6 cifras. Los PIN antiguos de 4 cifras siguen funcionando." }, 400, corsHeaders);
        }
        const users = await getUsers(env);
        if (!users.length) return json({ ok: false, error: "No hay usuarios configurados. Contacta con el administrador." }, 503, corsHeaders);
        const matches = users.filter((u) => String(u.pin) === pin && u.active !== false);
        if (!matches.length) {
          await registerLoginFailure(env, gateKey, specificGateKey);
          return json({ ok: false, error: "PIN incorrecto." }, 401, corsHeaders);
        }
        if (matches.length > 1) {
          await registerLoginFailure(env, gateKey, specificGateKey);
          return json({ ok: false, error: "PIN duplicado. Un administrador debe regenerar uno de los PIN." }, 409, corsHeaders);
        }
        await clearLoginGates(env, [gateKey, specificGateKey]);
        const user = matches[0];
        const token = await createSession(env, user);
        return json({ ok: true, token, user: { name: user.name, role: user.role || "player" } }, 200, corsHeaders);
      }
      if (action === "getOwnPin") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);

        const users = await getUsers(env);
        const user = users.find((u) =>
          normalize(u.name) === normalize(auth.session.name) &&
          u.active !== false
        );

        if (!user) return json({ ok: false, error: "Usuario no encontrado." }, 404, corsHeaders);

        const pin = String(user.pin || "").trim();
        if (!/^(?:\d{4}|\d{6})$/.test(pin)) {
          return json({ ok: false, error: "El PIN actual no es válido." }, 500, corsHeaders);
        }

        return json({ ok: true, pin }, 200, corsHeaders);
      }

      if (action === "logout") {
        const token = getToken(request, body);
        if (token) await deleteSession(env, token);
        return json({ ok: true }, 200, corsHeaders);
      }
      if (action === "readPublicConfig") {
        const state = await getState(env);
        return json({
          ok: true,
          config: {
            tournamentName: String(state.tournamentName || "II Liga Federada").trim().slice(0, 60) || "II Liga Federada"
          }
        }, 200, corsHeaders);
      }

      if (action === "saveTournamentName") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);

        const tournamentName = String(body.tournamentName || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 60);

        if (!tournamentName) {
          return json({ ok: false, error: "Escribe el nombre del torneo." }, 400, corsHeaders);
        }

        const state = await getState(env);
        const nextState = {
          ...state,
          tournamentName,
          updatedAt: new Date().toISOString(),
          updatedBy: admin.session.name
        };

        await env.DATA.put(STATE_KEY, JSON.stringify(nextState));

        return json({
          ok: true,
          tournamentName
        }, 200, corsHeaders);
      }

      if (action === "getAdminPreferences") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);

        const prefs = await getAdminPrefs(env);
        const key = normalize(admin.session.name);
        const own = prefs[key] && typeof prefs[key] === "object" ? prefs[key] : {};
        return json({
          ok: true,
          preferences: {
            adminOrder: cleanAdminOrder(own.adminOrder)
          }
        }, 200, corsHeaders);
      }

      if (action === "saveAdminOrder") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);

        const order = cleanAdminOrder(body.order);
        if (!order.length) {
          return json({ ok: false, error: "Orden de administración no válido." }, 400, corsHeaders);
        }

        const prefs = await getAdminPrefs(env);
        const key = normalize(admin.session.name);
        prefs[key] = {
          ...(prefs[key] && typeof prefs[key] === "object" ? prefs[key] : {}),
          adminOrder: order,
          updatedAt: new Date().toISOString()
        };
        await putAdminPrefs(env, prefs);
        return json({ ok: true, adminOrder: order }, 200, corsHeaders);
      }

      if (action === "resetAdminOrder") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);

        const prefs = await getAdminPrefs(env);
        const key = normalize(admin.session.name);
        if (prefs[key] && typeof prefs[key] === "object") {
          const next = { ...prefs[key] };
          delete next.adminOrder;
          next.updatedAt = new Date().toISOString();
          prefs[key] = next;
          await putAdminPrefs(env, prefs);
        }
        return json({ ok: true }, 200, corsHeaders);
      }

      if (action === "read") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const state = await getState(env);
        const reservations = await listReservations(env);
        const profiles = await getProfiles(env);
        const visibleState = stateForSession(state, reservations, profiles, auth.session);
        return json({ ok: true, state: visibleState, user: { name: auth.session.name, role: auth.session.role } }, 200, corsHeaders);
      }
      if (action === "readProfiles") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const profiles = await getProfiles(env);
        return json({ ok: true, profiles }, 200, corsHeaders);
      }
      if (action === "upsertProfile") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const profile = body.profile;
        if (!profile || typeof profile !== "object") {
          return json({ ok: false, error: "Falta profile" }, 400, corsHeaders);
        }
        const player = String(profile.player || "").trim();
        const photoDataUrl = String(profile.photoDataUrl || "");
        if (!player || normalize(player) !== normalize(auth.session.name)) {
          return json({ ok: false, error: "Solo puedes cambiar tu propia foto." }, 403, corsHeaders);
        }
        if (!photoDataUrl.startsWith("data:image/")) {
          return json({ ok: false, error: "Imagen no v\xE1lida." }, 400, corsHeaders);
        }
        if (photoDataUrl.length > 18e4) {
          return json({ ok: false, error: "Imagen demasiado grande." }, 413, corsHeaders);
        }
        const profiles = await getProfiles(env);
        profiles[auth.session.name] = {
          player: auth.session.name,
          photoDataUrl,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        await env.DATA.put(PROFILES_KEY, JSON.stringify(profiles));
        return json({ ok: true, profile: profiles[auth.session.name] }, 200, corsHeaders);
      }
      if (action === "deleteProfile") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const profiles = await getProfiles(env);
        delete profiles[auth.session.name];
        await env.DATA.put(PROFILES_KEY, JSON.stringify(profiles));
        return json({ ok: true }, 200, corsHeaders);
      }
      if (action === "getPushConfig") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        if (!env.PUSH_SERVICE) return json({ ok: false, error: "El servicio Push no est\xE1 configurado." }, 500, corsHeaders);
        const r = await env.PUSH_SERVICE.fetch("https://push.internal/health", { method: "GET" });
        const txt = await r.text();
        let j = {};
        try {
          j = JSON.parse(txt);
        } catch (_) {
        }
        if (!r.ok || !j.vapidPublicKey) return json({ ok: false, error: j.error || txt || "No se pudo obtener la clave Push." }, 502, corsHeaders);
        return json({ ok: true, vapidPublicKey: String(j.vapidPublicKey), vapidConfigured: !!j.vapidConfigured }, 200, corsHeaders);
      }
      if (action === "subscribePush") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        if (!env.PUSH_SERVICE || !env.PUSH_SERVICE_TOKEN) {
          return json({ ok: false, error: "El servicio Push no est\xE1 configurado." }, 500, corsHeaders);
        }
        const subscription = body.subscription || {};
        if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
          return json({ ok: false, error: "Suscripci\xF3n Push incompleta." }, 400, corsHeaders);
        }
        const r = await env.PUSH_SERVICE.fetch("https://push.internal/subscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.PUSH_SERVICE_TOKEN}`
          },
          body: JSON.stringify({
            subscription,
            userName: auth.session.name
          })
        });
        const txt = await r.text();
        let j = {};
        try {
          j = JSON.parse(txt);
        } catch (_) {
        }
        if (!r.ok || j.ok === false) {
          return json({ ok: false, error: j.error || txt || `Push HTTP ${r.status}` }, 502, corsHeaders);
        }
        return json({ ok: true, created: !!j.created, updated: !!j.updated, unchanged: !!j.unchanged }, 200, corsHeaders);
      }
      if (action === "sendAvailabilityPush") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        if (!env.PUSH_SERVICE_TOKEN) {
          return json({ ok: false, error: "Falta configurar PUSH_SERVICE_TOKEN en Cloudflare." }, 500, corsHeaders);
        }
        const weekLabel = String(body.weekLabel || body.weekId || "esta semana");
        const launchUrl = makeAppDeepLink({ open: "courts", week: String(body.weekId || "") });
        if (!env.PUSH_SERVICE) {
          return json({ ok: false, error: "Falta el Service Binding PUSH_SERVICE." }, 500, corsHeaders);
        }
        const pushResponse = await env.PUSH_SERVICE.fetch("https://push.internal/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.PUSH_SERVICE_TOKEN}`
          },
          body: JSON.stringify({
            title: "\u{1F3BE} CT Campeador \xB7 Pistas disponibles",
            body: `Ya puedes reservar pista para ${weekLabel}.`,
            url: launchUrl,
            tag: `ct-campeador-${String(body.weekId || "semana")}`
          })
        });
        const pushText = await pushResponse.text();
        let pushJson = {};
        try {
          pushJson = JSON.parse(pushText);
        } catch (_) {
        }
        if (!pushResponse.ok) {
          return json({ ok: false, error: pushJson.error || pushText || `Push HTTP ${pushResponse.status}` }, 502, corsHeaders);
        }
        return json({
          ok: true,
          sent: Number(pushJson.sent || 0),
          removed: Number(pushJson.removed || 0),
          failed: Array.isArray(pushJson.failed) ? pushJson.failed : [],
          delivered: Array.isArray(pushJson.delivered) ? pushJson.delivered : [],
          partial: pushJson.ok === false
        }, 200, corsHeaders);
      }
      if (action === "saveState") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const state = body.state;
        if (!state || typeof state !== "object") return json({ ok: false, error: "Falta el estado de la liga" }, 400, corsHeaders);
        const stateSize = new TextEncoder().encode(JSON.stringify(state)).byteLength;
        if (stateSize > 2e6) return json({ ok: false, error: "El estado enviado es demasiado grande." }, 413, corsHeaders);
        const reservations = await listReservations(env);
        const currentState = await getState(env);
        const safeState = {
          ...state,
          results: currentState.results || {},
          bookings: reservations,
          reservations,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          updatedBy: admin.session.name
        };
        await env.DATA.put(STATE_KEY, JSON.stringify(safeState));
        await broadcastRealtime(env, { type: "stateChanged", updatedAt: safeState.updatedAt });
        return json({ ok: true, state: safeState }, 200, corsHeaders);
      }
      if (action === "reserve") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const matchId = String(body.matchId || "").trim();
        const slotId = String(body.slotId || "").trim();
        if (!matchId || !slotId) return json({ ok: false, error: "Faltan datos de la reserva" }, 400, corsHeaders);
        const state = await getState(env);
        const found = findFixture(state, matchId);
        if (!found) return json({ ok: false, error: "El enfrentamiento no existe o ya no est\xE1 publicado." }, 404, corsHeaders);
        const { fixture, week, category, gender } = found;
        if (auth.session.role !== "admin" && normalize(fixture.a) !== normalize(auth.session.name) && normalize(fixture.b) !== normalize(auth.session.name)) {
          return json({ ok: false, error: "Solo uno de los jugadores del partido puede reservar." }, 403, corsHeaders);
        }
        if (!state.published?.[week]) {
          return json({ ok: false, error: "Las reservas de esta semana todav\xEDa no est\xE1n abiertas." }, 409, corsHeaders);
        }
        const slot = (state.slots?.[week] || []).find((s) => String(s.id) === slotId);
        if (!slot) return json({ ok: false, error: "Ese tramo ya no est\xE1 disponible." }, 409, corsHeaders);
        const reservation = {
          week,
          slotId,
          a: fixture.a,
          b: fixture.b,
          day: slot.day,
          date: slot.date,
          time: slot.time,
          court: slot.court,
          category,
          gender,
          reservedBy: auth.session.name,
          reservedAt: (/* @__PURE__ */ new Date()).toISOString(),
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        const result = await bookingCall(env, { action: "reserve", matchId, slotId, reservation });
        if (!result.ok) return json(result, result.error?.includes("acaba de ser reservada") ? 409 : 500, corsHeaders);
        await broadcastRealtime(env, { type: "reservationChanged", matchId, reservation: result.reservation });
        return json({ ok: true, reservation: result.reservation }, 200, corsHeaders);
      }
      if (action === "cancelReservation") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const matchId = String(body.matchId || "").trim();
        if (!matchId) return json({ ok: false, error: "Falta el partido" }, 400, corsHeaders);
        const current = await bookingCall(env, { action: "get", matchId });
        const reservation = current.reservation;
        if (!reservation) return json({ ok: false, error: "La reserva ya no existe" }, 404, corsHeaders);
        if (auth.session.role !== "admin" && normalize(reservation.a) !== normalize(auth.session.name) && normalize(reservation.b) !== normalize(auth.session.name)) {
          return json({ ok: false, error: "No puedes cancelar esta reserva." }, 403, corsHeaders);
        }
        await bookingCall(env, { action: "cancel", matchId });
        await broadcastRealtime(env, { type: "reservationChanged", matchId, reservation: null });
        return json({ ok: true }, 200, corsHeaders);
      }
      if (action === "submitResult") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const matchId = String(body.matchId || "").trim();
        const incoming = body.result || {};
        if (!matchId) return json({ ok: false, error: "Falta el partido" }, 400, corsHeaders);
        const state = await getState(env);
        const found = findFixture(state, matchId);
        if (!found) return json({ ok: false, error: "El enfrentamiento no existe." }, 404, corsHeaders);
        const { fixture, week, category, gender } = found;
        const isAdmin = auth.session.role === "admin";
        const isPlayer = normalize(fixture.a) === normalize(auth.session.name) || normalize(fixture.b) === normalize(auth.session.name);
        if (!isAdmin && !isPlayer) return json({ ok: false, error: "Solo los jugadores del partido o un administrador pueden subir el resultado." }, 403, corsHeaders);
        state.results = state.results || {};
        const previous = state.results[matchId];
        if (previous?.status === "confirmed" && !isAdmin) {
          return json({ ok: false, error: "El resultado ya est\xE1 confirmado. Solo un administrador puede corregirlo." }, 409, corsHeaders);
        }
        const type = ["normal", "retirement", "wo", "not_played"].includes(incoming.type) ? incoming.type : "normal";
        const sets = sanitizeSets(incoming.sets || []);
        const winner = String(incoming.winner || "").trim();
        if (type === "normal") {
          const validation = validateCompletedTennisResult(sets);
          if (!validation.ok) return json({ ok: false, error: validation.error }, 400, corsHeaders);
        }
        if ((type === "wo" || type === "retirement") && winner !== fixture.a && winner !== fixture.b) {
          return json({ ok: false, error: "Selecciona el ganador del partido." }, 400, corsHeaders);
        }
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const editedPendingFromRival =
          previous?.status === "pending" &&
          !isAdmin &&
          normalize(previous.submittedBy) !== normalize(auth.session.name);

        const result = {
          type,
          sets,
          winner: type === "wo" || type === "retirement" ? winner : "",
          status: isAdmin ? "confirmed" : "pending",
          submittedBy: auth.session.name,
          submittedAt: now,
          revisedFrom: editedPendingFromRival ? previous.submittedBy : null,
          revisedAt: editedPendingFromRival ? now : null,
          confirmedBy: isAdmin ? auth.session.name : null,
          confirmedAt: isAdmin ? now : null,
          week,
          category,
          gender,
          a: fixture.a,
          b: fixture.b,
          updatedAt: now
        };
        state.results[matchId] = result;
        state.updatedAt = now;
        await env.DATA.put(STATE_KEY, JSON.stringify(state));

        if (result.status === "pending") {
          const rival = normalize(auth.session.name) === normalize(fixture.a) ? fixture.b : fixture.a;
          await broadcastRealtime(
            env,
            { type: "resultChanged", matchId, result },
            { recipients: [fixture.a, fixture.b], includeAdmins: true }
          );
          await sendTargetedPush(
            env,
            [rival],
            editedPendingFromRival ? "✏️ Resultado modificado por tu rival" : "🎾 Resultado pendiente de confirmar",
            editedPendingFromRival
              ? `${auth.session.name} ha modificado el resultado propuesto. Revísalo y confírmalo o vuelve a editarlo.`
              : `${auth.session.name} ha comunicado el resultado de vuestro partido. Revísalo y confírmalo.`,
            { open: "result", matchId, week, category, gender }
          );
        } else {
          await broadcastRealtime(env, { type: "resultChanged", matchId, result });
        }

        return json({ ok: true, result }, 200, corsHeaders);
      }
      if (action === "confirmResult") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const matchId = String(body.matchId || "").trim();
        const state = await getState(env);
        const found = findFixture(state, matchId);
        if (!found) return json({ ok: false, error: "El enfrentamiento no existe." }, 404, corsHeaders);
        state.results = state.results || {};
        const result = state.results[matchId];
        if (!result) return json({ ok: false, error: "No hay ning\xFAn resultado pendiente." }, 404, corsHeaders);
        if (result.status === "confirmed") return json({ ok: true, result }, 200, corsHeaders);
        const { fixture } = found;
        const isAdmin = auth.session.role === "admin";
        const isPlayer = normalize(fixture.a) === normalize(auth.session.name) || normalize(fixture.b) === normalize(auth.session.name);
        if (!isAdmin && !isPlayer) return json({ ok: false, error: "No puedes confirmar este resultado." }, 403, corsHeaders);
        if (!isAdmin && normalize(result.submittedBy) === normalize(auth.session.name)) {
          return json({ ok: false, error: "El resultado debe confirmarlo el rival." }, 403, corsHeaders);
        }
        const now = (/* @__PURE__ */ new Date()).toISOString();
        result.status = "confirmed";
        result.confirmedBy = auth.session.name;
        result.confirmedAt = now;
        result.updatedAt = now;
        state.updatedAt = now;
        await env.DATA.put(STATE_KEY, JSON.stringify(state));
        await broadcastRealtime(env, { type: "resultChanged", matchId, result });
        if (result.submittedBy && normalize(result.submittedBy) !== normalize(auth.session.name)) {
          await sendTargetedPush(
            env,
            [result.submittedBy],
            "✅ Resultado confirmado",
            `${auth.session.name} ha confirmado el resultado de vuestro partido.`,
            { open: "result", matchId, week: result.week, category: result.category, gender: result.gender }
          );
        }
        return json({ ok: true, result }, 200, corsHeaders);
      }
      if (action === "deleteResult") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const matchId = String(body.matchId || "").trim();
        const state = await getState(env);
        state.results = state.results || {};
        const previousResult = state.results[matchId] || null;
        delete state.results[matchId];
        state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        await env.DATA.put(STATE_KEY, JSON.stringify(state));
        if (previousResult?.status === "pending") {
          await broadcastRealtime(
            env,
            { type: "resultChanged", matchId, result: null },
            { recipients: [previousResult.a, previousResult.b], includeAdmins: true }
          );
        } else {
          await broadcastRealtime(env, { type: "resultChanged", matchId, result: null });
        }
        return json({ ok: true }, 200, corsHeaders);
      }
      if (action === "regeneratePin") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const name = String(body.name || "").trim();
        if (!name) return json({ ok: false, error: "Falta el usuario." }, 400, corsHeaders);
        const users = await getUsers(env);
        const idx = users.findIndex((u) => normalize(u.name) === normalize(name) && u.active !== false);
        if (idx < 0) return json({ ok: false, error: "Usuario no encontrado." }, 404, corsHeaders);
        const used = new Set(users.map((u) => String(u.pin)));
        let pin = "";
        do {
          const bytes = new Uint32Array(1);
          crypto.getRandomValues(bytes);
          pin = String(1e5 + bytes[0] % 9e5);
        } while (used.has(pin));
        users[idx] = { ...users[idx], pin };
        await env.DATA.put(USERS_KEY, JSON.stringify(users));
        await revokeUserSessions(env, users[idx].name);
        return json({ ok: true, name: users[idx].name, pin }, 200, corsHeaders);
      }
      if (action === "listMessages") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const messages = await getMessages(env);
        const visible = messages
          .filter((m) => messageVisibleToUser(m, auth.session))
          .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
          .map((m) => messageForSession(m, auth.session));
        return json({ ok: true, messages: visible }, 200, corsHeaders);
      }

      if (action === "markMessagesRead") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const ids = new Set(
          (Array.isArray(body.ids) ? body.ids : [])
            .map((x) => String(x || "").trim())
            .filter(Boolean)
            .slice(0, 200)
        );
        if (!ids.size) return json({ ok: true, updated: 0 }, 200, corsHeaders);

        const messages = await getMessages(env);
        const me = auth.session.name;
        let updated = 0;

        for (const m of messages) {
          if (!ids.has(String(m.id || ""))) continue;
          if (!messageVisibleToUser(m, auth.session)) continue;
          const readBy = Array.isArray(m.readBy) ? m.readBy : [];
          if (!readBy.some((name) => normalize(name) === normalize(me))) {
            readBy.push(me);
            m.readBy = readBy;
            updated++;
          }
        }
        if (updated) {
          await putMessages(env, messages);
          await broadcastRealtime(
            env,
            { type: "messageChanged", reason: "read" },
            { recipients: [auth.session.name], includeAdmins: false }
          );
        }
        return json({ ok: true, updated }, 200, corsHeaders);
      }

      if (action === "deleteMessage") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const id = String(body.id || "").trim();
        if (!id) return json({ ok: false, error: "Falta el ID del mensaje." }, 400, corsHeaders);
        const messages = await getMessages(env);
        const removedMessage = messages.find((m) => String(m.id || "") === id) || null;
        const next = messages.filter((m) => String(m.id || "") !== id);
        if (next.length === messages.length) {
          return json({ ok: false, error: "El mensaje ya no existe." }, 404, corsHeaders);
        }
        await putMessages(env, next);
        await broadcastRealtime(
          env,
          { type: "messageChanged", reason: "deleted", messageId: id },
          {
            recipients: Array.isArray(removedMessage?.recipientNames) ? removedMessage.recipientNames : [],
            includeAdmins: true
          }
        );
        return json({ ok: true }, 200, corsHeaders);
      }

      if (action === "deleteAllMessages") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        await putMessages(env, []);
        await broadcastRealtime(env, { type: "messageChanged", reason: "deletedAll" });
        return json({ ok: true }, 200, corsHeaders);
      }

      if (action === "sendCustomPush") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        if (!env.PUSH_SERVICE || !env.PUSH_SERVICE_TOKEN) {
          return json({ ok: false, error: "El servicio Push no está configurado." }, 500, corsHeaders);
        }

        const title = String(body.title || "").trim().slice(0, 80);
        const message = String(body.message || "").trim().slice(0, 220);
        const launchUrl = makeAppDeepLink({ open: "messages" });
        const recipients = Array.isArray(body.recipients)
          ? [...new Set(body.recipients.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 250)
          : [];

        if (!title) return json({ ok: false, error: "Falta el título del mensaje." }, 400, corsHeaders);
        if (!message) return json({ ok: false, error: "Falta el mensaje." }, 400, corsHeaders);
        if (!recipients.length) return json({ ok: false, error: "No hay destinatarios." }, 400, corsHeaders);

        // Solo permitimos enviar a usuarios activos conocidos por la API.
        const users = await getUsers(env);
        const allowed = new Map(users.filter((u) => u.active !== false).map((u) => [normalize(u.name), u.name]));
        const safeRecipients = recipients
          .map((name) => allowed.get(normalize(name)))
          .filter(Boolean);

        if (!safeRecipients.length) {
          return json({ ok: false, error: "Ningún destinatario válido." }, 400, corsHeaders);
        }

        const r = await env.PUSH_SERVICE.fetch("https://push.internal/admin/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.PUSH_SERVICE_TOKEN}`
          },
          body: JSON.stringify({
            recipients: safeRecipients,
            title,
            body: message,
            url: launchUrl,
            tag: `ctc-admin-${Date.now()}`
          })
        });

        const txt = await r.text();
        let j = {};
        try { j = JSON.parse(txt); } catch (_) {}

        if (!r.ok || j.ok === false) {
          return json({ ok: false, error: j.error || txt || `Push HTTP ${r.status}` }, 502, corsHeaders);
        }

        const messages = await getMessages(env);
        const storedMessage = {
          id: `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          at: new Date().toISOString(),
          title,
          body: message,
          recipientNames: safeRecipients,
          sentBy: admin.session.name,
          sent: Number(j.sent || 0),
          readBy: []
        };
        messages.unshift(storedMessage);
        await putMessages(env, messages);

        // Actualización inmediata de buzón/badge en dispositivos con la app abierta.
        // El Push sigue siendo el aviso de fondo cuando la app no está activa.
        await broadcastRealtime(
          env,
          { type: "messageChanged", reason: "created", messageId: storedMessage.id },
          { recipients: safeRecipients, includeAdmins: true }
        );

        return json({
          ok: true,
          recipients: safeRecipients.length,
          matchedUsers: Number(j.matchedUsers || 0),
          totalDevices: Number(j.total || 0),
          sent: Number(j.sent || 0),
          removed: Number(j.removed || 0),
          failed: Array.isArray(j.failed) ? j.failed : [],
          message: messageForSession(storedMessage, admin.session)
        }, 200, corsHeaders);
      }

      if (action === "listPushDevices") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        if (!env.PUSH_SERVICE || !env.PUSH_SERVICE_TOKEN) {
          return json({ ok: false, error: "El servicio Push no est\xE1 configurado." }, 500, corsHeaders);
        }
        const r = await env.PUSH_SERVICE.fetch("https://push.internal/admin/devices", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.PUSH_SERVICE_TOKEN}`
          },
          body: "{}"
        });
        const txt = await r.text();
        let j = {};
        try {
          j = JSON.parse(txt);
        } catch (_) {
        }
        if (!r.ok || j.ok === false) {
          return json({ ok: false, error: j.error || txt || `Push HTTP ${r.status}` }, 502, corsHeaders);
        }
        return json(j, 200, corsHeaders);
      }
      if (action === "removePushDevices") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        if (!env.PUSH_SERVICE || !env.PUSH_SERVICE_TOKEN) {
          return json({ ok: false, error: "El servicio Push no est\xE1 configurado." }, 500, corsHeaders);
        }
        const userName = String(body.userName || "").trim();
        if (!userName) return json({ ok: false, error: "Falta el jugador." }, 400, corsHeaders);
        const r = await env.PUSH_SERVICE.fetch("https://push.internal/admin/remove-user", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.PUSH_SERVICE_TOKEN}`
          },
          body: JSON.stringify({ userName })
        });
        const txt = await r.text();
        let j = {};
        try {
          j = JSON.parse(txt);
        } catch (_) {
        }
        if (!r.ok || j.ok === false) {
          return json({ ok: false, error: j.error || txt || `Push HTTP ${r.status}` }, 502, corsHeaders);
        }
        return json(j, 200, corsHeaders);
      }
      if (action === "listUsers") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        return json({ ok: true, users: await getUsers(env) }, 200, corsHeaders);
      }
      if (action === "updateUserRole") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);

        const name = String(body.name || "").trim();
        const role = body.role === "admin" ? "admin" : body.role === "member" ? "member" : "player";
        if (!name) return json({ ok: false, error: "Falta el usuario." }, 400, corsHeaders);

        const users = await getUsers(env);
        const idx = users.findIndex((u) => normalize(u.name) === normalize(name) && u.active !== false);
        if (idx < 0) return json({ ok: false, error: "Usuario no encontrado." }, 404, corsHeaders);

        // Si se degrada un administrador, debe quedar al menos otro ADMIN.
        if (users[idx].role === "admin" && role !== "admin") {
          const activeAdmins = users.filter((u) => u.active !== false && u.role === "admin");
          if (activeAdmins.length <= 1) {
            return json({ ok: false, error: "Debe quedar al menos un administrador." }, 400, corsHeaders);
          }
        }

        const oldRole = users[idx].role;
        // MUY IMPORTANTE: conservamos literalmente el PIN existente.
        users[idx] = { ...users[idx], role };
        await env.DATA.put(USERS_KEY, JSON.stringify(users));

        // Solo revocamos las sesiones porque sus permisos han cambiado.
        // El PIN NO se modifica.
        if (oldRole !== role) await revokeUserSessions(env, users[idx].name);

        return json({
          ok: true,
          user: {
            name: users[idx].name,
            role: users[idx].role,
            pin: users[idx].pin,
            active: users[idx].active !== false
          }
        }, 200, corsHeaders);
      }

      if (action === "ensurePlayerUsers") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);

        const names = [...new Set(
          (Array.isArray(body.names) ? body.names : [])
            .map((x) => String(x || "").trim())
            .filter(Boolean)
            .slice(0, 300)
        )];

        const users = await getUsers(env);
        const byName = new Map(users.map((u, i) => [normalize(u.name), i]));
        const usedPins = new Set(users.map((u) => String(u.pin || "")).filter(Boolean));
        const ensured = [];
        let created = 0;

        for (const requestedName of names) {
          const key = normalize(requestedName);
          const existingIndex = byName.get(key);

          if (existingIndex !== undefined) {
            const existing = users[existingIndex];
            // MUY IMPORTANTE: usuario existente = mismo nombre canónico, mismo PIN, mismo rol.
            ensured.push({
              name: existing.name,
              pin: String(existing.pin || ""),
              role: existing.role || "player",
              active: existing.active !== false,
              created: false
            });
            continue;
          }

          let pin = "";
          do {
            const bytes = new Uint32Array(1);
            crypto.getRandomValues(bytes);
            pin = String(100000 + bytes[0] % 900000);
          } while (usedPins.has(pin));

          usedPins.add(pin);
          const user = {
            name: requestedName,
            pin,
            role: "player",
            active: true
          };
          users.push(user);
          byName.set(key, users.length - 1);
          ensured.push({ ...user, created: true });
          created++;
        }

        if (created) {
          await env.DATA.put(USERS_KEY, JSON.stringify(users));
        }

        return json({ ok: true, users: ensured, created }, 200, corsHeaders);
      }

      if (action === "saveUsers") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const previousUsers = await getUsers(env);
        const users = body.users;
        if (!Array.isArray(users)) return json({ ok: false, error: "Formato de usuarios incorrecto" }, 400, corsHeaders);
        const cleaned = users.map((u) => ({
          name: String(u.name || "").trim(),
          pin: String(u.pin || "").trim(),
          role: u.role === "admin" ? "admin" : u.role === "member" ? "member" : "player",
          active: u.active !== false
        })).filter((u) => u.name && /^(?:\d{4}|\d{6})$/.test(u.pin));
        if (!cleaned.some((u) => u.role === "admin")) {
          return json({ ok: false, error: "Debe existir al menos un administrador." }, 400, corsHeaders);
        }
        const pinOwners = /* @__PURE__ */ new Map();
        for (const u of cleaned) {
          if (pinOwners.has(u.pin)) {
            return json({
              ok: false,
              error: `PIN duplicado: ${u.pin} pertenece a ${pinOwners.get(u.pin)} y ${u.name}. Cada usuario debe tener un PIN \xFAnico.`
            }, 409, corsHeaders);
          }
          pinOwners.set(u.pin, u.name);
        }
        await env.DATA.put(USERS_KEY, JSON.stringify(cleaned));
        const prev = new Map(previousUsers.map((u) => [normalize(u.name), u]));
        const next = new Map(cleaned.map((u) => [normalize(u.name), u]));
        const toRevoke = /* @__PURE__ */ new Set();
        for (const [k, oldUser] of prev) {
          const newUser = next.get(k);
          if (!newUser || String(oldUser.pin) !== String(newUser.pin) || oldUser.role !== newUser.role || oldUser.active !== newUser.active) toRevoke.add(oldUser.name);
        }
        for (const name of toRevoke) await revokeUserSessions(env, name);
        return json({ ok: true, users: cleaned }, 200, corsHeaders);
      }
      if (action === "deleteUser") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const name = String(body.name || "").trim();
        if (!name) return json({ ok: false, error: "Falta el usuario" }, 400, corsHeaders);
        const users = await getUsers(env);
        const target = users.find((u) => normalize(u.name) === normalize(name));
        if (!target) return json({ ok: true, removed: false }, 200, corsHeaders);
        if (target.role === "admin") {
          const admins = users.filter((u) => u.active !== false && u.role === "admin");
          if (admins.length <= 1) {
            return json({ ok: false, error: "Debe quedar al menos un administrador." }, 400, corsHeaders);
          }
          if (normalize(admin.session.name) === normalize(target.name)) {
            return json({ ok: false, error: "No puedes eliminar el administrador con el que tienes iniciada la sesi\xF3n." }, 400, corsHeaders);
          }
        }
        const cleaned = users.filter((u) => normalize(u.name) !== normalize(name));
        await env.DATA.put(USERS_KEY, JSON.stringify(cleaned));
        let cursor;
        do {
          const page = await env.DATA.list({ prefix: "session:", cursor });
          for (const key of page.keys) {
            const raw = await env.DATA.get(key.name);
            if (!raw) continue;
            try {
              const session = JSON.parse(raw);
              if (normalize(session.name) === normalize(name)) {
                await env.DATA.delete(key.name);
              }
            } catch {
            }
          }
          if (page.list_complete) break;
          cursor = page.cursor;
        } while (cursor);
        return json({ ok: true, removed: true, name: target.name }, 200, corsHeaders);
      }
      if (action === "resetState") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const reservations = await listReservations(env);
        const blankState = {
          version: 2,
          playerLists: {},
          fixtures: {},
          slots: {},
          drafts: {},
          published: {},
          results: {},
          bookings: reservations,
          reservations,
          staff: {},
          adminRoles: {},
          weeks: {},
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          updatedBy: admin.session.name
        };
        await env.DATA.put(STATE_KEY, JSON.stringify(blankState));
        return json({ ok: true, state: blankState }, 200, corsHeaders);
      }
      return json({ ok: false, error: `Acci\xF3n desconocida: ${action}` }, 400, corsHeaders);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: error?.message || String(error) }, 500, corsHeaders);
    }
  }
};
async function bookingCall(env, payload) {
  const stub = env.BOOKINGS.getByName("ct-campeador-reservas-global");
  const r = await stub.fetch("https://bookings.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await r.json();
}
__name(bookingCall, "bookingCall");
async function broadcastRealtime(env, event, options = {}) {
  try {
    await bookingCall(env, {
      action: "broadcast",
      event,
      recipients: Array.isArray(options.recipients) ? options.recipients : null,
      includeAdmins: options.includeAdmins === true
    });
  } catch (_) {}
}
__name(broadcastRealtime, "broadcastRealtime");

const APP_BASE_URL = "https://ligasdetenis.github.io/ct-campeador-liga/";
function makeAppDeepLink(params = {}) {
  const u = new URL(APP_BASE_URL);
  for (const [key, value] of Object.entries(params || {})) {
    const v = String(value ?? "").trim();
    if (v) u.searchParams.set(key, v.slice(0, 240));
  }
  return u.toString();
}
__name(makeAppDeepLink, "makeAppDeepLink");

async function sendTargetedPush(env, recipients, title, body, deepLink = {}) {
  if (!env.PUSH_SERVICE || !env.PUSH_SERVICE_TOKEN) return;
  const safeRecipients = [...new Set((recipients || []).map((x) => String(x || "").trim()).filter(Boolean))];
  if (!safeRecipients.length) return;
  try {
    await env.PUSH_SERVICE.fetch("https://push.internal/admin/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.PUSH_SERVICE_TOKEN}`
      },
      body: JSON.stringify({
        recipients: safeRecipients,
        title: String(title || "CT Campeador").slice(0, 80),
        body: String(body || "").slice(0, 220),
        url: makeAppDeepLink(deepLink),
        tag: `ctc-${String(deepLink?.open || "notice").slice(0,30)}-${Date.now()}`
      })
    });
  } catch (_) {}
}
__name(sendTargetedPush, "sendTargetedPush");

function standardSetIsValid(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) return false;
  const w = Math.max(a, b), l = Math.min(a, b);
  return (w === 6 && l <= 4) || (w === 7 && (l === 5 || l === 6));
}
__name(standardSetIsValid, "standardSetIsValid");

function superTiebreakIsValid(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) return false;
  return Math.max(a, b) >= 10 && Math.abs(a - b) >= 2;
}
__name(superTiebreakIsValid, "superTiebreakIsValid");

function validateCompletedTennisResult(sets) {
  if (!Array.isArray(sets) || (sets.length !== 2 && sets.length !== 3)) {
    return { ok: false, error: "Un partido completado debe tener 2 sets o 2 sets más super tie-break." };
  }
  if (!standardSetIsValid(sets[0].a, sets[0].b)) {
    return { ok: false, error: "El primer set no tiene un tanteo válido de tenis." };
  }
  if (!standardSetIsValid(sets[1].a, sets[1].b)) {
    return { ok: false, error: "El segundo set no tiene un tanteo válido de tenis." };
  }

  const w1 = sets[0].a > sets[0].b ? "a" : "b";
  const w2 = sets[1].a > sets[1].b ? "a" : "b";

  if (w1 === w2) {
    if (sets.length !== 2) {
      return { ok: false, error: "Si un jugador gana los dos primeros sets no puede haber tercer set." };
    }
    return { ok: true };
  }

  if (sets.length !== 3) {
    return { ok: false, error: "Con un set para cada jugador es obligatorio disputar el super tie-break." };
  }
  if (!superTiebreakIsValid(sets[2].a, sets[2].b)) {
    return { ok: false, error: "El tercer set es un super tie-break: mínimo 10 puntos y diferencia de 2." };
  }
  return { ok: true };
}
__name(validateCompletedTennisResult, "validateCompletedTennisResult");

async function listReservations(env) {
  const r = await bookingCall(env, { action: "list" });
  if (!r.ok) throw new Error(r.error || "No se pudieron leer las reservas");
  return r.reservations || {};
}
__name(listReservations, "listReservations");
function findFixture(state, matchId) {
  for (const [key, arr] of Object.entries(state.fixtures || {})) {
    const fixture = (arr || []).find((m) => String(m.id) === matchId);
    if (!fixture) continue;
    const [week, category, gender] = key.split("|");
    return { fixture, week, category, gender };
  }
  return null;
}
__name(findFixture, "findFixture");
function sanitizeSets(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const set of input.slice(0, 3)) {
    if (!set || set.a === "" || set.b === "" || set.a === null || set.b === null || set.a === void 0 || set.b === void 0) continue;
    const a = Number(set.a), b = Number(set.b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 99 || b > 99 || a === b) continue;
    out.push({ a, b });
  }
  return out;
}
__name(sanitizeSets, "sanitizeSets");
function doJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" }
  });
}
__name(doJson, "doJson");
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
__name(json, "json");
function normalize(text) {
  return String(text || "").trim().toLocaleLowerCase("es");
}
__name(normalize, "normalize");
async function getState(env) {
  const raw = await env.DATA.get(STATE_KEY);
  if (!raw) return { version: 2, playerLists: {}, fixtures: {}, slots: {}, drafts: {}, published: {}, results: {}, bookings: {}, reservations: {}, staff: {}, adminRoles: {}, weeks: {} };
  try {
    return JSON.parse(raw);
  } catch {
    return { version: 2, playerLists: {}, fixtures: {}, slots: {}, drafts: {}, published: {}, results: {}, bookings: {}, reservations: {}, staff: {}, adminRoles: {}, weeks: {} };
  }
}
__name(getState, "getState");

async function getAdminPrefs(env) {
  const raw = await env.DATA.get(ADMIN_PREFS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}
async function putAdminPrefs(env, prefs) {
  await env.DATA.put(ADMIN_PREFS_KEY, JSON.stringify(prefs || {}));
}
function cleanAdminOrder(value) {
  const allowed = new Set([
    "tournamentIdentity",
    "messages",
    "matchesAdmin",
    "journey",
    "courts",
    "players",
    "accessDevices",
    "whats"
  ]);
  const out = [];
  for (const id of Array.isArray(value) ? value : []) {
    const key = String(id || "").trim();

    // Compatibilidad con preferencias guardadas antes de separar Jornada y Pistas.
    if (key === "journeyCourts") {
      if (!out.includes("journey")) out.push("journey");
      if (!out.includes("courts")) out.push("courts");
      continue;
    }

    if (allowed.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}
async function getProfiles(env) {
  const raw = await env.DATA.get(PROFILES_KEY);
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
__name(getProfiles, "getProfiles");

async function getMessages(env) {
  const raw = await env.DATA.get(MESSAGES_KEY);
  if (raw) {
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  // Migración automática de los mensajes de la versión anterior
  // si todavía estaban guardados dentro del estado general.
  try {
    const state = await getState(env);
    const legacy = Array.isArray(state.messageHistory) ? state.messageHistory : [];
    const migrated = legacy
      .filter((m) => Array.isArray(m.recipientNames) && m.recipientNames.length)
      .map((m) => ({
        id: String(m.id || `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`),
        at: String(m.at || new Date().toISOString()),
        title: String(m.title || "Aviso").slice(0, 80),
        body: String(m.body || "").slice(0, 220),
        recipientNames: [...new Set(m.recipientNames.map((x) => String(x || "").trim()).filter(Boolean))],
        sentBy: String(m.sentBy || m.updatedBy || "Administrador"),
        sent: Number(m.sent || 0),
        readBy: Array.isArray(m.readBy) ? m.readBy : []
      }));
    if (migrated.length) {
      await env.DATA.put(MESSAGES_KEY, JSON.stringify(migrated.slice(0, 500)));
      return migrated.slice(0, 500);
    }
  } catch (_) {}
  return [];
}
__name(getMessages, "getMessages");

async function putMessages(env, messages) {
  const clean = Array.isArray(messages) ? messages.slice(0, 500) : [];
  await env.DATA.put(MESSAGES_KEY, JSON.stringify(clean));
}
__name(putMessages, "putMessages");

function messageVisibleToUser(message, session) {
  if (session.role === "admin") return true;
  const me = normalize(session.name);
  return Array.isArray(message?.recipientNames) &&
    message.recipientNames.some((name) => normalize(name) === me);
}
__name(messageVisibleToUser, "messageVisibleToUser");

function messageForSession(message, session) {
  const me = normalize(session.name);
  const readBy = Array.isArray(message?.readBy) ? message.readBy : [];
  return {
    id: String(message?.id || ""),
    at: String(message?.at || ""),
    title: String(message?.title || ""),
    body: String(message?.body || ""),
    recipientNames: session.role === "admin" ? (message?.recipientNames || []) : undefined,
    recipients: Array.isArray(message?.recipientNames) ? message.recipientNames.length : 0,
    sentBy: String(message?.sentBy || "Administrador"),
    sent: Number(message?.sent || 0),
    read: readBy.some((name) => normalize(name) === me)
  };
}
__name(messageForSession, "messageForSession");

async function getUsers(env) {
  const raw = await env.DATA.get(USERS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
__name(getUsers, "getUsers");
function getToken(request, body) {
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.startsWith("Bearer ")) return authorization.substring(7).trim();
  if (body && body.token) return String(body.token);
  return "";
}
__name(getToken, "getToken");
async function getSession(request, body, env) {
  const token = getToken(request, body);
  if (!token) return null;
  const raw = await env.DATA.get(`session:${token}`);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    if (session.securityVersion !== SESSION_SECURITY_VERSION) return null;
    return session;
  } catch {
    return null;
  }
}
__name(getSession, "getSession");
async function createSession(env, user) {
  const token = crypto.randomUUID();
  const session = { name: user.name, role: user.role || "player", createdAt: (/* @__PURE__ */ new Date()).toISOString(), securityVersion: SESSION_SECURITY_VERSION };
  await env.DATA.put(`session:${token}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
  const key = `sessionsByUser:${encodeURIComponent(normalize(user.name))}`;
  let tokens = [];
  try {
    tokens = JSON.parse(await env.DATA.get(key) || "[]");
  } catch {
  }
  tokens = [.../* @__PURE__ */ new Set([...Array.isArray(tokens) ? tokens : [], token])].slice(-20);
  await env.DATA.put(key, JSON.stringify(tokens), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}
__name(createSession, "createSession");
async function deleteSession(env, token) {
  const raw = await env.DATA.get(`session:${token}`);
  let session = null;
  try {
    session = raw ? JSON.parse(raw) : null;
  } catch {
  }
  await env.DATA.delete(`session:${token}`);
  if (session?.name) {
    const key = `sessionsByUser:${encodeURIComponent(normalize(session.name))}`;
    let tokens = [];
    try {
      tokens = JSON.parse(await env.DATA.get(key) || "[]");
    } catch {
    }
    tokens = (Array.isArray(tokens) ? tokens : []).filter((t) => t !== token);
    if (tokens.length) await env.DATA.put(key, JSON.stringify(tokens), { expirationTtl: SESSION_TTL_SECONDS });
    else await env.DATA.delete(key);
  }
}
__name(deleteSession, "deleteSession");
async function revokeUserSessions(env, name) {
  const key = `sessionsByUser:${encodeURIComponent(normalize(name))}`;
  let tokens = [];
  try {
    tokens = JSON.parse(await env.DATA.get(key) || "[]");
  } catch {
  }
  for (const token of (Array.isArray(tokens) ? tokens : []).slice(0, 50)) await env.DATA.delete(`session:${token}`);
  await env.DATA.delete(key);
}
__name(revokeUserSessions, "revokeUserSessions");
async function checkLoginGates(env, keys) {
  for (const key of keys) {
    const gate = await bookingCall(env, { action: "loginGate", key });
    if (!gate.allowed) return gate;
  }
  return { ok: true, allowed: true };
}
__name(checkLoginGates, "checkLoginGates");

async function registerLoginFailure(env, globalKey, specificKey) {
  await bookingCall(env, { action: "loginFailure", key: globalKey, maxFailures: LOGIN_MAX_FAILURES });
  await bookingCall(env, { action: "loginFailure", key: specificKey, maxFailures: LOGIN_USER_MAX_FAILURES });
}
__name(registerLoginFailure, "registerLoginFailure");

async function clearLoginGates(env, keys) {
  for (const key of keys) await bookingCall(env, { action: "loginSuccess", key });
}
__name(clearLoginGates, "clearLoginGates");

function loginAttemptKey(request, discriminator) {
  return `${loginGuardKey(request)}|attempt:${normalize(discriminator).slice(0, 80)}`;
}
__name(loginAttemptKey, "loginAttemptKey");

function loginGuardKey(request) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  return `login:${String(ip).split(",")[0].trim()}`;
}
__name(loginGuardKey, "loginGuardKey");
function corsHeadersFor(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };
  if (origin && (ALLOWED_ORIGINS.has(origin) || origin === "null")) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}
__name(corsHeadersFor, "corsHeadersFor");
function isAllowedOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === "null" || ALLOWED_ORIGINS.has(origin);
}
__name(isAllowedOrigin, "isAllowedOrigin");
function stateForSession(state, reservations, profiles, session) {
  const base = { ...state, bookings: reservations, reservations, profiles };
  if (session.role === "admin") return base;
  const publishedSlots = {};
  for (const [week, slots] of Object.entries(state.slots || {})) if (state.published?.[week]) publishedSlots[week] = slots;
  const visibleResults = {};
  for (const [matchId, result] of Object.entries(state.results || {})) {
    const involved = normalize(result?.a) === normalize(session.name) || normalize(result?.b) === normalize(session.name) || normalize(result?.submittedBy) === normalize(session.name);
    if (result?.status === "confirmed" || involved) visibleResults[matchId] = result;
  }
  return {
    version: state.version || 2,
    playerLists: state.playerLists || {},
    fixtures: state.fixtures || {},
    fixtureRounds: state.fixtureRounds || {},
    slots: publishedSlots,
    drafts: {},
    published: state.published || {},
    results: visibleResults,
    bookings: reservations,
    reservations,
    profiles,
    weekRanges: state.weekRanges || {},
    postponed: state.postponed || {},
    weeks: state.weeks || {},
    staff: {},
    adminRoles: {},
    roles: {},
    updatedAt: state.updatedAt || null
  };
}
__name(stateForSession, "stateForSession");
async function requireUser(request, body, env) {
  const session = await getSession(request, body, env);
  if (!session) return { ok: false, status: 401, error: "Debes iniciar sesi\xF3n." };
  return { ok: true, session };
}
__name(requireUser, "requireUser");
async function requireAdmin(request, body, env) {
  const session = await getSession(request, body, env);
  if (!session) return { ok: false, status: 401, error: "Debes iniciar sesi\xF3n." };
  if (session.role !== "admin") return { ok: false, status: 403, error: "Solo un administrador puede realizar esta acci\xF3n." };
  return { ok: true, session };
}
__name(requireAdmin, "requireAdmin");
export {
  BookingCoordinator,
  index_default as default
};
//# sourceMappingURL=index.js.map
