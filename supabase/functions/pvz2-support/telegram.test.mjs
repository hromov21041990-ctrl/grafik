import test from "node:test";
import assert from "node:assert/strict";
import { sendSupportNotification } from "./telegram.ts";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const ticket = {
  id: "test-ticket", category: "bug", title: "<b>Ошибка</b>",
  message: "Проверка уведомлений техподдержки.", contact_email: "test@example.invalid",
  company_code: "", sender_role: "guest", created_at: "2026-10-12T00:00:00Z",
};
// Synthetic fixture; never reads production credentials.
const secrets = { token: "12345:TEST_ONLY", chatId: "-5492444972" };
const success = () => Response.json({ ok: true, result: { message_id: 1, chat: { id: -5492444972 } } });

test("requires secrets and intended group without making a request", async () => {
  const noFetch = () => { throw new Error("unexpected request"); };
  assert.equal((await sendSupportNotification(ticket, {}, noFetch)).error, "telegram_secrets_missing");
  assert.equal((await sendSupportNotification(ticket, { ...secrets, chatId: "-1" }, noFetch)).error, "telegram_chat_id_mismatch");
  assert.equal((await sendSupportNotification(ticket, { ...secrets, token: "invalid" }, noFetch)).error, "telegram_token_invalid_format");
});

test("sends one plain-text bounded message and requires confirmed chat/message", async () => {
  let calls = 0;
  const r = await sendSupportNotification({ ...ticket, message: "🙂".repeat(4000) }, secrets, async (url, options) => {
    calls++;
    assert.equal(url, "https://api.telegram.org/bot12345:TEST_ONLY/sendMessage");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    const body = JSON.parse(options.body);
    assert.equal(body.chat_id, secrets.chatId);
    assert.equal(body.parse_mode, undefined);
    assert.equal(body.link_preview_options.is_disabled, true);
    assert.ok(Array.from(body.text).length <= 4096);
    assert.ok(body.text.includes(ticket.id));
    assert.ok(body.text.includes(ticket.title));
    return success();
  });
  assert.equal(calls, 1);
  assert.equal(r.error, null);
  assert.ok(!Number.isNaN(Date.parse(r.notifiedAt)));
});

test("rejects HTTP, API and malformed confirmations without storing remote content", async () => {
  const cases = [
    [new Response("secret remote text", { status: 403 }), "telegram_http_403"],
    [Response.json({ ok: false, description: secrets.token }), "telegram_api_rejected"],
    [new Response("invalid JSON"), "telegram_invalid_response"],
    [Response.json({ ok: true, result: { message_id: 1, chat: { id: -1 } } }), "telegram_invalid_confirmation"],
    [Response.json({ ok: true }), "telegram_invalid_confirmation"],
  ];
  for (const [response, error] of cases) {
    const r = await sendSupportNotification(ticket, secrets, async () => response);
    assert.equal(r.notifiedAt, null);
    assert.equal(r.error, error);
    assert.ok(!JSON.stringify(r).includes(secrets.token));
  }
});

test("sanitizes token-bearing network exceptions and does not retry ambiguous delivery", async () => {
  let calls = 0;
  const r = await sendSupportNotification(ticket, secrets, async () => {
    calls++;
    throw new Error("https://api.telegram.org/bot" + secrets.token);
  });
  assert.equal(calls, 1);
  assert.equal(r.error, "telegram_network_error_delivery_unknown");
  assert.ok(!JSON.stringify(r).includes(secrets.token));
  assert.equal((await sendSupportNotification(ticket, secrets, async () => {
    throw new DOMException("timeout", "TimeoutError");
  })).error, "telegram_timeout_delivery_unknown");
});

async function runHandler({ fetcher, markerError = false, insertError = false, body = {} } = {}) {
  const events = [];
  const db = { from(table) {
    if (table === "pvz2_support_rate_limits") return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    };
    if (table === "pvz2_support_tickets") return {
      insert: (values) => ({ select: () => ({ single: async () => {
        events.push("insert");
        return insertError ? { data: null, error: {} } : { data: { ...ticket, ...values }, error: null };
      } }) }),
      update: (values) => ({ eq: () => ({ abortSignal: async () => {
        events.push({ marker: values });
        if (markerError) throw new Error("db unavailable");
        return { error: null };
      } }) }),
    };
    throw new Error("unexpected table");
  } };
  let handler;
  let source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .replace(/^import .*;$/gm, "");
  source = stripTypeScriptTypes(source);
  const context = vm.createContext({
    createClient: () => db, sendSupportNotification,
    Deno: { env: { get: (name) => ({
      SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-service",
      TELEGRAM_BOT_TOKEN: secrets.token, TELEGRAM_CHAT_ID: secrets.chatId,
    })[name] }, serve: (fn) => { handler = fn; } },
    fetch: async (...args) => { events.push("telegram"); return fetcher ? fetcher(...args) : success(); },
    console: { error: (...args) => events.push({ log: args }) },
    crypto: globalThis.crypto, TextEncoder, Uint8Array, Response, AbortSignal, Date,
  });
  // The helper's default fetch resolves in its module; inject the handler context's fetch.
  context.sendSupportNotification = (t, s) => sendSupportNotification(t, s, context.fetch);
  vm.runInContext(source, context);
  const response = await handler(new Request("https://example.invalid", {
    method: "POST", headers: {
      origin: "https://hromov21041990-ctrl.github.io",
      apikey: "sb_publishable_eIWwXJEBGxYAbnhOc-MKfw_NitfQtB_",
    },
    body: JSON.stringify({ action: "supportSubmit", category: "bug", title: "Тест",
      message: ticket.message, email: ticket.contact_email, ...body }),
  }));
  return { response, events };
}

test("handler commits first, records delivery and retains successful submission on failures", async () => {
  for (const config of [
    {},
    { fetcher: async () => new Response("", { status: 403 }) },
    { fetcher: async () => { throw new Error(secrets.token); } },
    { markerError: true },
  ]) {
    const { response, events } = await runHandler(config);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ticketId: ticket.id });
    assert.equal(events[0], "insert");
    assert.equal(events[1], "telegram");
    const mark = events[2].marker;
    assert.ok(mark);
    if (config.fetcher) {
      assert.equal(mark.telegram_notified_at, null);
      assert.ok(mark.telegram_delivery_error);
    } else assert.ok(mark.telegram_notified_at);
    assert.ok(!JSON.stringify(events).includes(secrets.token));
  }
});

test("failed insert, validation and honeypot never send Telegram", async () => {
  const failed = await runHandler({ insertError: true });
  assert.equal(failed.response.status, 503);
  assert.deepEqual(failed.events, ["insert"]);
  const invalid = await runHandler({ body: { title: "x" } });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.events.length, 0);
  const trap = await runHandler({ body: { website: "spam" } });
  assert.equal(trap.response.status, 200);
  assert.equal(trap.events.length, 0);
});
