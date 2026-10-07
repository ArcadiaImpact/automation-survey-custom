// Automation survey write API (Cloudflare Worker + D1).
//   POST /         draft or final snapshot from the survey page → ack JSON
//   GET  /         health check
//   GET  /export   events after a cursor, for the Sheet mirror (bearer secret)
//   cron           hourly removal of drafts idle for 48 h
import { parseRequest, MAX_BODY, result } from "./validate.js";
import { createStore, writeSnapshot, exportEvents, deleteExpiredDrafts, EXPORT_PAGE_LIMIT } from "./write.js";

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  },
};

export async function runCleanup(env) {
  const removed = await deleteExpiredDrafts(createStore(env.DB), new Date());
  console.log(`Expired drafts removed: ${removed.responses}; events removed: ${removed.events}`);
  return removed;
}

export function allowedOrigin(origin, configured) {
  if (!origin) return null;
  const list = String(configured || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

// Constant-time comparison; portable (no crypto.subtle.timingSafeEqual in Node tests).
export function secretsMatch(given, expected) {
  const a = new TextEncoder().encode(String(given ?? ""));
  const b = new TextEncoder().encode(String(expected ?? ""));
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigin(origin, env.ALLOWED_ORIGINS);
  if (origin && !allowed) return new Response("Forbidden", { status: 403 });
  const cors = allowed ? { "Access-Control-Allow-Origin": allowed, Vary: "Origin" } : {};

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (url.pathname === "/" && request.method === "GET") {
    return json({ ok: true, message: "Automation survey endpoint is running." }, 200, cors);
  }
  if (url.pathname === "/" && request.method === "POST") {
    return json(await handleWrite(request, env), 200, cors);
  }
  if (url.pathname === "/export" && request.method === "GET") {
    return handleExport(request, env, url);
  }
  return new Response("Not found", { status: 404 });
}

async function handleWrite(request, env) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY * 4) {
    return result(false, "too_large", "Response is too large.");
  }
  let body;
  try {
    body = await request.text();
  } catch (err) {
    return result(false, "invalid_request", "Unreadable request body.");
  }
  const parsed = parseRequest(body);
  if (!parsed.ok) return parsed;
  try {
    return await writeSnapshot(createStore(env.DB), parsed.value, body, new Date());
  } catch (err) {
    console.error("write failed", (err && err.stack) || err);
    return result(false, "server_error", "The response could not be saved.");
  }
}

async function handleExport(request, env, url) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.EXPORT_SECRET || !secretsMatch(token, env.EXPORT_SECRET)) {
    return json({ ok: false, code: "unauthorized", message: "Unauthorized." }, 401, {});
  }
  const after = Math.max(0, Math.floor(Number(url.searchParams.get("after")) || 0));
  const limit = url.searchParams.get("limit") ?? EXPORT_PAGE_LIMIT;
  const page = await exportEvents(createStore(env.DB), after, limit);
  return json({ ok: true, ...page }, 200, {});
}
