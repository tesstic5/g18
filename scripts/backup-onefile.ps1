<#
.SYNOPSIS
  Create ONE file containing everything needed to rebuild the platform.

.DESCRIPTION
  Produces casino-platform-<stamp>.tar.gz (or .cpb when -Encrypt) containing:
    database.dump              pg_dump -Fc — schema + data + migration history
    objects/minio-data.tar.gz  every deposit proof + avatar
    manifest.json              sizes, sha256 checksums, row counts, key fingerprint
    RESTORE.txt                instructions that work without this repo

  Restore it with:  .\scripts\restore-onefile.ps1 <file>

  The layout matches scripts/platform-backup.sh, so either tool can restore the
  other's file.

.EXAMPLE
  .\scripts\backup-onefile.ps1

.EXAMPLE
  .\scripts\backup-onefile.ps1 -Encrypt          # passphrase-protected .cpb

.EXAMPLE
  .\scripts\backup-onefile.ps1 -NoObjects -OutDir D:\backups
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [switch]$NoObjects,
  [switch]$Encrypt,
  [string]$Passphrase
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'onefile.psm1') -Force

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
if (-not $OutDir) { $OutDir = Join-Path $repo 'backups' }

$dotenv   = Get-DotEnv (Join-Path $repo '.env')
$pgUser   = Get-DotEnvValue -Map $dotenv -Key 'PG_USER' -Default 'casino'
$pgDb     = Get-DotEnvValue -Map $dotenv -Key 'PG_DB'   -Default 'casino'
$minioSvc = 'minio'
$stamp    = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "docker is not on PATH — install Docker Desktop and reopen this terminal"
}

function Invoke-Docker {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Argv)
  $out = & docker @Argv 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ("docker " + ($Argv -join ' ') + " failed:`n" + ($out -join "`n"))
  }
  return @($out)
}

function Get-ServiceContainer {
  param([Parameter(Mandatory = $true)][string]$Service)
  $ids = @(Invoke-Docker compose ps -q $Service)
  $id = ($ids | Where-Object { $_ -and $_.Trim() } | Select-Object -First 1)
  if (-not $id) { return $null }
  return $id.Trim()
}

