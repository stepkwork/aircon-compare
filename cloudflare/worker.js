const SESSION_COOKIE = "aircon_admin";
const SESSION_SECONDS = 60 * 60 * 8;
const MAX_DATA_BYTES = 1_000_000;
const MAX_TRANSLATION_LENGTH = 2_000;
const MAX_TRANSLATION_REQUEST_BYTES = 16_000;
const MAX_AUTOFILL_REQUEST_BYTES = 8_000_000;
const MAX_AUTOFILL_PAGE_BYTES = 1_500_000;
const MAX_AUTOFILL_TEXT_CHARS = 30_000;
const AUTOFILL_TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const AUTOFILL_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const AUTOFILL_FEATURES = ["Wi-Fi", "Self-cleaning", "Air purification", "Inverter", "Sleep mode", "Eco mode", "Voice control"];
const AUTOFILL_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

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
  const origin = request.headers.get("origin");
  // Wrangler remote previews rewrite request.url, but preserve browser Fetch Metadata.
  return (
    origin === new URL(request.url).origin ||
    (origin !== null && request.headers.get("sec-fetch-site") === "same-origin")
  );
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

async function translateSellingPoint(request, env) {
  if (!env.SESSION_SECRET || !(await hasAdminSession(request, env.SESSION_SECRET))) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!hasSameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!env.AI) return json({ error: "Cloudflare Workers AI is not configured" }, 503);
  if (Number(request.headers.get("content-length") || 0) > MAX_TRANSLATION_REQUEST_BYTES) {
    return json({ error: "Translation request is too large" }, 413);
  }

  let body;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_TRANSLATION_REQUEST_BYTES) {
      return json({ error: "Translation request is too large" }, 413);
    }
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof body.text !== "string" ||
    !body.text.trim() ||
    body.text.length > MAX_TRANSLATION_LENGTH
  ) {
    return json(
      { error: `Enter English text between 1 and ${MAX_TRANSLATION_LENGTH} characters` },
      400,
    );
  }

  try {
    const result = await env.AI.run("@cf/meta/m2m100-1.2b", {
      text: body.text.trim(),
      source_lang: "en",
      target_lang: "zh",
    });
    if (typeof result?.translated_text !== "string" || !result.translated_text.trim()) {
      console.error("[aircon-compare] Workers AI returned an invalid translation response");
      return json({ error: "Translation service returned an invalid response" }, 502);
    }
    return json({ translation: result.translated_text.trim() });
  } catch (error) {
    console.error("[aircon-compare] Selling-point translation failed:", error);
    return json({ error: "Translation failed. Please try again." }, 502);
  }
}

const AUTOFILL_PROMPT = `Extract air conditioner specifications for ONE model from the provided content.
Return ONLY a JSON object, no markdown, no explanation.
Use null for anything not clearly stated in the content. NEVER guess, infer or calculate missing values.
If the content lists several models and no target model is given below, extract only the first model shown.

{
  "indoor_model": string|null,
  "outdoor_model": string|null,
  "horsepower": number|null,
  "voltage": string|null,
  "frequency": number|null,
  "phase": number|null,
  "cooling_input_kw": number|null,
  "cooling_current_a": number|null,
  "cooling_capacity_btu": number|null,
  "cspf": number|null,
  "energy_stars": number|null,
  "airflow_m3h": number|null,
  "indoor": { "w": number|null, "d": number|null, "h": number|null, "net_weight_kg": number|null, "gross_weight_kg": number|null, "weight_kg": number|null, "noise_db": number[] },
  "outdoor": { "w": number|null, "d": number|null, "h": number|null, "net_weight_kg": number|null, "gross_weight_kg": number|null, "weight_kg": number|null, "noise_db": number[] },
  "refrigerant": string|null,
  "features": string[],
  "warranty": string|null,
  "price": number|null
}

Rules: voltage as written (e.g. "220-240"); cooling capacity in BTU/hr; cooling input in kW; dimensions in mm (width, depth, height);
cooling input must be converted to kW if the source gives watts (1090 W = 1.09);
weights in kg: net_weight_kg and gross_weight_kg when the source labels them, otherwise only weight_kg;
noise_db is a list of every dB(A) value shown for that unit in the order given (e.g. [38, 35, 32] for high/medium/low speed), or [] if none; airflow in m3/h; energy_stars 1-5;
features only from: ${AUTOFILL_FEATURES.join(", ")}; price as a number without currency.`;

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host.includes(":")) return true; // IPv6 literals are not supported
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (octets) {
    const [a, b] = [Number(octets[1]), Number(octets[2])];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  return !host.includes(".");
}

function parseAutofillUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || isBlockedHost(url.hostname)) {
    return null;
  }
  return url;
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(tr|li|p|div|h[1-6]|table|section|dt|dd)>|<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\r\f]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchPageText(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(url.href, {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; AirconCompareAutofill/1.0)", accept: "text/html,*/*;q=0.8" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      const next = parseAutofillUrl(new URL(response.headers.get("location"), url).href);
      if (!next) throw new AutofillError("The page redirects to an address that is not allowed.", 422);
      url = next;
      continue;
    }
    if (!response.ok) throw new AutofillError(`The page could not be opened (HTTP ${response.status}).`, 422);
    const type = response.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      throw new AutofillError("That link is not a web page. Upload it as an image instead.", 422);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < MAX_AUTOFILL_PAGE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    reader.cancel().catch(() => {});
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return htmlToText(new TextDecoder().decode(bytes)).slice(0, MAX_AUTOFILL_TEXT_CHARS);
  }
  throw new AutofillError("The page redirects too many times.", 422);
}

class AutofillError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function pickText(value, max = 120) {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, max);
  return text || null;
}

function pickNumber(value, min, max) {
  const number = typeof value === "string" ? Number(value.replace(/,/g, "")) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= min && number <= max ? number : null;
}

// Turns the model output into the admin form's field names. Anything missing or
// implausible is dropped so the form never receives a guessed value.
function mapAutofill(raw) {
  const data = {};
  const warnings = [];
  const set = (key, value) => { if (value !== null && value !== undefined) data[key] = String(value); };
  const src = raw && typeof raw === "object" ? raw : {};

  set("code", pickText(src.indoor_model));
  set("outModel", pickText(src.outdoor_model));
  const hp = pickNumber(src.horsepower, 0.5, 10);
  if (hp !== null) set("hp", hp.toFixed(1));
  set("voltage", pickText(src.voltage, 20));
  set("frequency", pickNumber(src.frequency, 40, 70));
  set("phase", pickNumber(src.phase, 1, 3));

  const input = pickNumber(src.cooling_input_kw, 0.05, 50);
  if (input !== null) { set("input", input); data.inputUnit = "kW"; }
  set("current", pickNumber(src.cooling_current_a, 0.1, 100));
  const cap = pickNumber(src.cooling_capacity_btu, 5000, 60000);
  if (cap !== null) { set("cap", cap); data.capUnit = "BTU/hr"; }
  else if (src.cooling_capacity_btu != null) warnings.push("Cooling capacity looked wrong, so it was left blank.");
  set("cspf", pickNumber(src.cspf, 1, 12));
  const stars = pickNumber(src.energy_stars, 1, 5);
  if (stars !== null) set("stars", Math.round(stars));
  const airflow = pickNumber(src.airflow_m3h, 50, 10000);
  if (airflow !== null) { set("airflow", airflow); data.airflowUnit = "m³/h"; }

  for (const [from, dim, wt, noise] of [["indoor", "idim", "iwt", "inoise"], ["outdoor", "odim", "owt", "onoise"]]) {
    const unit = src[from] && typeof src[from] === "object" ? src[from] : {};
    const parts = ["w", "d", "h"].map((axis) => pickNumber(unit[axis], 50, 3000));
    if (parts.every((part) => part !== null)) { data[dim] = parts.join("x"); data[dim + "Unit"] = "mm"; }
    const net = pickNumber(unit.net_weight_kg, 1, 300);
    const gross = pickNumber(unit.gross_weight_kg, 1, 300);
    if (net !== null && gross !== null) set(wt, `${net}/${gross}`);
    else set(wt, net ?? gross ?? pickNumber(unit.weight_kg, 1, 300));
    const levels = (Array.isArray(unit.noise_db) ? unit.noise_db : [unit.noise_db])
      .map((value) => pickNumber(value, 10, 100))
      .filter((value) => value !== null)
      .slice(0, 4);
    if (levels.length) set(noise, levels.join("/"));
  }

  const refrigerant = pickText(src.refrigerant, 20);
  if (refrigerant) {
    const known = ["R32", "R410A", "R22"].find((name) => name === refrigerant.toUpperCase().replace(/[\s-]/g, ""));
    if (known) data.ref = known;
    else { data.ref = "Other"; data.refOther = refrigerant; }
  }
  if (Array.isArray(src.features)) {
    const features = AUTOFILL_FEATURES.filter((name) => src.features.includes(name));
    if (features.length) data.features = features;
  }
  set("warranty", pickText(src.warranty, 80));
  set("price", pickNumber(src.price, 1, 1_000_000));
  return { data, warnings };
}

function aiText(result) {
  const out = result && (result.response ?? result.result?.response ?? result);
  return typeof out === "string" ? out : out && typeof out === "object" ? JSON.stringify(out) : "";
}

function targetHint(target) {
  if (!target) return "";
  return `\n\nThe content may be a table with several models in columns.
Extract ONLY the column for this model: "${target}". Match by model code first, otherwise by horsepower
(1.0HP is about 9,000-9,500 BTU/hr, 1.5HP about 12,000-13,000, 2.0HP about 18,000-19,000, 2.5HP about 22,000-24,000).
Never mix values from different columns. If you cannot tell which column is the target, return null for every field.`;
}

async function runAutofill(env, input) {
  let text;
  try {
    if (input.image) {
      const run = () =>
        env.AI.run(AUTOFILL_VISION_MODEL, {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: AUTOFILL_PROMPT + targetHint(input.target) },
              { type: "image_url", image_url: { url: `data:${input.image.mime};base64,${input.image.data}` } },
            ],
          }],
          max_tokens: 1500,
          temperature: 0,
        });
      let result;
      try {
        result = await run();
      } catch (error) {
        // Meta's vision model needs its licence accepted once per account.
        if (!/agree|licen[cs]e|5016/i.test(String(error?.message || error))) throw error;
        await env.AI.run(AUTOFILL_VISION_MODEL, { prompt: "agree" });
        result = await run();
      }
      text = aiText(result);
    } else {
      const result = await env.AI.run(AUTOFILL_TEXT_MODEL, {
        messages: [{ role: "user", content: `${AUTOFILL_PROMPT}${targetHint(input.target)}\n\nPAGE CONTENT:\n${input.text}` }],
        max_tokens: 1500,
        temperature: 0,
      });
      text = aiText(result);
    }
  } catch (error) {
    console.error("[aircon-compare] Autofill model error:", error);
    throw new AutofillError("The recognition service failed. Please try again.", 502);
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new AutofillError("Nothing could be read from that content.", 422);
  try {
    return mapAutofill(JSON.parse(match[0]));
  } catch {
    throw new AutofillError("Nothing could be read from that content.", 422);
  }
}

async function autofillSpecs(request, env) {
  if (!env.SESSION_SECRET || !(await hasAdminSession(request, env.SESSION_SECRET))) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!hasSameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!env.AI) return json({ error: "Cloudflare Workers AI is not configured" }, 503);
  if (Number(request.headers.get("content-length") || 0) > MAX_AUTOFILL_REQUEST_BYTES) {
    return json({ error: "The file is too large (limit about 5 MB)." }, 413);
  }

  try {
    const rawBody = await request.text();
    if (rawBody.length > MAX_AUTOFILL_REQUEST_BYTES) {
      return json({ error: "The file is too large (limit about 5 MB)." }, 413);
    }
    let body;
    try { body = JSON.parse(rawBody); } catch { return json({ error: "Invalid JSON" }, 400); }
    if (!body || typeof body !== "object") return json({ error: "Invalid request" }, 400);

    const target = pickText(body.target, 120);
    let content;
    if (body.file) {
      const { mime, data } = body.file;
      if (!AUTOFILL_MIME_TYPES.includes(mime) || typeof data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(data)) {
        return json({ error: "Upload a JPG, PNG or WebP image." }, 400);
      }
      content = { image: { mime, data }, target };
    } else {
      const url = parseAutofillUrl(body.url);
      if (!url) return json({ error: "Enter a valid public web address (https://…)." }, 400);
      const text = await fetchPageText(url);
      if (text.length < 200) {
        return json({ error: "That page has too little readable text (it may load its details with JavaScript). Upload a screenshot instead." }, 422);
      }
      content = { text, target };
    }

    const { data, warnings } = await runAutofill(env, content);
    if (!Object.keys(data).length) {
      return json({ error: "No specifications could be recognised, so nothing was filled." }, 422);
    }
    return json({ data, warnings });
  } catch (error) {
    if (error instanceof AutofillError) return json({ error: error.message }, error.status);
    console.error("[aircon-compare] Autofill failed:", error);
    return json({ error: "Auto-fill failed. Please try again." }, 502);
  }
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

  if (pathname === "/api/admin/translate" && request.method === "POST") {
    return translateSellingPoint(request, env);
  }

  if (pathname === "/api/admin/autofill" && request.method === "POST") {
    return autofillSpecs(request, env);
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
