import { DurableObject } from "cloudflare:workers";

// English-to-SQL proxy: holds the OpenAI key, enforces generation limits, and runs
// each model call in the background so PrairieLearn never waits on OpenAI.
//
//   POST /v1/jobs/<variant_key>  {seq, user, model, messages}  start a generation
//   GET  /v1/jobs/<variant_key>                                 check its status
//
// Every request needs "Authorization: Bearer <COURSE_TOKEN>".

const DEFAULT_OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const KEY_PATTERN = /^\/v1\/jobs\/([A-Za-z0-9_-]{8,64})$/;
const OPENAI_TIMEOUT_MS = 60_000;
// A job still pending after this long lost its alarm; report it as a timeout.
const STALE_MS = 120_000;
const MAX_PROMPT_CHARS = 200_000;
const ROLES = new Set(["system", "user", "assistant"]);

interface Message {
	role: "system" | "user" | "assistant";
	content: string;
}

interface NewJob {
	seq: number;
	user: string;
	model: string;
	messages: Message[];
}

interface JobState {
	key: string;
	seq: number;
	status: "pending" | "done" | "error";
	user: string;
	model: string;
	day: string;
	messages?: Message[];
	text?: string;
	error?: string;
	successes: number;
	started: number;
}

interface Reply {
	status: number;
	body: Record<string, unknown>;
}

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function limit(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function authorized(request: Request, env: Env): boolean {
	if (!env.COURSE_TOKEN) return false;
	const encoder = new TextEncoder();
	const given = encoder.encode(request.headers.get("authorization") ?? "");
	const expected = encoder.encode(`Bearer ${env.COURSE_TOKEN}`);
	return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

function validate(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return "Body must be a JSON object.";
	const job = body as Partial<NewJob>;
	if (!Number.isInteger(job.seq) || (job.seq as number) <= 0) return "seq must be a positive integer.";
	if (typeof job.user !== "string" || !job.user || job.user.length > 200) return "user must be a nonempty string.";
	if (typeof job.model !== "string" || !job.model || job.model.length > 100) return "model must be a nonempty string.";
	if (!Array.isArray(job.messages) || job.messages.length === 0 || job.messages.length > 10) {
		return "messages must be a list of 1 to 10 messages.";
	}
	let total = 0;
	for (const message of job.messages) {
		if (typeof message !== "object" || message === null || !ROLES.has(message.role) || typeof message.content !== "string") {
			return "Every message needs a system, user, or assistant role and string content.";
		}
		total += message.content.length;
	}
	return total > MAX_PROMPT_CHARS ? "messages are too long." : null;
}

function publicView(job: JobState, env: Env): Record<string, unknown> {
	// Never return the prompt.
	const max = limit(env.MAX_GENERATIONS_PER_VARIANT, 10);
	return {
		status: job.status,
		seq: job.seq,
		...(job.text !== undefined && { text: job.text }),
		...(job.error !== undefined && { error: job.error }),
		generations_used: job.successes,
		generations_left: Math.max(0, max - job.successes),
	};
}

function budget(env: Env) {
	return env.BUDGET.getByName("global");
}

export default {
	async fetch(request, env): Promise<Response> {
		if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
		const match = new URL(request.url).pathname.match(KEY_PATTERN);
		if (!match) return json({ error: "not_found" }, 404);
		const job = env.JOBS.getByName(match[1]); // one object per variant

		let reply: Reply;
		if (request.method === "GET") {
			reply = await job.check();
		} else if (request.method === "POST") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return json({ error: "bad_request", detail: "Body must be JSON." }, 400);
			}
			const problem = validate(body);
			if (problem) return json({ error: "bad_request", detail: problem }, 400);
			reply = await job.start(match[1], body as NewJob);
		} else {
			return json({ error: "method_not_allowed" }, 405);
		}
		return json(reply.body, reply.status);
	},
} satisfies ExportedHandler<Env>;

export class Job extends DurableObject<Env> {
	async start(key: string, input: NewJob): Promise<Reply> {
		const job = await this.load();
		const view = job ? publicView(job, this.env) : {};

		// PrairieLearn and browsers retry; a repeated seq returns the stored job.
		if (job && input.seq === job.seq) return { status: 200, body: view };
		if (job && input.seq < job.seq) return { status: 409, body: { ...view, error: "stale_seq" } };
		if (job?.status === "pending") return { status: 409, body: { ...view, error: "busy" } };

		const successes = job?.successes ?? 0;
		if (successes >= limit(this.env.MAX_GENERATIONS_PER_VARIANT, 10)) {
			return { status: 429, body: { ...view, error: "generation_limit" } };
		}
		if (!list(this.env.ALLOWED_MODELS).includes(input.model)) {
			return { status: 400, body: { error: "model_not_allowed" } };
		}
		const reserved = await budget(this.env).reserve(input.user);
		if (reserved.error) return { status: 429, body: { ...view, error: reserved.error } };

		const next: JobState = {
			key,
			seq: input.seq,
			status: "pending",
			user: input.user,
			model: input.model,
			day: reserved.day,
			messages: input.messages,
			successes,
			started: Date.now(),
		};
		await this.ctx.storage.put("job", next);
		await this.ctx.storage.setAlarm(Date.now()); // run the OpenAI call in the background
		return { status: 202, body: publicView(next, this.env) };
	}

