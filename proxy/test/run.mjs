// `npm test`: start the fake OpenAI and a local proxy pointed at it, run the checks,
// then shut both down. Uses no real OpenAI key and spends no credits.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-test-"));
const calls = path.join(dir, "calls.log");
fs.writeFileSync(calls, "");
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const children = [
	spawn(process.execPath, [path.join(here, "fake-openai.mjs"), calls], { stdio: "ignore" }),
	spawn(
		"npx",
		[
			"wrangler", "dev", "--port", "8787", "--persist-to", path.join(dir, "state"),
			"--var", "COURSE_TOKEN:test-token",
			"--var", "OPENAI_API_KEY:fake-key",
			"--var", "OPENAI_API_URL:http://127.0.0.1:8788/v1/chat/completions",
			"--var", "MAX_GENERATIONS_PER_VARIANT:3",
			"--var", "MAX_PER_USER_PER_DAY:6",
			"--var", "ALLOWED_MODELS:gpt-4.1-mini,gpt-5.6-luna",
		],
		{ stdio: "ignore", shell: process.platform === "win32" },
	),
];

function stop() {
	for (const child of children) {
		try {
			if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
			else child.kill();
		} catch {
			// already stopped
		}
	}
}

const test = spawn(process.execPath, [path.join(here, "test-proxy.mjs"), calls], { stdio: "inherit" });
test.on("exit", (code) => {
	stop();
	process.exit(code ?? 1);
});
