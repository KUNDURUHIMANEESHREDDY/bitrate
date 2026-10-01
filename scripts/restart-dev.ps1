# Restart the dev server cleanly and wait for it to answer.
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\himan\Downloads\dwonload3'
$conn = Get-NetTCPConnection -LocalPort 4820 -State Listen -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Start-Process -FilePath 'node' -ArgumentList 'server\index.js' -WorkingDirectory $root `
  -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\bitrate.log" -RedirectStandardError "$env:TEMP\bitrate.err"
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $h = Invoke-RestMethod 'http://127.0.0.1:4820/api/health' -TimeoutSec 3
    "server up: yt-dlp $($h.ytdlp.version), ffmpeg=$($h.ffmpeg), aria2c=$($h.aria2c)"
    exit 0
  } catch { }
}
"server failed to start"
Get-Content "$env:TEMP\bitrate.err" -Tail 20 -ErrorAction SilentlyContinue
exit 1
