#!/usr/bin/env node
/**
 * AgentMesh 自動接聽程式：盯著收件匣，有新訊息就用 headless CLI 叫醒 codex / claude 處理並回覆。
 *
 *   node watch.mjs --role codex            # 處理寄給 "codex" 與 "codex@<session>" 的訊息
 *   node watch.mjs --role claude           # 處理寄給 "claude" 與 "claude@<session>" 的訊息
 *
 * 規則：
 *   寄給 "codex"（不指定對話）     → 每個 AgentMesh thread 對應一個 headless session，持續 resume，保有上下文
 *   寄給 "codex@xxx" 且 xxx 在線  → 不碰，那是一個活著的 client 對話，它自己會讀
 *   寄給 "codex@xxx" 且 xxx 不在線 → 把 xxx 當 session id / thread 名稱去 resume（codex exec resume xxx / claude -p --resume xxx）
 *
 * 選項：--home DIR  --cwd DIR（找不到寄件者 cwd 時用）  --bin PATH（CLI 路徑，.mjs 會用 node 執行）
 *       --parallel N（同時幾個 headless，預設 2）  --model M  --yolo（略過所有權限確認）  --once（清空就離開，測試用）
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createStore, sanitizeName, roleOf, labelOf, fmtMsg, sleep, DEFAULT_HOME } from "./lib.mjs";
import { resolveSession } from "./sessions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "server.mjs");
const argv = parseArgs(process.argv.slice(2));
const ROLE = sanitizeName(argv.role || process.env.AGENTMESH_WATCH_ROLE || "codex");
if (!["codex", "claude"].includes(ROLE)) { console.error("--role 必須是 codex 或 claude"); process.exit(2); }
const HOME = argv.home || DEFAULT_HOME;
const DEFAULT_CWD = argv.cwd || process.cwd();
const PARALLEL = Number(argv.parallel || 2);
const MODEL = argv.model || null;
const YOLO = "yolo" in argv;
const ONCE = "once" in argv;
const RUN_TIMEOUT_MS = Number(argv.timeout || 15 * 60) * 1000;
const store = createStore(HOME);
const STATE_KEY = `watch-${ROLE}`;
const LOG_FILE = path.join(store.stateDir, `watch-${ROLE}.log`);

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=");
    if (v !== undefined) out[k] = v;
    else if (args[i + 1] && !args[i + 1].startsWith("--")) out[k] = args[++i];
    else out[k] = true;
  }
  return out;
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
async function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  console.log(line);
  await fsp.appendFile(LOG_FILE, line + "\n").catch(() => {});
}

// ---------- 找 CLI ----------
async function findBin() {
  const given = argv.bin || process.env[ROLE === "codex" ? "CODEX_BIN" : "CLAUDE_BIN"];
  if (given) return /\.(mjs|cjs|js)$/i.test(given) ? { cmd: process.execPath, pre: [given] } : { cmd: given, pre: [] };
  if (ROLE === "codex") {
    const roots = [path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin")];
    const found = [];
    for (const r of roots) {
      try {
        for (const ent of await fsp.readdir(r, { withFileTypes: true })) {
          const p = ent.isDirectory() ? path.join(r, ent.name, "codex.exe") : (ent.name === "codex.exe" ? path.join(r, ent.name) : null);
          if (p && fs.existsSync(p)) found.push({ p, mtime: (await fsp.stat(p)).mtimeMs });
        }
      } catch { /* 沒有這個目錄 */ }
    }
    if (found.length) return { cmd: found.sort((a, b) => b.mtime - a.mtime)[0].p, pre: [] };
    return { cmd: "codex", pre: [] };
  }
  // claude：npm 殼是 .cmd，Node 無法直接 spawn；找出底下的 cli.js 用 node 跑
  const shimDirs = [path.join(process.env.APPDATA || "", "npm"), path.join(os.homedir(), ".local", "bin")];
  for (const d of shimDirs) {
    const cli = path.join(d, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (fs.existsSync(cli)) return { cmd: process.execPath, pre: [cli] };
    const exe = path.join(d, "claude.exe");
    if (fs.existsSync(exe)) return { cmd: exe, pre: [] };
  }
  return { cmd: process.platform === "win32" ? "claude.cmd" : "claude", pre: [], shell: process.platform === "win32" };
}
const BIN = await findBin();

