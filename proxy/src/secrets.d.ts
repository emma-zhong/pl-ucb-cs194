// Secrets are set with `wrangler secret put` (deployed) or .dev.vars (local), so
// `wrangler types` cannot see them. Declare them here.
interface Env {
	COURSE_TOKEN: string;
	OPENAI_API_KEY: string;
}
