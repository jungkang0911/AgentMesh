#!/usr/bin/env node
/**
 * AgentMesh MCP — 讓 Claude Code 與 Codex（或任何 MCP client）互傳訊息的 MCP server。
 *
 * 每個 client 的每個對話各自以 stdio 啟動一份本程式，透過共用目錄（預設 ~/.agentmesh）交換訊息。
 *
 * 身分：
 *   role   = AGENTMESH_AGENT_NAME（claude / codex）
 *   label  = AGENTMESH_INSTANCE，沒給就用 client 的工作目錄名稱（例如 a2amcp）
 *   name   = role@label（例如 claude@a2amcp）；AGENTMESH_HEADLESS=1 時不寫心跳（給 watch.mjs 叫起來的 headless 用）
 *
 * 位址：
 *   "codex@lineauto"  指定某一個對話（該對話必須在線，或由 watch.mjs 以 session id / thread 名稱 resume）
 *   "codex"           不指定對話：有 watch.mjs 在跑就由它 headless 處理，否則任一個在線的 codex 對話讀取時會收到
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createStore, sanitizeName, roleOf, labelOf, fmtMsg, fmtMsgs, sleep, MAX_WAIT_S, DEFAULT_HOME } from "./lib.mjs";

// ---------- 設定 ----------
const argv = parseArgs(process.argv.slice(2));
const HOME = argv.home || DEFAULT_HOME;
const ROLE = roleOf(sanitizeName(argv.name || process.env.AGENTMESH_AGENT_NAME || "agent"));
const HEADLESS = (argv.headless ?? process.env.AGENTMESH_HEADLESS) === "1";
const EXPLICIT_LABEL = argv.instance ?? process.env.AGENTMESH_INSTANCE;
const DEFAULT_PEER = (argv.peer || process.env.AGENTMESH_PEER) ? sanitizeName(argv.peer || process.env.AGENTMESH_PEER) : undefined;
const POLL_MS = 400;
const HEARTBEAT_MS = 30_000;
const CHANNEL_POLL_MS = 1000;

const store = createStore(HOME);
let NAME = HEADLESS && !EXPLICIT_LABEL ? ROLE : `${ROLE}@${sanitizeName(EXPLICIT_LABEL || fallbackLabel())}`;
let initialized = false;

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); out[k] = v ?? args[++i]; }
  }
  return out;
}
function fallbackLabel() {
  const cwd = process.cwd();
  const home = os.homedir();
  const base = path.basename(cwd);
  if (!base || cwd === home || /[\\/]\.(codex|claude)([\\/]|$)/i.test(cwd) || base.startsWith(".")) return "desktop";
  return base;
}
async function labelFromRoots() {
  try {
    if (!server.server.getClientCapabilities()?.roots) return null;
    const { roots } = await server.server.listRoots();
    const uri = roots?.[0]?.uri;
    if (!uri) return roots?.[0]?.name || null;
    const p = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    return path.basename(p) || null;
  } catch { return null; }
}
async function uniqueName(base) {
  if (HEADLESS) return base;
  let name = base;
  for (let i = 2; i < 50; i++) {
    const a = await store.getAgent(name);
    if (!a || !a.online || a.pid === process.pid) return name;
    name = `${base}-${i}`;
  }
  return name;
}

async function heartbeat() {
  if (HEADLESS) return;
  try { await store.heartbeat({ name: NAME, role: ROLE, label: labelOf(NAME), kind: "live", pid: process.pid, cwd: process.cwd() }); }
  catch (e) { console.error(`[agentmesh] heartbeat failed: ${e.message}`); }
}

/** 我要讀的收件匣：自己的；若沒有 watcher 在線，也讀 role 層級的。 */
async function myInboxNames() {
  const names = [NAME];
  if (NAME !== ROLE && !(await store.isOnline(ROLE, "watcher"))) names.push(ROLE);
  return names;
}
async function readMyInbox() {
  const out = [];
  for (const n of await myInboxNames()) out.push(...(await store.readInbox(n)));
  return out.sort((a, b) => a.msg.id.localeCompare(b.msg.id));
}