Write-Host ""
Write-Host "One-file backup" -ForegroundColor Cyan
Write-Host "  repository : $repo"
Write-Host "  output     : $OutDir"
Write-Host ""

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$tmp = Join-Path ([IO.Path]::GetTempPath()) "casino-backup-$stamp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  # ── the stack must be running: we read the live database, not a stale file ──
  $pgCt = Get-ServiceContainer -Service 'postgres'
  if (-not $pgCt) {
    throw "no running 'postgres' container found. Start the stack first:  docker compose up -d postgres redis minio"
  }

  # ── [1/6] database ────────────────────────────────────────────────────────
  Write-Host "[1/6] dumping the database..." -ForegroundColor Yellow
  Invoke-Docker exec $pgCt pg_dump -U $pgUser -d $pgDb -F c --no-owner --no-privileges -f /tmp/platform-backup.dump | Out-Null
  Invoke-Docker cp "${pgCt}:/tmp/platform-backup.dump" (Join-Path $tmp 'database.dump') | Out-Null
  Invoke-Docker exec $pgCt rm -f /tmp/platform-backup.dump | Out-Null
  $dumpPath = Join-Path $tmp 'database.dump'
  if (-not (Test-Path -LiteralPath $dumpPath) -or (Get-Item -LiteralPath $dumpPath).Length -eq 0) {
    throw "the dump is empty — is the database reachable?"
  }
  Write-Host ("      database.dump: {0}" -f (Format-Bytes (Get-Item -LiteralPath $dumpPath).Length))

  # ── [2/6] uploaded images ─────────────────────────────────────────────────
  $parts = [ordered]@{}
  $parts['database.dump'] = New-BackupPart -Path $dumpPath

  if (-not $NoObjects) {
    Write-Host "[2/6] archiving uploaded images..." -ForegroundColor Yellow
    $minioCt = Get-ServiceContainer -Service $minioSvc
    $volume = $null
    if ($minioCt) {
      # docker inspect piped into ConvertFrom-Json — avoids Go templates
      # ({{ range ... }} inside PowerShell quoting is a minefield).
      $info = (Invoke-Docker inspect $minioCt) -join "`n"
      $mounts = ($info | ConvertFrom-Json)[0].Mounts
      foreach ($m in $mounts) {
        if ($m.Destination -eq '/data' -and $m.Name) { $volume = $m.Name; break }
      }
    }
    if ($volume) {
      $objDir = Join-Path $tmp 'objects'
      New-Item -ItemType Directory -Force -Path $objDir | Out-Null
      # :ro — a backup must never be able to write to live storage.
      Invoke-Docker run --rm -v "${volume}:/data:ro" -v "${objDir}:/out" alpine tar czf /out/minio-data.tar.gz -C /data . | Out-Null
      $objPath = Join-Path $objDir 'minio-data.tar.gz'
      Write-Host ("      minio-data.tar.gz: {0}  (volume {1})" -f (Format-Bytes (Get-Item -LiteralPath $objPath).Length), $volume)
      $parts['objects/minio-data.tar.gz'] = New-BackupPart -Path $objPath
    } else {
      Write-Warning "no MinIO volume found — proof images are NOT in this backup"
    }
  } else {
    Write-Host "[2/6] skipping images (-NoObjects)"
  }

  # ── [3/6] row counts + key fingerprint ────────────────────────────────────
  Write-Host "[3/6] collecting row counts + key fingerprint..." -ForegroundColor Yellow
  $tables = @('User', 'Wallet', 'GameRound', 'Transaction', 'Deposit', 'Withdrawal', 'AdminUser', 'GameConfig')
  $sqlPath = Join-Path $tmp 'counts.sql'
  # Written via .NET so there is no BOM — a BOM makes psql fail on the first line.
  [IO.File]::WriteAllText($sqlPath, (Get-CountsSql -Tables $tables))
  Invoke-Docker cp $sqlPath "${pgCt}:/tmp/counts.sql" | Out-Null
  $rows = @(Invoke-Docker exec $pgCt psql -U $pgUser -d $pgDb -tA -f /tmp/counts.sql | Where-Object { $_ -match '\|' })
  Invoke-Docker exec $pgCt rm -f /tmp/counts.sql | Out-Null
  $counts = [ordered]@{}
  foreach ($r in $rows) {
    $partsR = $r.Split('|')
    if ($partsR.Count -ge 2 -and $partsR[1] -match '^\d+$') { $counts[$partsR[0].Trim()] = [int]$partsR[1] }
  }
  if ($counts.Count -eq 0) { Write-Warning "could not read row counts — manifest will show none" }

  $keyFp = 'none'
  $apiCt = Get-ServiceContainer -Service 'api'
  if ($apiCt) {
    $raw = @(Invoke-Docker exec $apiCt printenv ENCRYPTION_KEY | Select-Object -First 1)
    $key = if ($raw.Count -gt 0) { [string]$raw[0] } else { '' }
    if (-not $key) {
      $raw2 = @(Invoke-Docker exec $apiCt printenv AES_ENCRYPTION_KEY | Select-Object -First 1)
      if ($raw2.Count -gt 0) { $key = [string]$raw2[0] }
    }
    $keyFp = Get-KeyFingerprint -Key $key
  } else {
    Write-Warning "api container not running — the key fingerprint will be 'none'"
  }
  Write-Host ("      ENCRYPTION_KEY fingerprint: {0}" -f $keyFp)

  # ── [4/6] manifest + instructions ─────────────────────────────────────────
  Write-Host "[4/6] writing manifest.json + RESTORE.txt..." -ForegroundColor Yellow
  $commit = 'unknown'
  try {
    $c = (& git -C $repo rev-parse --short HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $c) { $commit = ([string]$c).Trim() }
  } catch { }
  $manifestJson = New-BackupManifest -Parts $parts -Counts $counts -KeyFingerprint $keyFp -AppCommit $commit
  [IO.File]::WriteAllText((Join-Path $tmp 'manifest.json'), $manifestJson)

  $restoreTxt = @"
How to restore this platform backup
===================================

