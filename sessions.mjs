#!/usr/bin/env node
// 列出／查詢 Codex 與 Claude Code 的對話（session），支援用「對話名稱」找 id。
//
//   node sessions.mjs --role codex [--last 20] [--all]        列出 Codex 對話（--all 含 headless）
//   node sessions.mjs --role claude [--last 20] [--project X]  列出 Claude Code 對話
//   node sessions.mjs --role codex --find 電腦粉機             用名稱（或 id 片段）查一個對話
//
// 也是 watch.mjs 的模組：resolveSession(role, label) 把 "codex@電腦粉機" 的 label 換成 session id。
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { sanitizeName, labelOf } from "./lib.mjs";

export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => UUID_RE.test(String(s));

async function walk(dir, pred) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, pred)));
    else if (pred(e.name)) out.push(p);
  }
  return out;
}
async function readHead(file, bytes) {
  const fh = await fsp.open(file, "r");
  try { const { buffer, bytesRead } = await fh.read(Buffer.alloc(bytes), 0, bytes, 0); return buffer.toString("utf8", 0, bytesRead); }
  finally { await fh.close(); }
}
async function readTail(file, bytes) {
  const { size } = await fsp.stat(file);
  const start = Math.max(0, size - bytes);
  const fh = await fsp.open(file, "r");
  try { const { buffer, bytesRead } = await fh.read(Buffer.alloc(size - start), 0, size - start, start); return buffer.toString("utf8", 0, bytesRead); }
  finally { await fh.close(); }
}
const jsonLines = (txt) => txt.split("\n").flatMap((l) => { if (!l.startsWith("{")) return []; try { return [JSON.parse(l)]; } catch { return []; } });

