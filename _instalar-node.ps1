# _instalar-node.ps1
# Instala Node.js automaticamente no Windows 10/11 x64.
# Metodos: winget -> MSI silencioso -> MSI com log detalhado.
# Auto-eleva para Administrador se necessario.
#
# @version 1.2.1
# @changelog
#   1.2.1 - 2026-08-07 15:30 - Prevencao (causa raiz encontrada em
#                              iniciar-tray.ps1, mesma familia de risco):
#     - Havia um travessao Unicode dentro de um Write-Log real (nao em
#       comentario) na secao de download do MSI. Windows PowerShell 5.1 nao
#       assume UTF-8 por padrao para .ps1 sem BOM - pode reinterpretar bytes
#       multi-byte incorretamente e corromper o parsing do script a partir
#       dali. Removidos todos os caracteres nao-ASCII do arquivo; agora 100%
#       ASCII. Ver changelog de iniciar-tray.ps1 v1.2.2 para o caso concreto
#       que motivou essa checagem em todos os .ps1 do projeto.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# TITULO FIX (ajuste solicitado): nunca derruba o script se falhar (ex:
# config.json ainda nao existe nesta etapa da instalacao) - titulo e' so'
# cosmetico, nao pode impedir a instalacao do Node.js.
try {
    $__appName = "Relatorios"
    $__cfgPath = Join-Path $PSScriptRoot "config.json"
    if (Test-Path $__cfgPath) {
        $__cfg = Get-Content $__cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        if ($__cfg.appName) { $__appName = $__cfg.appName }
    }
    $host.UI.RawUI.WindowTitle = "$__appName - Instalando Node.js"
} catch {}

# ---------------------------------------------------------------------------
# Constantes
# ---------------------------------------------------------------------------
# NOTA (trade-off consciente): versao fixa em vez de buscar dinamicamente a
# ultima LTS. Buscar a versao mais recente exigiria uma chamada de rede extra
# (novo ponto de falha) so' para DESCOBRIR o que baixar, antes mesmo de baixar
# o instalador. Mantido simples e previsivel - reveja/atualize este numero
# periodicamente (verifique a LTS atual em https://nodejs.org/en/download).
$NODE_VERSION = "20.19.0"
$NODE_URL     = "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-x64.msi"
$NODE_DIR     = "C:\Program Files\nodejs"
$LOG_FILE     = "$env:TEMP\node-install-log.txt"
$TMP_MSI      = "$env:TEMP\node-setup.msi"

