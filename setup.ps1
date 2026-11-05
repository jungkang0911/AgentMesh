# 一鍵把 AgentMesh MCP 註冊到 Claude Code（user scope）與 Codex（~/.codex/config.toml）。
# 用法：pwsh ./setup.ps1   （可加 -SkipClaude / -SkipCodex）
param([switch]$SkipClaude, [switch]$SkipCodex)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root "server.mjs"
$node = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path (Join-Path $root "node_modules"))) {
  Write-Host "安裝依賴..." ; Push-Location $root; npm install --omit=dev | Out-Null; Pop-Location
}

# ---- Claude Code ----
if (-not $SkipClaude) {
  $json = @{ type = "stdio"; command = $node; args = @($server); env = @{ AGENTMESH_AGENT_NAME = "claude" } } | ConvertTo-Json -Compress
  claude mcp remove a2a -s user 2>$null | Out-Null        # 舊名稱（0.2 以前叫 a2a）
  claude mcp remove agentmesh -s user 2>$null | Out-Null
  claude mcp add-json agentmesh $json -s user
  Write-Host "Claude Code: 已註冊 MCP server 'agentmesh'（身分 claude）" -ForegroundColor Green
}

# ---- Codex ----
if (-not $SkipCodex) {
  $cfg = Join-Path $env:USERPROFILE ".codex\config.toml"
  if (-not (Test-Path (Split-Path $cfg))) { New-Item -ItemType Directory -Force (Split-Path $cfg) | Out-Null }
  if (-not (Test-Path $cfg)) { New-Item -ItemType File $cfg | Out-Null }
  $content = Get-Content $cfg -Raw
  if ($content -match '(?m)^\[mcp_servers\.a2a\]') {
    Copy-Item $cfg "$cfg.bak-a2a-migrate" -Force
    $content = [regex]::Replace($content, '(?s)\r?\n\[mcp_servers\.a2a\]\r?\n.*?A2A_AGENT_NAME = "codex"\r?\n', "`n")
    Set-Content -Path $cfg -Value $content -Encoding UTF8 -NoNewline
    Write-Host "Codex: 已移除舊名稱的 [mcp_servers.a2a]（備份在 $cfg.bak-a2a-migrate）" -ForegroundColor Yellow
  }
  if ($content -match '(?m)^\[mcp_servers\.agentmesh\]') {
    Write-Host "Codex: config.toml 已經有 [mcp_servers.agentmesh]，略過（要改請手動編輯）" -ForegroundColor Yellow
  } else {
    Copy-Item $cfg "$cfg.bak-agentmesh" -Force
    $block = @"

[mcp_servers.agentmesh]
command = '$node'
args = ['$server']
startup_timeout_sec = 30

[mcp_servers.agentmesh.env]
AGENTMESH_AGENT_NAME = "codex"
"@
    Add-Content -Path $cfg -Value $block -Encoding UTF8
    Write-Host "Codex: 已寫入 $cfg（身分 codex，備份在 $cfg.bak-agentmesh）" -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "完成。重新啟動 Claude Code 與 Codex 後，兩邊都會多出 AgentMesh 的工具。"
Write-Host "讓 Codex 主動接聽（另開一個終端機常駐）：  node `"$root\watch.mjs`" --role codex"
Write-Host "讓 Claude 主動接聽：                      node `"$root\watch.mjs`" --role claude"
Write-Host "即時看對話：                              node `"$root\tail.mjs`""
