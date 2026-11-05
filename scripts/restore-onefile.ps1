<#
.SYNOPSIS
  Rebuild the platform from ONE file made by backup-onefile.ps1.

.DESCRIPTION
  In order:
    1. decrypt   (.cpb — your private key or a passphrase)
    2. verify    every part against manifest sha256 — a corrupt archive stops here
    3. report    row counts + whether the target's ENCRYPTION_KEY matches the backup
    4. confirm   (type RESTORE, unless -Yes)
    5. database  stop app -> drop + recreate -> pg_restore -> re-check counts
    6. images    extract into the MinIO volume
    7. finish    flush Redis, restart the app, wait for /health

.EXAMPLE
  .\scripts\restore-onefile.ps1 ..\backups\casino-platform-20260919-120000.tar.gz

.EXAMPLE
  .\scripts\restore-onefile.ps1 .\backups\casino-platform-20260919-120000.cpb -Passphrase 'your passphrase'

.EXAMPLE
  .\scripts\restore-onefile.ps1 .\backups\b.tar.gz -DbOnly      # database only, leave images
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$File,
  [switch]$Yes,
  [switch]$DbOnly,
  [switch]$ObjectsOnly,
  [string]$Passphrase,
  [string]$KeyPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'onefile.psm1') -Force

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$full = (Resolve-Path -LiteralPath $File -ErrorAction SilentlyContinue)
if (-not $full) { throw "backup file not found: $File" }
$full = $full.Path

$dotenv  = Get-DotEnv (Join-Path $repo '.env')
$pgUser  = Get-DotEnvValue -Map $dotenv -Key 'PG_USER' -Default 'casino'
$pgDb    = Get-DotEnvValue -Map $dotenv -Key 'PG_DB'   -Default 'casino'
$redisPw = Get-DotEnvValue -Map $dotenv -Key 'REDIS_PASSWORD' -Default ''

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

$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$tmp = Join-Path ([IO.Path]::GetTempPath()) "casino-restore-$stamp"
$extract = Join-Path $tmp 'extract'
New-Item -ItemType Directory -Force -Path $extract | Out-Null

