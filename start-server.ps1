param(
  [int]$Port = 4173
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

Write-Host "StocksAI Market Desk running at http://localhost:$Port/"
Write-Host "Press Ctrl+C to stop."

function Get-ContentType($Path) {
  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8" }
    ".css" { "text/css; charset=utf-8" }
    ".js" { "application/javascript; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    default { "application/octet-stream" }
  }
}

function Send-Response($Stream, [int]$Status, [string]$StatusText, [byte[]]$Body, [string]$ContentType) {
  $header = "HTTP/1.1 $Status $StatusText`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::UTF8.GetBytes($header)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $stream.ReadTimeout = 2000
      $buffer = [byte[]]::new(4096)
      try {
        $read = $stream.Read($buffer, 0, $buffer.Length)
      }
      catch [System.IO.IOException] {
        $client.Close()
        continue
      }

      if ($read -le 0) {
        $client.Close()
        continue
      }

      $requestText = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
      $requestLine = $requestText.Split("`r`n")[0]

      if ([string]::IsNullOrWhiteSpace($requestLine)) {
        $client.Close()
        continue
      }

      $parts = $requestLine.Split(" ")
      $requestPath = if ($parts.Length -gt 1) { $parts[1] } else { "/" }
      $path = [Uri]::UnescapeDataString($requestPath.Split("?")[0].TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($path)) {
        $path = "index.html"
      }

      $filePath = Join-Path $root $path
      $resolvedRoot = [System.IO.Path]::GetFullPath($root)
      $resolvedFile = [System.IO.Path]::GetFullPath($filePath)

      if (-not $resolvedFile.StartsWith($resolvedRoot)) {
        $body = [System.Text.Encoding]::UTF8.GetBytes("Forbidden")
        Send-Response $stream 403 "Forbidden" $body "text/plain; charset=utf-8"
      }
      elseif (-not [System.IO.File]::Exists($resolvedFile)) {
        $body = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        Send-Response $stream 404 "Not Found" $body "text/plain; charset=utf-8"
      }
      else {
        $body = [System.IO.File]::ReadAllBytes($resolvedFile)
        Send-Response $stream 200 "OK" $body (Get-ContentType $resolvedFile)
      }
    }
    finally {
      $client.Close()
    }
  }
}
finally {
  $listener.Stop()
}
