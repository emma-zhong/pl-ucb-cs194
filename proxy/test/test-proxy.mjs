// Checks the proxy against test/fake-openai.mjs. Run through `npm test` (test/run.mjs).
import fs from "node:fs";
const BASE = "http://127.0.0.1:8787", LOG = process.argv[2];
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };
const run = Date.now().toString(36);
const key = (name) => `${name}-${run}`;
const calls = () => fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); };
const post = async (k, body, headers = AUTH) => { const r = await fetch(`${BASE}/v1/jobs/${k}`, { method: "POST", headers, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
const get = async (k) => { const r = await fetch(`${BASE}/v1/jobs/${k}`, { headers: AUTH }); return [r.status, await r.json()]; };
const job = (seq, content, extra = {}) => ({ seq, user: `angie-${run}`, model: "gpt-4.1-mini", messages: [{ role: "system", content: "SECRET-PROMPT" }, { role: "user", content }], ...extra });
const settle = async (k) => { for (let i = 0; i < 50; i++) { const [, b] = await get(k); if (b.status !== "pending") return b; await new Promise((r) => setTimeout(r, 200)); } return null; };

for (let i = 0; i < 60; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }

const A = key("variantA");
check("no token -> 401", (await get(A).then(() => fetch(`${BASE}/v1/jobs/${A}`)).then((r) => r.status)) === 401);
check("wrong token -> 401", (await post(A, job(1, "hi"), { authorization: "Bearer nope" }))[0] === 401);
check("bad path -> 404", (await fetch(`${BASE}/v1/jobs/x`, { headers: AUTH })).status === 404);
check("bad body -> 400", (await post(A, { seq: 0 }))[0] === 400);
let [s, b] = await get(A);
check("fresh variant -> status none, 3 left", s === 200 && b.status === "none" && b.generations_left === 3, JSON.stringify(b));

const before = calls().length;
[s, b] = await post(A, job(1, "Reply OK"));
check("POST seq 1 -> 202 pending", s === 202 && b.status === "pending", `${s} ${JSON.stringify(b)}`);
b = await settle(A);
check("GET -> done with text", b?.status === "done" && b.text.startsWith("OK"), JSON.stringify(b));
check("GET never returns the prompt", !("messages" in b) && Object.keys(b).every((k) => ["status","seq","text","error","generations_used","generations_left"].includes(k)), JSON.stringify(Object.keys(b)));
[s, b] = await post(A, job(1, "Reply OK"));
check("repeat seq 1 -> stored job, no new OpenAI call", s === 200 && b.status === "done" && calls().length === before + 1, `${s} calls=${calls().length - before}`);

[s] = await post(A, job(2, "SLOW please"));
const [s2, b2] = await post(A, job(3, "another"));
check("new seq while pending -> 409 busy", s === 202 && s2 === 409 && b2.error === "busy", `${s2} ${JSON.stringify(b2)}`);
b = await settle(A);
check("slow job finishes", b?.status === "done" && b.generations_used === 2, JSON.stringify(b));
[s, b] = await post(A, job(1, "old retry"));
check("older seq -> 409 stale_seq", s === 409 && b.error === "stale_seq", `${s} ${JSON.stringify(b)}`);

[s, b] = await post(A, job(4, "QUOTA"));
b = await settle(A);
check("out of credits -> provider_quota", b?.error === "provider_quota", JSON.stringify(b));
check("failure does not use a generation", b?.generations_used === 2, JSON.stringify(b));
await post(A, job(5, "RATE")); b = await settle(A);
check("rate limited -> provider_rate_limit", b?.error === "provider_rate_limit", JSON.stringify(b));
await post(A, job(6, "BAD")); b = await settle(A);
check("OpenAI 400 -> provider_rejected", b?.error === "provider_rejected", JSON.stringify(b));
await post(A, job(7, "third success")); b = await settle(A);
check("third success -> 0 left", b?.status === "done" && b.generations_left === 0, JSON.stringify(b));
[s, b] = await post(A, job(8, "fourth"));
check("over limit -> 429 generation_limit", s === 429 && b.error === "generation_limit", `${s} ${JSON.stringify(b)}`);

const B = key("variantB");
[s, b] = await post(B, job(1, "x", { model: "gpt-9-mega" }));
check("model not allowed -> 400", s === 400 && b.error === "model_not_allowed", `${s} ${JSON.stringify(b)}`);
await post(B, job(2, "luna test", { model: "gpt-5.6-luna" })); b = await settle(B);
const last = calls().at(-1);
check("gpt-5.6-luna sent without temperature", b?.status === "done" && last.has_temperature === false, JSON.stringify(last));
check("gpt-4.1-mini sent with temperature + token cap", calls().find((c) => c.model === "gpt-4.1-mini").has_temperature === true && last.max === 1000);

// Daily cap is 6 per user. User "dana": failures are refunded, so 6 quota failures + 6 successes fit, the 7th success is refused.
const user = `dana-${run}`;
for (let i = 0; i < 6; i++) { const k = key(`fail${i}`); await post(k, job(1, "QUOTA", { user })); await settle(k); }
let accepted = 0;
for (let i = 0; i < 6; i++) { const k = key(`ok${i}`); const [st] = await post(k, job(1, "fine", { user })); if (st === 202) accepted++; await settle(k); }
check("failed calls refunded to daily budget", accepted === 6, `accepted=${accepted}`);
[s, b] = await post(key("ok7"), job(1, "fine", { user }));
check("7th in a day -> 429 user_daily_limit", s === 429 && b.error === "user_daily_limit", `${s} ${JSON.stringify(b)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
