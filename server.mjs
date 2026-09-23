import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const FORMSPREE = process.env.FORMSPREE_URL || "https://formspree.io/f/xppzvjbo";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || process.env.TWILIO_PHONE || "";
const RESEND_FROM = process.env.RESEND_FROM || "TraderOath <onboarding@resend.dev>";
const DEMO = process.env.TRADOVATE_DEMO === "1";
const TV_REST = DEMO
  ? "https://demo.tradovateapi.com/v1"
  : "https://live.tradovateapi.com/v1";
const TV_WS = DEMO
  ? "wss://demo.tradovateapi.com/v1/websocket"
  : "wss://live.tradovateapi.com/v1/websocket";

const oaths = new Map();
const sockets = new Map();
const DATA = join(dirname(fileURLToPath(import.meta.url)), "oaths.json");
const AFF = join(dirname(fileURLToPath(import.meta.url)), "affiliates.json");
const affiliates = new Map();
try {
  const raw = JSON.parse(readFileSync(DATA, "utf8"));
  Object.entries(raw).forEach(([k, v]) => oaths.set(k, v));
} catch {}
try {
  const raw = JSON.parse(readFileSync(AFF, "utf8"));
  Object.entries(raw).forEach(([k, v]) => affiliates.set(k, v));
} catch {}
function save() {
  writeFileSync(DATA, JSON.stringify(Object.fromEntries(oaths), null, 2));
}
function saveAff() {
  writeFileSync(AFF, JSON.stringify(Object.fromEntries(affiliates), null, 2));
}
const TOK = join(dirname(fileURLToPath(import.meta.url)), "tokens.json");
const SITE = process.env.SITE_URL || "https://traderoath.com";
const tokens = new Map();
try {
  const raw = JSON.parse(readFileSync(TOK, "utf8"));
  Object.entries(raw).forEach(([k, v]) => tokens.set(k, v));
} catch {}
function saveTok() {
  writeFileSync(TOK, JSON.stringify(Object.fromEntries(tokens), null, 2));
}
function cleanTok() {
  const now = Date.now();
  for (const [k, v] of tokens) if (!v.exp || v.exp < now) tokens.delete(k);
}
function publicOath(o) {
  if (!o) return null;
  const { tvToken, tvpass, password, sec, ...safe } = o;
  return safe;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function emptyDay() {
  return { date: todayKey(), fills: [], lastWinAt: 0, lastLossAt: 0, realized: 0, blown: false, smsSent: 0 };
}

function dayState(oath) {
  if (!oath.day || oath.day.date !== todayKey()) oath.day = emptyDay();
  return oath.day;
}

async function sendAlert(oath, subject, body) {
  const out = { email: "none", sms: "none" };
  const payload = {
    email: oath.pemail,
    name: oath.pname,
    trader: oath.name,
    _subject: subject,
    message: body,
  };
  if (RESEND_KEY && oath.pemail) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [oath.pemail],
        subject,
        text: body,
      }),
    });
    const errText = res.ok ? "" : await res.text();
    out.email = res.ok ? "resend" : "resend-error";
    if (!res.ok) out.emailError = String(errText).slice(0, 180);
  } else {
    out.email = RESEND_KEY ? "no-lookout-email" : "resend-not-configured";
  }
  if (oath.alert_sms === false || oath.alert_sms === "false") {
    out.sms = "off";
    return out;
  }
  if (!oath.pphone) {
    out.sms = "no-phone-on-oath";
    return out;
  }
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    out.sms = "twilio-not-configured";
    return out;
  }
  const cap = Math.max(0, Number(oath.smsCap || 5));
  const d = dayState(oath);
  if ((d.smsSent || 0) >= cap) {
    out.sms = "capped";
    out.smsCap = cap;
    return out;
  }
  const digits = String(oath.pphone).replace(/[^\d+]/g, "");
  const to = digits.startsWith("+") ? digits : "+1" + digits.replace(/^1/, "");
  const trialBody = process.env.TWILIO_TEMPLATE || "sms_account_alerts";
  const custom = process.env.TWILIO_CUSTOM === "1";
  const bodySms = new URLSearchParams({
    To: to,
    From: TWILIO_FROM,
    Body: custom ? (subject + " — " + body) : trialBody,
  });
  const smsRes = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + TWILIO_SID + "/Messages.json", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(TWILIO_SID + ":" + TWILIO_TOKEN).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodySms,
  });
  const smsJson = await smsRes.json().catch(() => ({}));
  out.sms = smsRes.ok ? "sent" : (smsJson.message || smsJson.code || "twilio-error");
  out.smsTo = to;
  if (smsRes.ok) {
    d.smsSent = (d.smsSent || 0) + 1;
    out.smsLeft = Math.max(0, cap - d.smsSent);
  }
  return out;
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v).toFixed(2);
  return (v < 0 ? "-$" : "$") + abs;
}