// ---------- Codex ----------
/** @returns {Promise<Array<{id,name,cwd,when,kind,first}>>} 新到舊 */
export async function listCodexSessions({ all = false, codexHome = CODEX_HOME } = {}) {
  const names = new Map(); // id → thread_name（取最後一筆）
  for (const o of jsonLines(await fsp.readFile(path.join(codexHome, "session_index.jsonl"), "utf8").catch(() => ""))) {
    if (o.id && o.thread_name) names.set(o.id, o.thread_name);
  }
  const files = await walk(path.join(codexHome, "sessions"), (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"));
  const rows = [];
  for (const f of files) {
    const id = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
    if (!id) continue;
    const mtime = (await fsp.stat(f)).mtimeMs;
    let meta = null, first = null;
    for (const o of jsonLines(await readHead(f, 96 * 1024))) {
      if (o.type === "session_meta") meta = o.payload;
      if (!first && o.type === "event_msg" && o.payload?.type === "user_message" && o.payload.message) first = o.payload.message;
      if (!first && o.type === "response_item" && o.payload?.role === "user") {
        const t = (o.payload.content ?? []).map((c) => c.text ?? "").join(" ").trim();
        if (t && !t.startsWith("#") && !t.startsWith("<")) first = t;
      }
      if (meta && first) break;
    }
    const headless = meta?.originator === "codex_exec" || meta?.source === "exec";
    if (headless && !all) continue;
    rows.push({ id, name: names.get(id) ?? null, cwd: meta?.cwd ?? null, when: mtime, kind: headless ? "headless" : (meta?.originator || "codex"), first: (first ?? "").replace(/\s+/g, " ").slice(0, 70) });
  }
  return rows.sort((a, b) => b.when - a.when);
}

// ---------- Claude Code ----------
function decodeProjectDir(name) {
  // D--Document-My-Dev-A2AMCP → D:\Document\My Dev\A2AMCP（只能近似：- 可能原本是 \ 或空格或 -）
  return name.replace(/^([A-Za-z])--/, "$1:\\").replace(/-/g, "\\");
}
export async function listClaudeSessions({ claudeHome = CLAUDE_HOME, includeScratch = false } = {}) {
  const root = path.join(claudeHome, "projects");
  const rows = [];
  for (const dir of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    if (!includeScratch && /scratch|Temp-claude|worktrees/i.test(dir.name)) continue;
    const d = path.join(root, dir.name);
    for (const f of await fsp.readdir(d).catch(() => [])) {
      const id = f.match(/^([0-9a-f-]{36})\.jsonl$/i)?.[1];
      if (!id) continue;
      const file = path.join(d, f);
      const mtime = (await fsp.stat(file)).mtimeMs;
      let cwd = null, first = null, name = null;
      for (const o of jsonLines(await readHead(file, 64 * 1024))) {
        cwd ??= o.cwd ?? null;
        if (o.type === "custom-title" && o.customTitle) name = o.customTitle;
        if (!first && o.type === "user" && !o.isSidechain && o.message?.role === "user") {
          const c = o.message.content;
          const t = (typeof c === "string" ? c : (c ?? []).map((x) => x.text ?? "").join(" ")).trim();
          if (t && !t.startsWith("<")) first = t;
        }
      }
      for (const o of jsonLines(await readTail(file, 256 * 1024))) if (o.type === "custom-title" && o.customTitle) name = o.customTitle; // 最後一次改名為準
      cwd ??= decodeProjectDir(dir.name);
      if (!includeScratch && /scratch-workspaces|Temp[\\/]claude/i.test(cwd)) continue;
      rows.push({ id, name, cwd, when: mtime, kind: "claude", first: (first ?? "").replace(/\s+/g, " ").slice(0, 70) });
    }
  }
  return rows.sort((a, b) => b.when - a.when);
}

export async function listSessions(role, opts = {}) {
  return role === "codex" ? listCodexSessions(opts) : listClaudeSessions(opts);
}

/**
 * 把 AgentMesh 位址的 label 換成實際 session。
 * 順序：完整 UUID → 名稱完全相同（正規化後）→ id 前綴 → 名稱包含（唯一或取最新）。
 * @returns {Promise<{id,name,cwd,how}|null>}
 */
export async function resolveSession(role, label, opts = {}) {
  if (!label) return null;
  if (isUuid(label)) return { id: label, name: null, cwd: null, how: "uuid" };
  const want = labelOf(sanitizeName(`x@${label}`)) ?? "";
  const rows = await listSessions(role, { all: true, includeScratch: true, ...opts });
  const norm = (s) => labelOf(sanitizeName(`x@${s ?? ""}`)) ?? "";
  const pick = (list, how) => (list.length ? { ...list[0], how, ambiguous: list.length > 1 ? list.length : 0 } : null);
  return pick(rows.filter((r) => r.name && norm(r.name) === want), "name")
    ?? pick(rows.filter((r) => r.id.toLowerCase().startsWith(want)), "id-prefix")
    ?? pick(rows.filter((r) => r.name && (norm(r.name).includes(want) || want.includes(norm(r.name)))), "name-contains");
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const role = sanitizeName(opt("role", "codex"));
  if (!["codex", "claude"].includes(role)) { console.error("--role 必須是 codex 或 claude"); process.exit(2); }
  const fmtWhen = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);
  const C = (s) => `\x1b[36m${s}\x1b[0m`, G = (s) => `\x1b[90m${s}\x1b[0m`, Y = (s) => `\x1b[33m${s}\x1b[0m`;

  const find = opt("find");
  if (find) {
    const r = await resolveSession(role, find);
    if (!r) { console.log(`找不到名稱或 id 含「${find}」的 ${role} 對話。`); process.exit(1); }
    console.log(`${C(r.id)}  ${Y(r.name ?? "(無名稱)")}  ${r.cwd ?? ""}  ${G(`by ${r.how}${r.ambiguous ? `, 另有 ${r.ambiguous - 1} 筆相似，取最新` : ""}`)}`);
    console.log(`\n位址：${role}@${r.name ? labelOf(sanitizeName(`x@${r.name}`)) : r.id}`);
    process.exit(0);
  }

  const rows = (await listSessions(role, { all: args.includes("--all") })).filter((r) => {
    const p = (opt("project", "") || "").toLowerCase();
    return !p || (r.cwd ?? "").toLowerCase().includes(p);
  }).slice(0, Number(opt("last", 20)));
  if (!rows.length) { console.log(`找不到任何 ${role} 對話。`); process.exit(0); }
  for (const r of rows) {
    const addr = r.name ? `${role}@${labelOf(sanitizeName(`x@${r.name}`))}` : `${role}@${r.id}`;
    console.log(`${Y(r.name ?? "(無名稱)")}  ${G(fmtWhen(r.when))}  ${G(r.kind)}  ${r.cwd ?? ""}\n    ${C(addr)}\n    ${G(r.id)}  ${r.first}`);
  }
  console.log(`\n用 AgentMesh 傳給上面任一個「${role}@…」位址即可指定對話；watch.mjs --role ${role} 會 resume 它。`);
}