/** 解析收件人：明確指定 > AGENTMESH_PEER > 唯一的另一個 role。 */
async function resolvePeer(to) {
  if (to) {
    const t = sanitizeName(to);
    if (t === NAME) throw new Error("不能寄給自己。");
    return t;
  }
  if (DEFAULT_PEER) return DEFAULT_PEER;
  const roles = [...new Set((await store.listAgents()).map((a) => a.role || roleOf(a.name)))].filter((r) => r !== ROLE);
  if (roles.length === 1) return roles[0];
  if (roles.length === 0) throw new Error('找不到其他 agent，請在 `to` 指定收件人（例如 "codex"）。');
  throw new Error(`有多種 agent（${roles.join(", ")}），請在 \`to\` 指定收件人。`);
}

function matches(msg, { from, thread_id, reply_to }) {
  if (from) { const f = sanitizeName(from); if (msg.from !== f && roleOf(msg.from) !== f) return false; }
  if (thread_id && msg.thread_id !== thread_id) return false;
  if (reply_to && msg.reply_to !== reply_to) return false;
  return true;
}

async function waitForMessages({ timeout_s, from, thread_id, reply_to }) {
  const deadline = Date.now() + Math.min(Math.max(timeout_s, 0), MAX_WAIT_S) * 1000;
  let lastBeat = 0;
  for (;;) {
    const hits = (await readMyInbox()).filter((e) => matches(e.msg, { from, thread_id, reply_to }));
    if (hits.length) { await store.consume(hits); return hits.map((e) => e.msg); }
    if (Date.now() >= deadline) return [];
    if (Date.now() - lastBeat > HEARTBEAT_MS) { await heartbeat(); lastBeat = Date.now(); }
    await sleep(POLL_MS);
  }
}

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `錯誤：${e.message || e}` }] });

// ---------- MCP server ----------
const OTHER = ROLE === "claude" ? "codex" : "claude";
const server = new McpServer({ name: "agentmesh-mcp", version: "0.2.0" }, {
  // 宣告 Claude Code Channels 能力；未啟用時通知會被對方靜默丟棄，無害。
  capabilities: { experimental: { "claude/channel": {} } },
  instructions:
    `你是 AgentMesh 裡的一個 ${ROLE}（呼叫 whoami 可知完整名稱，格式 role@label）。這組工具讓你跟另一個 AI agent（例如 ${OTHER}）互傳訊息。` +
    ` 位址寫法：「${OTHER}」= 不指定對話，交給對方的自動接聽程式處理；「${OTHER}@某標籤」= 指定對方某一個對話（用 list_agents 查）。` +
    ` 要問對方並等答案，用 send_message 搭配 wait_for_reply_seconds；要等對方主動聯絡，用 wait_for_message；` +
    ` 收到訊息後用 send_message 搭配 reply_to 回覆。若看到 <channel source="agentmesh"> 事件，表示有新訊息已推送給你，請用 check_inbox 取出並回覆。`,
});

server.registerTool("whoami", {
  title: "我是誰",
  description: "回傳本對話在 AgentMesh 的名稱（role@label）、共用目錄、預設對象與其他已知 agent。",
  inputSchema: {},
}, async () => {
  try {
    await heartbeat();
    const agents = await store.listAgents();
    return text(JSON.stringify({ me: NAME, role: ROLE, label: labelOf(NAME), headless: HEADLESS, home: HOME, default_peer: DEFAULT_PEER ?? null, agents }, null, 2));
  } catch (e) { return fail(e); }
});

server.registerTool("set_name", {
  title: "改名",
  description: "替本對話取一個好認的標籤，之後對方可用 role@label 指定傳給這個對話。例如 set_name(\"videos\") 會變成 claude@videos；中文也可以，空白會變成 -。",
  inputSchema: { label: z.string().min(1).max(100).describe("新的標籤（任何語言的字母數字與 _.-，其餘變成 -）") },
}, async ({ label }) => {
  try {
    const target = `${ROLE}@${sanitizeName(label)}`;
    if (target === NAME) return text(`名稱已經是 ${NAME}`);
    const other = await store.getAgent(target);
    if (other?.online && other.pid !== process.pid) throw new Error(`${target} 已被另一個在線對話使用（pid ${other.pid}）。`);
    const moved = await store.moveInbox(NAME, target);
    await store.removeHeartbeat(NAME);
    const old = NAME; NAME = target;
    await heartbeat();
    return text(`已改名：${old} → ${NAME}${moved ? `（搬移 ${moved} 則未讀）` : ""}`);
  } catch (e) { return fail(e); }
});