function evaluate(oath, fill) {
  const d = dayState(oath);
  const now = Date.now();
  const qty = Number(fill.qty || fill.quantity || 0);
  const symbol = String(fill.contractName || fill.symbol || fill.product || "").toUpperCase();
  const pnl = Number(fill.pnl || fill.realizedPnl || fill.profit || 0);
  const price = Number(fill.price || fill.avgPrice || 0);
  const side = String(fill.side || fill.action || fill.buySell || "").toLowerCase();
  const line = [symbol || "fill"];
  if (side) line.push(side);
  if (qty) line.push("x" + qty);
  if (price) line.push("@ " + price);
  const alerts = [];

  if (oath.alert_entry !== false) {
    alerts.push({
      type: "entry",
      subject: oath.name + " placed a trade",
      body: line.join(" "),
    });
  }

  if (pnl > 0 && oath.alert_win !== false) {
    alerts.push({
      type: "win",
      subject: oath.name + " took a win " + money(pnl),
      body: line.join(" ") + "  closed " + money(pnl) + " profit",
    });
  }
  if (pnl < 0 && oath.alert_loss !== false) {
    alerts.push({
      type: "loss",
      subject: oath.name + " took a loss " + money(pnl),
      body: line.join(" ") + "  closed " + money(pnl),
    });
  }

  if (oath.rule_hours && oath.hourstart && oath.hourend) {
    try {
      const tz = oath.hourtz || "America/New_York";
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(fill.timestamp || now));
      const hh = parts.find((p) => p.type === "hour").value;
      const mm = parts.find((p) => p.type === "minute").value;
      const cur = hh + ":" + mm;
      if (cur < oath.hourstart || cur >= oath.hourend) {
        alerts.push({
          type: "hours",
          subject: oath.name + " traded outside the window",
          body: cur + " " + tz + " is outside " + oath.hourstart + "–" + oath.hourend,
        });
      }
    } catch {}
  }

  if (oath.symbols && oath.symbols.length && symbol) {
    const allowed = oath.symbols.some((s) => symbol.includes(String(s).toUpperCase()));
    if (!allowed) {
      alerts.push({
        type: "product",
        subject: oath.name + " traded off-list",
        body: symbol + " is outside " + oath.symbols.join(", "),
      });
    }
  }

  if (oath.rule_max_contracts && oath.maxcontracts && qty > Number(oath.maxcontracts)) {
    alerts.push({
      type: "size",
      subject: oath.name + " exceeded max contracts",
      body: "Size " + qty + " > max " + oath.maxcontracts,
    });
  }

  const cluster = d.fills.filter((t) => now - t < 15 * 60 * 1000);
  if (oath.rule_cluster && cluster.length >= 1) {
    alerts.push({
      type: "cluster",
      subject: oath.name + " clustered trades",
      body: "More than one fill inside 15 minutes",
    });
  }

  if (oath.rule_win_break && d.lastWinAt && now - d.lastWinAt < 15 * 60 * 1000) {
    alerts.push({
      type: "win-break",
      subject: oath.name + " skipped the post-win break",
      body: "Traded inside 15 minutes after a win",
    });
  }
  if (oath.rule_loss_break && d.lastLossAt && now - d.lastLossAt < 15 * 60 * 1000) {
    alerts.push({
      type: "loss-break",
      subject: oath.name + " skipped the post-loss break",
      body: "Traded inside 15 minutes after a loss",
    });
  }

  if (pnl > 0) d.lastWinAt = now;
  if (pnl < 0) {
    d.lastLossAt = now;
    d.realized += pnl;
  }
  if (oath.rule_max_loss && oath.maxloss && Math.abs(d.realized) >= Number(oath.maxloss) && pnl < 0) {
    alerts.push({
      type: "max-loss",
      subject: oath.name + " hit daily max loss",
      body: "Realized " + d.realized + " vs max " + oath.maxloss,
    });
  }
  if (oath.rule_blown && fill.blown) {
    alerts.push({ type: "blown", subject: oath.name + " blew the account", body: "Account blown flag from broker" });
  }

  d.fills.push(now);
  return alerts;
}

