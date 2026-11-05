const SESSION_COOKIE = "aircon_admin";
const SESSION_SECONDS = 60 * 60 * 8;
const MAX_DATA_BYTES = 1_000_000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

async function signSession(expiresAt, secret) {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ expiresAt })),
  );
  const signature = bytesToBase64Url(await hmac(payload, secret));
  return `${payload}.${signature}`;
}

async function hasAdminSession(request, secret) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return false;

  const [payload, signature, extra] = match[1].split(".");
  if (!payload || !signature || extra) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(payload),
    );
    if (!valid) return false;
    const session = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    return Number.isSafeInteger(session.expiresAt) && session.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function hasSameOrigin(request) {
  return request.headers.get("origin") === new URL(request.url).origin;
}

function setSessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${maxAge}`;
}

async function login(request, env) {
  if (!hasSameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: "Admin authentication is not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (typeof body.password !== "string" || body.password.length > 1024) {
    return json({ error: "Invalid password" }, 400);
  }

  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.password)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ADMIN_PASSWORD)),
  ]);
  const actualBytes = new Uint8Array(actual);
  const expectedBytes = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < actualBytes.length; i += 1) {
    difference |= actualBytes[i] ^ expectedBytes[i];
  }
  if (difference !== 0) return json({ error: "Incorrect password" }, 401);

  const token = await signSession(Date.now() + SESSION_SECONDS * 1000, env.SESSION_SECRET);
  return json(
    { authenticated: true },
    200,
    { "set-cookie": setSessionCookie(token, SESSION_SECONDS) },
  );
}

async function handleApi(request, env) {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/data" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT payload FROM site_data WHERE id = 1").first();
    return json(row ? JSON.parse(row.payload) : null);
  }

  if (pathname === "/api/admin/login" && request.method === "POST") {
    return login(request, env);
  }

  if (pathname === "/api/admin/logout" && request.method === "POST") {
    if (!hasSameOrigin(request)) return json({ error: "Forbidden" }, 403);
    return json(
      { authenticated: false },
      200,
      { "set-cookie": setSessionCookie("", 0) },
    );
  }

  if (pathname === "/api/admin/data" && request.method === "PUT") {
    if (!env.SESSION_SECRET || !(await hasAdminSession(request, env.SESSION_SECRET))) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (!hasSameOrigin(request)) return json({ error: "Forbidden" }, 403);

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_DATA_BYTES) return json({ error: "Data is too large" }, 413);

    let data;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_DATA_BYTES) {
        return json({ error: "Data is too large" }, 413);
      }
      data = JSON.parse(body);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      !data.models ||
      typeof data.models !== "object" ||
      Array.isArray(data.models) ||
      !data.specData ||
      typeof data.specData !== "object" ||
      Array.isArray(data.specData)
    ) {
      return json({ error: "Expected models and specData objects" }, 400);
    }
    if (
      "brands" in data &&
      (!Array.isArray(data.brands) ||
        data.brands.some(
          (brand) =>
            !brand ||
            typeof brand !== "object" ||
            typeof brand.b !== "string" ||
            !brand.b.trim() ||
            typeof brand.o !== "string" ||
            typeof brand.sEn !== "string" ||
            typeof brand.sCn !== "string" ||
            typeof brand.kEn !== "string" ||
            typeof brand.kCn !== "string" ||
            typeof brand.c !== "string" ||
            !/^#[0-9a-f]{6}(?:\|#[0-9a-f]{6})?$/i.test(brand.c) ||
            !Number.isFinite(brand.lo) ||
            !Number.isFinite(brand.hi) ||
            ![1, 1.5, 2, 2.5, 3, 4].includes(brand.lo) ||
            ![1, 1.5, 2, 2.5, 3, 4].includes(brand.hi) ||
            brand.lo <= 0 ||
            brand.hi < brand.lo ||
            typeof brand.inv !== "boolean",
        ) ||
        new Set(data.brands.map((brand) => brand.b.toLowerCase())).size !==
          data.brands.length)
    ) {
      return json({ error: "Expected a valid, unique brands list" }, 400);
    }

    await env.DB.prepare(
      "INSERT INTO site_data (id, payload, updated_at) VALUES (1, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
    )
      .bind(JSON.stringify(data), new Date().toISOString())
      .run();
    return json({ saved: true });
  }

  if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return env.ASSETS.fetch(new Request(new URL("/aircon.html", url), request));
    }
    const response = await handleApi(request, env);
    if (response) return response;
    return env.ASSETS.fetch(request);
  },
};
