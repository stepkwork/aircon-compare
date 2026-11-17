import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

function makeEnv() {
  const store = { value: null, aiInput: null };
  return {
    store,
    env: {
      ADMIN_PASSWORD: "test-admin-password",
      SESSION_SECRET: "a-test-session-signing-secret-that-is-long-enough",
      AI: {
        async run(model, input) {
          store.aiInput = { model, input };
          return { translated_text: "安静可靠" };
        },
      },
      ASSETS: {
        async fetch(request) {
          return new Response(new URL(request.url).pathname);
        },
      },
      DB: {
        prepare(query) {
          let values = [];
          return {
            bind(...args) {
              values = args;
              return this;
            },
            async first() {
              if (query.startsWith("SELECT")) {
                return store.value ? { payload: store.value } : null;
              }
              return null;
            },
            async run() {
              store.value = values[0];
              return { success: true };
            },
          };
        },
      },
    },
  };
}

function request(path, { method = "GET", headers = {}, body } = {}) {
  return new Request(`https://aircon.example${path}`, {
    method,
    headers,
    body,
  });
}

test("serves the comparison page at the root", async () => {
  const { env } = makeEnv();
  const response = await worker.fetch(request("/"), env);
  assert.equal(await response.text(), "/aircon.html");
});

test("requires same-origin admin login and persists protected data", async () => {
  const { env } = makeEnv();
  const wrongOrigin = await worker.fetch(
    request("/api/admin/login", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ password: "test-admin-password" }),
    }),
    env,
  );
  assert.equal(wrongOrigin.status, 403);

  const remotePreviewLogin = await worker.fetch(
    request("/api/admin/login", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:8080",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: "test-admin-password" }),
    }),
    env,
  );
  assert.equal(remotePreviewLogin.status, 200);

  const login = await worker.fetch(
    request("/api/admin/login", {
      method: "POST",
      headers: { origin: "https://aircon.example", "content-type": "application/json" },
      body: JSON.stringify({ password: "test-admin-password" }),
    }),
    env,
  );
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];

  const data = {
    models: { Daikin: { series: [] } },
    specData: {},
  };
  const dataWithBrands = {
    ...data,
    brands: [
      {
        b: "Daikin",
        o: "Japan",
        sEn: "Quiet and reliable",
        sCn: "安静可靠",
        kEn: "Coanda airflow",
        kCn: "康达气流",
        c: "#0090D0",
        lo: 1,
        hi: 4,
        inv: true,
      },
    ],
  };
  const save = await worker.fetch(
    request("/api/admin/data", {
      method: "PUT",
      headers: {
        origin: "https://aircon.example",
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    }),
    env,
  );
  assert.equal(save.status, 200);

  const read = await worker.fetch(request("/api/data"), env);
  assert.deepEqual(await read.json(), data);

  const saveBrands = await worker.fetch(
    request("/api/admin/data", {
      method: "PUT",
      headers: {
        origin: "https://aircon.example",
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify(dataWithBrands),
    }),
    env,
  );
  assert.equal(saveBrands.status, 200);
  const readBrands = await worker.fetch(request("/api/data"), env);
  assert.deepEqual(await readBrands.json(), dataWithBrands);
});

test("rejects saves without a valid admin session", async () => {
  const { env } = makeEnv();
  const response = await worker.fetch(
    request("/api/admin/data", {
      method: "PUT",
      headers: { origin: "https://aircon.example", "content-type": "application/json" },
      body: JSON.stringify({ models: {}, specData: {} }),
    }),
    env,
  );
  assert.equal(response.status, 401);
});

test("translates selling points through Workers AI for authenticated admins", async () => {
  const { env, store } = makeEnv();
  const unauthorized = await worker.fetch(
    request("/api/admin/translate", {
      method: "POST",
      headers: { origin: "https://aircon.example", "content-type": "application/json" },
      body: JSON.stringify({ text: "Quiet and reliable" }),
    }),
    env,
  );
  assert.equal(unauthorized.status, 401);

  const login = await worker.fetch(
    request("/api/admin/login", {
      method: "POST",
      headers: { origin: "https://aircon.example", "content-type": "application/json" },
      body: JSON.stringify({ password: "test-admin-password" }),
    }),
    env,
  );
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const response = await worker.fetch(
    request("/api/admin/translate", {
      method: "POST",
      headers: {
        origin: "https://aircon.example",
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "  Quiet and reliable  " }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { translation: "安静可靠" });
  assert.deepEqual(store.aiInput, {
    model: "@cf/meta/m2m100-1.2b",
    input: { text: "Quiet and reliable", source_lang: "en", target_lang: "zh" },
  });
});

test("limits selling-point translation input and requires the AI binding", async () => {
  const { env } = makeEnv();
  const login = await worker.fetch(
    request("/api/admin/login", {
      method: "POST",
      headers: { origin: "https://aircon.example", "content-type": "application/json" },
      body: JSON.stringify({ password: "test-admin-password" }),
    }),
    env,
  );
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const headers = {
    origin: "https://aircon.example",
    cookie,
    "content-type": "application/json",
  };
  const tooLong = await worker.fetch(
    request("/api/admin/translate", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "x".repeat(2001) }),
    }),
    env,
  );
  assert.equal(tooLong.status, 400);

  delete env.AI;
  const notConfigured = await worker.fetch(
    request("/api/admin/translate", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "Quiet and reliable" }),
    }),
    env,
  );
  assert.equal(notConfigured.status, 503);
});

test("rejects invalid brand metadata", async () => {
  const { env } = makeEnv();
  const login = await worker.fetch(
    request("/api/admin/login", {
      method: "POST",
      headers: { origin: "https://aircon.example", "content-type": "application/json" },
      body: JSON.stringify({ password: "test-admin-password" }),
    }),
    env,
  );
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const duplicateBrand = {
    b: "Duplicate",
    o: "Japan",
    sEn: "",
    sCn: "",
    kEn: "",
    kCn: "",
    c: "#0090D0",
    lo: 1,
    hi: 4,
    inv: true,
  };
  const response = await worker.fetch(
    request("/api/admin/data", {
      method: "PUT",
      headers: {
        origin: "https://aircon.example",
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        brands: [duplicateBrand, { ...duplicateBrand }],
        models: {},
        specData: {},
      }),
    }),
    env,
  );
  assert.equal(response.status, 400);
});