function tvHosts(demo) {
  return demo
    ? { rest: "https://demo.tradovateapi.com/v1", ws: "wss://demo.tradovateapi.com/v1/websocket" }
    : { rest: "https://live.tradovateapi.com/v1", ws: "wss://live.tradovateapi.com/v1/websocket" };
}

async function tradovateToken(creds) {
  const rest = tvHosts(creds.demo).rest;
  const res = await fetch(rest + "/auth/accessTokenRequest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: creds.name,
      password: creds.password,
      appId: creds.appId || "TraderOath",
      appVersion: creds.appVersion || "0.1",
      cid: Number(creds.cid || 0),
      sec: creds.sec,
      deviceId: creds.deviceId || "traderoath-" + creds.name,
    }),
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error(data.errorText || "Tradovate auth failed");
  return data;
}

function watchTradovate(oathId, accessToken, userId, demo) {
  if (sockets.has(oathId)) {
    try { sockets.get(oathId).close(); } catch {}
  }
  const ws = new WebSocket(tvHosts(demo).ws);
  sockets.set(oathId, ws);
  let n = 1;
  ws.addEventListener("open", () => {
    ws.send("authorize\n0\n\n" + accessToken);
  });
  ws.addEventListener("message", async (ev) => {
    const raw = String(ev.data || "");
    const kind = raw[0];
    if (kind === "h") return;
    if (kind === "o") return;
    if (kind !== "a") return;
    let frames;
    try { frames = JSON.parse(raw.slice(1)); } catch { return; }
    for (const frame of frames) {
      if (frame.s === 200 && frame.i === 0) {
        ws.send("user/syncrequest\n" + n++ + "\n\n" + JSON.stringify({ users: [userId] }));
        continue;
      }
      const evnt = frame.e === "props" ? frame.d : frame.d && frame.d.entityType ? frame.d : null;
      if (!evnt) continue;
      const type = evnt.entityType;
      const entity = evnt.entity || {};
      if (type !== "fill" && type !== "executionReport" && type !== "order") continue;
      if (type === "order" && entity.ordStatus && entity.ordStatus !== "Filled") continue;
      const oath = oaths.get(oathId);
      if (!oath) continue;
      const alerts = evaluate(oath, entity);
      for (const a of alerts) await sendAlert(oath, a.subject, a.body);
    }
  });
  ws.addEventListener("close", () => {
    sockets.delete(oathId);
    setTimeout(() => {
      const o = oaths.get(oathId);
      if (o && o.tvToken) watchTradovate(oathId, o.tvToken, o.tvUserId, o.tvDemo);
    }, 5000);
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    },
  });
}

const server = await import("node:http").then(({ createServer }) =>
      createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "content-type",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          });
          return res.end();
        }
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = {};
        try { if (raw) body = JSON.parse(raw); } catch {}
        const out = await handle(req.method, url.pathname, body, url.searchParams);
        res.writeHead(out.status, Object.fromEntries(out.headers));
        res.end(await out.text());
      })
    );

