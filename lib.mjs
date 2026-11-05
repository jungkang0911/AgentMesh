// AgentMesh 共用儲存層：server.mjs（MCP）與 watch.mjs（主動接聽）都用這一份。
//
// ~/.agentmesh/
//   inbox/<name>/<id>.json   收件匣；<name> 是 "role"（例如 codex）或 "role@label"（例如 codex@lineauto）
//   agents/<name>.json       心跳：live（MCP 實例）或 watcher（監聽程式）
//   history.jsonl            所有訊息流水帳
//   state/                   watcher 的狀態（AgentMesh thread → CLI session 對應）
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const ONLINE_WINDOW_MS = 5 * 60 * 1000;
export const MAX_WAIT_S = 600;
export const DEFAULT_HOME = process.env.AGENTMESH_HOME || path.join(os.homedir(), ".agentmesh");

/**
 * 名稱正規化：小寫，保留任何語言的字母與數字（中文可）及 _.-，其餘（空白、標點）變成 -，
 * 最多一個 @ 分隔 role 與 label。例：「Codex-Claude MCP 訊息服務」→ codex-claude-mcp-訊息服務
 */
export function sanitizeName(raw) {
  const s = String(raw ?? "").trim().toLowerCase().normalize("NFC");
  const [role, ...rest] = s.split("@");
  const clean = (x) => x.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 120);
  const r = clean(role) || "agent";
  const label = rest.length ? clean(rest.join("-")) : "";
  return label ? `${r}@${label}` : r;
}
export const roleOf = (name) => name.split("@")[0];
export const labelOf = (name) => name.split("@")[1] ?? null;

export const now = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function newId() {
  return `${String(Date.now()).padStart(14, "0")}-${crypto.randomBytes(3).toString("hex")}`;
}

export function fmtMsg(m) {
  const head = `[${m.from} → ${m.to}] ${m.ts}  id=${m.id}  thread=${m.thread_id}` +
    (m.reply_to ? `  reply_to=${m.reply_to}` : "") + (m.cwd ? `  cwd=${m.cwd}` : "");
  return `${head}\n${m.content}`;
}
export function fmtMsgs(list, emptyText = "") {
  if (!list.length) return emptyText;
  return list.map(fmtMsg).join("\n\n---\n\n");
}

export function createStore(home = DEFAULT_HOME) {
  const agentsDir = path.join(home, "agents");
  const stateDir = path.join(home, "state");
  const historyFile = path.join(home, "history.jsonl");
  const inboxDir = (name) => path.join(home, "inbox", name);

  async function atomicWriteJson(file, obj) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj), "utf8");
    await fsp.rename(tmp, file);
  }
  async function readJson(file) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return null; }
  }

  async function init() {
    await fsp.mkdir(agentsDir, { recursive: true });
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.mkdir(path.join(home, "inbox"), { recursive: true });
  }

  // ---- 心跳 ----
  async function heartbeat(info) {
    await fsp.mkdir(agentsDir, { recursive: true });
    await atomicWriteJson(path.join(agentsDir, `${info.name}.json`), { ...info, last_seen: now() });
  }
  async function removeHeartbeat(name) {
    await fsp.unlink(path.join(agentsDir, `${name}.json`)).catch(() => {});
  }
  async function listAgents() {
    let names = [];
    try { names = await fsp.readdir(agentsDir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const a = await readJson(path.join(agentsDir, n));
      if (!a?.name) continue;
      const age = Date.now() - Date.parse(a.last_seen);
      out.push({ ...a, online: age < ONLINE_WINDOW_MS, seconds_since_seen: Math.round(age / 1000) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function getAgent(name) {
    const a = await readJson(path.join(agentsDir, `${name}.json`));
    if (!a) return null;
    const age = Date.now() - Date.parse(a.last_seen);
    return { ...a, online: age < ONLINE_WINDOW_MS, seconds_since_seen: Math.round(age / 1000) };
  }
  async function isOnline(name, kind) {
    const a = await getAgent(name);
    return !!a && a.online && (!kind || a.kind === kind);
  }

  // ---- 收件匣 ----
  async function listInboxNames() {
    try {
      const ents = await fsp.readdir(path.join(home, "inbox"), { withFileTypes: true });
      return ents.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { return []; }
  }
  async function readInbox(name) {
    let names = [];
    try { names = await fsp.readdir(inboxDir(name)); } catch { return []; }
    names = names.filter((n) => n.endsWith(".json")).sort();
    const out = [];
    for (const n of names) {
      const file = path.join(inboxDir(name), n);
      const msg = await readJson(file);
      if (msg?.id) out.push({ file, msg });
    }
    return out;
  }
  async function consume(entries) {
    for (const e of entries) await fsp.unlink(e.file).catch(() => {});
  }
  /** 把 oldName 收件匣裡的未讀搬到 newName（改名用）。 */
  async function moveInbox(oldName, newName) {
    const entries = await readInbox(oldName);
    if (!entries.length) return 0;
    await fsp.mkdir(inboxDir(newName), { recursive: true });
    for (const e of entries) {
      await fsp.rename(e.file, path.join(inboxDir(newName), path.basename(e.file))).catch(() => {});
    }
    return entries.length;
  }

  // ---- 歷史 ----
  async function appendHistory(msg) {
    await fsp.appendFile(historyFile, JSON.stringify(msg) + "\n", "utf8");
  }
  async function readHistory() {
    try {
      const txt = await fsp.readFile(historyFile, "utf8");
      return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
  async function findMessage(id) {
    return (await readHistory()).find((m) => m.id === id) ?? null;
  }

  /** 建立並投遞一則訊息。thread_id 省略且有 reply_to 時沿用原訊息的 thread。 */
  async function send({ from, to, content, thread_id, reply_to, cwd }) {
    const peer = sanitizeName(to);
    const id = newId();
    let thread = thread_id;
    if (!thread && reply_to) thread = (await findMessage(reply_to))?.thread_id;
    const msg = { id, from, to: peer, content, thread_id: thread || id, reply_to: reply_to || null, ts: now(), cwd: cwd || null };
    await fsp.mkdir(inboxDir(peer), { recursive: true });
    await atomicWriteJson(path.join(inboxDir(peer), `${id}.json`), msg);
    await appendHistory(msg);
    return msg;
  }

  // ---- watcher 狀態 ----
  async function readState(key) {
    return (await readJson(path.join(stateDir, `${key}.json`))) ?? {};
  }
  async function writeState(key, obj) {
    await fsp.mkdir(stateDir, { recursive: true });
    await atomicWriteJson(path.join(stateDir, `${key}.json`), obj);
  }

  return {
    home, agentsDir, stateDir, historyFile, inboxDir,
    init, heartbeat, removeHeartbeat, listAgents, getAgent, isOnline,
    listInboxNames, readInbox, consume, moveInbox,
    appendHistory, readHistory, findMessage, send,
    readState, writeState,
  };
}
