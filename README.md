# AgentMesh MCP — 讓 Claude Code 與 Codex 互傳訊息、互相叫醒的 MCP server

兩個 AI coding agent 的每一個對話都掛同一支 MCP server，透過本機共用目錄（預設 `~/.agentmesh`）交換訊息。
不需要常駐 daemon、不需要網路 port。再加一個監聽程式，對方就能「主動接」：收到訊息自動處理並回覆。

```
Claude Code 對話 A ──stdio──> server.mjs (claude@agentmesh) ──┐
Claude Code 對話 B ──stdio──> server.mjs (claude@videos) ──┤
Codex 對話        ──stdio──> server.mjs (codex@lineauto) ──┼── ~/.agentmesh/ (inbox / agents / history.jsonl)
watch.mjs --role codex  （收到訊息 → codex exec resume …） ──┤
watch.mjs --role claude （收到訊息 → claude -p --resume …）──┘
```

## 安裝

```powershell
git clone https://github.com/jungkang0911/AgentMesh.git
cd AgentMesh
npm install
pwsh ./setup.ps1        # 同時註冊到 Claude Code（user scope）與 Codex（~/.codex/config.toml）
```

重新啟動兩邊的 client 後，每個對話都會多出 AgentMesh 的工具。

讓對方「主動接」，另開終端機常駐：

```bash
node watch.mjs --role codex
```

```bash
node watch.mjs --role claude
```

## 身分與位址

每個對話都有一個名字 `role@label`：

- `role` 是 `claude` 或 `codex`（由 `AGENTMESH_AGENT_NAME` 決定）
- `label` 預設是該對話的工作目錄名稱（例如 `claude@agentmesh`）；同名會自動加 `-2`
- 在對話裡說「用 AgentMesh 把自己改名成 videos」會呼叫 `set_name`，變成 `claude@videos`
- `list_agents` 看得到所有在線的對話與它們的工作目錄

寄信時 `to` 有兩種寫法：

| `to` | 意思 | 誰來接 |
|---|---|---|
| `codex` | 不指定對話 | 有 `watch.mjs --role codex` 在跑：它用 headless 的 `codex exec` 處理，同一個 AgentMesh thread 會一直 resume 同一個 session，保有上下文。沒有 watcher：任何在線的 codex 對話下次查收件匣時收到。 |
| `codex@lineauto` | 指定某一個對話 | 該對話在線：留在它的收件匣，它自己查收（live 對話沒辦法被外力叫醒，見下方限制）。不在線：watcher 把 `lineauto` 當作 Codex 的 session id 或 thread 名稱去 `codex exec resume`，找不到就開新 session 並記住對應。 |

Claude 側對稱：`claude` / `claude@<label 或 session uuid>`，watcher 用 `claude -p --resume`。

### 用對話名稱指定對方的對話

`role@` 後面可以直接寫對話的名稱（Codex 的 thread 名稱、Claude Code 的對話標題），中文可以，空白會變成 `-`：

> 用 AgentMesh 傳給 codex@電腦粉機：「……」
> 用 AgentMesh 傳給 claude@codex-claude-mcp-訊息服務：「……」

watcher 收到後的查法：先看之前記過的對應，再去兩邊的 session 紀錄找 **名稱完全相同** → **id 前綴** → **名稱包含**（多筆時取最新），找到就 `codex exec resume <id>` / `claude -p --resume <id>`，並用該對話原本的工作目錄執行。名稱來源：Codex 是 `~/.codex/session_index.jsonl`，Claude 是 session 檔裡的 `custom-title`。

列出對話與可用的位址：

```bash
node sessions.mjs --role codex
```

```bash
node sessions.mjs --role claude --project agentmesh
```

用名稱或 id 片段查某一個：

```bash
node sessions.mjs --role codex --find 電腦粉機
```

注意：這是在背景 headless 接續該對話的紀錄，桌面版開著的視窗不會即時刷新，重新開啟那個對話才看得到新的回合。

另一種不查名稱的方式：在對方的對話裡先說「用 AgentMesh 把自己改名成 lineauto」，之後寄給 `codex@lineauto`；但這條路要等對方下次查收件匣才會看到（桌面版對話無法被外力叫醒）。

### Codex 要找 Claude

完全對稱：

| Codex 寄給 | 誰來接 |
|---|---|
| `claude` | `node watch.mjs --role claude` 以 headless 的 `claude -p` 處理並回覆，同一 thread 持續 resume。 |
| `claude@agentmesh`（在線對話的 label，預設是專案資料夾名稱） | 在線的那個 Claude Code 對話。桌面版要等它下次查收件匣；終端機版加 `--dangerously-load-development-channels server:agentmesh` 啟動的話會即時收到。 |
| `claude@<對話標題>` 或 `claude@<session uuid>` | watcher 查到 session 後用 `claude -p --resume` 接續那個對話。 |

## 工具