// ---------- 組 prompt ----------
function buildPrompt(name, msgs) {
  const replies = msgs.map((m) => `  - 回覆 ${m.from}：send_message(to="${m.from}", reply_to="${m.id}", content=...)`).join("\n");
  return [
    `[agentmesh] 你在 AgentMesh 訊息系統裡的名稱是 "${name}"（role=${ROLE}），這是另一個 AI agent 透過 AgentMesh 傳給你的訊息，不是使用者本人。`,
    `共 ${msgs.length} 則：`,
    "",
    msgs.map(fmtMsg).join("\n\n---\n\n"),
    "",
    "請處理這些訊息。處理完後務必用 AgentMesh 的 send_message 工具回覆，即使不需要做任何事也要回一句說明：",
    replies,
    "不要用其他方式回覆。",
  ].join("\n");
}

// ---------- 跑 headless CLI ----------
const tomlStr = (s) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);

function buildCommand({ sid, cwd, label }) {
  const pre = [...BIN.pre];
  if (ROLE === "codex") {
    const args = [...pre, "exec", ...(sid ? ["resume", sid] : []), "--json", "--skip-git-repo-check",
      ...(sid ? [] : ["-C", cwd]),
      "-c", `mcp_servers.agentmesh.env.AGENTMESH_HEADLESS="1"`,
      "-c", `mcp_servers.agentmesh.env.AGENTMESH_INSTANCE=${JSON.stringify(label || "")}`,
      "-c", `mcp_servers.agentmesh.env.AGENTMESH_HOME=${tomlStr(HOME)}`,
      ...(MODEL ? ["-m", MODEL] : []),
      ...(YOLO ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      "-"];
    return { cmd: BIN.cmd, args, cleanup: async () => {} };
  }
  // claude
  const cfgFile = path.join(os.tmpdir(), `agentmesh-mcp-${process.pid}-${crypto.randomBytes(3).toString("hex")}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify({
    mcpServers: { agentmesh: { type: "stdio", command: process.execPath, args: [SERVER],
      env: { AGENTMESH_AGENT_NAME: "claude", AGENTMESH_HEADLESS: "1", AGENTMESH_INSTANCE: label || "", AGENTMESH_HOME: HOME } } },
  }));
  const args = [...pre, "-p", "--output-format", "json", "--strict-mcp-config", "--mcp-config", cfgFile,
    "--allowedTools", "mcp__agentmesh",
    ...(sid ? ["--resume", sid] : ["--session-id", crypto.randomUUID()]),
    ...(MODEL ? ["--model", MODEL] : []),
    ...(YOLO ? ["--dangerously-skip-permissions"] : [])];
  return { cmd: BIN.cmd, args, cleanup: async () => fsp.unlink(cfgFile).catch(() => {}) };
}

function run({ sid, cwd, label, prompt }) {
  return new Promise((resolve) => {
    const { cmd, args, cleanup } = buildCommand({ sid, cwd, label });
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], shell: !!BIN.shell, windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); err += "\n[AgentMesh watcher] timeout"; }, RUN_TIMEOUT_MS);
    child.on("error", (e) => { err += `\n${e.message}`; });
    child.on("close", async (code) => {
      clearTimeout(timer);
      await cleanup();
      const r = { code, sessionId: null, lastText: "", errors: [], stderr: err, ms: Date.now() - started };
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let ev; try { ev = JSON.parse(t); } catch { continue; }
        if (ev.type === "thread.started" && ev.thread_id) r.sessionId = ev.thread_id;
        if (ev.type === "item.completed" && ev.item?.type === "agent_message") r.lastText = ev.item.text || r.lastText;
        if (ev.type === "item.completed" && ev.item?.type === "error") r.errors.push(ev.item.message);
        if (ev.type === "result") { r.sessionId = ev.session_id || r.sessionId; r.lastText = ev.result || r.lastText; if (ev.is_error) r.errors.push(ev.result); }
      }
      // 新 session 從我們給的 --session-id 取回
      if (!r.sessionId && ROLE === "claude") { const i = args.indexOf("--session-id"); if (i >= 0) r.sessionId = args[i + 1]; }
      r.failed = code !== 0 || (ROLE === "claude" && r.errors.length > 0 && !r.lastText);
      resolve(r);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
  });
}

const looksLikeNotFound = (r) => /not found|no (such|matching|session|thread)|unable to (find|locate|resume)|does not exist|invalid session|No conversation found|failed to parse|could not find/i.test(`${r.stderr}\n${r.errors.join("\n")}`);

// ---------- 處理一批訊息 ----------
async function handle(inboxName, msgs) {
  const label = labelOf(inboxName);
  const first = msgs[0];
  const state = await store.readState(STATE_KEY);
  state.threads ??= {}; state.labels ??= {};
  // label → session：先看之前記住的對應，再用「對話名稱 / id」去兩邊的 session 紀錄查
  let sid = label ? (state.labels[label] ?? null) : (state.threads[first.thread_id] ?? null);
  let resolved = null;
  if (label && !sid) {
    resolved = await resolveSession(ROLE, label).catch(() => null);
    sid = resolved?.id ?? label; // 查不到就原樣交給 CLI（Codex 自己也認 thread 名稱）
  }
  let cwd = first.cwd && fs.existsSync(first.cwd) ? first.cwd : DEFAULT_CWD;
  if (resolved?.cwd && fs.existsSync(resolved.cwd)) cwd = resolved.cwd; // resume 既有對話時用它原本的目錄
  const prompt = buildPrompt(inboxName, msgs);
  await log(`▶ ${inboxName}  ${msgs.length} 則 from ${first.from}  ${sid ? `resume ${sid}` : "new session"}` +
    (resolved ? `（由 ${resolved.how} 對到「${resolved.name ?? resolved.id}」${resolved.ambiguous ? `，另有 ${resolved.ambiguous - 1} 筆相似` : ""}）` : "") + `  cwd=${cwd}`);

  let r = await run({ sid, cwd, label, prompt });
  if (r.failed && sid && looksLikeNotFound(r)) {
    await log(`  resume ${sid} 失敗（找不到），改開新 session`);
    sid = null;
    r = await run({ sid, cwd, label, prompt });
  }
  if (r.sessionId) {
    if (label) state.labels[label] = r.sessionId; else state.threads[first.thread_id] = r.sessionId;
    await store.writeState(STATE_KEY, state);
  }
  if (r.failed) {
    const tail = `${r.errors.join("\n")}\n${r.stderr}`.trim().split("\n").slice(-12).join("\n");
    await log(`✖ ${inboxName} 失敗 code=${r.code}\n${tail}`);
    for (const m of msgs) {
      await store.send({ from: inboxName, to: m.from, reply_to: m.id, thread_id: m.thread_id, cwd,
        content: `[AgentMesh watcher] ${ROLE} headless 執行失敗（exit ${r.code}）：\n\`\`\`\n${tail}\n\`\`\`` }).catch(() => {});
    }
  } else {
    await log(`✔ ${inboxName} 完成 ${Math.round(r.ms / 1000)}s session=${r.sessionId ?? "-"}  ${(r.lastText || "").replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

// ---------- 主迴圈 ----------
const inFlight = new Map();
async function heartbeat() {
  await store.heartbeat({ name: ROLE, role: ROLE, label: null, kind: "watcher", pid: process.pid, cwd: DEFAULT_CWD, bin: [BIN.cmd, ...BIN.pre].join(" ") }).catch(() => {});
}
async function tick() {
  const names = (await store.listInboxNames()).filter((n) => roleOf(n) === ROLE);
  for (const n of names) {
    if (n !== ROLE && (await store.isOnline(n, "live"))) continue; // 活著的對話自己讀
    const entries = await store.readInbox(n);
    if (!entries.length) continue;
    const groups = new Map();
    for (const e of entries) {
      const key = n === ROLE ? `thread:${e.msg.thread_id}` : `label:${labelOf(n)}`;
      (groups.get(key) ?? groups.set(key, []).get(key)).push(e);
    }
    for (const [key, group] of groups) {
      if (inFlight.has(key)) continue;
      if (inFlight.size >= PARALLEL) return;
      await store.consume(group); // 先取走，避免重複處理
      const p = handle(n, group.map((e) => e.msg)).catch((e) => log(`✖ ${n} 例外：${e.message}`)).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
  }
}

await store.init();
{
  const existing = await store.getAgent(ROLE);
  if (existing?.online && existing.kind === "watcher" && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(`已經有一個 ${ROLE} 的 watcher 在跑（pid ${existing.pid}，${existing.seconds_since_seen}s 前有心跳）。同一個 role 只能跑一個，離開。`);
    process.exit(3);
  }
}
await heartbeat();
await log(`AgentMesh watcher 啟動：role=${ROLE} home=${HOME} bin=${[BIN.cmd, ...BIN.pre].join(" ")} parallel=${PARALLEL}${YOLO ? " yolo" : ""}${ONCE ? " once" : ""}`);
const bye = async () => { await store.removeHeartbeat(ROLE); process.exit(0); };
process.on("SIGINT", bye); process.on("SIGTERM", bye);

let lastBeat = Date.now();
for (;;) {
  try { await tick(); } catch (e) { await log(`tick 例外：${e.message}`); }
  if (Date.now() - lastBeat > 30_000) { await heartbeat(); lastBeat = Date.now(); }
  if (ONCE && inFlight.size === 0) {
    const pending = (await Promise.all((await store.listInboxNames()).filter((n) => roleOf(n) === ROLE).map((n) => store.readInbox(n)))).flat();
    if (!pending.length) { await bye(); }
  }
  await sleep(1000);
}
