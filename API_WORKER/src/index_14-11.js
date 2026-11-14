var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
import { DurableObject } from "cloudflare:workers";
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
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
  static {
    __name2(this, "BookingCoordinator");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS league_snapshot (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS court_booking_history (
      booking_id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      payment_a TEXT NOT NULL DEFAULT 'pending',
      payment_b TEXT NOT NULL DEFAULT 'pending',
      payment_a_at TEXT,
      payment_b_at TEXT,
      payment_a_by TEXT,
      payment_b_by TEXT,
      updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_court_history_match ON court_booking_history(match_id)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS family_accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, salt TEXT NOT NULL,
      pin_hash TEXT NOT NULL, created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS family_links (
      family_id TEXT NOT NULL, player_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
      PRIMARY KEY(family_id, player_name)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_family_links_player ON family_links(player_name, status)`);
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_family_name_casefold ON family_accounts(lower(name))`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        match_id TEXT PRIMARY KEY,
        slot_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS match_proposals (
      match_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
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
    if (action === "leagueRead" || action === "leagueWrite" || action === "leagueExpire") {
      try {
        const result = await this.ctx.blockConcurrencyWhile(async () => {
          let row = this.sql.exec("SELECT payload FROM league_snapshot WHERE id=1").toArray()[0];
          if (!row) {
            const legacy = await this.env.DATA.get(STATE_KEY);
            const initial = legacy ? JSON.parse(legacy) : { version: 2, playerLists: {}, fixtures: {}, slots: {}, drafts: {}, published: {}, results: {}, bookings: {}, reservations: {}, staff: {}, adminRoles: {}, weeks: {} };
            this.sql.exec("INSERT INTO league_snapshot (id,payload) VALUES (1,?)", JSON.stringify(initial));
            row = { payload: JSON.stringify(initial) };
          }
          const state = JSON.parse(row.payload);
          if (action === "leagueRead") return { ok: true, state };
          if (action === "leagueWrite") {
            const mode = String(body.mode || "");
            if (mode === "general") {
              if (!body.state || typeof body.state !== "object") return { ok: false, status: 400, error: "Estado ausente" };
              const expectedUpdatedAt = String(body.expectedUpdatedAt || "");
              if (expectedUpdatedAt && String(state.updatedAt || "") !== expectedUpdatedAt)
                return { ok: false, status: 409, error: "La liga ha cambiado mientras editabas. Actualiza la p\xE1gina y vuelve a intentarlo." };
              const next = { ...body.state, results: state.results || {} };
              this.sql.exec("UPDATE league_snapshot SET payload=? WHERE id=1", JSON.stringify(next));
              await this.env.DATA.put(STATE_KEY, JSON.stringify(next)).catch((e) => console.error("Espejo KV pendiente", e));
              return { ok: true, state: next };
            }
            if (mode === "reset") {
              if (!body.state || typeof body.state !== "object") return { ok: false, status: 400, error: "Estado ausente" };
              this.sql.exec("UPDATE league_snapshot SET payload=? WHERE id=1", JSON.stringify(body.state));
              await this.env.DATA.put(STATE_KEY, JSON.stringify(body.state)).catch((e) => console.error("Espejo KV pendiente", e));
              return { ok: true, state: body.state };
            }
            const matchId = String(body.matchId || "");
            const found = findFixture(state, matchId);
            if (!found) return { ok: false, status: 404, error: "Partido inexistente" };
            const { fixture, week, category, gender } = found;
            const who = String(body.who || "");
            const isAdmin = body.isAdmin === true;
            const isPlayer = normalize(fixture.a) === normalize(who) || normalize(fixture.b) === normalize(who);
            if (!isAdmin && !isPlayer) return { ok: false, status: 403, error: "No perteneces al partido" };
            state.results = state.results || {};
            const previous = state.results[matchId] || null;
            const now2 = (/* @__PURE__ */ new Date()).toISOString();
            if (mode === "submit") {
              if (previous?.status === "confirmed" && !isAdmin) return { ok: false, status: 409, error: "Resultado confirmado. Solo administraci\xF3n puede corregirlo." };
              const incoming = body.incoming || {};
              const type = ["normal", "retirement", "wo", "not_played"].includes(incoming.type) ? incoming.type : "normal";
              const sets = sanitizeSets(incoming.sets || []);
              const winner = String(incoming.winner || "").trim();
              if (type === "normal") {
                const v = validateCompletedTennisResult(sets);
                if (!v.ok) return { ok: false, status: 400, error: v.error };
              }
              if ((type === "wo" || type === "retirement") && winner !== fixture.a && winner !== fixture.b) return { ok: false, status: 400, error: "Selecciona ganador" };
              const revised = previous?.status === "pending" && !isAdmin && normalize(previous.submittedBy) !== normalize(who);
              state.results[matchId] = { type, sets, winner: type === "wo" || type === "retirement" ? winner : "", status: isAdmin ? "confirmed" : "pending", submittedBy: who, submittedAt: now2, revisedFrom: revised ? previous.submittedBy : null, revisedAt: revised ? now2 : null, confirmedBy: isAdmin ? who : null, confirmedAt: isAdmin ? now2 : null, week, category, gender, a: fixture.a, b: fixture.b, updatedAt: now2 };
              state.updatedAt = now2;
              this.sql.exec("UPDATE league_snapshot SET payload=? WHERE id=1", JSON.stringify(state));
              await this.env.DATA.put(STATE_KEY, JSON.stringify(state)).catch((e) => console.error("Espejo KV pendiente", e));
              return { ok: true, result: state.results[matchId], editedPendingFromRival: !!revised };
            }
            if (mode === "confirm") {
              if (!previous) return { ok: false, status: 404, error: "No hay resultado pendiente" };
              if (previous.status === "confirmed") return { ok: true, result: previous, alreadyConfirmed: true };
              if (!isAdmin && normalize(previous.submittedBy) === normalize(who)) return { ok: false, status: 403, error: "Debe confirmarlo el rival" };
              previous.status = "confirmed";
              previous.confirmedBy = who;
              previous.confirmedAt = now2;
              previous.updatedAt = now2;
              state.updatedAt = now2;
              this.sql.exec("UPDATE league_snapshot SET payload=? WHERE id=1", JSON.stringify(state));
              await this.env.DATA.put(STATE_KEY, JSON.stringify(state)).catch((e) => console.error("Espejo KV pendiente", e));
              return { ok: true, result: previous };
            }
            if (mode === "delete") {
              if (!isAdmin) return { ok: false, status: 403, error: "Solo administraci\xF3n" };
              delete state.results[matchId];
              state.updatedAt = now2;
              this.sql.exec("UPDATE league_snapshot SET payload=? WHERE id=1", JSON.stringify(state));
              await this.env.DATA.put(STATE_KEY, JSON.stringify(state)).catch((e) => console.error("Espejo KV pendiente", e));
              return { ok: true, previousResult: previous };
            }
            return { ok: false, status: 400, error: "Operaci\xF3n desconocida" };
          }
          if (body.enabled !== true) return { ok: true, enabled: false, confirmed: [] };
          const start = Date.parse(String(body.notBefore || ""));
          if (!Number.isFinite(start)) return { ok: false, status: 400, error: "Fecha de activaci\xF3n no v\xE1lida" };
          const now = Date.now(), stamp = new Date(now).toISOString(), confirmed = [];
          for (const [id, r] of Object.entries(state.results || {})) {
            const t = Date.parse(r?.submittedAt || "");
            if (r?.status !== "pending" || !findFixture(state, id) || !Number.isFinite(t) || t < start || t > now - 24 * 60 * 60 * 1e3) continue;
            r.status = "confirmed";
            r.confirmedBy = "Sistema (24 h sin respuesta)";
            r.confirmedAt = stamp;
            r.updatedAt = stamp;
            r.autoConfirmed = true;
            confirmed.push({ matchId: id, result: { ...r } });
          }
          if (confirmed.length) {
            state.updatedAt = stamp;
            this.sql.exec("UPDATE league_snapshot SET payload=? WHERE id=1", JSON.stringify(state));
            await this.env.DATA.put(STATE_KEY, JSON.stringify(state)).catch((e) => console.error("Espejo KV pendiente", e));
          }
          return { ok: true, enabled: true, confirmed };
        });
        return doJson(result, result.status || 200);
      } catch (error) {
        return doJson({ ok: false, error: error?.message || String(error) }, 500);
      }
    }
    if (action === "leagueStatus") {
      const row = this.sql.exec("SELECT payload FROM league_snapshot WHERE id=1").toArray()[0];
      if (!row) return doJson({ ok: true, initialized: false });
      const state = JSON.parse(row.payload);
      const results = Object.values(state.results || {});
      return doJson({
        ok: true,
        initialized: true,
        updatedAt: state.updatedAt || null,
        fixtureCount: Object.values(state.fixtures || {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0),
        resultCount: results.length,
        confirmed: results.filter((r) => r?.status === "confirmed").length,
        pending: results.filter((r) => r?.status === "pending").length
      });
    }
    if (action === "ping") {
      return doJson({ ok: true, durableObject: "online" });
    }
    if (action === "broadcast") {
      const event = body.event && typeof body.event === "object" ? body.event : null;
      if (!event) return doJson({ ok: false, error: "Falta evento" }, 400);
      const recipients = Array.isArray(body.recipients) ? new Set(body.recipients.map((x) => normalize(x)).filter(Boolean)) : null;
      const includeAdmins = body.includeAdmins === true;
      let sent = 0;
      for (const ws of this.ctx.getWebSockets()) {
        let attachment = {};
        try {
          attachment = ws.deserializeAttachment() || {};
        } catch (_) {
        }
        if (!attachment.authenticated) continue;
        const allowed = !recipients || recipients.has(normalize(attachment.name)) || includeAdmins && attachment.role === "admin";
        if (!allowed) continue;
        try {
          ws.send(JSON.stringify({ type: "event", event }));
          sent++;
        } catch (_) {
        }
      }
      return doJson({ ok: true, sent });
    }
    if (action === "familyCreate") {
      const id = String(body.id || ""), name = String(body.name || "").trim(), salt = String(body.salt || ""), hash = String(body.hash || "");
      if (!id || !name || !salt || !hash) return doJson({ ok: false, error: "Datos incompletos" });
      try {
        this.sql.exec("INSERT INTO family_accounts(id,name,salt,pin_hash,created_at) VALUES(?,?,?,?,?)", id, name, salt, hash, (/* @__PURE__ */ new Date()).toISOString());
      } catch (e) {
        return doJson({ ok: false, error: "Ya existe una cuenta familiar con ese nombre" });
      }
      return doJson({ ok: true, id, name });
    }
    if (action === "familyGetByName") {
      const rows = [...this.sql.exec("SELECT * FROM family_accounts WHERE name=? COLLATE NOCASE AND active=1 LIMIT 1", String(body.name || ""))];
      return doJson({ ok: true, account: rows[0] || null });
    }
    if (action === "familyGet") {
      const rows = [...this.sql.exec("SELECT id,name,active FROM family_accounts WHERE id=? LIMIT 1", String(body.id || ""))];
      return doJson({ ok: true, account: rows[0] || null });
    }
    if (action === "familyLinks") {
      const rows = [...this.sql.exec("SELECT player_name AS playerName,status,requested_at AS requestedAt,decided_at AS decidedAt FROM family_links WHERE family_id=? ORDER BY requested_at", String(body.id || ""))];
      return doJson({ ok: true, links: rows });
    }
    if (action === "familyLinkRequest") {
      const id = String(body.id || ""), player = String(body.player || "").trim();
      if (!id || !player) return doJson({ ok: false, error: "Datos incompletos" });
      const prior = [...this.sql.exec("SELECT status FROM family_links WHERE family_id=? AND player_name=?", id, player)];
      if (prior[0]?.status === "approved") return doJson({ ok: true, status: "approved" });
      this.sql.exec(`INSERT INTO family_links(family_id,player_name,status,requested_at,decided_at,decided_by)
        VALUES(?,?,'pending',?,NULL,NULL)
        ON CONFLICT(family_id,player_name) DO UPDATE SET status='pending',requested_at=excluded.requested_at,decided_at=NULL,decided_by=NULL`, id, player, (/* @__PURE__ */ new Date()).toISOString());
      return doJson({ ok: true, status: "pending" });
    }
    if (action === "familyAllowed") {
      const rows = [...this.sql.exec(`SELECT 1 AS yes FROM family_links l JOIN family_accounts a ON a.id=l.family_id
        WHERE l.family_id=? AND l.player_name=? COLLATE NOCASE AND l.status='approved' AND a.active=1 LIMIT 1`, String(body.id || ""), String(body.player || ""))];
      return doJson({ ok: true, allowed: !!rows.length });
    }
    if (action === "familyRequests") {
      const rows = [...this.sql.exec(`SELECT l.family_id AS familyId,a.name AS familyName,l.player_name AS playerName,
        l.status,l.requested_at AS requestedAt FROM family_links l JOIN family_accounts a ON a.id=l.family_id
        WHERE a.active=1 ORDER BY CASE WHEN l.status='pending' THEN 0 ELSE 1 END,l.requested_at DESC LIMIT 250`)];
      return doJson({ ok: true, requests: rows });
    }
    if (action === "familyDecision") {
      const id = String(body.id || ""), player = String(body.player || ""), status = String(body.status || "");
      if (!["approved", "rejected", "revoked"].includes(status)) return doJson({ ok: false, error: "Estado inv\xE1lido" });
      this.sql.exec("UPDATE family_links SET status=?,decided_at=?,decided_by=? WHERE family_id=? AND player_name=?", status, (/* @__PURE__ */ new Date()).toISOString(), String(body.who || ""), id, player);
      return doJson({ ok: true });
    }
    if (action === "familyRecipients") {
      const names = Array.isArray(body.players) ? body.players.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 250) : [];
      const recipients = [];
      for (const player of names) {
        const rows = [...this.sql.exec(`SELECT DISTINCT a.name AS name FROM family_links l JOIN family_accounts a ON a.id=l.family_id
          WHERE l.player_name=? COLLATE NOCASE AND l.status='approved' AND a.active=1`, player)];
        for (const r of rows) recipients.push("FAMILIA:" + r.name);
      }
      return doJson({ ok: true, recipients: [...new Set(recipients)] });
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
    if (action === "listCourtPayments") {
      this.ctx.storage.transactionSync(() => {
        const active = this.sql.exec("SELECT match_id,payload,updated_at FROM reservations").toArray();
        for (const r of active) {
          const exists = this.sql.exec("SELECT booking_id FROM court_booking_history WHERE match_id=? AND status='active' LIMIT 1", r.match_id).toArray()[0];
          if (!exists) {
            this.sql.exec("INSERT INTO court_booking_history(booking_id,match_id,payload,status,updated_at) VALUES(?,?,?,?,?)", crypto.randomUUID(), r.match_id, r.payload, "active", String(r.updated_at || (/* @__PURE__ */ new Date()).toISOString()));
          }
        }
      });
      const rows = this.sql.exec("SELECT booking_id,match_id,payload,status,payment_a,payment_b,payment_a_at,payment_b_at,payment_a_by,payment_b_by,updated_at FROM court_booking_history ORDER BY updated_at DESC LIMIT 3000").toArray();
      return doJson({ ok: true, records: rows.map((row) => ({ bookingId: row.booking_id, matchId: row.match_id, reservation: JSON.parse(row.payload), status: row.status, paymentA: row.payment_a, paymentB: row.payment_b, paymentAAt: row.payment_a_at, paymentBAt: row.payment_b_at, paymentABy: row.payment_a_by, paymentBBy: row.payment_b_by, updatedAt: row.updated_at })) });
    }
    if (action === "setCourtPayment") {
      const bookingId = String(body.bookingId || "").trim();
      const side = String(body.side || "");
      const payment = String(body.payment || "");
      const adminName = String(body.adminName || "").slice(0, 120);
      if (!bookingId || !["a", "b"].includes(side) || !["pending", "paid"].includes(payment) || !adminName) return doJson({ ok: false, error: "Datos de pago no v\xE1lidos" }, 400);
      const col = side === "a" ? "a" : "b";
      const result = this.ctx.storage.transactionSync(() => {
        const row = this.sql.exec("SELECT payload,payment_" + col + " AS current FROM court_booking_history WHERE booking_id=?", bookingId).toArray()[0];
        if (!row) throw new Error("Reserva hist\xF3rica no encontrada");
        const booking = JSON.parse(row.payload);
        if (!booking[col]) throw new Error("Jugador sin identificar");
        const now = (/* @__PURE__ */ new Date()).toISOString();
        this.sql.exec("UPDATE court_booking_history SET payment_" + col + "=?,payment_" + col + "_at=?,payment_" + col + "_by=?,updated_at=? WHERE booking_id=?", payment, now, adminName, now, bookingId);
        return { bookingId, side, payment, player: booking[col], updatedAt: now };
      });
      return doJson({ ok: true, ...result });
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
    if (action === "getProposal") {
      const matchId = String(body.matchId || "");
      if (!matchId) return doJson({ ok: false, error: "Falta el partido" }, 400);
      const proposal = this.ctx.storage.transactionSync(() => {
        const row = this.sql.exec("SELECT payload FROM match_proposals WHERE match_id = ?", matchId).toArray()[0];
        if (!row) return null;
        let current;
        try {
          current = JSON.parse(row.payload);
        } catch (_) {
          return null;
        }
        if (current.status !== "accepted") return current;
        const booked = this.sql.exec("SELECT slot_id FROM reservations WHERE match_id = ?", matchId).toArray()[0];
        if (booked && String(booked.slot_id) === String(current.slotId)) return current;
        const now = (/* @__PURE__ */ new Date()).toISOString();
        current.status = "cancelled";
        current.cancelledAt = current.cancelledAt || now;
        current.updatedAt = now;
        current.reconciled = true;
        this.sql.exec("UPDATE match_proposals SET payload = ?, updated_at = ? WHERE match_id = ?", JSON.stringify(current), now, matchId);
        return current;
      });
      return doJson({ ok: true, proposal });
    }
    if (action === "proposeSlot") {
      const proposal = body.proposal;
      if (!proposal?.matchId || !proposal?.slotId) return doJson({ ok: false, error: "Propuesta incompleta" }, 400);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const priorRow = this.sql.exec("SELECT payload FROM match_proposals WHERE match_id=?", proposal.matchId).toArray()[0];
      let prior = null;
      try {
        prior = priorRow ? JSON.parse(priorRow.payload) : null;
      } catch (_) {
      }
      const history = Array.isArray(prior?.history) ? prior.history.slice(-18) : [];
      if (prior) {
        history.push({ from: prior.from, to: prior.to, date: prior.reservation?.date, time: prior.reservation?.time, court: prior.reservation?.court, status: prior.status === "pending" ? "sustituida" : prior.status, at: prior.updatedAt || prior.createdAt });
      }
      const next = { ...proposal, status: "pending", updatedAt: now, history: history.slice(-18) };
      this.sql.exec(
        `INSERT INTO match_proposals(match_id,payload,updated_at) VALUES(?,?,?)
        ON CONFLICT(match_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`,
        proposal.matchId,
        JSON.stringify(next),
        now
      );
      return doJson({ ok: true, proposal: next });
    }
    if (action === "rejectProposal") {
      const matchId = String(body.matchId || "");
      const row = this.sql.exec("SELECT payload FROM match_proposals WHERE match_id=?", matchId).toArray()[0];
      if (!row) return doJson({ ok: false, error: "No hay propuesta pendiente" }, 404);
      const proposal = JSON.parse(row.payload);
      if (body.expectedSlotId && proposal.slotId !== body.expectedSlotId) return doJson({ ok: false, error: "La propuesta ha cambiado" }, 409);
      if (proposal.status !== "pending") return doJson({ ok: false, error: "Esta propuesta ya no est\xE1 pendiente" }, 409);
      proposal.status = "rejected";
      proposal.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.sql.exec("UPDATE match_proposals SET payload=?,updated_at=? WHERE match_id=?", JSON.stringify(proposal), proposal.updatedAt, matchId);
      return doJson({ ok: true, proposal });
    }
    if (action === "acceptProposal") {
      const matchId = String(body.matchId || "");
      try {
        const result = this.ctx.storage.transactionSync(() => {
          const row = this.sql.exec("SELECT payload FROM match_proposals WHERE match_id=?", matchId).toArray()[0];
          if (!row) throw new Error("No existe la propuesta");
          const proposal = JSON.parse(row.payload);
          if (body.expectedSlotId && proposal.slotId !== body.expectedSlotId) throw new Error("La propuesta ha cambiado. Vuelve a abrirla");
          if (proposal.status !== "pending") throw new Error("La propuesta ya no est\xE1 pendiente");
          if (proposal.expiresAt && Date.parse(proposal.expiresAt) <= Date.now()) throw new Error("La propuesta ha caducado");
          const occupied = this.sql.exec("SELECT match_id FROM reservations WHERE slot_id=?", proposal.slotId).toArray()[0];
          if (occupied && occupied.match_id !== matchId) throw new Error("La pista ya ha sido reservada por otro partido");
          const existing = this.sql.exec("SELECT match_id FROM reservations WHERE match_id=?", matchId).toArray()[0];
          if (existing) throw new Error("Este partido ya tiene una reserva. Canc\xE9lala antes de aceptar otra propuesta");
          const now = (/* @__PURE__ */ new Date()).toISOString();
          const reservation = { ...proposal.reservation, reservedBy: body.acceptedBy, reservedAt: now, updatedAt: now };
          this.sql.exec("INSERT INTO reservations(match_id,slot_id,payload,updated_at) VALUES(?,?,?,?)", matchId, proposal.slotId, JSON.stringify(reservation), now);
          const bookingId = crypto.randomUUID();
          this.sql.exec("INSERT INTO court_booking_history(booking_id,match_id,payload,status,updated_at) VALUES(?,?,?,?,?)", bookingId, matchId, JSON.stringify(reservation), "active", now);
          proposal.status = "accepted";
          proposal.acceptedBy = body.acceptedBy;
          proposal.updatedAt = now;
          this.sql.exec("UPDATE match_proposals SET payload=?,updated_at=? WHERE match_id=?", JSON.stringify(proposal), now, matchId);
          return { reservation, proposal };
        });
        return doJson({ ok: true, ...result });
      } catch (e) {
        return doJson({ ok: false, error: e?.message || String(e) }, 409);
      }
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
          const previous = this.sql.exec("SELECT slot_id FROM reservations WHERE match_id=?", matchId).toArray()[0];
          const payload = JSON.stringify(reservation);
          const now = (/* @__PURE__ */ new Date()).toISOString();
          if (previous) {
            this.sql.exec("UPDATE court_booking_history SET status='replaced',updated_at=? WHERE match_id=? AND status='active'", now, matchId);
          }
          const bookingId = crypto.randomUUID();
          this.sql.exec("INSERT INTO court_booking_history(booking_id,match_id,payload,status,updated_at) VALUES(?,?,?,?,?)", bookingId, matchId, payload, "active", now);
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
      const cancelledProposal = this.ctx.storage.transactionSync(() => {
        const active = this.sql.exec("SELECT slot_id FROM reservations WHERE match_id = ?", matchId).toArray()[0];
        this.sql.exec("DELETE FROM reservations WHERE match_id = ?", matchId);
        if (active) {
          const now2 = (/* @__PURE__ */ new Date()).toISOString();
          this.sql.exec("UPDATE court_booking_history SET status='cancelled',updated_at=? WHERE match_id=? AND status='active'", now2, matchId);
        }
        if (!active) return null;
        const row = this.sql.exec("SELECT payload FROM match_proposals WHERE match_id = ?", matchId).toArray()[0];
        if (!row) return null;
        let proposal;
        try {
          proposal = JSON.parse(row.payload);
        } catch (_) {
          return null;
        }
        if (proposal.status !== "accepted" || String(proposal.slotId) !== String(active.slot_id)) return null;
        const now = (/* @__PURE__ */ new Date()).toISOString();
        proposal.status = "cancelled";
        proposal.cancelledAt = now;
        proposal.cancelledBy = String(body.cancelledBy || "");
        proposal.updatedAt = now;
        this.sql.exec("UPDATE match_proposals SET payload = ?, updated_at = ? WHERE match_id = ?", JSON.stringify(proposal), now, matchId);
        return proposal;
      });
      return doJson({ ok: true, proposal: cancelledProposal });
    }
    if (action === "replaceAllForTestRestore") {
      const reservations = body.reservations && typeof body.reservations === "object" ? body.reservations : {};
      let restored = 0;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM reservations");
        for (const [matchId, reservation] of Object.entries(reservations)) {
          const slotId = String(reservation?.slotId || reservation?.slot?.id || "").trim();
          if (!matchId || !slotId) continue;
          this.sql.exec(
            `INSERT INTO reservations (match_id, slot_id, payload, updated_at) VALUES (?, ?, ?, ?)`,
            String(matchId),
            slotId,
            JSON.stringify(reservation),
            String(reservation?.updatedAt || (/* @__PURE__ */ new Date()).toISOString())
          );
          restored++;
        }
      });
      return doJson({ ok: true, restored });
    }
    return doJson({ ok: false, error: `Acci\xF3n DO desconocida: ${action}` }, 400);
  }
  async webSocketMessage(ws, message) {
    let payload = {};
    try {
      payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch (_) {
      try {
        ws.send(JSON.stringify({ type: "error", error: "Mensaje no v\xE1lido." }));
      } catch (_2) {
      }
      return;
    }
    let attachment = {};
    try {
      attachment = ws.deserializeAttachment() || {};
    } catch (_) {
    }
    if (!attachment.authenticated) {
      if (payload.type !== "auth") {
        try {
          ws.close(1008, "Autenticaci\xF3n requerida");
        } catch (_) {
        }
        return;
      }
      const token = String(payload.token || "").trim();
      if (!token) {
        try {
          ws.close(1008, "Token requerido");
        } catch (_) {
        }
        return;
      }
      const raw = await this.env.DATA.get(`session:${token}`);
      if (!raw) {
        try {
          ws.close(1008, "Sesi\xF3n no v\xE1lida");
        } catch (_) {
        }
        return;
      }
      try {
        const session = JSON.parse(raw);
        if (session.securityVersion !== SESSION_SECURITY_VERSION) throw new Error("Sesi\xF3n caducada");
        ws.serializeAttachment({
          authenticated: true,
          name: String(session.name || ""),
          role: String(session.role || "player")
        });
        ws.send(JSON.stringify({ type: "ready" }));
      } catch (_) {
        try {
          ws.close(1008, "Sesi\xF3n no v\xE1lida");
        } catch (_2) {
        }
      }
      return;
    }
    if (payload.type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
      } catch (_) {
      }
    }
  }
  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch (_) {
    }
  }
};
var AUTORESULTS_WAIT_MS = 24 * 60 * 60 * 1e3;
async function confirmExpiredResults(env) {
  if (env.AUTORESULTS_ENABLED !== "true") return { enabled: false, confirmed: 0 };
  const op = await bookingCall(env, { action: "leagueExpire", enabled: true, notBefore: env.AUTORESULTS_NOT_BEFORE });
  if (!op.ok) throw new Error(op.error || "Error al confirmar resultados");
  for (const { matchId: id, result } of op.confirmed) {
    try {
      const b = await bookingCall(env, { action: "get", matchId: id });
      if (b?.reservation) {
        const c = await bookingCall(env, { action: "cancel", matchId: id });
        if (!c?.ok) throw new Error(c.error || "No se pudo liberar la pista");
        await broadcastRealtime(env, { type: "reservationChanged", matchId: id, reservation: null });
      }
    } catch (e) {
      console.error("Reserva pendiente de liberar", id, e);
    }
    await broadcastRealtime(env, { type: "resultChanged", matchId: id, result });
    await sendTargetedPush(env, [result.a, result.b], "\u2705 Resultado confirmado autom\xE1ticamente", "Han pasado 24 horas sin respuesta. El resultado ya cuenta para la clasificaci\xF3n.", { open: "result", matchId: id, week: result.week, category: result.category, gender: result.gender });
  }
  return { enabled: true, confirmed: op.confirmed.length };
}
__name(confirmExpiredResults, "confirmExpiredResults");
var index_default = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(confirmExpiredResults(env).then(
      (summary) => console.log("PROD autoresultados 24h", JSON.stringify(summary)),
      (error) => console.error("PROD autoresultados 24h", error)
    ));
  },
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
      if (request.method === "GET" && requestUrl.pathname === "/realtime" && (request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
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
          version: "2.6.10-finaliza-libera-pista",
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
        return json({ ok: true, message: "CT Campeador conectado", durableObject: ping.durableObject, version: "2.6.10-finaliza-libera-pista" }, 200, corsHeaders);
      }
      if (action === "familyProtocol") {
        return json({ ok: true, environment: "production", familyProtocol: "pin-only", build: "1.5.1", requiresPlayerName: false }, 200, corsHeaders);
      }
      if (action === "familyRegister") {
        const name = String(body.name || "").trim().replace(/\s+/g, " ");
        const pin = String(body.pin || "").trim();
        const gateKey = loginGuardKey(request);
        const registerKey = loginAttemptKey(request, "family-registration");
        const gate = await checkLoginGates(env, [gateKey, registerKey]);
        if (!gate.allowed) return json({ ok: false, error: "Demasiados intentos." }, 429, corsHeaders);
        if (name.length < 4 || name.length > 70 || !/^[\p{L}\p{N} .'-]+$/u.test(name) || !/^[0-9]{6}$/.test(pin))
          return json({ ok: false, error: "Introduce un nombre de 4 a 70 caracteres y un PIN familiar de 6 cifras." }, 400, corsHeaders);
        if ((await getUsers(env)).some((u) => normalize(u.name) === normalize(name))) return json({ ok: false, error: "Nombre reservado: elige otro nombre para la familia." }, 409, corsHeaders);
        const salt = crypto.randomUUID() + crypto.randomUUID();
        const hash = await familyPinHash(pin, salt);
        const r = await bookingCall(env, { action: "familyCreate", id: crypto.randomUUID(), name, salt, hash });
        if (!r.ok) return json({ ok: false, error: r.error }, 409, corsHeaders);
        await clearLoginGates(env, [gateKey, registerKey]);
        const token = await createSession(env, { name: "FAMILIA:" + name, role: "family", familyId: r.id });
        return json({ ok: true, token, user: { name: "FAMILIA:" + name, role: "family" }, familyName: name }, 200, corsHeaders);
      }
      if (action === "familyLogin") {
        const name = String(body.name || "").trim(), pin = String(body.pin || "").trim();
        const gateKey = loginGuardKey(request), specific = loginAttemptKey(request, name);
        const gate = await checkLoginGates(env, [gateKey, specific]);
        if (!gate.allowed) return json({ ok: false, error: "Demasiados intentos. Int\xE9ntalo m\xE1s tarde." }, 429, corsHeaders);
        if (!name || !/^[0-9]{6}$/.test(pin)) return json({ ok: false, error: "Nombre y PIN familiar de 6 cifras obligatorios." }, 400, corsHeaders);
        const r = await bookingCall(env, { action: "familyGetByName", name });
        const good = r.account?.pin_hash ? secureEqualString(await familyPinHash(pin, r.account.salt), r.account.pin_hash) : false;
        if (!good) {
          await registerLoginFailure(env, gateKey, specific);
          return json({ ok: false, error: "Credenciales incorrectas" }, 401, corsHeaders);
        }
        await clearLoginGates(env, [gateKey, specific]);
        const token = await createSession(env, { name: "FAMILIA:" + r.account.name, role: "family", familyId: r.account.id });
        return json({ ok: true, token, user: { name: "FAMILIA:" + r.account.name, role: "family" }, familyName: r.account.name }, 200, corsHeaders);
      }
      if (action === "familyInfo") {
        const session = await getSession(request, body, env);
        if (!session || session.role !== "family") return json({ ok: false, error: "Acceso familiar requerido" }, 403, corsHeaders);
        const r = await bookingCall(env, { action: "familyLinks", id: session.familyId });
        return json({ ok: true, name: session.name.replace(/^FAMILIA:/, ""), links: r.links || [] }, 200, corsHeaders);
      }
      if (action === "familyRequestLink") {
        const session = await getSession(request, body, env);
        if (!session || session.role !== "family") return json({ ok: false, error: "Acceso familiar requerido" }, 403, corsHeaders);
        const pin = String(body.pin || "").trim();
        const gateKey = loginGuardKey(request), specific = loginAttemptKey(request, "family-link");
        const gate = await checkLoginGates(env, [gateKey, specific]);
        if (!gate.allowed) return json({ ok: false, error: "Demasiados intentos. Vuelve a probar m\xE1s tarde." }, 429, corsHeaders);
        if (!/^(?:\d{4}|\d{6})$/.test(pin)) return json({ ok: false, error: "Introduce el PIN del jugador (4 o 6 cifras)." }, 400, corsHeaders);
        const users = await getUsers(env);
        const matches = users.filter((u) => String(u.pin) === pin && u.active !== false);
        if (matches.length !== 1) {
          await registerLoginFailure(env, gateKey, specific);
          return json({ ok: false, error: matches.length > 1 ? "PIN duplicado. Solicita al administrador un PIN nuevo." : "PIN no encontrado entre los usuarios activos de la liga." }, matches.length > 1 ? 409 : 401, corsHeaders);
        }
        const match = matches[0];
        if (match.role === "admin") return json({ ok: false, error: "Este PIN corresponde a una cuenta administradora, no vinculable en Modo Familia." }, 403, corsHeaders);
        const r = await bookingCall(env, { action: "familyLinkRequest", id: session.familyId, player: match.name });
        if (!r.ok) return json({ ok: false, error: r.error || "No se pudo solicitar la vinculaci\xF3n." }, 409, corsHeaders);
        await clearLoginGates(env, [gateKey, specific]);
        return json({ ok: true, status: r.status, player: match.name }, 200, corsHeaders);
      }
      if (action === "familyAdminList") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const r = await bookingCall(env, { action: "familyRequests" });
        return json({ ok: true, requests: r.requests || [] }, 200, corsHeaders);
      }
      if (action === "familyAdminDecision") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const id = String(body.familyId || ""), player = String(body.player || ""), status = String(body.status || "");
        const r = await bookingCall(env, { action: "familyDecision", id, player, status, who: admin.session.name });
        return json(r, r.ok ? 200 : 400, corsHeaders);
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
        const rawSession = await getSession(request, body, env);
        if (rawSession?.role === "family") return json({ ok: false, error: "El PIN personal no se muestra en cuentas familiares." }, 403, corsHeaders);
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const users = await getUsers(env);
        const user = users.find(
          (u) => normalize(u.name) === normalize(auth.session.name) && u.active !== false
        );
        if (!user) return json({ ok: false, error: "Usuario no encontrado." }, 404, corsHeaders);
        const pin = String(user.pin || "").trim();
        if (!/^(?:\d{4}|\d{6})$/.test(pin)) {
          return json({ ok: false, error: "El PIN actual no es v\xE1lido." }, 500, corsHeaders);
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
        const tournamentName = String(body.tournamentName || "").trim().replace(/\s+/g, " ").slice(0, 60);
        if (!tournamentName) {
          return json({ ok: false, error: "Escribe el nombre del torneo." }, 400, corsHeaders);
        }
        const state = await getState(env);
        const nextState = {
          ...state,
          tournamentName,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          updatedBy: admin.session.name
        };
        const saved = await bookingCall(env, { action: "leagueWrite", mode: "general", state: nextState, expectedUpdatedAt: state.updatedAt || "" });
        if (!saved.ok) return json({ ok: false, error: saved.error || "No se pudo guardar estado" }, saved.status || 409, corsHeaders);
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
          return json({ ok: false, error: "Orden de administraci\xF3n no v\xE1lido." }, 400, corsHeaders);
        }
        const prefs = await getAdminPrefs(env);
        const key = normalize(admin.session.name);
        prefs[key] = {
          ...prefs[key] && typeof prefs[key] === "object" ? prefs[key] : {},
          adminOrder: order,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
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
          next.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
          prefs[key] = next;
          await putAdminPrefs(env, prefs);
        }
        return json({ ok: true }, 200, corsHeaders);
      }
      if (action === "liveAuthorization") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const matchKey = String(body.matchKey || "").trim();
        if (!/^ct[0-9a-f]{16}$/.test(matchKey)) return json({ ok: false, error: "Identificador LIVE incorrecto." }, 400, corsHeaders);
        const state = await getState(env);
        let match = null;
        for (const fixtures of Object.values(state.fixtures || {})) {
          for (const fixture of Array.isArray(fixtures) ? fixtures : []) {
            if (liveMatchKey(fixture.id) === matchKey) {
              match = fixture;
              break;
            }
          }
          if (match) break;
        }
        if (!match) return json({ ok: false, error: "Este partido no existe en la liga oficial." }, 404, corsHeaders);
        const canControl = normalize(auth.session.name) === normalize(match.a) || normalize(auth.session.name) === normalize(match.b);
        return json({ ok: true, canControl, names: [String(match.a), String(match.b)], player: auth.session.name }, 200, corsHeaders);
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
        const familySession = await getSession(request, body, env);
        const auth = familySession?.role === "family" ? null : await requireUser(request, body, env);
        if (familySession?.role !== "family" && !auth?.ok)
          return json({ ok: false, error: auth?.error || "Sesi\xF3n requerida" }, auth?.status || 401, corsHeaders);
        if (!env.PUSH_SERVICE || !env.PUSH_SERVICE_TOKEN) {
          return json({ ok: false, error: "El servicio Push no est\xE1 configurado." }, 500, corsHeaders);
        }
        const subscription = body.subscription || {};
        const deviceId = String(body.deviceId || "").trim();
        if (!/^[a-zA-Z0-9_.:-]{8,128}$/.test(deviceId)) return json({ ok: false, error: "Identificador del dispositivo no v\xE1lido" }, 400, corsHeaders);
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
            deviceId: String(body.deviceId || "").trim(),
            subscription,
            userName: familySession?.role === "family" ? familySession.name : auth.session.name
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
        const saved = await bookingCall(env, { action: "leagueWrite", mode: "general", state: safeState, expectedUpdatedAt: currentState.updatedAt || "" });
        if (!saved.ok) return json({ ok: false, error: saved.error || "No se pudo guardar estado" }, saved.status || 409, corsHeaders);
        await broadcastRealtime(env, { type: "stateChanged", updatedAt: safeState.updatedAt });
        return json({ ok: true, state: safeState }, 200, corsHeaders);
      }
      if (["getMatchProposal", "proposeMatchSlot", "respondMatchProposal"].includes(action)) {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const matchId = String(body.matchId || "").trim();
        const league = await getState(env);
        const found = findFixture(league, matchId);
        if (!found) return json({ ok: false, error: "Partido no encontrado" }, 404, corsHeaders);
        const { fixture, week, category, gender } = found;
        const me = auth.session.name;
        const participant = normalize(me) === normalize(fixture.a) || normalize(me) === normalize(fixture.b);
        if (!participant && auth.session.role !== "admin") return json({ ok: false, error: "No perteneces a este partido" }, 403, corsHeaders);
        if (action === "getMatchProposal") {
          const result2 = await bookingCall(env, { action: "getProposal", matchId });
          return json(result2, result2.ok ? 200 : 500, corsHeaders);
        }
        if (!participant) return json({ ok: false, error: "Solo los jugadores pueden proponer o responder" }, 403, corsHeaders);
        if (league.results?.[matchId]?.status === "confirmed") return json({ ok: false, error: "El partido est\xE1 finalizado" }, 409, corsHeaders);
        if (action === "proposeMatchSlot") {
          const bookingWeek = String(body.week || body.reservation?.week || week).trim();
          if (!league.published?.[bookingWeek]) return json({ ok: false, error: "Las pistas de la jornada elegida todav\xEDa no est\xE1n publicadas" }, 409, corsHeaders);
          const slotId = String(body.slotId || "").trim();
          const slot = (league.slots?.[bookingWeek] || []).find((x) => String(x.id) === slotId);
          if (!slot) return json({ ok: false, error: "La pista ya no est\xE1 disponible" }, 409, corsHeaders);
          const until = spanishSlotTimeToUTC(slot.date, slot.time);
          if (!Number.isFinite(until)) return json({ ok: false, error: "La fecha u hora de la pista no tiene un formato v\xE1lido" }, 409, corsHeaders);
          if (until <= Date.now()) return json({ ok: false, error: "La hora propuesta ya ha pasado. Elige una fecha y hora futuras." }, 409, corsHeaders);
          const current = await bookingCall(env, { action: "get", matchId });
          if (current.reservation) return json({ ok: false, error: "El partido ya tiene una reserva" }, 409, corsHeaders);
          const target = normalize(me) === normalize(fixture.a) ? fixture.b : fixture.a;
          const proposal2 = {
            matchId,
            slotId,
            from: me,
            to: target,
            week: bookingWeek,
            createdAt: (/* @__PURE__ */ new Date()).toISOString(),
            expiresAt: new Date(until).toISOString(),
            reservation: { week: bookingWeek, officialWeek: week, slotId, a: fixture.a, b: fixture.b, day: slot.day, date: slot.date, time: slot.time, court: slot.court, category, gender }
          };
          const result2 = await bookingCall(env, { action: "proposeSlot", proposal: proposal2 });
          if (!result2.ok) return json(result2, 409, corsHeaders);
          await broadcastRealtime(env, { type: "reservationProposalChanged", matchId }, { recipients: [fixture.a, fixture.b], includeAdmins: true });
          await sendTargetedPush(env, [target], "\u{1F3BE} Propuesta de pista", `${me} propone jugar el ${slot.date} a las ${slot.time} en ${slot.court}. Entra en Mi partido para responder.`, { open: "proposal", matchId, week: bookingWeek });
          return json(result2, 200, corsHeaders);
        }
        const before = await bookingCall(env, { action: "getProposal", matchId });
        const proposal = before.proposal;
        if (!proposal || proposal.status !== "pending") return json({ ok: false, error: "No hay propuesta pendiente" }, 409, corsHeaders);
        const response = String(body.response || "");
        if (response !== "accept" && response !== "reject") return json({ ok: false, error: "Respuesta no v\xE1lida" }, 400, corsHeaders);
        if (normalize(proposal.to) !== normalize(me)) return json({ ok: false, error: "Solo el rival puede responder a esta propuesta" }, 403, corsHeaders);
        if (response === "accept") {
          if (!league.published?.[proposal.week]) return json({ ok: false, error: "La disponibilidad se ha cerrado" }, 409, corsHeaders);
          const slot = (league.slots?.[proposal.week] || []).find((x) => String(x.id) === proposal.slotId);
          if (!slot || slot.date !== proposal.reservation?.date || slot.time !== proposal.reservation?.time || slot.court !== proposal.reservation?.court)
            return json({ ok: false, error: "La pista propuesta ya no est\xE1 disponible" }, 409, corsHeaders);
        }
        const result = await bookingCall(env, { action: response === "accept" ? "acceptProposal" : "rejectProposal", matchId, acceptedBy: me, expectedSlotId: proposal.slotId });
        if (!result.ok) return json(result, 409, corsHeaders);
        await broadcastRealtime(env, { type: response === "accept" ? "reservationChanged" : "reservationProposalChanged", matchId, reservation: result.reservation || null }, { recipients: [fixture.a, fixture.b], includeAdmins: true });
        await sendTargetedPush(env, [proposal.from], response === "accept" ? "\u2705 Propuesta aceptada" : "\u21A9\uFE0F Propuesta rechazada", response === "accept" ? `${me} ha aceptado la propuesta. La pista ha quedado reservada.` : `${me} no puede jugar en el horario propuesto.`, { open: "proposal", matchId, week });
        return json(result, 200, corsHeaders);
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
        const confirmedResult = state.results?.[matchId];
        if (confirmedResult?.status === "confirmed") {
          return json({ ok: false, error: "Este partido ya est\xE1 finalizado y no puede volver a reservar pista." }, 409, corsHeaders);
        }
        if (auth.session.role !== "admin" && normalize(fixture.a) !== normalize(auth.session.name) && normalize(fixture.b) !== normalize(auth.session.name)) {
          return json({ ok: false, error: "Solo uno de los jugadores del partido puede reservar." }, 403, corsHeaders);
        }
        const bookingWeek = String(body.week || body.reservation?.week || week).trim();
        if (!state.published?.[bookingWeek]) {
          return json({ ok: false, error: "Las reservas de la jornada elegida todav\xEDa no est\xE1n abiertas." }, 409, corsHeaders);
        }
        const slot = (state.slots?.[bookingWeek] || []).find((s) => String(s.id) === slotId);
        if (!slot) return json({ ok: false, error: "Ese tramo ya no est\xE1 disponible." }, 409, corsHeaders);
        const slotStart = spanishSlotTimeToUTC(slot.date, slot.time);
        if (!Number.isFinite(slotStart) || slotStart <= Date.now()) return json({ ok: false, error: "La fecha u hora de esta pista ya ha pasado." }, 409, corsHeaders);
        const reservation = {
          week: bookingWeek,
          officialWeek: week,
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
        const cancelled = await bookingCall(env, { action: "cancel", matchId, cancelledBy: auth.session.name });
        if (!cancelled.ok) return json({ ok: false, error: cancelled.error || "No se pudo cancelar la reserva." }, 500, corsHeaders);
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
        const op = await bookingCall(env, { action: "leagueWrite", mode: "submit", matchId, who: auth.session.name, isAdmin, incoming });
        if (!op.ok) return json({ ok: false, error: op.error }, op.status || 409, corsHeaders);
        const result = op.result;
        const editedPendingFromRival = op.editedPendingFromRival;
        if (result.status === "confirmed") {
          const currentReservation = await bookingCall(env, { action: "get", matchId });
          if (currentReservation?.reservation) {
            await bookingCall(env, { action: "cancel", matchId });
            await broadcastRealtime(env, { type: "reservationChanged", matchId, reservation: null });
          }
        }
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
            editedPendingFromRival ? "\u270F\uFE0F Resultado modificado por tu rival" : "\u{1F3BE} Resultado pendiente de confirmar",
            editedPendingFromRival ? `${auth.session.name} ha modificado el resultado propuesto. Rev\xEDsalo y conf\xEDrmalo o vuelve a editarlo.` : `${auth.session.name} ha comunicado el resultado de vuestro partido. Rev\xEDsalo y conf\xEDrmalo.`,
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
        const { fixture } = found;
        const op = await bookingCall(env, { action: "leagueWrite", mode: "confirm", matchId, who: auth.session.name, isAdmin: auth.session.role === "admin" });
        if (!op.ok) return json({ ok: false, error: op.error }, op.status || 409, corsHeaders);
        const result = op.result;
        if (op.alreadyConfirmed) return json({ ok: true, result }, 200, corsHeaders);
        const currentReservation = await bookingCall(env, { action: "get", matchId });
        if (currentReservation?.reservation) {
          await bookingCall(env, { action: "cancel", matchId });
          await broadcastRealtime(env, { type: "reservationChanged", matchId, reservation: null });
        }
        await broadcastRealtime(env, { type: "resultChanged", matchId, result });
        if (result.submittedBy && normalize(result.submittedBy) !== normalize(auth.session.name)) {
          await sendTargetedPush(
            env,
            [result.submittedBy],
            "\u2705 Resultado confirmado",
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
        const op = await bookingCall(env, { action: "leagueWrite", mode: "delete", matchId, who: admin.session.name, isAdmin: true });
        if (!op.ok) return json({ ok: false, error: op.error }, op.status || 409, corsHeaders);
        const previousResult = op.previousResult;
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
      if (action === "familyInbox") {
        const session = await getSession(request, body, env);
        if (!session || session.role !== "family") return json({ ok: false, error: "Acceso familiar requerido" }, 403, corsHeaders);
        const links = await bookingCall(env, { action: "familyLinks", id: session.familyId });
        const approved = (links.links || []).filter((l) => l.status === "approved");
        const users = await getUsers(env);
        const active = new Map(users.filter((u) => u.active !== false && u.role !== "admin").map((u) => [normalize(u.name), u.name]));
        const players = [...new Set(approved.map((l) => active.get(normalize(l.playerName))).filter(Boolean))];
        const messages = await getMessages(env);
        const combined = [];
        for (const player of players) {
          const virtual = { name: player, role: "player" };
          for (const m of messages) {
            if (messageVisibleToUser(m, virtual)) combined.push({ ...messageForSession(m, virtual), playerName: player });
          }
        }
        combined.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
        return json({ ok: true, players, messages: combined.slice(0, 500), unread: combined.filter((m) => !m.read).length }, 200, corsHeaders);
      }
      if (action === "listMessages") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const messages = await getMessages(env);
        const visible = messages.filter((m) => messageVisibleToUser(m, auth.session)).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).map((m) => messageForSession(m, auth.session));
        return json({ ok: true, messages: visible }, 200, corsHeaders);
      }
      if (action === "markMessagesRead") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        const ids = new Set(
          (Array.isArray(body.ids) ? body.ids : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 200)
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
      if (action === "hideOwnMessage") {
        const auth = await requireUser(request, body, env);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, corsHeaders);
        if (auth.session.role === "admin") return json({ ok: false, error: "Usa la gesti\xF3n de mensajes del administrador." }, 403, corsHeaders);
        const id = String(body.id || "").trim().slice(0, 120);
        if (!id) return json({ ok: false, error: "Falta el ID del mensaje." }, 400, corsHeaders);
        const messages = await getMessages(env);
        const message = messages.find((m) => String(m.id || "") === id);
        if (!message || !Array.isArray(message.recipientNames) || !message.recipientNames.some((n) => normalize(n) === normalize(auth.session.name))) {
          return json({ ok: false, error: "Mensaje no disponible para este jugador." }, 404, corsHeaders);
        }
        const hiddenBy = Array.isArray(message.hiddenBy) ? message.hiddenBy : [];
        const alreadyHidden = hiddenBy.some((n) => normalize(n) === normalize(auth.session.name));
        if (!alreadyHidden) {
          message.hiddenBy = [...hiddenBy, auth.session.name];
          await putMessages(env, messages);
          await broadcastRealtime(
            env,
            { type: "messageChanged", reason: "hidden" },
            { recipients: [auth.session.name], includeAdmins: false }
          );
        }
        return json({ ok: true, hidden: !alreadyHidden, player: auth.session.name }, 200, corsHeaders);
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
        const title = String(body.title || "").trim().slice(0, 80);
        const message = String(body.message || "").trim().slice(0, 220);
        const launchUrl = makeAppDeepLink({ open: "messages" });
        const recipients = Array.isArray(body.recipients) ? [...new Set(body.recipients.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 250) : [];
        if (!title) return json({ ok: false, error: "Falta el t\xEDtulo del mensaje." }, 400, corsHeaders);
        if (!message) return json({ ok: false, error: "Falta el mensaje." }, 400, corsHeaders);
        if (!recipients.length) return json({ ok: false, error: "No hay destinatarios." }, 400, corsHeaders);
        const users = await getUsers(env);
        const allowed = new Map(users.filter((u) => u.active !== false).map((u) => [normalize(u.name), u.name]));
        const safeRecipients = recipients.map((name) => allowed.get(normalize(name))).filter(Boolean);
        if (!safeRecipients.length) return json({ ok: false, error: "Ning\xFAn destinatario v\xE1lido." }, 400, corsHeaders);
        const messages = await getMessages(env);
        const storedMessage = {
          id: `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          at: (/* @__PURE__ */ new Date()).toISOString(),
          title,
          body: message,
          recipientNames: safeRecipients,
          sentBy: admin.session.name,
          sent: 0,
          readBy: []
        };
        messages.unshift(storedMessage);
        await putMessages(env, messages);
        for (const recipient of safeRecipients) {
          const recipientSession = { name: recipient, role: "player" };
          await broadcastRealtime(
            env,
            {
              type: "messageChanged",
              reason: "created",
              messageId: storedMessage.id,
              message: messageForSession(storedMessage, recipientSession)
            },
            { recipients: [recipient], includeAdmins: false }
          );
        }
        await broadcastRealtime(
          env,
          {
            type: "messageChanged",
            reason: "created",
            messageId: storedMessage.id,
            message: messageForSession(storedMessage, admin.session)
          },
          { recipients: [], includeAdmins: true }
        );
        let pushResult = { ok: true, sent: 0, matchedUsers: 0, total: 0, removed: 0, failed: [] };
        let pushWarning = "";
        if (!env.PUSH_SERVICE || !env.PUSH_SERVICE_TOKEN) {
          pushWarning = "Mensaje guardado; servicio Push no configurado.";
        } else {
          const matched = /* @__PURE__ */ new Set();
          for (const player of safeRecipients) {
            try {
              const fam = await bookingCall(env, { action: "familyRecipients", players: [player] });
              const recipientsForPlayer = [.../* @__PURE__ */ new Set([player, ...fam.recipients || []])];
              const r = await env.PUSH_SERVICE.fetch("https://push.internal/admin/send", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.PUSH_SERVICE_TOKEN}` },
                body: JSON.stringify({
                  recipients: recipientsForPlayer,
                  title,
                  body: message,
                  url: makeAppDeepLink({ open: "messages", player, messageId: storedMessage.id }),
                  tag: `ctc-msg-${storedMessage.id}-${encodeURIComponent(player).slice(0, 32)}`
                })
              });
              const txt = await r.text();
              let info = {};
              try {
                info = JSON.parse(txt);
              } catch (_) {
              }
              if (!r.ok) {
                pushWarning = `Algunos avisos Push no se han enviado (HTTP ${r.status}).`;
                continue;
              }
              pushResult.sent += Number(info.sent || 0);
              pushResult.total += Number(info.total || 0);
              pushResult.removed += Number(info.removed || 0);
              for (const name of recipientsForPlayer) matched.add(normalize(name));
              if (Array.isArray(info.failed)) pushResult.failed.push(...info.failed);
            } catch (e) {
              pushWarning = "Env\xEDo Push parcial: " + String(e?.message || e).slice(0, 160);
            }
          }
          pushResult.matchedUsers = matched.size;
          if (pushResult.failed.length) {
            pushResult.ok = false;
            pushWarning = pushWarning || "Algunos dispositivos no recibieron el aviso.";
          }
        }
        storedMessage.sent = Number(pushResult.sent || 0);
        const latest = await getMessages(env);
        const mi = latest.findIndex((m) => String(m.id) === storedMessage.id);
        if (mi >= 0) {
          latest[mi].sent = storedMessage.sent;
          await putMessages(env, latest);
        }
        return json({
          ok: true,
          recipients: safeRecipients.length,
          matchedUsers: Number(pushResult.matchedUsers || 0),
          totalDevices: Number(pushResult.total || 0),
          sent: Number(pushResult.sent || 0),
          removed: Number(pushResult.removed || 0),
          failed: Array.isArray(pushResult.failed) ? pushResult.failed : [],
          pushWarning,
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
      if (action === "resultStorageHealth") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const status = await bookingCall(env, { action: "leagueStatus" });
        return json(status, status.ok ? 200 : 500, corsHeaders);
      }
      if (action === "listCourtPayments" || action === "setCourtPayment") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const answer = await bookingCall(env, action === "listCourtPayments" ? { action } : { action, bookingId: body.bookingId, side: body.side, payment: body.payment, adminName: admin.session.name });
        return json(answer, answer.ok ? 200 : 400, corsHeaders);
      }
      if (action === "exportBackup") {
        const admin = await requireAdmin(request, body, env);
        if (!admin.ok) return json({ ok: false, error: admin.error }, admin.status, corsHeaders);
        const [state, users, profiles, messages, adminPreferences, reservations] = await Promise.all([
          getState(env),
          getUsers(env),
          getProfiles(env),
          getMessages(env),
          getAdminPrefs(env),
          listReservations(env)
        ]);
        const courtPaymentsResult = await bookingCall(env, { action: "listCourtPayments" });
        if (!courtPaymentsResult.ok) return json({ ok: false, error: "No se pudo incluir el hist\xF3rico de pagos en la copia" }, 500, corsHeaders);
        const safeUsers = (Array.isArray(users) ? users : []).map(({ pin, pinHash, token, ...u }) => u);
        const safeState = JSON.parse(JSON.stringify(state || {}));
        delete safeState.pins;
        delete safeState.tokens;
        delete safeState.sessions;
        const backup = {
          format: "ct-campeador-backup",
          schemaVersion: 1,
          generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          apiVersion: "2.6.10-finaliza-libera-pista",
          tournamentName: String(state?.tournamentName || "CT Campeador"),
          contents: {
            state,
            users,
            profiles,
            messages,
            adminPreferences,
            reservations
          },
          excluded: [
            "sesiones y tokens de autenticaci\xF3n",
            "secretos de Cloudflare",
            "claves VAPID privadas",
            "suscripciones Push del servicio de notificaciones"
          ]
        };
        return json({ ok: true, backup }, 200, corsHeaders);
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
        if (users[idx].role === "admin" && role !== "admin") {
          const activeAdmins = users.filter((u) => u.active !== false && u.role === "admin");
          if (activeAdmins.length <= 1) {
            return json({ ok: false, error: "Debe quedar al menos un administrador." }, 400, corsHeaders);
          }
        }
        const oldRole = users[idx].role;
        users[idx] = { ...users[idx], role };
        await env.DATA.put(USERS_KEY, JSON.stringify(users));
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
          (Array.isArray(body.names) ? body.names : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 300)
        )];
        const users = await getUsers(env);
        const byName = new Map(users.map((u, i) => [normalize(u.name), i]));
        const usedPins = new Set(users.map((u) => String(u.pin || "")).filter(Boolean));
        const ensured = [];
        let created = 0;
        for (const requestedName of names) {
          const key = normalize(requestedName);
          const existingIndex = byName.get(key);
          if (existingIndex !== void 0) {
            const existing = users[existingIndex];
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
            pin = String(1e5 + bytes[0] % 9e5);
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
        const saved = await bookingCall(env, { action: "leagueWrite", mode: "reset", state: blankState });
        if (!saved.ok) return json({ ok: false, error: saved.error || "No se pudo guardar estado" }, saved.status || 409, corsHeaders);
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
__name2(bookingCall, "bookingCall");
async function broadcastRealtime(env, event, options = {}) {
  try {
    await bookingCall(env, {
      action: "broadcast",
      event,
      recipients: Array.isArray(options.recipients) ? options.recipients : null,
      includeAdmins: options.includeAdmins === true
    });
  } catch (_) {
  }
}
__name(broadcastRealtime, "broadcastRealtime");
__name2(broadcastRealtime, "broadcastRealtime");
var APP_BASE_URL = "https://ligasdetenis.github.io/ct-campeador-liga/";
function spanishSlotTimeToUTC(dateValue, timeValue) {
  const date = String(dateValue || "").trim();
  const time = String(timeValue || "").trim().split(/\s*[-–—]\s*/)[0].trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) return NaN;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(naive).toISOString().slice(0, 10) !== date || hour > 23 || minute > 59) return NaN;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const madridParts = /* @__PURE__ */ __name((timestamp) => {
    const fields = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((p) => [p.type, p.value]));
    return Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day), Number(fields.hour), Number(fields.minute));
  }, "madridParts");
  let utc = naive;
  for (let i = 0; i < 3; i++) utc += naive - madridParts(utc);
  return madridParts(utc) === naive ? utc : NaN;
}
__name(spanishSlotTimeToUTC, "spanishSlotTimeToUTC");
function makeAppDeepLink(params = {}) {
  const u = new URL(APP_BASE_URL);
  for (const [key, value] of Object.entries(params || {})) {
    const v = String(value ?? "").trim();
    if (v) u.searchParams.set(key, v.slice(0, 240));
  }
  return u.toString();
}
__name(makeAppDeepLink, "makeAppDeepLink");
__name2(makeAppDeepLink, "makeAppDeepLink");
async function sendTargetedPush(env, recipients, title, body, deepLink = {}) {
  if (!env.PUSH_SERVICE || !env.PUSH_SERVICE_TOKEN) return;
  const players = [...new Set((recipients || []).map((x) => String(x || "").trim()).filter(Boolean))];
  for (const player of players) {
    try {
      const family = await bookingCall(env, { action: "familyRecipients", players: [player] });
      const targets = [.../* @__PURE__ */ new Set([player, ...family.recipients || []])];
      const response = await env.PUSH_SERVICE.fetch("https://push.internal/admin/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.PUSH_SERVICE_TOKEN}` },
        body: JSON.stringify({
          recipients: targets,
          title: String(title || "CT Campeador").slice(0, 80),
          body: String(body || "").slice(0, 220),
          url: makeAppDeepLink({ ...deepLink, player }),
          tag: `ctc-${String(deepLink?.open || "notice").slice(0, 24)}-${Date.now()}-${encodeURIComponent(player).slice(0, 32)}`
        })
      });
      if (!response.ok) console.error("Push de jugador rechazado", response.status);
    } catch (e) {
      console.error("Push de jugador", e);
    }
  }
}
__name(sendTargetedPush, "sendTargetedPush");
__name2(sendTargetedPush, "sendTargetedPush");
function standardSetIsValid(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) return false;
  const w = Math.max(a, b), l = Math.min(a, b);
  return w === 6 && l <= 4 || w === 7 && (l === 5 || l === 6);
}
__name(standardSetIsValid, "standardSetIsValid");
__name2(standardSetIsValid, "standardSetIsValid");
function superTiebreakIsValid(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) return false;
  return Math.max(a, b) >= 10 && Math.abs(a - b) >= 2;
}
__name(superTiebreakIsValid, "superTiebreakIsValid");
__name2(superTiebreakIsValid, "superTiebreakIsValid");
function validateCompletedTennisResult(sets) {
  if (!Array.isArray(sets) || sets.length !== 2 && sets.length !== 3) {
    return { ok: false, error: "Un partido completado debe tener 2 sets o 2 sets m\xE1s super tie-break." };
  }
  if (!standardSetIsValid(sets[0].a, sets[0].b)) {
    return { ok: false, error: "El primer set no tiene un tanteo v\xE1lido de tenis." };
  }
  if (!standardSetIsValid(sets[1].a, sets[1].b)) {
    return { ok: false, error: "El segundo set no tiene un tanteo v\xE1lido de tenis." };
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
    return { ok: false, error: "El tercer set es un super tie-break: m\xEDnimo 10 puntos y diferencia de 2." };
  }
  return { ok: true };
}
__name(validateCompletedTennisResult, "validateCompletedTennisResult");
__name2(validateCompletedTennisResult, "validateCompletedTennisResult");
async function listReservations(env) {
  const r = await bookingCall(env, { action: "list" });
  if (!r.ok) throw new Error(r.error || "No se pudieron leer las reservas");
  return r.reservations || {};
}
__name(listReservations, "listReservations");
__name2(listReservations, "listReservations");
function liveMatchKey(matchId) {
  const input = String(matchId);
  let h1 = 2166136261, h2 = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ input.charCodeAt(i) + i, 16777619);
  }
  return "ct" + (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
__name(liveMatchKey, "liveMatchKey");
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
__name2(findFixture, "findFixture");
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
__name2(sanitizeSets, "sanitizeSets");
function doJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" }
  });
}
__name(doJson, "doJson");
__name2(doJson, "doJson");
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
__name(json, "json");
__name2(json, "json");
function normalize(text) {
  return String(text || "").trim().toLocaleLowerCase("es");
}
__name(normalize, "normalize");
__name2(normalize, "normalize");
async function familyPinHash(pin, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 1e5 }, key, 256);
  return Array.from(new Uint8Array(derived), (v) => v.toString(16).padStart(2, "0")).join("");
}
__name(familyPinHash, "familyPinHash");
function secureEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(secureEqualString, "secureEqualString");
async function getState(env) {
  const r = await bookingCall(env, { action: "leagueRead" });
  if (!r.ok) throw new Error(r.error || "No se pudo leer la liga desde el coordinador");
  return r.state;
}
__name(getState, "getState");
__name2(getState, "getState");
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
__name(getAdminPrefs, "getAdminPrefs");
async function putAdminPrefs(env, prefs) {
  await env.DATA.put(ADMIN_PREFS_KEY, JSON.stringify(prefs || {}));
}
__name(putAdminPrefs, "putAdminPrefs");
function cleanAdminOrder(value) {
  const allowed = /* @__PURE__ */ new Set([
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
    if (key === "journeyCourts") {
      if (!out.includes("journey")) out.push("journey");
      if (!out.includes("courts")) out.push("courts");
      continue;
    }
    if (allowed.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}
__name(cleanAdminOrder, "cleanAdminOrder");
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
__name2(getProfiles, "getProfiles");
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
  try {
    const state = await getState(env);
    const legacy = Array.isArray(state.messageHistory) ? state.messageHistory : [];
    const migrated = legacy.filter((m) => Array.isArray(m.recipientNames) && m.recipientNames.length).map((m) => ({
      id: String(m.id || `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`),
      at: String(m.at || (/* @__PURE__ */ new Date()).toISOString()),
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
  } catch (_) {
  }
  return [];
}
__name(getMessages, "getMessages");
__name2(getMessages, "getMessages");
async function putMessages(env, messages) {
  const clean = Array.isArray(messages) ? messages.slice(0, 500) : [];
  await env.DATA.put(MESSAGES_KEY, JSON.stringify(clean));
}
__name(putMessages, "putMessages");
__name2(putMessages, "putMessages");
function messageVisibleToUser(message, session) {
  if (session.role === "admin") return true;
  const me = normalize(session.name);
  if (Array.isArray(message?.hiddenBy) && message.hiddenBy.some((name) => normalize(name) === me)) return false;
  return Array.isArray(message?.recipientNames) && message.recipientNames.some((name) => normalize(name) === me);
}
__name(messageVisibleToUser, "messageVisibleToUser");
__name2(messageVisibleToUser, "messageVisibleToUser");
function messageForSession(message, session) {
  const me = normalize(session.name);
  const readBy = Array.isArray(message?.readBy) ? message.readBy : [];
  return {
    id: String(message?.id || ""),
    at: String(message?.at || ""),
    title: String(message?.title || ""),
    body: String(message?.body || ""),
    recipientNames: session.role === "admin" ? message?.recipientNames || [] : void 0,
    recipients: Array.isArray(message?.recipientNames) ? message.recipientNames.length : 0,
    sentBy: String(message?.sentBy || "Administrador"),
    sent: Number(message?.sent || 0),
    read: readBy.some((name) => normalize(name) === me)
  };
}
__name(messageForSession, "messageForSession");
__name2(messageForSession, "messageForSession");
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
__name2(getUsers, "getUsers");
function getToken(request, body) {
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.startsWith("Bearer ")) return authorization.substring(7).trim();
  if (body && body.token) return String(body.token);
  return "";
}
__name(getToken, "getToken");
__name2(getToken, "getToken");
async function getSession(request, body, env) {
  const token = getToken(request, body);
  if (!token) return null;
  const raw = await env.DATA.get(`session:${token}`);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    if (session.securityVersion !== SESSION_SECURITY_VERSION) return null;
    if (session.role === "family") {
      const r = await bookingCall(env, { action: "familyGet", id: session.familyId });
      if (!r.account || r.account.active !== 1) return null;
    }
    return session;
  } catch {
    return null;
  }
}
__name(getSession, "getSession");
__name2(getSession, "getSession");
async function createSession(env, user) {
  const token = crypto.randomUUID();
  const session = { name: user.name, role: user.role || "player", createdAt: (/* @__PURE__ */ new Date()).toISOString(), securityVersion: SESSION_SECURITY_VERSION, ...user.familyId ? { familyId: user.familyId } : {} };
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
__name2(createSession, "createSession");
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
__name2(deleteSession, "deleteSession");
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
__name2(revokeUserSessions, "revokeUserSessions");
async function checkLoginGates(env, keys) {
  for (const key of keys) {
    const gate = await bookingCall(env, { action: "loginGate", key });
    if (!gate.allowed) return gate;
  }
  return { ok: true, allowed: true };
}
__name(checkLoginGates, "checkLoginGates");
__name2(checkLoginGates, "checkLoginGates");
async function registerLoginFailure(env, globalKey, specificKey) {
  await bookingCall(env, { action: "loginFailure", key: globalKey, maxFailures: LOGIN_MAX_FAILURES });
  await bookingCall(env, { action: "loginFailure", key: specificKey, maxFailures: LOGIN_USER_MAX_FAILURES });
}
__name(registerLoginFailure, "registerLoginFailure");
__name2(registerLoginFailure, "registerLoginFailure");
async function clearLoginGates(env, keys) {
  for (const key of keys) await bookingCall(env, { action: "loginSuccess", key });
}
__name(clearLoginGates, "clearLoginGates");
__name2(clearLoginGates, "clearLoginGates");
function loginAttemptKey(request, discriminator) {
  return `${loginGuardKey(request)}|attempt:${normalize(discriminator).slice(0, 80)}`;
}
__name(loginAttemptKey, "loginAttemptKey");
__name2(loginAttemptKey, "loginAttemptKey");
function loginGuardKey(request) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  return `login:${String(ip).split(",")[0].trim()}`;
}
__name(loginGuardKey, "loginGuardKey");
__name2(loginGuardKey, "loginGuardKey");
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
__name2(corsHeadersFor, "corsHeadersFor");
function isAllowedOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === "null" || ALLOWED_ORIGINS.has(origin);
}
__name(isAllowedOrigin, "isAllowedOrigin");
__name2(isAllowedOrigin, "isAllowedOrigin");
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
    fixtureVisibilityOverrides: state.fixtureVisibilityOverrides || {},
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
__name2(stateForSession, "stateForSession");
async function requireUser(request, body, env) {
  const session = await getSession(request, body, env);
  if (!session) return { ok: false, status: 401, error: "Debes iniciar sesi\xF3n." };
  if (session.role === "family") {
    const player = String(body?.familyPlayer || "").trim();
    if (!player) return { ok: false, status: 400, error: "Selecciona un jugador vinculado en Modo Familia." };
    const allowed = await bookingCall(env, { action: "familyAllowed", id: session.familyId, player });
    if (!allowed.allowed) return { ok: false, status: 403, error: "Jugador no vinculado o pendiente de autorizaci\xF3n." };
    const users = await getUsers(env);
    const target = users.find((u) => normalize(u.name) === normalize(player) && u.active !== false && u.role !== "admin");
    if (!target) return { ok: false, status: 403, error: "El jugador ya no est\xE1 activo o no puede delegarse." };
    return { ok: true, session: { ...session, name: target.name, role: "player", familyActor: session.name } };
  }
  return { ok: true, session };
}
__name(requireUser, "requireUser");
__name2(requireUser, "requireUser");
async function requireAdmin(request, body, env) {
  const session = await getSession(request, body, env);
  if (!session) return { ok: false, status: 401, error: "Debes iniciar sesi\xF3n." };
  if (session.role !== "admin") return { ok: false, status: 403, error: "Solo un administrador puede realizar esta acci\xF3n." };
  return { ok: true, session };
}
__name(requireAdmin, "requireAdmin");
__name2(requireAdmin, "requireAdmin");
export {
  BookingCoordinator,
  index_default as default
};
//# sourceMappingURL=index.js.map