	async check(): Promise<Reply> {
		const job = await this.load();
		if (!job) {
			const max = limit(this.env.MAX_GENERATIONS_PER_VARIANT, 10);
			return { status: 200, body: { status: "none", seq: 0, generations_used: 0, generations_left: max } };
		}
		return { status: 200, body: publicView(job, this.env) };
	}

	async alarm(): Promise<void> {
		const job = await this.ctx.storage.get<JobState>("job");
		if (!job || job.status !== "pending" || !job.messages) return;
		const result = await callOpenAI(job, this.env);

		const latest = await this.ctx.storage.get<JobState>("job");
		if (!latest || latest.seq !== job.seq || latest.status !== "pending") return;
		if (result.error) await budget(this.env).refund(job.user, job.day); // failures don't count
		await this.ctx.storage.put("job", {
			...latest,
			status: result.error ? "error" : "done",
			text: result.text,
			error: result.error,
			successes: latest.successes + (result.error ? 0 : 1),
			messages: undefined, // don't keep prompts longer than needed
		});
	}

	private async load(): Promise<JobState | undefined> {
		const job = await this.ctx.storage.get<JobState>("job");
		if (job?.status === "pending" && Date.now() - job.started > STALE_MS) {
			const failed: JobState = { ...job, status: "error", error: "timeout", messages: undefined };
			await this.ctx.storage.put("job", failed);
			await budget(this.env).refund(job.user, job.day);
			return failed;
		}
		return job;
	}
}

export class Budget extends DurableObject<Env> {
	// Daily generation counts, keyed like "2026-10-23:user:<id>" and "2026-10-23:total".
	async reserve(user: string): Promise<{ day: string; error?: string }> {
		const day = today();
		const userKey = `${day}:user:${user}`;
		const totalKey = `${day}:total`;
		const counts = await this.ctx.storage.get<number>([userKey, totalKey]);
		const used = counts.get(userKey) ?? 0;
		const total = counts.get(totalKey) ?? 0;
		if (total >= limit(this.env.MAX_TOTAL_PER_DAY, 300)) return { day, error: "course_daily_limit" };
		if (used >= limit(this.env.MAX_PER_USER_PER_DAY, 50)) return { day, error: "user_daily_limit" };
		await this.ctx.storage.put({ [userKey]: used + 1, [totalKey]: total + 1 });
		return { day };
	}

	async refund(user: string, day: string): Promise<void> {
		const userKey = `${day}:user:${user}`;
		const totalKey = `${day}:total`;
		const counts = await this.ctx.storage.get<number>([userKey, totalKey]);
		await this.ctx.storage.put({
			[userKey]: Math.max(0, (counts.get(userKey) ?? 0) - 1),
			[totalKey]: Math.max(0, (counts.get(totalKey) ?? 0) - 1),
		});
	}
}

function providerError(status: number, payload: any): string {
	if (status === 429) {
		const code = payload?.error?.code ?? payload?.error?.type;
		return code === "insufficient_quota" ? "provider_quota" : "provider_rate_limit";
	}
	if (status === 401 || status === 403) return "provider_auth";
	if (status === 408 || status >= 500) return "provider_unavailable";
	return "provider_rejected";
}

async function callOpenAI(job: JobState, env: Env): Promise<{ text?: string; error?: string }> {
	const body: Record<string, unknown> = {
		model: job.model,
		messages: job.messages,
		max_completion_tokens: limit(env.MAX_COMPLETION_TOKENS, 1000),
	};
	// Newer models reject temperature; keep it at 0 wherever it is accepted.
	if (!list(env.NO_TEMPERATURE_MODELS).includes(job.model)) body.temperature = 0;

	const started = Date.now();
	let result: { text?: string; error?: string };
	let detail: string | undefined;
	let usage: any;
	try {
		const response = await fetch(env.OPENAI_API_URL || DEFAULT_OPENAI_URL, {
			method: "POST",
			headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
		});
		const raw = await response.text();
		let payload: any = null;
		try {
			payload = JSON.parse(raw);
		} catch {
			// handled below
		}
		if (response.ok) {
			usage = payload?.usage;
			const text = payload?.choices?.[0]?.message?.content;
			result = typeof text === "string" && text.trim() ? { text } : { error: "provider_rejected" };
			if (result.error) detail = "Response had no message content.";
		} else {
			result = { error: providerError(response.status, payload) };
			detail = String(payload?.error?.message ?? `HTTP ${response.status}`).slice(0, 300);
		}
	} catch (err) {
		result = { error: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "provider_unavailable" };
		detail = String(err).slice(0, 300);
	}

	// One log line per model call; view live with `npx wrangler tail`.
	console.log(
		JSON.stringify({
			variant: job.key,
			user: job.user,
			seq: job.seq,
			model: job.model,
			status: result.error ? "error" : "done",
			error: result.error,
			detail,
			prompt_tokens: usage?.prompt_tokens,
			completion_tokens: usage?.completion_tokens,
			latency_ms: Date.now() - started,
		}),
	);
	return result;
}