try {
  # ── 1. decrypt if needed ─────────────────────────────────────────────────
  $archive = $full
  if ([IO.Path]::GetExtension($full).ToLowerInvariant() -eq '.cpb') {
    Write-Host "[1/7] decrypting $([IO.Path]::GetFileName($full))..." -ForegroundColor Yellow
    $inDir = Split-Path -Parent $full
    $inName = [IO.Path]::GetFileName($full)
    $outName = 'archive.tar.gz'
    $repoMount = "${repo}:/repo:ro"
    $args = @('run', '--rm')
    if ($KeyPath) {
      $resolvedKey = (Resolve-Path -LiteralPath $KeyPath).Path
      $keyDir = Split-Path -Parent $resolvedKey
      $args += @('-v', "${keyDir}:/keys:ro")
      $args += @('-v', "${inDir}:/in:ro", '-v', "${inDir}:/out", '-v', $repoMount, '-w', '/repo')
      $args += @('node:22-alpine', 'node', 'scripts/backup-crypto.mjs', 'decrypt',
        '--key', "/keys/$([IO.Path]::GetFileName($resolvedKey))", '--in', "/in/$inName", '--out', "/out/$outName")
    } else {
      if (-not $Passphrase) {
        $sec = Read-Host -AsSecureString 'Backup passphrase'
        $Passphrase = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
          [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
      }
      $args += @('--env', 'BACKUP_PASSPHRASE', '-v', "${inDir}:/in:ro", '-v', "${inDir}:/out",
        '-v', $repoMount, '-w', '/repo')
      $args += @('node:22-alpine', 'node', 'scripts/backup-crypto.mjs', 'decrypt',
        '--passphrase-env', 'BACKUP_PASSPHRASE', '--in', "/in/$inName", '--out', "/out/$outName")
      # Forward the passphrase as a host env var so quotes/spaces/$ cannot break
      # the argument list.
      $env:BACKUP_PASSPHRASE = $Passphrase
      $Passphrase = $null
    }
    try {
      Invoke-Docker @args | Out-Null
    } finally {
      Remove-Item Env:\BACKUP_PASSPHRASE -ErrorAction SilentlyContinue
    }
    $archive = Join-Path $inDir $outName
    if (-not (Test-Path -LiteralPath $archive)) { throw "decryption produced no file" }
  } else {
    Write-Host "[1/7] archive is not encrypted — skipping decryption" -ForegroundColor Yellow
  }

  # ── 2. unpack + verify ───────────────────────────────────────────────────
  Write-Host "[2/7] unpacking and verifying checksums..." -ForegroundColor Yellow
  & tar -xzf $archive -C $extract
  if ($LASTEXITCODE -ne 0) { throw "tar failed to extract the archive (exit $LASTEXITCODE)" }
  $manifest = Read-BackupManifest -ExtractDir $extract
  $verified = Assert-BackupParts -Manifest $manifest -ExtractDir $extract
  Write-Host ("      verified: {0}" -f ($verified -join ', ')) -ForegroundColor Green

  # ── 3. report what is inside, and whether this stack can read it ─────────
  Write-Host ""
  Write-Host "  Backup made : $($manifest.createdAt)  on $($manifest.host)  (commit $($manifest.appCommit))"
  foreach ($name in $manifest.parts.PSObject.Properties.Name) {
    $p = $manifest.parts.$name
    Write-Host ("    {0,-28} {1}" -f $name, (Format-Bytes ([int64]$p.bytes)))
  }
  if ($manifest.counts) {
    $countText = @()
    foreach ($c in $manifest.counts.PSObject.Properties) {
      if ($null -ne $c.Value) { $countText += "$($c.Name)=$($c.Value)" }
    }
    if ($countText.Count) { Write-Host ("  Row counts  : " + ($countText -join '  ')) }
  }

  $liveKey = ''
  $livePrev = ''
  try {
    $k = @(Invoke-Docker compose exec -T api printenv ENCRYPTION_KEY | Select-Object -First 1)
    if ($k.Count -gt 0) { $liveKey = ([string]$k[0]).Trim() }
    $p = @(Invoke-Docker compose exec -T api printenv ENCRYPTION_KEY_PREVIOUS | Select-Object -First 1)
    if ($p.Count -gt 0) { $livePrev = ([string]$p[0]).Trim() }
  } catch {
    Write-Warning "could not read ENCRYPTION_KEY from the api container — is the stack running?"
  }
  $readable = Get-ReadableKeyFingerprints -EncryptionKey $liveKey -EncryptionKeyPrevious $livePrev
  $keyOk = $false
  if ($manifest.encryption -and $manifest.encryption.keyFingerprint) {
    if ($readable -contains $manifest.encryption.keyFingerprint) { $keyOk = $true }
  } else { $keyOk = $true }

  Write-Host ""
  if ($keyOk) {
    Write-Host "  Key check   : OK — this stack can read the encrypted fields" -ForegroundColor Green
  } else {
    Write-Host "  Key check   : MISMATCH" -ForegroundColor Red
    Write-Host ("    backup fingerprint : {0}" -f $manifest.encryption.keyFingerprint)
    Write-Host ("    this stack         : {0}" -f (($readable | Where-Object { $_ -ne 'none' }) -join ', '))
    Write-Host "    The database will restore fine, but saved bank / mobile-wallet details"
    Write-Host "    cannot be decrypted. Add the backup's key to ENCRYPTION_KEY_PREVIOUS"
    Write-Host "    in .env, recreate the api container, and run this restore again."
  }
  Write-Host ""

  # ── 4. confirm ───────────────────────────────────────────────────────────
  if (-not $Yes) {
    Write-Host "This REPLACES the database" -NoNewline
    if (-not $DbOnly) { Write-Host " and the uploaded images" -NoNewline }
    Write-Host " on this machine."
    $answer = Read-Host "Type RESTORE to continue"
    if ($answer -ne 'RESTORE') {
      Write-Host "aborted — nothing was changed"
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
      return
    }
  }

  # ── 5. database ──────────────────────────────────────────────────────────
  if (-not $ObjectsOnly) {
    Write-Host "[5/7] restoring the database..." -ForegroundColor Yellow
    Invoke-Docker compose stop api worker | Out-Null
    Invoke-Docker compose cp (Join-Path $extract 'database.dump') "postgres:/tmp/restore.dump" | Out-Null
    # `--force` disconnects leftover sessions, so the drop cannot fail. No
    # --clean: the database is empty at this point, so there is nothing to drop.
    Invoke-Docker compose exec -T postgres psql -U $pgUser -d postgres -c "DROP DATABASE IF EXISTS $pgDb WITH (FORCE);" | Out-Null
    Invoke-Docker compose exec -T postgres psql -U $pgUser -d postgres -c "CREATE DATABASE $pgDb OWNER $pgUser;" | Out-Null
    Invoke-Docker compose exec -T postgres pg_restore -U $pgUser -d $pgDb --no-owner --no-privileges --exit-on-error /tmp/restore.dump | Out-Null
    Invoke-Docker compose exec -T postgres rm -f /tmp/restore.dump | Out-Null
    Write-Host "      database restored"

    # Re-count from the restored database and compare with the manifest — the
    # cheapest possible proof that the data actually landed.
    if ($manifest.counts) {
      $tables = @()
      foreach ($c in $manifest.counts.PSObject.Properties) { $tables += $c.Name }
      $sqlPath = Join-Path $tmp 'counts.sql'
      [IO.File]::WriteAllText($sqlPath, (Get-CountsSql -Tables $tables))
      Invoke-Docker compose cp $sqlPath "postgres:/tmp/counts.sql" | Out-Null
      $rows = @(Invoke-Docker compose exec -T postgres psql -U $pgUser -d $pgDb -tA -f /tmp/counts.sql | Where-Object { $_ -match '\|' })
      Invoke-Docker compose exec -T postgres rm -f /tmp/counts.sql | Out-Null
      $mismatch = @()
      foreach ($r in $rows) {
        $f = $r.Split('|')
        if ($f.Count -lt 2) { continue }
        $table = $f[0].Trim()
        $got = $f[1].Trim()
        $want = $manifest.counts.$table
        if ($null -ne $want -and "$want" -ne $got) { $mismatch += "$table (expected $want, got $got)" }
      }
      if ($mismatch.Count) {
        Write-Warning ("count mismatch: " + ($mismatch -join '; '))
      } else {
        Write-Host "      row counts match the manifest" -ForegroundColor Green
      }
    }
  } else {
    Write-Host "[5/7] -ObjectsOnly: database left untouched"
  }

  # ── 6. images ────────────────────────────────────────────────────────────
  if (-not $DbOnly) {
    $objLocal = Join-Path $extract (Join-Path 'objects' 'minio-data.tar.gz')
    if (Test-Path -LiteralPath $objLocal) {
      Write-Host "[6/7] restoring uploaded images..." -ForegroundColor Yellow
      $info = (Invoke-Docker inspect (Invoke-Docker compose ps -q minio | Select-Object -First 1)) -join "`n"
      $volume = $null
      foreach ($m in ($info | ConvertFrom-Json)[0].Mounts) {
        if ($m.Destination -eq '/data' -and $m.Name) { $volume = $m.Name; break }
      }
      if (-not $volume) {
        Write-Warning "no MinIO volume found — skipping images (they stay in the archive)"
      } else {
        $objDir = Split-Path -Parent $objLocal
        Invoke-Docker run --rm -v "${volume}:/data" -v "${objDir}:/ro:ro" alpine tar xzf /ro/minio-data.tar.gz -C /data | Out-Null
        Write-Host "      images restored into $volume"
      }
    } else {
      Write-Host "[6/7] this archive has no images — nothing to do"
    }
  } else {
    Write-Host "[6/7] -DbOnly: images left untouched"
  }

  # ── 7. caches + restart ──────────────────────────────────────────────────
  Write-Host "[7/7] flushing caches and restarting the app..." -ForegroundColor Yellow
  if ($redisPw) {
    Invoke-Docker compose exec -T -e "REDISCLI_AUTH=$redisPw" redis redis-cli FLUSHALL | Out-Null
    Write-Host "      redis flushed"
  } else {
    Write-Warning "REDIS_PASSWORD not found in .env — skipping the Redis flush"
  }
  Invoke-Docker compose up -d api web worker | Out-Null

  $deadline = (Get-Date).AddMinutes(3)
  $healthy = $false
  while ((Get-Date) -lt $deadline) {
    $id = (Invoke-Docker compose ps -q api | Select-Object -First 1)
    if ($id) {
      try {
        $status = ([string](Invoke-Docker inspect -f '{{.State.Health.Status}}' $id | Select-Object -First 1)).Trim()
        if ($status -eq 'healthy') { $healthy = $true; break }
      } catch { }
    }
    Start-Sleep -Seconds 5
  }

  Write-Host ""
  if ($healthy) {
    Write-Host "  Restore complete — the API is healthy." -ForegroundColor Green
  } else {
    Write-Host "  Restore finished, but the API is not reporting healthy yet. Check:" -ForegroundColor Yellow
    Write-Host "      docker compose logs --tail 100 api"
  }
  Write-Host ""
  Write-Host "  Next:"
  Write-Host "    1. Log in with an admin that came from the backup (this restore replaced AdminUser)."
  Write-Host "    2. If the API logs 'applying migrations...', that is expected — the backup is an"
  Write-Host "       older schema and migrations bring it forward."
  Write-Host "    3. The working copy is deleted automatically on success."
  Write-Host ""
} catch {
  # Keep the unpacked copy on failure so the cause can be inspected, but say so —
  # a decrypted database dump must not be left lying around unnoticed.
  Write-Host ""
  Write-Host "  Restore failed: $($_.Exception.Message)" -ForegroundColor Red
  if (Test-Path -LiteralPath $tmp) {
    Write-Host "  Debug copy kept at: $tmp" -ForegroundColor Red
  }
  throw
}

# Success: remove the unpacked (and, for .cpb, decrypted) copy.
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host "  Working copy removed: $tmp"
Write-Host ""

