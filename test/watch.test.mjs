// watch.mjs 測試：用假的 codex CLI 驗證「主動接聽」流程。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStore } from "../lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentmesh-watch-"));
const store = createStore(home);
let failures = 0;
const check = (c, l, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : `  ${String(d).slice(0, 400)}`}`); if (!c) failures++; };
const txt = (r) => r.content.map((c) => c.text).join("\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(role, instance) {
  const t = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server.mjs")],
    env: { ...process.env, AGENTMESH_AGENT_NAME: role, AGENTMESH_INSTANCE: instance, AGENTMESH_HOME: home }, stderr: "pipe" });
  const c = new Client({ name: "t", version: "0" }); await c.connect(t); return c;
}

// 假的 Codex 家目錄：一個有名字的對話，讓 watcher 能用名稱查到 session id
const NAMED_ID = "11111111-2222-4333-8444-555555555555";
const codexHome = path.join(home, "fake-codex-home");
await fsp.mkdir(path.join(codexHome, "sessions", "2026", "11", "05"), { recursive: true });
await fsp.writeFile(path.join(codexHome, "session_index.jsonl"), JSON.stringify({ id: NAMED_ID, thread_name: "電腦 粉機", updated_at: "2026-11-05T00:00:00Z" }) + "\n");
await fsp.writeFile(path.join(codexHome, "sessions", "2026", "11", "05", `rollout-2026-11-05T00-00-00-${NAMED_ID}.jsonl`),
  JSON.stringify({ type: "session_meta", payload: { id: NAMED_ID, cwd: home, originator: "Codex Desktop" } }) + "\n");

const watcher = spawn(process.execPath, [path.join(root, "watch.mjs"), "--role", "codex", "--home", home, "--bin", path.join(here, "fake-codex.mjs"), "--cwd", home],
  { env: { ...process.env, FAKE_FAIL_RESUME: "ghost", CODEX_HOME: codexHome }, stdio: ["ignore", "pipe", "pipe"] });
let wlog = ""; watcher.stdout.on("data", (d) => { wlog += d; }); watcher.stderr.on("data", (d) => { wlog += d; });

const claude = await connect("claude", "alpha");
await wait(1500);
try {
  check((await store.getAgent("codex"))?.kind === "watcher", "watcher heartbeat registered");

  // 1. 寄給 role → watcher 開新 headless session 並回覆
  const r1 = txt(await claude.callTool({ name: "send_message", arguments: { content: "吃飯了嗎", to: "codex", wait_for_reply_seconds: 20 } }));
  check(r1.includes("收到回覆") && r1.includes("[codex → claude@alpha]") && r1.includes("resumed=none") && r1.includes("headless=1"), "role message → new headless session replies as plain codex", r1);
  const thread1 = r1.match(/thread=(\S+)/)[1];
  const state1 = await store.readState("watch-codex");
  const sid1 = state1.threads?.[thread1];
  check(!!sid1, "thread → session mapping saved", JSON.stringify(state1));

  // 2. 同一 thread 再寄 → resume 同一個 session
  const r2 = txt(await claude.callTool({ name: "send_message", arguments: { content: "再問一次", to: "codex", thread_id: thread1, wait_for_reply_seconds: 20 } }));
  check(r2.includes(`resumed=${sid1}`), "same thread resumes same session", r2);

  // 3. 寄給不在線的 codex@<session> → 直接 resume 那個 session id
  const r3 = txt(await claude.callTool({ name: "send_message", arguments: { content: "指定對話", to: "codex@01a1-some-thread", wait_for_reply_seconds: 20 } }));
  check(r3.includes("[codex@01a1-some-thread → claude@alpha]") && r3.includes("resumed=01a1-some-thread"), "label used as session ref, reply from codex@label", r3);

  // 4. resume 失敗（找不到）→ 退回新 session，並記住對應
  const r4 = txt(await claude.callTool({ name: "send_message", arguments: { content: "鬼對話", to: "codex@ghost-1", wait_for_reply_seconds: 20 } }));
  check(r4.includes("resumed=none"), "unknown session falls back to new", r4);
  const state4 = await store.readState("watch-codex");
  check(!!state4.labels?.["ghost-1"] && state4.labels["ghost-1"] !== "ghost-1", "fallback session remembered for label", JSON.stringify(state4));
  const r4b = txt(await claude.callTool({ name: "send_message", arguments: { content: "鬼對話 2", to: "codex@ghost-1", wait_for_reply_seconds: 20 } }));
  check(r4b.includes(`resumed=${state4.labels["ghost-1"]}`), "next message to label resumes remembered session", r4b);

  // 4b. 用「對話名稱」指定：codex@電腦-粉機 → 查 session_index 對到 id 再 resume
  const r4c = txt(await claude.callTool({ name: "send_message", arguments: { content: "用名字找你", to: "codex@電腦 粉機", wait_for_reply_seconds: 20 } }));
  check(r4c.includes("[codex@電腦-粉機 → claude@alpha]") && r4c.includes(`resumed=${NAMED_ID}`), "label as conversation name resolves to session id (unicode kept)", r4c);
  const r4d = txt(await claude.callTool({ name: "send_message", arguments: { content: "用 id 前綴找你", to: "codex@11111111", wait_for_reply_seconds: 20 } }));
  check(r4d.includes(`resumed=${NAMED_ID}`), "label as id prefix resolves", r4d);
  const state4d = await store.readState("watch-codex");
  check(state4d.labels?.["電腦-粉機"] === NAMED_ID, "name → id mapping remembered", JSON.stringify(state4d));

  // 5. 在線的 live 對話：watcher 不碰，live 自己讀
  const live = await connect("codex", "live");
  await wait(500);
  await claude.callTool({ name: "send_message", arguments: { content: "給活著的", to: "codex@live" } });
  await wait(2500);
  const liveInbox = txt(await live.callTool({ name: "check_inbox", arguments: {} }));
  check(liveInbox.includes("給活著的"), "watcher leaves live instance's inbox alone", liveInbox + "\n" + wlog);
  // live 對話在 watcher 在線時不讀 role 收件匣，role 訊息由 watcher 處理
  const r5 = txt(await claude.callTool({ name: "send_message", arguments: { content: "role 訊息", to: "codex", wait_for_reply_seconds: 20 } }));
  check(r5.includes("[codex → claude@alpha]"), "role message handled by watcher even with live instance online", r5);
  await live.close();

  // 6. 歷史完整
  const hist = await store.readHistory();
  check(hist.filter((m) => m.from.startsWith("codex")).length >= 6, "all replies in history", hist.length);
} finally {
  await claude.close();
  watcher.kill();
  await wait(500);
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
}
if (failures) console.log("\n--- watcher log ---\n" + wlog);
console.log(failures ? `\n${failures} failure(s)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
