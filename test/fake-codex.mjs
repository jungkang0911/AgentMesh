// 假的 codex CLI：模仿 `codex exec [resume SID] --json ... -` 的行為，從 stdin 讀 prompt，
// 解析出要回覆誰，直接寫進 AgentMesh 收件匣，並印出 JSONL 事件。測試 watch.mjs 用。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../lib.mjs";

const args = process.argv.slice(2);
const ri = args.indexOf("resume");
const resumeSid = ri >= 0 ? args[ri + 1] : null;
if (resumeSid && process.env.FAKE_FAIL_RESUME && resumeSid.startsWith(process.env.FAKE_FAIL_RESUME)) {
  console.error(`error: no session found for ${resumeSid}`);
  process.exit(1);
}
const cfg = Object.fromEntries(args.flatMap((a, i) => (a === "-c" ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
const unq = (s = "") => s.replace(/^['"]|['"]$/g, "");
const home = unq(cfg["mcp_servers.agentmesh.env.AGENTMESH_HOME"]);
const label = unq(cfg["mcp_servers.agentmesh.env.AGENTMESH_INSTANCE"]);
const headless = unq(cfg["mcp_servers.agentmesh.env.AGENTMESH_HEADLESS"]);

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const name = prompt.match(/名稱是 "([^"]+)"/)?.[1] ?? (label ? `codex@${label}` : "codex");
const sid = resumeSid ?? `fake-${Math.random().toString(16).slice(2, 8)}`;
console.log(JSON.stringify({ type: "thread.started", thread_id: sid }));
console.log(JSON.stringify({ type: "turn.started" }));

const store = createStore(home);
const replies = [...prompt.matchAll(/send_message\(to="([^"]+)", reply_to="([^"]+)"/g)];
for (const [, to, replyTo] of replies) {
  const orig = await store.findMessage(replyTo);
  await store.send({ from: name, to, reply_to: replyTo,
    content: `fake-codex 回覆「${(orig?.content ?? "").slice(0, 30)}」 resumed=${resumeSid ?? "none"} headless=${headless} cwd=${path.basename(process.cwd())}` });
}
console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: `replied to ${replies.length}` } }));
console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
void fileURLToPath;
