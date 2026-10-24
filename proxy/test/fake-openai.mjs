// Fake OpenAI chat-completions endpoint for testing the proxy without spending credits.
import http from "node:http";
import fs from "node:fs";
const log = process.argv[2];
http.createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
    const body = JSON.parse(raw);
    const prompt = body.messages.map((m) => m.content).join(" ");
    fs.appendFileSync(log, JSON.stringify({ model: body.model, has_temperature: "temperature" in body, max: body.max_completion_tokens, prompt }) + "\n");
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer fake-key") return send(401, { error: { message: "Incorrect API key" } });
    if (prompt.includes("QUOTA")) return send(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } });
    if (prompt.includes("RATE")) return send(429, { error: { code: "rate_limit_exceeded", message: "slow down" } });
    if (prompt.includes("BAD")) return send(400, { error: { message: "Unsupported value: 'temperature'" } });
    const reply = () => send(200, { choices: [{ message: { content: "OK " + prompt.slice(0, 20) } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    if (prompt.includes("SLOW")) setTimeout(reply, 3000); else reply();
  });
}).listen(8788, () => console.log("fake openai on 8788"));
