import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const root = fileURLToPath(new URL("../", import.meta.url));
const privatePath = resolve(root, ".gateway-test-admin.json");
const linksPath = resolve(root, ".gateway-live-links.json");
const origin = process.env.GATEWAY_ORIGIN || "https://converter.yahenix.top";
const mode = process.argv[2] || "matrix";
const values = Object.fromEntries(readFileSync(resolve(root, "test_env"), "utf8").split(/\r?\n/).filter(x => x.trim() && !x.trim().startsWith("#")).map(line => {
  const match = /^\s*([\w]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (!match) throw new Error("test_env must contain KEY=value lines");
  let value = match[2];
  if (/^["']/.test(value) && value.at(-1) === value[0]) value = value.slice(1, -1);
  return [match[1].toLowerCase(), value];
}));
const apiKey = values.api_key || values.apikey || values.key;
const model = values.model || values.model_name;
const upstreamBase = values.base_url?.replace(/\/+$/, "");
assert(apiKey && model && upstreamBase, "test_env requires base_url, api_key and model");
const protocols = ["chat", "messages", "responses"];
const upstreamBases = { chat: upstreamBase, responses: upstreamBase, messages: `${upstreamBase}/anthropic/v1` };
const suffix = { chat: "/chat/completions", messages: "/messages", responses: "/responses" };
const results = [];
let cookie = "";

function redact(text) {
  return String(text).replaceAll(apiKey, "[REDACTED]").replace(/https:\/\/[^\s"']+\/-[^\s"']*/g, "[GATEWAY_ENDPOINT]");
}
async function request(url, options = {}) {
  return fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(90000) });
}
async function admin(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await request(`${origin}/api/admin${path}`, {
    method, headers: { cookie, origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = response.status === 204 ? null : await response.json();
  assert(response.ok, `admin ${path}: HTTP ${response.status} ${redact(JSON.stringify(value))}`);
  return value;
}
async function login() {
  const credentials = JSON.parse(readFileSync(privatePath, "utf8"));
  const response = await request(`${origin}/api/admin/login`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
  });
  assert(response.ok, `login failed: HTTP ${response.status} ${redact(await response.clone().text())}`);
  cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
  assert(cookie, "login did not set a session cookie");
}
function payload(protocol, stream = false, prompt = "Reply with the single word OK.") {
  if (protocol === "responses") return { model, input: prompt, max_output_tokens: 96, stream, store: false };
  return { model, messages: [{ role: "user", content: prompt }], max_tokens: 96, stream,
    ...(protocol === "chat" && stream ? { stream_options: { include_usage: true } } : {}) };
}
async function modelCall(url, protocol, body) {
  const began = Date.now();
  const response = await request(url, {
    method: "POST", headers: { "content-type": "application/json", ...(protocol === "messages"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${apiKey}` }) }, body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, ms: Date.now() - began, text, contentType: response.headers.get("content-type") };
}
function events(text) {
  return text.split(/\r?\n\r?\n/).map(frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    return data && data !== "[DONE]" ? JSON.parse(data) : data;
  }).filter(Boolean);
}
function answerText(protocol, body) {
  return protocol === "chat" ? body.choices?.[0]?.message?.content : protocol === "messages"
    ? body.content?.filter(c => c.type === "text").map(c => c.text).join("")
    : body.output?.flatMap(item => item.content || []).filter(c => c.type === "output_text").map(c => c.text).join("");
}
function verify(protocol, response, stream) {
  assert.equal(response.status, 200, `HTTP ${response.status}: ${redact(response.text).slice(0, 500)}`);
  if (!stream) {
    const body = JSON.parse(response.text);
    assert(body.id, "missing response ID");
    const text = answerText(protocol, body);
    assert(text?.includes("OK"), "missing OK answer: " + redact(response.text).slice(0, 600));
    assert(body.usage, "missing usage");
    return { answer: text.slice(0, 80), usage: body.usage };
  }
  assert(response.contentType?.includes("text/event-stream"), "wrong SSE content type");
  const frames = events(response.text);
  assert(!frames.some(e => e.type === "error" || e.error || e.type === "response.failed"), "error frame: " + redact(response.text).slice(-500));
  const last = frames.at(-1);
  if (protocol === "chat") assert.equal(last, "[DONE]");
  if (protocol === "messages") assert.equal(last?.type, "message_stop");
  if (protocol === "responses") assert.equal(last?.type, "response.completed");
  const text = frames.map(e => protocol === "chat" ? e.choices?.[0]?.delta?.content || "" : protocol === "messages"
    ? e.delta?.type === "text_delta" ? e.delta.text : ""
    : e.type === "response.output_text.delta" ? e.delta : "").join("");
  assert(text.includes("OK"), "stream missing OK answer: " + redact(response.text).slice(-600));
  return { answer: text.slice(0, 80), events: frames.length, usage: frames.findLast(e => e.usage || e.response?.usage)?.usage || last?.response?.usage };
}
async function record(name, run) {
  try {
    const detail = await run();
    results.push({ name, passed: true, ...detail });
    console.log(JSON.stringify(results.at(-1)));
  } catch (error) {
    results.push({ name, passed: false, error: redact(error.message) });
    console.log(JSON.stringify(results.at(-1)));
  }
}
async function prepareLinks() {
  const existing = existsSync(linksPath) ? JSON.parse(readFileSync(linksPath, "utf8")) : {};
  const current = (await admin("/links")).links;
  for (const client of protocols) for (const upstream of protocols) {
    const direction = `${client}->${upstream}`;
    if (existing[direction] && current.some(l => l.id === existing[direction].id && !l.revoked_at)) continue;
    const { link } = await admin("/links", { client_protocol: client, upstream_protocol: upstream, target_type: "direct", base_url: upstreamBases[upstream] });
    existing[direction] = link;
    writeFileSync(linksPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }
  return existing;
}

async function sdkResponse(link, body, stream) {
  if (link.client_protocol === "messages") {
    const client = new Anthropic({ baseURL: link.base_url, apiKey, maxRetries: 0, timeout: 90000 });
    return stream ? client.messages.stream(body).finalMessage() : client.messages.create(body);
  }
  const client = new OpenAI({ baseURL: link.base_url, apiKey, maxRetries: 0, timeout: 90000 });
  if (link.client_protocol === "responses") return stream ? client.responses.stream(body).finalResponse() : client.responses.create(body);
  return stream ? client.chat.completions.stream(body).finalChatCompletion() : client.chat.completions.create(body);
}
function noThinking(protocol) {
  return protocol === "responses" ? { reasoning: { effort: "none" } } : { thinking: { type: "disabled" } };
}
function toolRequest(protocol) {
  const prompt = "Call get_weather twice, once for Beijing and once for Shanghai, before answering. After both tool results, reply only TOOL_OK.";
  const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false };
  const common = { ...payload(protocol, false, prompt), max_tokens: undefined, max_output_tokens: undefined };
  if (protocol === "messages") return { ...common, max_tokens: 256, tools: [{ name: "get_weather", description: "Read weather for a city", input_schema: schema }], tool_choice: { type: "tool", name: "get_weather" } };
  if (protocol === "responses") return { ...common, max_output_tokens: 256, tools: [{ type: "function", name: "get_weather", description: "Read weather for a city", parameters: schema }], tool_choice: { type: "function", name: "get_weather" } };
  return { ...common, max_tokens: 256, tools: [{ type: "function", function: { name: "get_weather", description: "Read weather for a city", parameters: schema } }], tool_choice: { type: "function", function: { name: "get_weather" } } };
}
function toolFollowup(protocol, requestBody, first) {
  const result = JSON.stringify({ weather: "sunny", testing: true });
  const followup = { ...requestBody, tool_choice: protocol === "messages" ? { type: "auto" } : "auto" };
  function checkCalls(calls, getInput, getId) {
    assert.equal(calls.length, 2, `expected two parallel tool calls, got ${calls.length}`);
    assert.equal(new Set(calls.map(getId)).size, 2, "tool IDs collided");
    assert.deepEqual(calls.map(c => getInput(c).city.toLowerCase()).sort(), ["beijing", "shanghai"], "tool arguments were mixed or lost");
  }
  if (protocol === "messages") {
    const calls = first.content.filter(b => b.type === "tool_use");
    checkCalls(calls, c => c.input, c => c.id);
    followup.messages = [...requestBody.messages, { role: "assistant", content: first.content }, { role: "user", content: calls.map(c => ({ type: "tool_result", tool_use_id: c.id, content: result })) }];
    return { followup, count: calls.length };
  }
  if (protocol === "responses") {
    const calls = first.output.filter(i => i.type === "function_call");
    checkCalls(calls, c => JSON.parse(c.arguments), c => c.call_id);
    followup.input = [{ role: "user", content: requestBody.input }, ...first.output, ...calls.map(c => ({ type: "function_call_output", call_id: c.call_id, output: result }))];
    return { followup, count: calls.length };
  }
  const message = first.choices[0].message;
  const calls = message.tool_calls || [];
  checkCalls(calls, c => JSON.parse(c.function.arguments), c => c.id);
  followup.messages = [...requestBody.messages, message, ...calls.map(c => ({ role: "tool", tool_call_id: c.id, content: result }))];
  return { followup, count: calls.length };
}
function solidRedPng() {
  function crc32(bytes) { let crc = -1; for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
  function chunk(type, body) { const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(body.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, body]))); return Buffer.concat([length, name, body, crc]); }
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.from([0, ...Array.from({ length: 32 }, () => [255, 0, 0]).flat()]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array(32).fill(row)))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
function imageRequest(protocol) {
  const image = solidRedPng();
  const question = "What is the dominant color? Reply only RED, BLUE, or GREEN.";
  const body = payload(protocol, false, question);
  if (protocol === "messages") body.messages[0].content = [{ type: "text", text: question }, { type: "image", source: { type: "base64", media_type: "image/png", data: image } }];
  else if (protocol === "chat") body.messages[0].content = [{ type: "text", text: question }, { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }];
  else body.input = [{ role: "user", content: [{ type: "input_text", text: question }, { type: "input_image", image_url: `data:image/png;base64,${image}` }] }];
  return body;
}

try {
  if (mode === "bootstrap") {
    if (!existsSync(privatePath)) writeFileSync(privatePath, JSON.stringify({ origin, username: "admin", password: randomBytes(24).toString("base64url") }, null, 2), { mode: 0o600 });
    const credentials = JSON.parse(readFileSync(privatePath, "utf8"));
    const result = spawnSync(process.execPath, [resolve(root, "scripts/setup.mjs"), "--non-interactive"], {
      cwd: root, stdio: "inherit", env: { ...process.env, ADMIN_USERNAME: credentials.username, ADMIN_PASSWORD: credentials.password },
    });
    process.exitCode = result.status || 0;
  } else if (mode === "direct") {
    for (const upstream of protocols) await record(`direct:${upstream}`, async () => {
      const response = await modelCall(upstreamBases[upstream] + suffix[upstream], upstream, payload(upstream));
      return { ms: response.ms, ...verify(upstream, response, false) };
    });
  } else {
    await login();
    const links = await prepareLinks();
    if (mode === "management") {
      await record("management:unauthenticated", async () => {
        const response = await request(`${origin}/api/admin/links`);
        assert.equal(response.status, 401);
        return { status: response.status };
      });
      await record("management:failed-login-rate-limit", async () => {
        const username = `invalid-test-${Date.now()}`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const response = await request(`${origin}/api/admin/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username, password: "incorrect-test-password" }) });
          assert.equal(response.status, attempt < 5 ? 401 : 429);
        }
        return { failures: 5, blocked_status: 429 };
      });
      await record("management:same-origin", async () => {
        const response = await request(`${origin}/api/admin/aliases`, { method: "POST", headers: { cookie, origin: "https://other.example", "content-type": "application/json" }, body: JSON.stringify({ name: "should-not-exist", base_url: upstreamBase }) });
        assert.equal(response.status, 403);
        return { status: response.status };
      });
      await record("management:tampered-link", async () => {
        const url = new URL(links["messages->chat"].endpoint);
        url.pathname = url.pathname.replace(/^\/([^/]+)/, "/$1-tampered");
        const response = await modelCall(url.toString(), "messages", payload("messages"));
        assert.equal(response.status, 403);
        assert.equal(JSON.parse(response.text).type, "error");
        return { status: response.status };
      });
      await record("management:upstream-auth-error", async () => {
        const response = await request(links["messages->chat"].endpoint, { method: "POST", headers: { "x-api-key": "invalid-test-key", "content-type": "application/json" }, body: JSON.stringify(payload("messages")) });
        assert.equal(response.status, 401);
        assert.equal((await response.json()).type, "error");
        return { status: response.status };
      });
      await record("management:unsupported-store", async () => {
        const response = await modelCall(links["responses->chat"].endpoint, "responses", { ...payload("responses"), store: true });
        assert.equal(response.status, 400);
        return { status: response.status };
      });
      await record("management:alias-lifecycle", async () => {
        const name = `verify-${Date.now()}`;
        const { alias } = await admin("/aliases", { name, base_url: upstreamBase });
        let link;
        try {
          ({ link } = await admin("/links", { client_protocol: "chat", upstream_protocol: "chat", target_type: "alias", alias_id: alias.id }));
          await admin(`/aliases/${alias.id}`, { base_url: `${upstreamBase}/v1` }, "PUT");
          const listed = (await admin("/links")).links.find(l => l.id === link.id);
          assert.equal(listed.upstream_url, `${upstreamBase}/v1/chat/completions`);
          const followed = await modelCall(link.endpoint, "chat", payload("chat"));
          verify("chat", followed, false);
          await admin(`/aliases/${alias.id}`, undefined, "DELETE");
          const replacement = (await admin("/aliases", { name, base_url: upstreamBase })).alias;
          try {
            const denied = await modelCall(link.endpoint, "chat", payload("chat"));
            assert.equal(denied.status, 403);
          } finally { await admin(`/aliases/${replacement.id}`, undefined, "DELETE"); }
          return { follows_update: true, revoked_on_delete: true, name_reuse_stays_revoked: true };
        } finally {
          if (link) await admin(`/links/${link.id}/revoke`, {});
          const aliases = (await admin("/aliases")).aliases;
          if (aliases.some(a => a.id === alias.id)) await admin(`/aliases/${alias.id}`, undefined, "DELETE");
        }
      });
    } else for (const client of protocols) for (const upstream of protocols) {
      const link = links[`${client}->${upstream}`];
      if (mode === "models") {
        const proxyRoot = link.base_url.replace(/\/v1$/, "");
        const upstreamResponse = await request(`${upstreamBases[upstream]}/models`, { headers: upstream === "messages"
          ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${apiKey}` } });
        const expectedStatus = upstreamResponse.status;
        await upstreamResponse.body?.cancel();
        for (const path of ["/models", "/v1/models"]) await record(`${client}->${upstream}:GET${path}`, async () => {
          const response = await request(`${proxyRoot}${path}`, { headers: client === "messages"
            ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
            : { authorization: `Bearer ${apiKey}` } });
          assert.equal(response.status, expectedStatus);
          assert.equal(response.headers.get("cache-control"), "no-store");
          if (expectedStatus !== 200) {
            await response.body?.cancel();
            return { status: response.status, matches_upstream: true };
          }
          const body = await response.json();
          assert(Array.isArray(body.data), "model response lacks a data array");
          assert(body.data.some(item => item.id === model), "configured model absent from list");
          return { status: response.status, models: body.data.map(item => item.id) };
        });
        await record(`${client}->${upstream}:models-sdk`, async () => {
          const sdk = client === "messages"
            ? new Anthropic({ apiKey, baseURL: link.base_url, maxRetries: 0, timeout: 20000 })
            : new OpenAI({ apiKey, baseURL: link.base_url, maxRetries: 0, timeout: 20000 });
          if (expectedStatus !== 200) {
            await assert.rejects(sdk.models.list(), error => error.status === expectedStatus);
            return { status: expectedStatus, matches_upstream: true };
          }
          const page = await sdk.models.list();
          assert(page.data.some(item => item.id === model), "SDK model list lacks configured model");
          return { models: page.data.map(item => item.id) };
        });
        // A separate provider API verifies the general fallback, without
        // logging account balances or executing model generation.
        if (upstream !== "messages") await record(`${client}->${upstream}:GET/user/balance`, async () => {
          const response = await request(`${proxyRoot}/v1/user/balance`, { headers: { authorization: `Bearer ${apiKey}` } });
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(typeof body.is_available, "boolean");
          assert(Array.isArray(body.balance_infos));
          return { status: response.status, provider_response_shape_preserved: true };
        });
      }
      else if (mode === "truncate") {
        if (client === upstream) continue;
        for (const stream of [false, true]) await record(`${client}->${upstream}:truncate-${stream ? "stream" : "json"}`, async () => {
          const body = payload(client, stream, "List all integers from 1 to 10000, separated by spaces, without shortcuts.");
          if (client === "responses") body.max_output_tokens = 2;
          else body.max_tokens = 2;
          const response = await modelCall(link.endpoint, client, body);
          assert.equal(response.status, 200);
          const parsed = stream ? events(response.text) : [JSON.parse(response.text)];
          if (client === "chat") assert(parsed.some(e => e.choices?.[0]?.finish_reason === "length"));
          else if (client === "messages") assert(parsed.some(e => e.stop_reason === "max_tokens" || e.delta?.stop_reason === "max_tokens"));
          else {
            const final = parsed.at(-1);
            assert.equal(stream ? final.type : final.status, stream ? "response.incomplete" : "incomplete");
            assert.equal((final.response || final).incomplete_details?.reason, "max_output_tokens");
          }
          return { truncated: true };
        });
      }
      else if (mode === "sdk") for (const stream of [false, true]) await record(`${client}->${upstream}:sdk-${stream ? "stream" : "json"}`, async () => {
        const body = payload(client); delete body.stream;
        if (client === upstream) Object.assign(body, noThinking(client));
        const response = await sdkResponse(link, body, stream);
        return verify(client, { status: 200, text: JSON.stringify(response) }, false);
      });
      else if (mode === "tools") for (const stream of [false, true]) await record(`${client}->${upstream}:parallel-tools-${stream ? "stream" : "json"}`, async () => {
        const body = toolRequest(client); delete body.stream;
        if (client === upstream) Object.assign(body, noThinking(client));
        const first = await sdkResponse(link, body, stream);
        const { followup, count } = toolFollowup(client, body, first);
        const second = await sdkResponse(link, followup, false);
        const detail = verify(client, { status: 200, text: JSON.stringify(second) }, false);
        assert.equal(detail.answer.trim(), "TOOL_OK");
        return { ...detail, tool_calls: count };
      });
      else if (mode === "images") await record(`${client}->${upstream}:image`, async () => {
        const response = await sdkResponse(link, imageRequest(client), false);
        const text = answerText(client, response);
        assert(text && /\bRED\b/i.test(text), "image recognition did not return RED");
        return { color: "RED", usage: response.usage };
      });
      else for (const stream of [false, true]) await record(`${client}->${upstream}:${stream ? "stream" : "json"}`, async () => {
        const body = payload(client, stream);
        if (client === upstream) Object.assign(body, noThinking(client));
        const response = await modelCall(link.endpoint, client, body);
        return { ms: response.ms, ...verify(client, response, stream) };
      });
    }
    await admin("/logout", {});
    if (mode === "management") await record("management:logout-invalidates-cookie", async () => {
      const response = await request(`${origin}/api/admin/session`, { headers: { cookie } });
      assert.equal(response.status, 401);
      return { status: response.status };
    });
  }
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  if (results.length) {
    mkdirSync(resolve(root, "test-results"), { recursive: true });
    writeFileSync(resolve(root, `test-results/live-${mode}.json`), JSON.stringify({ date: new Date().toISOString(), origin, upstream: upstreamBase, model, results }, null, 2));
    if (results.some(r => !r.passed)) process.exitCode = 1;
  }
}