server.registerTool("list_agents", {
  title: "列出 agent",
  description: "列出所有已知的對話／監聽程式與是否在線（5 分鐘內有心跳）。live = 一個 client 對話，watcher = 自動接聽程式。",
  inputSchema: {},
}, async () => {
  try {
    await heartbeat();
    const agents = await store.listAgents();
    if (!agents.length) return text("目前沒有任何已註冊的 agent。");
    return text(agents.map((a) =>
      `${a.online ? "●" : "○"} ${a.name}${a.name === NAME ? " (me)" : ""}  [${a.kind || "live"}]  last_seen=${a.last_seen} (${a.seconds_since_seen}s ago)  pid=${a.pid}  cwd=${a.cwd ?? "-"}`,
    ).join("\n"));
  } catch (e) { return fail(e); }
});

server.registerTool("send_message", {
  title: "傳送訊息",
  description:
    "傳一則訊息給另一個 agent。`to` 可以是 role（如 codex，交給對方自動接聽）或 role@label（指定對方某個對話）。" +
    " `to` 省略時：若設定了 AGENTMESH_PEER 就用它，否則若只有一種其他 agent 就用那個 role。" +
    " 要等對方回覆，設定 wait_for_reply_seconds（最多 600 秒）。回覆別人時帶上 reply_to（對方訊息的 id），thread_id 會自動沿用。",
  inputSchema: {
    content: z.string().min(1).describe("訊息內容（可以是 Markdown）"),
    to: z.string().optional().describe("收件人：codex、claude、codex@lineauto、claude@videos ……"),
    thread_id: z.string().optional().describe("要歸入的對話串 id；不給則開新串"),
    reply_to: z.string().optional().describe("回覆哪一則訊息（訊息 id）"),
    wait_for_reply_seconds: z.number().int().min(0).max(MAX_WAIT_S).optional().describe("送出後等待對方回覆的秒數；0 或省略表示不等"),
  },
}, async ({ content, to, thread_id, reply_to, wait_for_reply_seconds }) => {
  try {
    await heartbeat();
    const peer = await resolvePeer(to);
    const msg = await store.send({ from: NAME, to: peer, content, thread_id, reply_to, cwd: process.cwd() });
    let sentLine = `已送出 → ${msg.to}  id=${msg.id}  thread=${msg.thread_id}`;
    if (!labelOf(peer)) {
      const w = await store.isOnline(peer, "watcher");
      const live = (await store.listAgents()).filter((a) => a.online && a.kind === "live" && (a.role || roleOf(a.name)) === peer);
      sentLine += w ? `\n（${peer} 的自動接聽程式在線，會 headless 處理）`
        : live.length ? `\n（沒有自動接聽程式；在線的 ${peer} 對話：${live.map((a) => a.name).join(", ")}，它們下次查收件匣時會收到）`
        : `\n（目前沒有任何 ${peer} 在線，訊息會留在收件匣）`;
    } else if (!(await store.isOnline(peer, "live"))) {
      sentLine += (await store.isOnline(roleOf(peer), "watcher"))
        ? `\n（${peer} 不在線，自動接聽程式會嘗試以 "${labelOf(peer)}" 作為 session id / thread 名稱 resume）`
        : `\n（注意：${peer} 不在線，也沒有自動接聽程式，訊息會留在收件匣）`;
    }
    if (!wait_for_reply_seconds) return text(sentLine);
    const replies = await waitForMessages({ timeout_s: wait_for_reply_seconds, thread_id: msg.thread_id });
    if (!replies.length) return text(`${sentLine}\n\n等了 ${wait_for_reply_seconds} 秒沒有收到回覆。之後可用 wait_for_message 或 check_inbox 再收。`);
    return text(`${sentLine}\n\n收到回覆：\n\n${fmtMsgs(replies)}`);
  } catch (e) { return fail(e); }
});