With the repository (Windows):

    .\scripts\restore-onefile.ps1 <this-file>

With the repository (Linux / VPS):

    ./scripts/platform-restore.sh <this-file>.cpb

The script verifies every checksum, then: stops the app, drops and recreates the
database, pg_restore-s it, extracts the images into the MinIO volume, flushes
Redis and restarts the app.

Without the repository:

  Database (into a running postgres container, e.g. <pg>):
    docker cp database.dump <pg>:/tmp/restore.dump
    docker exec <pg> psql -U casino -d postgres -c 'DROP DATABASE IF EXISTS casino WITH (FORCE);'
    docker exec <pg> psql -U casino -d postgres -c 'CREATE DATABASE casino OWNER casino;'
    docker exec <pg> pg_restore -U casino -d casino --no-owner --no-privileges --exit-on-error /tmp/restore.dump

  Images (replace <minio_vol> with the volume from `docker volume ls`):
    docker run --rm -v <minio_vol>:/data -v "`$PWD/objects":/ro:ro alpine tar xzf /ro/minio-data.tar.gz -C /data

  IMPORTANT: the restored stack must use the SAME ENCRYPTION_KEY as the one that
  made this backup (see manifest.json -> encryption.keyFingerprint), otherwise
  saved bank / mobile-wallet details cannot be read.
"@
  [IO.File]::WriteAllText((Join-Path $tmp 'RESTORE.txt'), $restoreTxt)

  # ── [5/6] package ─────────────────────────────────────────────────────────
  Write-Host "[5/6] packaging..." -ForegroundColor Yellow
  $base = "casino-platform-$stamp"
  $plain = Join-Path $OutDir "$base.tar.gz"
  $names = @('manifest.json', 'database.dump', 'RESTORE.txt')
  if ($parts.Contains('objects/minio-data.tar.gz')) { $names += 'objects' }
  & tar -czf $plain -C $tmp @names
  if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
  $out = $plain

  # ── [6/6] optional encryption ─────────────────────────────────────────────
  if ($Encrypt) {
    Write-Host "[6/6] encrypting (passphrase)..." -ForegroundColor Yellow
    if (-not $Passphrase) {
      $sec = Read-Host -AsSecureString 'Backup passphrase (min 12 characters)'
      $Passphrase = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
    if ($Passphrase.Length -lt 12) { throw "the passphrase must be at least 12 characters" }
    $enc = Join-Path $OutDir "$base.cpb"
    # Same crypto as the bash scripts (scripts/backup-crypto.mjs), run in a
    # throwaway container so no Node install is needed on this machine.
    # The passphrase travels as a host environment variable that `--env` forwards,
    # so spaces, quotes and $ characters in it cannot break the command line.
    $env:BACKUP_PASSPHRASE = $Passphrase
    try {
      Invoke-Docker run --rm --env BACKUP_PASSPHRASE -v "${repo}:/repo:ro" -v "${OutDir}:/out" -w /repo node:22-alpine `
        node scripts/backup-crypto.mjs encrypt --passphrase-env BACKUP_PASSPHRASE --in "/out/$base.tar.gz" --out "/out/$base.cpb" | Out-Null
    } finally {
      Remove-Item Env:\BACKUP_PASSPHRASE -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $plain -Force   # never leave the plaintext archive behind
    $out = $enc
    $Passphrase = $null
  } else {
    Write-Host "[6/6] not encrypting — the archive is readable by anyone holding the file" -ForegroundColor Yellow
  }

  $size = (Get-Item -LiteralPath $out).Length
  Write-Host ""
  Write-Host "  Backup : $out" -ForegroundColor Green
  Write-Host ("  Size   : {0}" -f (Format-Bytes $size))
  $contents = 'database.dump'
  if ($parts.Contains('objects/minio-data.tar.gz')) { $contents += ' + all uploaded images' }
  Write-Host "  Held   : $contents + manifest"
  Write-Host "  Key    : $keyFp  (the restore needs this same key)"
  Write-Host ""
  Write-Host "  Restore with:  .\scripts\restore-onefile.ps1 `"$out`""
  Write-Host "  Keep a copy somewhere that is not this machine."
  Write-Host ""
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