| 工具 | 用途 |
|---|---|
| `send_message` | 傳訊息。`to` 省略時自動選唯一的另一個 role。設 `wait_for_reply_seconds` 可送出後直接等回覆（問答一次搞定）。回覆時帶 `reply_to`，thread 自動沿用。 |
| `wait_for_message` | 阻塞等待新訊息（最多 600 秒），可用 `from` / `thread_id` / `reply_to` 過濾。 |
| `check_inbox` | 立刻看收件匣，不等待。預設讀完即移除，`peek=true` 只看不移除。 |
| `get_history` | 看所有 agent 共用的訊息紀錄，可按 `thread_id` 或 `with` 過濾。 |
| `list_agents` | 哪些對話／watcher 在線（5 分鐘內有心跳）、工作目錄。 |
| `set_name` | 替本對話取標籤，讓對方能指定寄給它。 |
| `whoami` | 自己的名稱、共用目錄、預設對象。 |

### 典型用法

在 Claude Code 裡：

> 用 AgentMesh 問 codex：「你那邊 `src/api.ts` 的錯誤處理改好了嗎？」等他回。

Claude 呼叫 `send_message(to="codex", content=..., wait_for_reply_seconds=300)`。若 codex 的 watcher 在跑，幾十秒內就有回覆；headless codex 會在 Claude 當時的工作目錄執行，所以可以真的去看檔案。

在 Codex 裡：

> 用 AgentMesh 等 claude 的訊息，收到後回答他。

Codex 呼叫 `wait_for_message(from="claude")`，再 `send_message(reply_to=<id>, ...)`。

指定對話：

> 用 AgentMesh 傳給 codex@lineauto：「LINE 排程那段改完了嗎？」

## 自動接聽程式 watch.mjs

```
node watch.mjs --role codex|claude [選項]
  --cwd DIR       寄件者沒附工作目錄時用的預設目錄
  --bin PATH      CLI 路徑（預設自動找：Codex 桌面版的 codex.exe；claude 的 cli.js）
  --parallel N    同時幾個 headless（預設 2）
  --model M       指定模型
  --yolo          codex: --dangerously-bypass-approvals-and-sandbox；claude: --dangerously-skip-permissions
  --timeout SEC   單次 headless 最長秒數（預設 900）
```

- watcher 把收到的訊息包成 prompt 交給 headless CLI，並要求它用 AgentMesh 的 `send_message` 回覆原寄件者。
- headless 實例用 `AGENTMESH_HEADLESS=1` 啟動，不寫心跳，身分是 `codex` 或 `codex@<label>`。
- `AgentMesh thread → CLI session` 的對應存在 `~/.agentmesh/state/watch-<role>.json`，執行紀錄在同目錄的 `.log`。
- 執行失敗（CLI 非零退出）會自動回一則 `[AgentMesh watcher] … 執行失敗` 給寄件者，附 stderr 尾段。

Claude Code 另有 Channels 機制可以把訊息即時推進「活著的」終端機對話：server 已宣告 `claude/channel` 能力，用終端機啟動時加

```bash
claude --dangerously-load-development-channels server:agentmesh
```

新訊息就會以 `<channel source="agentmesh">` 事件出現在對話裡。桌面版 app 無法加這個旗標，所以桌面版對話還是要靠 watcher 或手動查收。

## 即時觀看對話

```bash
node tail.mjs
```

## 設定

| 環境變數 / 參數 | 預設 | 說明 |
|---|---|---|
| `AGENTMESH_AGENT_NAME` / `--name` | `agent` | role：claude 或 codex |
| `AGENTMESH_INSTANCE` / `--instance` | 工作目錄名稱 | label |
| `AGENTMESH_HEADLESS` | 無 | `1` 時不寫心跳（watcher 專用） |
| `AGENTMESH_HOME` / `--home` | `~/.agentmesh` | 共用目錄，所有實例要一樣 |
| `AGENTMESH_PEER` / `--peer` | 無 | 預設收件人 |
| `CODEX_BIN` / `CLAUDE_BIN` | 自動尋找 | watcher 用的 CLI |

## 儲存格式

```
~/.agentmesh/
  inbox/<name>/<id>.json    未讀訊息，一則一檔；tmp + rename 寫入，不會讀到半截
  agents/<name>.json        心跳：kind=live（對話）或 watcher
  history.jsonl             所有訊息流水帳（append-only）
  state/watch-<role>.json   watcher 的 thread/label → session 對應
  state/watch-<role>.log    watcher 執行紀錄
```

訊息欄位：`id`、`from`、`to`、`content`、`thread_id`、`reply_to`、`ts`、`cwd`（寄件者工作目錄）。

## 測試

```bash
npm test
```

`test/e2e.mjs` 起兩個 live 實例跑 23 項檢查；`test/watch.test.mjs` 用假的 codex CLI 與假的 Codex 家目錄驗證 watcher 的 13 項行為（新 session、同 thread resume、指定 session、用對話名稱／id 前綴查 session、找不到退回新 session、不碰在線對話）。

## 限制

- 活著的桌面版對話（Claude 桌面 app、Codex 桌面 app）無法被外力叫醒，只能等它下次查收件匣；要「主動接」就用 watcher 的 headless session。終端機跑的 Claude Code 可用 Channels 即時收到。
- `claude -p` 用的是 CLI 的登入狀態，和桌面 app 分開；若 watcher 回報 OAuth 過期，先在終端機跑一次 `claude` 重新登入。
- 只在同一台機器、同一個使用者下運作。
- `wait_for_message` 單次最多 600 秒，超時再呼叫一次即可。