server.registerTool("check_inbox", {
  title: "檢查收件匣",
  description: "立即回傳收件匣裡所有未讀訊息（不會等待）。預設讀取後就視為已讀並移除；peek=true 則只看不移除。",
  inputSchema: {
    peek: z.boolean().optional().describe("true 表示只看不標記已讀"),
    from: z.string().optional().describe("只看來自某個 agent 的訊息（role 或 role@label）"),
  },
}, async ({ peek, from }) => {
  try {
    await heartbeat();
    const hits = (await readMyInbox()).filter((e) => matches(e.msg, { from }));
    if (!peek) await store.consume(hits);
    return text(fmtMsgs(hits.map((e) => e.msg), "收件匣是空的。"));
  } catch (e) { return fail(e); }
});

server.registerTool("wait_for_message", {
  title: "等待訊息",
  description: "阻塞等待直到收到新訊息或超時（最多 600 秒）。可用 from / thread_id / reply_to 過濾。收到的訊息會從收件匣移除。超時可以再呼叫一次繼續等。",
  inputSchema: {
    timeout_seconds: z.number().int().min(1).max(MAX_WAIT_S).default(120).describe("最多等幾秒"),
    from: z.string().optional().describe("只等來自某個 agent 的訊息"),
    thread_id: z.string().optional().describe("只等某個對話串"),
    reply_to: z.string().optional().describe("只等針對某則訊息的回覆"),
  },
}, async ({ timeout_seconds, from, thread_id, reply_to }) => {
  try {
    await heartbeat();
    const msgs = await waitForMessages({ timeout_s: timeout_seconds, from, thread_id, reply_to });
    return text(fmtMsgs(msgs, `等了 ${timeout_seconds} 秒沒有新訊息。`));
  } catch (e) { return fail(e); }
});

server.registerTool("get_history", {
  title: "查看歷史",
  description: "查看最近的訊息紀錄（所有 agent 共用同一份），可用 thread_id 或 with 過濾。",
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(20).describe("最多回傳幾則（取最新的）"),
    thread_id: z.string().optional().describe("只看某個對話串"),
    with: z.string().optional().describe("只看與某個 agent（role 或 role@label）之間的往來"),
  },
}, async ({ limit, thread_id, with: peer }) => {
  try {
    await heartbeat();
    let hist = await store.readHistory();
    if (thread_id) hist = hist.filter((m) => m.thread_id === thread_id);
    if (peer) {
      const p = sanitizeName(peer);
      hist = hist.filter((m) => [m.from, m.to, roleOf(m.from), roleOf(m.to)].includes(p));
    }
    return text(fmtMsgs(hist.slice(-limit), "沒有符合的歷史訊息。"));
  } catch (e) { return fail(e); }
});

// ---------- Claude Code Channels：有新訊息就主動推進對話 ----------
// 不消費訊息（檔案留在收件匣），只推一次；沒啟用 channel 的 client 會靜默丟棄，不會漏信。
const pushed = new Set();
async function channelTick() {
  if (!initialized) return;
  try {
    for (const { msg } of await readMyInbox()) {
      if (pushed.has(msg.id)) continue;
      pushed.add(msg.id);
      await server.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: `${fmtMsg(msg)}\n\n（請用 check_inbox 取出這則訊息，處理後以 send_message reply_to=${msg.id} 回覆 ${msg.from}）`,
          meta: { from: msg.from, id: msg.id, thread_id: msg.thread_id, severity: "normal" },
        },
      });
    }
    if (pushed.size > 2000) pushed.clear();
  } catch (e) { console.error(`[agentmesh] channel push failed: ${e.message}`); }
}

// ---------- 啟動 ----------
await store.init();
server.server.oninitialized = async () => {
  try {
    if (!HEADLESS && !EXPLICIT_LABEL) {
      const fromRoots = await labelFromRoots();
      if (fromRoots) NAME = `${ROLE}@${sanitizeName(fromRoots)}`;
    }
    NAME = await uniqueName(NAME);
    await heartbeat();
    initialized = true;
    console.error(`[agentmesh] "${NAME}" ready, home=${HOME}${HEADLESS ? " (headless)" : ""}`);
  } catch (e) { console.error(`[agentmesh] init failed: ${e.message}`); initialized = true; }
};
setInterval(heartbeat, HEARTBEAT_MS).unref();
setInterval(channelTick, CHANNEL_POLL_MS).unref();
const bye = async () => { if (!HEADLESS) await store.removeHeartbeat(NAME); process.exit(0); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
server.server.onclose = bye;

await server.connect(new StdioServerTransport());
