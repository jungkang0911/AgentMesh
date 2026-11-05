#!/usr/bin/env node
// 即時觀看 Claude 與 Codex 之間的對話：node tail.mjs [--home DIR] [--last N]
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const HOME = opt("home", process.env.AGENTMESH_HOME || path.join(os.homedir(), ".agentmesh"));
const LAST = Number(opt("last", 10));
const file = path.join(HOME, "history.jsonl");

const fmt = (m) => `\x1b[36m[${m.from} → ${m.to}]\x1b[0m \x1b[90m${m.ts.replace("T", " ").slice(0, 19)}  id=${m.id}${m.reply_to ? "  ↩ " + m.reply_to : ""}\x1b[0m\n${m.content}\n`;

await fsp.mkdir(HOME, { recursive: true });
if (!fs.existsSync(file)) fs.writeFileSync(file, "");

let offset = 0;
const initial = (await fsp.readFile(file, "utf8")).split("\n").filter(Boolean);
offset = (await fsp.stat(file)).size;
for (const l of initial.slice(-LAST)) { try { console.log(fmt(JSON.parse(l))); } catch {} }
console.log(`\x1b[90m-- watching ${file} (Ctrl+C 離開) --\x1b[0m\n`);

let buf = "";
async function poll() {
  const st = await fsp.stat(file).catch(() => null);
  if (!st) return;
  if (st.size < offset) { offset = 0; buf = ""; } // 檔案被清空
  if (st.size > offset) {
    const fh = await fsp.open(file, "r");
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(st.size - offset), 0, st.size - offset, offset);
    await fh.close();
    offset += bytesRead;
    buf += buffer.toString("utf8", 0, bytesRead);
    const lines = buf.split("\n"); buf = lines.pop();
    for (const l of lines) { if (!l) continue; try { console.log(fmt(JSON.parse(l))); } catch {} }
  }
}
setInterval(poll, 500);
