// 端對端測試：兩個 live 實例（claude@alpha / codex@beta）互傳、role 位址、改名、watcher 旗標。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStore } from "../lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "server.mjs");
const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentmesh-test-"));
const store = createStore(home);

let failures = 0;
function check(cond, label, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  ${String(detail).slice(0, 400)}`}`);
  if (!cond) failures++;
}
const txt = (res) => res.content.map((c) => c.text).join("\n");

async function connect(role, instance, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [serverPath],
    env: { ...process.env, AGENTMESH_AGENT_NAME: role, AGENTMESH_INSTANCE: instance, AGENTMESH_HOME: home, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: `${role}-client`, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const claude = await connect("claude", "alpha");
const codex = await connect("codex", "beta");
await new Promise((r) => setTimeout(r, 300)); // 等 oninitialized 寫完心跳

try {
  const tools = (await claude.listTools()).tools.map((t) => t.name).sort();
  check(JSON.stringify(tools) === JSON.stringify(["check_inbox", "get_history", "list_agents", "send_message", "set_name", "wait_for_message", "whoami"]), "tools registered", tools.join(","));

  const who = JSON.parse(txt(await claude.callTool({ name: "whoami", arguments: {} })));
  check(who.me === "claude@alpha" && who.role === "claude", "whoami = claude@alpha", who.me);
  check(who.agents.some((a) => a.name === "codex@beta" && a.online && a.kind === "live"), "codex@beta visible & online");

  // 不指定 to → 唯一的另一個 role → "codex"（role 收件匣）
  const sent = txt(await claude.callTool({ name: "send_message", arguments: { content: "哈囉 codex，1+1 等於幾？" } }));
  check(sent.includes("已送出 → codex ") && sent.includes("codex@beta"), "auto-resolve to role, lists live instance", sent);
  const sentId = sent.match(/id=(\S+)/)[1];

  // 沒有 watcher → live 實例讀得到 role 收件匣
  const inbox = txt(await codex.callTool({ name: "check_inbox", arguments: {} }));
  check(inbox.includes("[claude@alpha → codex]") && inbox.includes(`id=${sentId}`) && inbox.includes("cwd="), "live instance reads role inbox", inbox);
  check(txt(await codex.callTool({ name: "check_inbox", arguments: {} })) === "收件匣是空的。", "inbox consumed");

  // 指定對話：claude@alpha → codex@beta，並等待回覆；codex 用 reply_to 回
  const ask = claude.callTool({ name: "send_message", arguments: { content: "請回我 PONG", to: "codex@beta", wait_for_reply_seconds: 15 } });
  const q = txt(await codex.callTool({ name: "wait_for_message", arguments: { timeout_seconds: 10, from: "claude" } }));
  check(q.includes("請回我 PONG") && q.includes("→ codex@beta]"), "targeted message received (from filter by role)", q);
  const qId = q.match(/id=(\S+)/)[1];
  const qThread = q.match(/thread=(\S+)/)[1];
  await codex.callTool({ name: "send_message", arguments: { content: "PONG", to: "claude@alpha", reply_to: qId } });
  const answer = txt(await ask);
  check(answer.includes("收到回覆") && answer.includes("PONG") && answer.includes(`thread=${qThread}`), "reply via wait_for_reply, thread kept", answer);

  // 寄給不在線的指定對話 → 提示
  const off = txt(await claude.callTool({ name: "send_message", arguments: { content: "x", to: "codex@nobody" } }));
  check(off.includes("不在線"), "offline target warned", off);

  // 改名
  const renamed = txt(await codex.callTool({ name: "set_name", arguments: { label: "Line Auto" } }));
  check(renamed.includes("codex@beta → codex@line-auto"), "set_name sanitizes", renamed);
  const la = txt(await claude.callTool({ name: "list_agents", arguments: {} }));
  check(la.includes("● codex@line-auto") && !la.includes("codex@beta"), "old heartbeat removed after rename", la);
  await claude.callTool({ name: "send_message", arguments: { content: "after rename", to: "codex@line-auto" } });
  check(txt(await codex.callTool({ name: "check_inbox", arguments: {} })).includes("after rename"), "renamed inbox works");
  const renamedZh = txt(await codex.callTool({ name: "set_name", arguments: { label: "訊息 服務 v2" } }));
  check(renamedZh.includes("→ codex@訊息-服務-v2"), "set_name keeps unicode, spaces → -", renamedZh);
  await claude.callTool({ name: "send_message", arguments: { content: "中文位址", to: "codex@訊息 服務 V2" } });
  check(txt(await codex.callTool({ name: "check_inbox", arguments: {} })).includes("中文位址"), "unicode address normalizes the same way on send");
  await codex.callTool({ name: "set_name", arguments: { label: "line-auto" } });

  // watcher 在線時，live 實例不再讀 role 收件匣
  await store.heartbeat({ name: "codex", role: "codex", kind: "watcher", pid: 1, cwd: "x" });
  const sentW = txt(await claude.callTool({ name: "send_message", arguments: { content: "for watcher", to: "codex" } }));
  check(sentW.includes("自動接聽程式在線"), "send notes watcher online", sentW);
  check(txt(await codex.callTool({ name: "check_inbox", arguments: {} })) === "收件匣是空的。", "live skips role inbox while watcher online");
  await store.removeHeartbeat("codex");
  check(txt(await codex.callTool({ name: "check_inbox", arguments: {} })).includes("for watcher"), "live reads role inbox again after watcher gone");

  // 超時、歷史、拒絕寄給自己
  const t0 = Date.now();
  const timeout = txt(await codex.callTool({ name: "wait_for_message", arguments: { timeout_seconds: 1 } }));
  check(timeout.includes("沒有新訊息") && Date.now() - t0 >= 900, "wait_for_message times out", timeout);
  const h1 = txt(await claude.callTool({ name: "get_history", arguments: { limit: 50 } }));
  const h2 = txt(await codex.callTool({ name: "get_history", arguments: { limit: 50 } }));
  check(h1 === h2 && h1.includes("PONG") && h1.includes("1+1"), "history shared");
  const hw = txt(await codex.callTool({ name: "get_history", arguments: { with: "claude" } }));
  check(hw.includes("PONG") && hw.includes("after rename"), "history filter by role");
  check((await claude.callTool({ name: "send_message", arguments: { content: "x", to: "claude@alpha" } })).isError === true, "self-send rejected");

  // 同名第二個實例會自動加 -2
  const claude2 = await connect("claude", "alpha");
  await new Promise((r) => setTimeout(r, 300));
  const who2 = JSON.parse(txt(await claude2.callTool({ name: "whoami", arguments: {} })));
  check(who2.me === "claude@alpha-2", "duplicate label gets -2 suffix", who2.me);
  await claude2.close();

  // headless 實例不寫心跳
  const hl = await connect("codex", "", { AGENTMESH_HEADLESS: "1" });
  await new Promise((r) => setTimeout(r, 300));
  const whoH = JSON.parse(txt(await hl.callTool({ name: "whoami", arguments: {} })));
  check(whoH.me === "codex" && whoH.headless === true && !whoH.agents.some((a) => a.name === "codex"), "headless = plain role, no heartbeat", JSON.stringify(whoH));
  await hl.close();
} finally {
  await claude.close();
  await codex.close();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
}

console.log(failures ? `\n${failures} failure(s)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
