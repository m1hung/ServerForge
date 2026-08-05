#Requires -Version 5.1
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command "node")) {
  Write-Host "Node.js is not installed or not on PATH."
  Write-Host "Install Node 20.11+ from https://nodejs.org/ then run this again."
  exit 1
}

if (-not (Test-Command "docker")) {
  Write-Host "Docker is not installed or not on PATH."
  Write-Host "Install Docker Desktop, start it, then run this again."
  Write-Host "https://docs.docker.com/desktop/setup/install/windows-install/"
  exit 1
}

& node scripts/start-persistent.mjs @args
exit $LASTEXITCODE