# ---------------------------------------------------------------------------
# Log com timestamp
# ---------------------------------------------------------------------------
function Write-Log {
    param(
        [string]$Msg,
        [string]$Nivel = 'INFO'
    )
    $ts    = (Get-Date).ToString("HH:mm:ss")
    $linha = "[$ts][$Nivel] $Msg"
    Write-Host $linha
    Add-Content -Path $LOG_FILE -Value $linha -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Auto-elevacao para Administrador
# ---------------------------------------------------------------------------
function Ensure-Admin {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if (-not $isAdmin) {
        Write-Log "Nao esta rodando como Administrador. Reiniciando elevado..." "AVISO"
        $script = $MyInvocation.ScriptName
        if (-not $script) { $script = $PSCommandPath }
        # ROBUSTEZ FIX: se o usuario clicar "Nao" no prompt do UAC, Start-Process
        # -Verb RunAs lanca uma excecao terminante (ErrorActionPreference='Stop'
        # esta em vigor no escopo do modulo) - sem este try/catch, o script
        # encerrava com um stack trace .NET cru em vez de uma mensagem clara,
        # inconsistente com o padrao de log amigavel usado no resto do arquivo.
        try {
            Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -Verb RunAs -Wait -ErrorAction Stop
        } catch {
            Write-Log "Elevacao para Administrador foi cancelada ou falhou: $($_.Exception.Message)" "ERRO"
            Write-Log "A instalacao do Node.js requer privilegios de Administrador. Execute novamente e aceite o prompt do UAC." "ERRO"
            exit 1
        }
        exit 0
    }
}

# ---------------------------------------------------------------------------
# Retorna versao do Node se encontrado no PATH
# ---------------------------------------------------------------------------
function Get-NodeVersion {
    try {
        $saida = & node --version 2>$null
        if ($saida -match 'v(\d+\.\d+\.\d+)') { return $Matches[1] }
    } catch {}
    return $null
}

# ---------------------------------------------------------------------------
# Procura node.exe fora do PATH
# ---------------------------------------------------------------------------
function Find-NodeDir {
    $candidatos = @(
        $NODE_DIR,
        "$env:ProgramFiles\nodejs",
        "${env:ProgramFiles(x86)}\nodejs",
        "$env:LOCALAPPDATA\Programs\nodejs"
    )
    foreach ($c in $candidatos) {
        if (Test-Path "$c\node.exe") { return $c }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Adiciona diretorio ao PATH da sessao e do sistema
# ---------------------------------------------------------------------------
function Add-ToPath {
    param([string]$Dir)
    if (-not $Dir) { return }
    if (-not (Test-Path $Dir)) { return }

    if ($env:Path -notlike "*$Dir*") {
        $env:Path = "$Dir;$env:Path"
    }

    try {
        $mPath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        if ($mPath -notlike "*$Dir*") {
            [System.Environment]::SetEnvironmentVariable("Path", "$mPath;$Dir", "Machine")
            Write-Log "PATH do sistema atualizado: $Dir" "OK"
        }
    } catch {
        Write-Log "Nao foi possivel atualizar PATH do sistema: $($_.Exception.Message)" "AVISO"
    }
}

# ---------------------------------------------------------------------------
# Metodo 1 -- winget
# ---------------------------------------------------------------------------
function Install-ViaWinget {
    Write-Log "Tentando instalar via winget..."
    try {
        $wg = Get-Command winget -ErrorAction Stop
        Write-Log "winget encontrado: $($wg.Source)"
        $saida = & winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements 2>&1
        Write-Log "Saida winget: $saida"
        Start-Sleep -Seconds 5

        $dir = Find-NodeDir
        if ($dir) {
            Add-ToPath $dir
            $ver = Get-NodeVersion
            if ($ver) {
                Write-Log "Node.js $ver instalado via winget." "OK"
                return $true
            }
        }
    } catch {
        Write-Log "winget nao disponivel ou falhou: $($_.Exception.Message)" "AVISO"
    }
    return $false
}

# ---------------------------------------------------------------------------
# Download do MSI com 3 tentativas
# ---------------------------------------------------------------------------
function Download-Msi {
    Write-Log "Baixando Node.js $NODE_VERSION..."
    Write-Log "URL: $NODE_URL"

    if (Test-Path $TMP_MSI) {
        Remove-Item $TMP_MSI -Force -ErrorAction SilentlyContinue
    }

    $limite = 3
    $TIMEOUT_DOWNLOAD_SEG = 180
    for ($i = 1; $i -le $limite; $i++) {
        Write-Log "Tentativa de download $i de $limite (timeout: ${TIMEOUT_DOWNLOAD_SEG}s)..."
        try {
            $ErrorActionPreference = 'Stop'

            # TIMEOUT FIX: nem Start-BitsTransfer nem WebClient.DownloadFile tem
            # timeout de rede embutido. Se a conexao travar em vez de falhar
            # (ex: firewall descartando pacotes silenciosamente, proxy pendurado),
            # o download ficava preso PARA SEMPRE - nunca cai no catch, nunca
            # avanca de tentativa, e a instalacao inteira do Node.js trava sem
            # nenhuma mensagem de erro. Executa o download num job em segundo
            # plano com teto rigido de tempo; se estourar, mata o job e trata
            # como falha desta tentativa (cai no laco normal de retry).
            $job = Start-Job -ScriptBlock {
                param($url, $dest)
                try {
                    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
                        Start-BitsTransfer -Source $url -Destination $dest -ErrorAction Stop
                    } else {
                        $wc = New-Object System.Net.WebClient
                        $wc.DownloadFile($url, $dest)
                    }
                    return $true
                } catch {
                    return $_.Exception.Message
                }
            } -ArgumentList $NODE_URL, $TMP_MSI

            $terminou = Wait-Job -Job $job -Timeout $TIMEOUT_DOWNLOAD_SEG
            if (-not $terminou) {
                Write-Log "Download nao respondeu em ${TIMEOUT_DOWNLOAD_SEG}s - abortando esta tentativa." "AVISO"
                Stop-Job -Job $job -ErrorAction SilentlyContinue
            } else {
                $resultadoJob = Receive-Job -Job $job -ErrorAction SilentlyContinue
                if ($resultadoJob -ne $true) {
                    Write-Log "Job de download retornou erro: $resultadoJob" "AVISO"
                }
            }
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

            if (Test-Path $TMP_MSI) {
                $tamBytes = (Get-Item $TMP_MSI -ErrorAction Stop).Length
                $tamMB    = [math]::Round($tamBytes / 1MB, 1)

                if ($tamBytes -gt 5000000) {
                    Write-Log "Download OK. Tamanho: $tamMB MB" "OK"
                    return $true
                } else {
                    Write-Log "Arquivo suspeito ($tamMB MB). Removendo e tentando novamente." "AVISO"
                    Remove-Item $TMP_MSI -Force -ErrorAction SilentlyContinue
                }
            }
        } catch {
            Write-Log "Falha na tentativa $i : $($_.Exception.Message)" "AVISO"
        }
        $ErrorActionPreference = 'Stop'
        Start-Sleep -Seconds 3
    }

    Write-Log "Download falhou apos $limite tentativas." "ERRO"
    return $false
}

# ---------------------------------------------------------------------------
# Metodo 2 -- MSI silencioso
# ---------------------------------------------------------------------------
function Install-ViaMsiSilent {
    Write-Log "Instalando via MSI (modo silencioso)..."
    $ErrorActionPreference = 'SilentlyContinue'
    $proc   = Start-Process msiexec -ArgumentList "/i `"$TMP_MSI`" /qn /norestart ALLUSERS=1 ADDLOCAL=ALL" -Wait -PassThru
    $codigo = $proc.ExitCode
    $ErrorActionPreference = 'Stop'

    Write-Log "msiexec retornou: $codigo"
    if ($codigo -eq 0 -or $codigo -eq 3010) { return $true }

    Write-Log "MSI silencioso falhou (codigo $codigo)." "AVISO"
    return $false
}

# ---------------------------------------------------------------------------
# Metodo 3 -- MSI com log verbose (diagnostico)
# ---------------------------------------------------------------------------
function Install-ViaMsiComLog {
    Write-Log "Instalando via MSI com log detalhado..."
    Write-Log "Log sera salvo em: $LOG_FILE"

    $ErrorActionPreference = 'SilentlyContinue'
    $proc   = Start-Process msiexec -ArgumentList "/i `"$TMP_MSI`" /qb /norestart ALLUSERS=1 ADDLOCAL=ALL /L*V `"$LOG_FILE`"" -Wait -PassThru
    $codigo = $proc.ExitCode
    $ErrorActionPreference = 'Stop'

    Write-Log "msiexec (log) retornou: $codigo"

    if ($codigo -eq 0 -or $codigo -eq 3010) { return $true }

    Write-Log "Instalacao MSI falhou. Log em: $LOG_FILE" "ERRO"

    if (Test-Path $LOG_FILE) {
        $ultimas = Get-Content $LOG_FILE -Tail 25 -ErrorAction SilentlyContinue
        if ($ultimas) {
            Write-Host ""
            Write-Host "--- Ultimas linhas do log MSI ---"
            $ultimas | ForEach-Object { Write-Host $_ }
            Write-Host "---------------------------------"
            Write-Host ""
        }
    }
    return $false
}

# ===========================================================================
# INICIO
# ===========================================================================
Ensure-Admin

Write-Log "=== Instalador Node.js v$NODE_VERSION ==="

# Ja instalado e no PATH?
$ver = Get-NodeVersion
if ($ver) {
    Write-Log "Node.js ja esta instalado: v$ver" "OK"
    exit 0
}

# Instalado fora do PATH?
$dir = Find-NodeDir
if ($dir) {
    Add-ToPath $dir
    $ver = Get-NodeVersion
    if ($ver) {
        Write-Log "Node.js encontrado em '$dir' e adicionado ao PATH (v$ver)." "OK"
        exit 0
    }
}

# --- Tentativa 1: winget ---
if (Install-ViaWinget) { exit 0 }

# --- Download do MSI ---
if (-not (Download-Msi)) {
    Write-Log "Impossivel baixar o instalador. Verifique a internet." "ERRO"
    Write-Log "Download manual: $NODE_URL" "ERRO"
    Read-Host "Pressione ENTER para fechar"
    exit 1
}

# --- Tentativa 2: MSI silencioso ---
$instalou = Install-ViaMsiSilent

# --- Tentativa 3: MSI com log ---
if (-not $instalou) {
    $instalou = Install-ViaMsiComLog
}

# Limpa MSI temporario
Remove-Item $TMP_MSI -Force -ErrorAction SilentlyContinue

if (-not $instalou) {
    Write-Log "Todas as tentativas falharam." "ERRO"
    Write-Log "Instale manualmente: https://nodejs.org/en/download" "ERRO"
    Write-Log "Log de diagnostico: $LOG_FILE" "ERRO"
    Read-Host "Pressione ENTER para fechar"
    exit 1
}

# Atualiza PATH e confirma
$dir = Find-NodeDir
if ($dir) { Add-ToPath $dir }
Start-Sleep -Seconds 2

$ver = Get-NodeVersion
if ($ver) {
    Write-Log "Node.js v$ver instalado com sucesso!" "OK"
    exit 0
} else {
    Write-Log "Instalacao concluida. Abra um NOVO terminal para usar o node." "AVISO"
    Write-Log "Se o problema persistir, reinicie o computador." "AVISO"
    exit 0
}