async function handle(method, path, body, query = new URLSearchParams()) {
  if (path === "/health") {
    return json({ ok: true, oaths: oaths.size, twilio: !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM), resend: !!RESEND_KEY });
  }

  if (path === "/auth/link" && method === "POST") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return json({ ok: false, error: "Email required" }, 400);
    const found = [...oaths.values()].filter((o) => String(o.email || "").toLowerCase() === email);
    if (!found.length) {
      return json({ ok: true, sent: true });
    }
    cleanTok();
    const token = crypto.randomUUID();
    tokens.set(token, {
      email,
      ids: found.map((o) => o.id),
      exp: Date.now() + 24 * 60 * 60 * 1000,
    });
    saveTok();
    const links = found.map((o) =>
      SITE + "/rules.html?id=" + encodeURIComponent(o.id) + "&token=" + token
    ).join("\n");
    const first = found[0];
    await sendAlert(
      { pemail: email, pname: first.name || "Trader", name: "TraderOath" },
      "Your TraderOath link",
      "This link opens your locked rules. It dies in 24 hours.\n\n" + links +
        "\n\nA change still needs your lookout to confirm."
    );
    return json({ ok: true, sent: true });
  }

  if (path === "/auth/session" && method === "GET") {
    const token = query.get("token") || "";
    const row = tokens.get(token);
    if (!row || row.exp < Date.now()) return json({ ok: false, error: "Link expired" }, 401);
    const list = row.ids.map((id) => publicOath(oaths.get(id))).filter(Boolean);
    return json({ ok: true, email: row.email, oaths: list });
  }

  if (path === "/affiliate" && method === "POST") {
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 3) return json({ ok: false, error: "Code too short" }, 400);
    if (affiliates.has(code)) return json({ ok: false, error: "Code taken" }, 409);
    affiliates.set(code, {
      code,
      name: body.name || "",
      email: body.email || "",
      payout: body.payout || "",
      createdAt: new Date().toISOString(),
      signups: 0,
    });
    saveAff();
    return json({ ok: true, code, link: "https://traderoath.com/?ref=" + code });
  }

  if (path.startsWith("/affiliate/") && method === "GET") {
    const code = path.slice("/affiliate/".length).toUpperCase();
    const row = affiliates.get(code);
    if (!row) return json({ ok: false, error: "Unknown code" }, 404);
    return json({ ok: true, affiliate: { code: row.code, name: row.name, signups: row.signups } });
  }

  if (path === "/oath" && method === "POST") {
    const id = body.id || crypto.randomUUID();
    const code = String(body.affiliate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code && affiliates.has(code)) {
      const a = affiliates.get(code);
      a.signups = (a.signups || 0) + 1;
      saveAff();
    }
    const hookKey = body.hookKey || crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    oaths.set(id, {
      ...body,
      id,
      hookKey,
      affiliate: code || "",
      paid: false,
      accepted: false,
      locked: false,
      pendingRules: null,
      day: emptyDay(),
    });
    save();
    const oath = oaths.get(id);
    const accept = SITE + "/accept.html?id=" + encodeURIComponent(id) +
      "&from=" + encodeURIComponent(oath.name || "") + "&to=" + encodeURIComponent(oath.pname || "");
    if (oath.pemail) {
      await sendAlert(
        oath,
        (oath.name || "A trader") + " asked you to hold their TraderOath",
        (oath.pname || "Lookout") + ",\n\n" +
          (oath.name || "A trader") + " asked you to hold their rules.\nAccept: " + accept
      );
    }
    return json({
      ok: true,
      id,
      affiliate: code || null,
      hookKey,
      webhook: SITE.replace(/\/$/, "") && process.env.ENGINE_PUBLIC_URL
        ? process.env.ENGINE_PUBLIC_URL.replace(/\/$/, "") + "/webhook/ninjatrader?key=" + hookKey
        : "/webhook/ninjatrader?key=" + hookKey,
    });
  }

  const oathMatch = path.match(/^\/oath\/([^/]+)(?:\/(accept|rules|confirm))?$/);
  if (oathMatch) {
    const id = oathMatch[1];
    const action = oathMatch[2] || "";
    const oath = oaths.get(id);
    if (!oath) return json({ ok: false, error: "Unknown oath" }, 404);

    if (method === "GET" && !action) return json({ ok: true, oath: publicOath(oath) });

    if (action === "accept" && method === "POST") {
      oath.accepted = true;
      oath.locked = true;
      oath.acceptedAt = new Date().toISOString();
      save();
      return json({ ok: true, oath: publicOath(oath) });
    }

    if (action === "rules" && method === "POST") {
      const next = body.rules || body;
      if (!oath.locked) {
        Object.assign(oath, next);
        save();
        return json({ ok: true, applied: true, oath: publicOath(oath) });
      }
      oath.pendingRules = next;
      save();
      await sendAlert(
        oath,
        oath.name + " wants to change the oath",
        "Rules stay locked until you confirm.\nConfirm: https://traderoath.com/accept.html?id=" +
          id +
          "&change=1\nProposed: " +
          JSON.stringify(next)
      );
      return json({ ok: true, applied: false, pending: true });
    }

    if (action === "confirm" && method === "POST") {
      if (oath.pendingRules) Object.assign(oath, oath.pendingRules);
      oath.pendingRules = null;
      oath.locked = true;
      save();
      return json({ ok: true, oath: publicOath(oath) });
    }
  }

  if (path === "/connect/tradovate" && method === "POST") {
    let id = body.id;
    let oath = id ? oaths.get(id) : null;
    if (!oath) {
      id = crypto.randomUUID();
      oaths.set(id, { ...body, id, paid: true, accepted: false, locked: false, day: emptyDay() });
      oath = oaths.get(id);
    }
    try {
      const tok = await tradovateToken(body);
      const rest = tvHosts(!!body.demo).rest;
      const listRes = await fetch(rest + "/account/list", {
        headers: { Authorization: "Bearer " + tok.accessToken },
      });
      const accounts = await listRes.json().catch(() => []);
      oath.tvToken = tok.accessToken;
      oath.tvUserId = tok.userId;
      oath.tvDemo = !!body.demo;
      oath.platform = "tradovate";
      oath.tvAccounts = Array.isArray(accounts) ? accounts : [];
      save();
      return json({
        ok: true,
        id,
        userId: tok.userId,
        accounts: (Array.isArray(accounts) ? accounts : []).map((a) => ({
          id: a.id,
          name: a.name || a.nickname || String(a.id),
          active: a.active !== false,
        })),
      });
    } catch (err) {
      return json({
        ok: false,
        error: String(err.message || err),
        hint: "Prop and eval Tradovate logins usually have no API. Tradovate requires a live funded account plus the $25 API add-on.",
      }, 401);
    }
  }

  if (path === "/connect/tradovate/watch" && method === "POST") {
    const oath = oaths.get(body.id);
    if (!oath || !oath.tvToken) return json({ ok: false, error: "Log into Tradovate first" }, 400);
    oath.tvAccountId = body.accountId;
    watchTradovate(body.id, oath.tvToken, oath.tvUserId, oath.tvDemo);
    save();
    return json({ ok: true, watching: body.accountId });
  }

  if (path === "/webhook/ninjatrader" && method === "POST") {
    const key = query.get("key") || body.key || body.hookKey || "";
    const oath = [...oaths.values()].find(
      (o) =>
        (key && o.hookKey === key) ||
        o.id === body.id ||
        (body.email && String(o.email || "").toLowerCase() === String(body.email).toLowerCase())
    );
    if (!oath) return json({ ok: false, error: "Unknown oath" }, 404);
    const fill = {
      symbol: body.symbol || body.instrument || body.Instrument || body.contractName || "",
      qty: body.qty || body.quantity || body.Quantity || 0,
      pnl: body.pnl || body.PnL || body.realizedPnl || body.profit || 0,
      price: body.price || body.avgPrice || body.Price || 0,
      side: body.side || body.action || body.buySell || "",
      timestamp: body.timestamp || Date.now(),
    };
    const alerts = evaluate(oath, fill);
    let delivery = { email: "none", sms: "none", phone: oath.pphone || "" };
    for (const a of alerts) delivery = await sendAlert(oath, a.subject, a.body);
    save();
    return json({ ok: true, alerts: alerts.length, delivery });
  }

  if (path === "/checkout" && method === "POST") {
    if (!STRIPE_KEY) return json({ ok: false, error: "Stripe is not configured" }, 501);
    const oathId = body.id || "";
    const email = body.email || "";
    const params = new URLSearchParams();
    params.set("mode", "subscription");
    params.set("success_url", SITE + "/connect.html?paid=1");
    params.set("cancel_url", SITE + "/pay.html?canceled=1");
    if (oathId) params.set("client_reference_id", oathId);
    if (email) params.set("customer_email", email);
    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][unit_amount]", "999");
    params.set("line_items[0][price_data][recurring][interval]", "month");
    params.set("line_items[0][price_data][product_data][name]", "TraderOath founding");
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + STRIPE_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const session = await res.json();
    if (!session.url) return json({ ok: false, error: session.error?.message || "Stripe failed" }, 400);
    return json({ ok: true, url: session.url });
  }

  if (path === "/stripe/webhook" && method === "POST") {
    const event = body;
    const session = event.data && event.data.object;
    if (event.type === "checkout.session.completed" && session) {
      const id = session.client_reference_id;
      const oath = oaths.get(id) || [...oaths.values()].find((o) => o.email === session.customer_email);
      if (oath) {
        oath.paid = true;
        oath.stripeCustomer = session.customer || "";
        save();
      }
    }
    return json({ received: true });
  }

  return json({ ok: false, error: "Not found" }, 404);
}

server.listen(PORT, "0.0.0.0", () => console.log("TraderOath engine on " + PORT));
