# iniciar-tray.ps1
# Servidor em background + icone na bandeja do sistema.
# Instancia unica via mutex global.
# Abrir Relatorio: se ja tem aba aberta (SSE), foca ela. Se nao, abre browser.
#
# @version 1.2.5
# @changelog
#   1.2.5 - 2026-08-15 18:00 - CAUSA RAIZ do "Sair nao encerra direito":
#                              taskkill "rodava" sem confirmar que matou o
#                              processo de verdade + confirmacao visivel de
#                              encerramento (pedido do usuario).
#     - RELATO DO USUARIO: clicar em "Sair" faz o icone sumir, mas
#       relatorio.log continua crescendo -- o servidor continua rodando em
#       segundo plano.
#     - CAUSA RAIZ: "Start-Process -FilePath taskkill.exe ... -Wait" so'
#       confirma que o PROCESSO taskkill.exe conseguiu INICIAR -- nunca que
#       ele conseguiu matar o PID alvo de verdade. Se o taskkill falhasse
#       por dentro (PID ja mudou, falta de permissao, ou qualquer outro
#       motivo), o codigo antigo seguia em frente como se tivesse dado
#       certo. Os tres lugares que matavam o processo (Sair, Reiniciar
#       servidor, watchdog de travamento a cada 10s) tinham exatamente essa
#       mesma lacuna -- o watchdog rodando sozinho, sem supervisao, o dia
#       inteiro, e' o candidato mais provavel para node.exe orfaos se
#       acumularem ao longo do dia.
#     - FIX: nova funcao compartilhada Stop-ServidorRelatorio() -- alem do
#       taskkill, espera o processo morrer de verdade (WaitForExit) e
#       CONFERE HasExited depois, com um Kill() de segunda tentativa se
#       ainda estiver vivo. So' retorna sucesso quando confirma a morte.
#       Usada nos tres lugares que antes tinham copias divergentes do mesmo
#       bloco.
#     - FIX: Reiniciar servidor e o watchdog de travamento agora abortam
#       (com aviso) em vez de subir um processo novo por cima de um antigo
#       que nao foi possivel confirmar como encerrado -- evita exatamente o
#       acumulo de node.exe orfaos concorrendo pela mesma porta/banco.
#     - NOVO (pedido do usuario): "Sair" agora mostra um balao de
#       confirmacao ("Servidor encerrado com sucesso." ou aviso, se nao
#       confirmou) no mesmo padrao visual das mensagens ja existentes de
#       "Servidor reiniciado"/"Servidor iniciado" (BalloonTipTitle =
#       $APP_NAME, igual as demais). Mostrado ANTES de esconder o icone --
#       um NotifyIcon invisivel nao exibe balao, o Windows descarta a
#       chamada em silencio.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# NOTA (trade-off consciente): mantido SilentlyContinue - este e' um processo
# de bandeja em segundo plano sem console visivel; qualquer erro NAO tratado
# que virasse excecao terminante encerraria o icone inteiro sem aviso algum
# para o usuario (pior que o comportamento atual). A mitigacao real para a
# invisibilidade de erros e' o Write-TrayLog abaixo, chamado nos pontos
# criticos, em vez de trocar a politica global de erros.
$ErrorActionPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# Log - escreve no MESMO relatorio.log que servidor-relatorio.js usa (pedido
# do usuario: nao criar um arquivo tray.log separado). Formato identico ao
# que o Node grava ("[DD-MM-YYYY] [HH:MM:SS] mensagem"), com prefixo [TRAY]
# para diferenciar a origem das linhas quando misturadas no mesmo arquivo.
#
# CONCORRENCIA: servidor-relatorio.js (v2.6.2+) foi ajustado para nunca mais
# reescrever o arquivo inteiro em uso normal - so' ACRESCENTA linhas novas a
# cada flush, exatamente como Add-Content faz aqui. As duas operacoes de
# escrita (Node appendFileSync / PowerShell Add-Content) sao atomicas no
# nivel do SO para escritas deste tamanho, entao os dois processos podem
# gravar no mesmo arquivo com seguranca. Se estiver usando uma versao mais
# antiga de servidor-relatorio.js (que reescrevia o arquivo inteiro a cada
# flush), as linhas gravadas aqui serao apagadas no proximo flush do Node -
# atualize os dois arquivos juntos.
#
# Falhas ao gravar o log sao ignoradas de proposito (log e' best-effort,
# nunca deve impedir o tray de funcionar).
# ---------------------------------------------------------------------------
$DIR      = Split-Path -Parent $MyInvocation.MyCommand.Path
$LOG_PATH = Join-Path $DIR "relatorio.log"
function Write-TrayLog {
    param([string]$Msg, [string]$Nivel = "INFO")
    try {
        $prefixo = if ($Nivel -eq "INFO") { "" } else { "$($Nivel): " }
        $linha = "[{0}] [{1}] [TRAY] {2}{3}" -f (Get-Date -Format "dd-MM-yyyy"), (Get-Date -Format "HH:mm:ss"), $prefixo, $Msg
        Add-Content -Path $LOG_PATH -Value $linha -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
}

# ---------------------------------------------------------------------------
# Instancia unica via mutex
# ---------------------------------------------------------------------------
$mutexName = "Global\RelatoriosTray_7734"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$acquired = $false
try { $acquired = $mutex.WaitOne(0) } catch { $acquired = $false }
if (-not $acquired) {
    Write-TrayLog "Outra instancia ja esta rodando (mutex ja em uso) - encerrando esta sem fazer nada."
    exit 0
}
Write-TrayLog "Mutex adquirido - nenhuma outra instancia ativa."


# ---------------------------------------------------------------------------
# Le config.json
# ---------------------------------------------------------------------------
$cfgPath = Join-Path $DIR "config.json"

$APP_NAME  = "Relatorios"
$PORT      = 7734
$MAQUINA_IP = $null
# Credenciais do Firebird - ver bloco de leitura do config.json abaixo.
$FB_USER = "SYSDBA"
$FB_PASS = "masterkey"

try {
    if (Test-Path $cfgPath) {
        $raw = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        $cfg = $raw | ConvertFrom-Json
        if ($cfg.appName -and $cfg.appName -ne "") { $APP_NAME = $cfg.appName }
        if ($cfg.porta   -and $cfg.porta    -gt 0)  { $PORT     = [int]$cfg.porta }
        # SEGURANCA FIX: fbUser/fbPass agora podem vir do config.json em vez de
        # ficarem hardcoded no script. Mantido o fallback SYSDBA/masterkey
        # (credenciais de fabrica do Firebird) para nao quebrar instalacoes
        # existentes que nunca definiram esses campos.
        if ($cfg.fbUser -and $cfg.fbUser -ne "") { $FB_USER = [string]$cfg.fbUser }
        if ($cfg.fbPass -and $cfg.fbPass -ne "") { $FB_PASS = [string]$cfg.fbPass }
        # maquinaIP NAO e lido aqui - o servidor sempre o sobrescreve na inicializacao.
        # Sera relido logo apos o servidor subir (bloco abaixo).
    }
} catch {}

if ($FB_USER -eq "SYSDBA" -and $FB_PASS -eq "masterkey") {
    Write-TrayLog "Usando credenciais padrao de fabrica do Firebird (SYSDBA/masterkey). Defina fbUser/fbPass em config.json se o banco usa senha propria." "AVISO"
}
# TITULO FIX (ajuste solicitado): normalmente esta janela roda oculta (via
# launcher.vbs -WindowStyle Hidden), mas se alguem rodar o script direto
# (debug, ou se o launcher.vbs falhar) o titulo generico "Windows
# PowerShell" nao ajudava a identificar do que se tratava. Nunca derruba o
# tray se falhar - titulo e' so' cosmetico.
try { $host.UI.RawUI.WindowTitle = "$APP_NAME - Servidor (bandeja)" } catch {}
Write-TrayLog "Tray iniciando | App: $APP_NAME | Porta: $PORT"

# $ADDR      -> usado em Start-Process (abre no browser)
# $ADDR_LOCAL -> usado em Invoke-WebRequest (sempre IPv4 127.0.0.1, nunca falha por ::1)
$ADDR       = "http://localhost:$PORT"
$ADDR_LOCAL = "http://127.0.0.1:$PORT"

# ---------------------------------------------------------------------------
# Funcao: Abre relatorio - foca aba existente se possivel
# ---------------------------------------------------------------------------
function Open-Relatorio {
    param([string]$UrlPath = "/")
    $clients = 0
    try {
        $r = Invoke-WebRequest "$ADDR_LOCAL/api/sse-clients" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        $j = $r.Content | ConvertFrom-Json
        $clients = [int]$j.clients
    } catch { $clients = 0 }

    if ($clients -gt 0) {
        if ($UrlPath -eq "/") {
            try { Invoke-WebRequest "$ADDR_LOCAL/api/navigate/hoje" -UseBasicParsing -TimeoutSec 2 | Out-Null } catch {}
        } else {
            try { Start-Process ($ADDR + $UrlPath) } catch {}
        }
    } else {
        try { Start-Process ($ADDR + $UrlPath) } catch {}
    }
}

# ---------------------------------------------------------------------------
# Funcao: retorna contagem de clientes SSE (usa ADDR_LOCAL)
# ---------------------------------------------------------------------------
function Get-SseClients {
    try {
        $r = Invoke-WebRequest "$ADDR_LOCAL/api/sse-clients" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        $j = $r.Content | ConvertFrom-Json
        return [int]$j.clients
    } catch { return 0 }
}

# ---------------------------------------------------------------------------
# Funcao: verifica se o servidor HTTP esta respondendo.
# Retorna $true se OK, $false caso contrario.
# Usa TCP primeiro (rapido), depois confirma com HTTP.
# ---------------------------------------------------------------------------
function Test-ServidorAtivo {
    # 1) Teste TCP rapido (< 500 ms)
    try {
        $tc = New-Object Net.Sockets.TcpClient
        $ok = $tc.ConnectAsync("127.0.0.1", $PORT).Wait(500)
        $tc.Close()
        if (-not $ok) { return $false }
    } catch { return $false }

    # 2) Confirma via HTTP (garante que o Node ja subiu o listener)
    try {
        $r = Invoke-WebRequest "$ADDR_LOCAL/api/db-status" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# ---------------------------------------------------------------------------
# Inicia o servidor Node.js
# ---------------------------------------------------------------------------
$serverScript = Join-Path $DIR "servidor-relatorio.js"

# DIAGNOSTICO FIX: esse loop podia ficar ate' 30 minutos (120 x 15s) em
# silencio TOTAL se servidor-relatorio.js nao fosse encontrado (pensado
# para unidade de rede ainda mapeando no boot) - sem nenhum log, essa
# espera parecia um travamento sem explicacao nenhuma. Agora registra o
# inicio da espera e, se de fato demorar, um aviso a cada minuto.
if (-not (Test-Path $serverScript)) {
    Write-TrayLog "servidor-relatorio.js nao encontrado em '$serverScript' - aguardando ate 30min (rede pode estar mapeando no boot)." "AVISO"
}
$maxTentativas = 120
$tentativa     = 0
while (-not (Test-Path $serverScript) -and $tentativa -lt $maxTentativas) {
    $tentativa++
    if ($tentativa % 4 -eq 0) {
        Write-TrayLog "Ainda aguardando servidor-relatorio.js aparecer (${tentativa}/${maxTentativas} tentativas, ~$([math]::Round($tentativa*15/60,1))min)." "AVISO"
    }
    Start-Sleep -Seconds 15
}
if (-not (Test-Path $serverScript)) {
    Write-TrayLog "servidor-relatorio.js CONTINUA ausente apos 30min de espera - desistindo. Verifique se o arquivo existe em '$DIR'." "ERRO"
    [System.Windows.Forms.MessageBox]::Show(
        "Nao foi possivel encontrar servidor-relatorio.js em:`n$DIR`n`nReinstale ou verifique se a pasta do sistema esta completa.",
        "$APP_NAME - Erro",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    try { $mutex.ReleaseMutex() } catch {}
    exit 1
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName        = "node"
$psi.Arguments       = "`"$serverScript`" --user $FB_USER --pass $FB_PASS --no-browser"
$psi.WindowStyle     = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.CreateNoWindow  = $true
$psi.UseShellExecute = $false

# ---------------------------------------------------------------------------
# Encerra o processo do servidor (e toda a sua arvore) com VERIFICACAO REAL
# de sucesso.
#
# PRECISAO FIX: Sair, Reiniciar servidor e o watchdog de travamento tinham,
# cada um, sua propria copia deste bloco -- e os tres tinham a mesma lacuna:
# "Start-Process -FilePath taskkill.exe ... -Wait" so' confirma que o
# PROCESSO taskkill.exe conseguiu INICIAR, nunca que ele conseguiu matar o
# PID alvo. Se o PID ja nao existisse mais (race com o watchdog), ou por
# falta de permissao, ou por qualquer outro motivo do taskkill falhar por
# dentro, o codigo antigo seguia em frente como se tivesse dado certo --
# deixando o node.exe vivo, orfao (ainda consultando o Firebird, ainda
# escrevendo no log), sem que o tray tivesse como saber. E' esse o cenario
# relatado pelo usuario: "Sair" faz o icone sumir mas o relatorio.log
# continua crescendo.
#
# Unifica os tres em uma unica funcao com verificacao de verdade
# (WaitForExit + checagem de HasExited depois, nao so' antes). Retorna
# $true somente se confirmou que o processo morreu.
# ---------------------------------------------------------------------------
function Stop-ServidorRelatorio {
    param(
        [System.Diagnostics.Process]$Proc,
        [int]$TimeoutMs = 5000
    )
    if (-not $Proc) { return $true }
    try { if ($Proc.HasExited) { return $true } } catch { return $true }

    $pidAlvo = $Proc.Id
    try {
        Start-Process -FilePath "taskkill.exe" -ArgumentList "/F","/T","/PID","$pidAlvo" -WindowStyle Hidden -Wait -ErrorAction Stop
    } catch {
        Write-TrayLog "taskkill falhou (PID $pidAlvo): $($_.Exception.Message) - tentando Kill() direto." "AVISO"
        try { $Proc.Kill() } catch {}
    }

    try { $Proc.WaitForExit($TimeoutMs) | Out-Null } catch {}
    if (-not $Proc.HasExited) {
        # taskkill "rodou" mas o processo continua vivo - a lacuna que este
        # fix existe para fechar. Tenta mais uma vez, direto, antes de desistir.
        Write-TrayLog "PID $pidAlvo continua ativo apos taskkill + $([int]($TimeoutMs/1000))s de espera - tentando Kill() direto." "AVISO"
        try { $Proc.Kill() } catch {}
        try { $Proc.WaitForExit(2000) | Out-Null } catch {}
    }

    if ($Proc.HasExited) { return $true }

    Write-TrayLog "PID $pidAlvo SOBREVIVEU a taskkill /F /T e a Kill() - pode ficar orfao consumindo recursos. Verifique o Gerenciador de Tarefas manualmente." "ERRO"
    return $false
}

# Testa se a porta ja esta em uso.
# ROBUSTEZ FIX: a versao anterior usava $tc.Connect() SINCRONO sem timeout -
# se a porta estivesse "filtrada" (pacotes descartados em vez de recusados
# ativamente, ex: firewall silencioso), essa chamada podia travar por
# dezenas de segundos. Como esta funcao roda na THREAD DE UI (chamada pelo
# watchdog a cada 10s e pelo clique em "Reiniciar servidor"), um travamento
# aqui congelava o icone inteiro da bandeja. ConnectAsync(...).Wait(500) usa
# o mesmo padrao ja correto de Test-ServidorAtivo neste arquivo.
function Test-PortaLivre {
    param([int]$Porta)
    $tc = $null
    try {
        $tc = New-Object Net.Sockets.TcpClient
        $ok = $tc.ConnectAsync("127.0.0.1", $Porta).Wait(500)
        if ($ok -and $tc.Connected) { return $false }  # porta ocupada
        return $true                                    # porta livre (ou timeout = trata como livre)
    } catch {
        return $true   # porta livre (conexao recusada)
    } finally {
        try { if ($tc) { $tc.Close() } } catch {}
    }
}

$script:nodeProc = $null

if (Test-PortaLivre -Porta $PORT) {
    try {
        $script:nodeProc = [System.Diagnostics.Process]::Start($psi)
        Write-TrayLog "Servidor iniciado (PID $($script:nodeProc.Id))."
    } catch {
        Write-TrayLog "Falha ao iniciar o servidor: $($_.Exception.Message)" "ERRO"
        [System.Windows.Forms.MessageBox]::Show(
            "Nao foi possivel iniciar o servidor.`nVerifique se o Node.js esta instalado.",
            "$APP_NAME - Erro",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
        try { $mutex.ReleaseMutex() } catch {}
        exit 1
    }
} else {
    Write-TrayLog "Porta $PORT ja estava ocupada ao iniciar - assumindo servidor ja rodando."
}

# ---------------------------------------------------------------------------
# Aguarda o servidor ficar disponivel (ate 30s) antes de continuar
# (necessario para que o maquinaIP seja salvo pelo servidor antes de ler)
#
# DIAGNOSTICO FIX: antes, esse loop simplesmente esgotava os 30s em silencio
# se o servidor nunca abrisse a porta - sem diferenciar "processo morreu
# logo de cara" (Node ausente, erro de sintaxe, modulo faltando) de
# "processo vivo mas ainda inicializando" (Firebird demorando a responder,
# maquina lenta). Agora verifica HasExited no processo apos a espera e
# registra qual dos dois casos aconteceu, com o codigo de saida quando
# disponivel - a diferenca e' o que separa "reinstale o Node" de "so'
# espere mais um pouco".
# ---------------------------------------------------------------------------
$_espera = 0
$_portaAbriu = $false
while ($_espera -lt 30) {
    if (-not (Test-PortaLivre -Porta $PORT)) { $_portaAbriu = $true; break }
    if ($script:nodeProc -and $script:nodeProc.HasExited) { break }  # nao adianta continuar esperando
    Start-Sleep -Milliseconds 500
    $_espera++
}

if ($_portaAbriu) {
    Write-TrayLog "Servidor respondendo na porta $PORT apos $([math]::Round($_espera*0.5,1))s."
} elseif ($script:nodeProc -and $script:nodeProc.HasExited) {
    Write-TrayLog "Processo do servidor encerrou sozinho logo apos iniciar (codigo de saida: $($script:nodeProc.ExitCode)). Verifique relatorio.log na pasta do sistema para o motivo (Node.js ausente, modulo faltando, ou erro ao conectar no Firebird sao as causas mais comuns)." "ERRO"
    [System.Windows.Forms.MessageBox]::Show(
        "O servidor iniciou mas fechou sozinho logo em seguida.`nConsulte relatorio.log na pasta do sistema para o motivo.`n`nCausas comuns: Node.js nao instalado corretamente, ou banco de dados Firebird inacessivel.",
        "$APP_NAME - Erro",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
} elseif ($script:nodeProc) {
    Write-TrayLog "Servidor ainda nao respondeu na porta $PORT apos 30s, mas o processo continua vivo (PID $($script:nodeProc.Id)) - pode estar demorando para conectar ao Firebird. Continuando." "AVISO"
}

# Reler maquinaIP do config apos o servidor subir.
# O servidor SEMPRE sobrescreve maquinaIP com o IP real da maquina na inicializacao,
# entao aqui sempre obteremos o valor correto e atualizado.
try {
    if (Test-Path $cfgPath) {
        $raw2 = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        $cfg2 = $raw2 | ConvertFrom-Json
        if ($cfg2.maquinaIP -and $cfg2.maquinaIP -ne "") {
            $MAQUINA_IP = $cfg2.maquinaIP.Trim()
        }
    }
} catch {}

# ---------------------------------------------------------------------------
# Icone da bandeja
# ---------------------------------------------------------------------------
$tray         = New-Object System.Windows.Forms.NotifyIcon
$tray.Text    = $APP_NAME
$tray.Visible = $true

$faviconPath = Join-Path $DIR "favicon.png"
if (Test-Path $faviconPath) {
    try {
        $bmp     = [System.Drawing.Bitmap]::FromFile($faviconPath)
        $resized = New-Object System.Drawing.Bitmap($bmp, 32, 32)
        $hIcon     = $resized.GetHicon()
        $tray.Icon = [System.Drawing.Icon]::FromHandle($hIcon)
        # LEAK FIX: (1) $resized nunca era descartado - Bitmap intermediario
        # do redimensionamento ficava preso na memoria pelo resto da sessao.
        # (2) GetHicon() retorna um HICON nativo (GDI) que .NET NAO libera
        # sozinho - Icon.FromHandle() apenas "empresta" o handle, nunca o
        # possui; a documentacao da Microsoft recomenda destruir esse handle
        # explicitamente via DestroyIcon (P/Invoke) apos clonar o Icon para
        # um objeto gerenciado independente do handle original.
        Add-Type -Namespace TrayNativo -Name Gdi32 -MemberDefinition '
            [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
        ' -ErrorAction SilentlyContinue
        $tray.Icon = $tray.Icon.Clone()  # copia gerenciada independente do HICON
        try { [TrayNativo.Gdi32]::DestroyIcon($hIcon) | Out-Null } catch {}
        $resized.Dispose()
        $bmp.Dispose()
    } catch { $tray.Icon = [System.Drawing.SystemIcons]::Application }
} else {
    $tray.Icon = [System.Drawing.SystemIcons]::Application
}

# ---------------------------------------------------------------------------
# Menu de contexto
# ---------------------------------------------------------------------------
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.RenderMode = [System.Windows.Forms.ToolStripRenderMode]::System

# --- Abrir Relatorio (negrito) ---
$itemAbrir = New-Object System.Windows.Forms.ToolStripMenuItem
$itemAbrir.Text = "Abrir Relatorio"
$itemAbrir.Font = New-Object System.Drawing.Font($menu.Font.FontFamily, $menu.Font.Size, [System.Drawing.FontStyle]::Bold)
$itemAbrir.Add_Click({ Open-Relatorio "/" })
$menu.Items.Add($itemAbrir) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# --- Atualizar dados de hoje ---
$itemAtualizar = New-Object System.Windows.Forms.ToolStripMenuItem
$itemAtualizar.Text = "Atualizar dados de hoje"
$itemAtualizar.Add_Click({
    $clients = Get-SseClients
    if ($clients -gt 0) {
        # Aba aberta: navega para / (reload) e forca foco
        try { Invoke-WebRequest "$ADDR_LOCAL/api/navigate/hoje" -UseBasicParsing -TimeoutSec 2 | Out-Null } catch {}
        try { Invoke-WebRequest "$ADDR_LOCAL/api/navigate/foco" -UseBasicParsing -TimeoutSec 1 | Out-Null } catch {}
    } else {
        # Sem aba aberta: abre /atualizar no browser (redireciona para / apos limpar cache)
        try { Start-Process "$ADDR/atualizar" } catch {}
    }
})
$menu.Items.Add($itemAtualizar) | Out-Null

# --- Gerar por periodo ---
$itemPeriodo = New-Object System.Windows.Forms.ToolStripMenuItem
$itemPeriodo.Text = "Gerar por periodo..."
$itemPeriodo.Add_Click({
    $clients = Get-SseClients
    if ($clients -gt 0) {
        # Aba aberta: abre modal de periodo via SSE (nao abre nova aba)
        try {
            Invoke-WebRequest "$ADDR_LOCAL/api/navigate/hash/periodo" -UseBasicParsing -TimeoutSec 2 | Out-Null
        } catch {}
        try { Invoke-WebRequest "$ADDR_LOCAL/api/navigate/foco" -UseBasicParsing -TimeoutSec 1 | Out-Null } catch {}
    } else {
        # Sem aba aberta: abre /periodo no browser
        try { Start-Process "$ADDR/periodo" } catch {}
    }
})
$menu.Items.Add($itemPeriodo) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# --- Editar configuracoes ---
$itemEditarCfg = New-Object System.Windows.Forms.ToolStripMenuItem
$itemEditarCfg.Text = "Editar configuracoes..."
$itemEditarCfg.Add_Click({
    $clients = Get-SseClients
    if ($clients -gt 0) {
        try {
            Invoke-WebRequest "$ADDR_LOCAL/api/navigate/config" -UseBasicParsing -TimeoutSec 2 | Out-Null
        } catch {}
    } else {
        try {
            Start-Process "$ADDR/config"
        } catch {
            [System.Windows.Forms.MessageBox]::Show(
                "Nao foi possivel abrir o painel de configuracoes:`n$ADDR/config",
                "$APP_NAME",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            ) | Out-Null
        }
    }
})
$menu.Items.Add($itemEditarCfg) | Out-Null

# --- Selecionar banco (FDB)... ---
$itemFdb = New-Object System.Windows.Forms.ToolStripMenuItem
$itemFdb.Text = "Selecionar banco (FDB)..."
$itemFdb.Add_Click({
    # 1) Verifica se o servidor esta respondendo antes de qualquer acao
    if (-not (Test-ServidorAtivo)) {
        $tray.BalloonTipTitle = "$APP_NAME - Atencao"
        $tray.BalloonTipText  = "O servidor nao esta respondendo.`nAguarde a inicializacao ou use 'Reiniciar servidor'."
        $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Warning
        $tray.ShowBalloonTip(5000)
        return
    }

    # 2) Verifica se ha banco ja configurado e funcionando (avisa mas nao bloqueia)
    $dbOk = $false
    try {
        $r   = Invoke-WebRequest "$ADDR_LOCAL/api/db-status" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        $st  = $r.Content | ConvertFrom-Json
        $dbOk = [bool]$st.ok
    } catch {}

    # Se banco ja esta OK, pede confirmacao antes de trocar
    if ($dbOk) {
        $resp = [System.Windows.Forms.MessageBox]::Show(
            "O banco de dados atual esta conectado e funcionando.`n`nDeseja selecionar um banco diferente mesmo assim?",
            "$APP_NAME - Selecionar banco",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question
        )
        if ($resp -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    }

    # 3) Navega ou abre a pagina de selecao de FDB
    $clients = Get-SseClients
    if ($clients -gt 0) {
        try {
            Invoke-WebRequest "$ADDR_LOCAL/api/navigate/selecionar-fdb" -UseBasicParsing -TimeoutSec 2 | Out-Null
        } catch {
            # Fallback: abre nova aba
            try { Start-Process "$ADDR/selecionar-fdb" } catch {}
        }
    } else {
        try {
            Start-Process "$ADDR/selecionar-fdb"
        } catch {
            [System.Windows.Forms.MessageBox]::Show(
                "Nao foi possivel abrir o seletor de banco.`nVerifique se o servidor esta rodando.",
                "$APP_NAME",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            ) | Out-Null
        }
    }
})
$menu.Items.Add($itemFdb) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# --- Reiniciar servidor ---
$itemReiniciar = New-Object System.Windows.Forms.ToolStripMenuItem
$itemReiniciar.Text = "Reiniciar servidor"
$itemReiniciar.Add_Click({
    Write-TrayLog "Reinicio manual solicitado pelo usuario via bandeja."
    # 1) Mata o processo rastreado pelo tray e toda a sua arvore (inclui
    #    filhos que ele possa ter deixado orfaos: geracoes de relatorio em
    #    andamento, PowerShell do seletor de FDB, etc.), com verificacao
    #    REAL de que morreu -- ver comentario completo em
    #    Stop-ServidorRelatorio.
    #    BUG FIX (seguranca): a versao anterior, apos isso, ainda executava
    #    "Get-Process -Name node | Kill" - matando TODO processo node.exe da
    #    maquina, inclusive programas Node.js de terceiros sem nenhuma
    #    relacao com este relatorio. taskkill /F /T /PID mata apenas a
    #    arvore do PID especifico que o tray lancou.
    $encerrouOk = Stop-ServidorRelatorio -Proc $script:nodeProc
    $script:nodeProc = $null

    if (-not $encerrouOk) {
        # PRECISAO FIX: nao inicia um processo novo por cima de um antigo que
        # pode continuar vivo -- isso so' criaria um segundo node.exe
        # concorrendo pela mesma porta/banco, exatamente o tipo de processo
        # orfao que motivou este fix inteiro. Avisa e para aqui.
        Write-TrayLog "Reinicio abortado: nao foi possivel confirmar o encerramento do servidor anterior." "ERRO"
        $tray.BalloonTipTitle = "$APP_NAME - Atencao"
        $tray.BalloonTipText  = "Nao foi possivel confirmar o encerramento do servidor anterior.`nVerifique o Gerenciador de Tarefas antes de tentar reiniciar de novo."
        $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Warning
        $tray.ShowBalloonTip(6000)
        return
    }

    # 2) Aguarda a porta ficar livre (ate 10s) antes de relancar
    $esperaPorta = 0
    while (-not (Test-PortaLivre -Porta $PORT) -and $esperaPorta -lt 20) {
        Start-Sleep -Milliseconds 500
        $esperaPorta++
    }

    # 3) Relanca o servidor via tray
    $reiniciouOk = $false
    try {
        $script:nodeProc = [System.Diagnostics.Process]::Start($psi)
        $reiniciouOk = ($null -ne $script:nodeProc)
    } catch {
        Write-TrayLog "Falha ao relancar o servidor: $($_.Exception.Message)" "ERRO"
    }

    if ($reiniciouOk) {
        Write-TrayLog "Servidor reiniciado manualmente com sucesso (novo PID: $($script:nodeProc.Id))."
        $tray.BalloonTipTitle = $APP_NAME
        $tray.BalloonTipText  = "Servidor reiniciado com sucesso!"
        $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
        $tray.ShowBalloonTip(3000)
    } else {
        Write-TrayLog "Falha ao reiniciar o servidor apos clique manual." "ERRO"
        $tray.BalloonTipTitle = "$APP_NAME - Erro"
        $tray.BalloonTipText  = "Falha ao reiniciar o servidor.`nVerifique se o Node.js esta instalado."
        $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Error
        $tray.ShowBalloonTip(5000)
    }
})
$menu.Items.Add($itemReiniciar) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# --- Sair ---
$itemSair = New-Object System.Windows.Forms.ToolStripMenuItem
$itemSair.Text = "Sair"
$itemSair.Add_Click({
    Write-TrayLog "Encerramento solicitado pelo usuario via bandeja."
    # PRECISAO FIX: agora usa Stop-ServidorRelatorio, que CONFIRMA que o
    # processo morreu de verdade (nao so' que o taskkill rodou sem erro) -
    # ver comentario completo na declaracao da funcao. Isso e' o que faltava
    # para o log parar de crescer depois do icone sumir.
    $encerrouOk = Stop-ServidorRelatorio -Proc $script:nodeProc
    $script:nodeProc = $null

    # MENSAGEM FIX (pedido do usuario): confirmacao de encerramento, no
    # mesmo padrao das mensagens de "Servidor reiniciado"/"Servidor
    # iniciado" ja existentes neste arquivo -- BalloonTipTitle = $APP_NAME,
    # igual as demais. O balao PRECISA ser mostrado ANTES de
    # "$tray.Visible = $false": um NotifyIcon invisivel nao exibe balao
    # nenhum, o Windows simplesmente descarta a chamada em silencio.
    if ($encerrouOk) {
        $tray.BalloonTipTitle = $APP_NAME
        $tray.BalloonTipText  = "Servidor encerrado com sucesso."
        $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
    } else {
        $tray.BalloonTipTitle = "$APP_NAME - Atencao"
        $tray.BalloonTipText  = "Nao foi possivel confirmar o encerramento do servidor.`nVerifique o Gerenciador de Tarefas (node.exe)."
        $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Warning
    }
    $tray.ShowBalloonTip(3000)
    # Da tempo do balao renderizar antes de esconder o icone e encerrar o
    # processo do tray -- ShowBalloonTip e' assincrono; sem essa pausa o
    # balao e' descartado antes mesmo de aparecer na tela.
    Start-Sleep -Milliseconds 1500

    $tray.Visible = $false
    try { $mutex.ReleaseMutex() } catch {}
    [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($itemSair) | Out-Null

$tray.ContextMenuStrip = $menu
$tray.Add_DoubleClick({ Open-Relatorio "/" })

# ---------------------------------------------------------------------------
# Timer 1: Reinicia node se cair (verifica processo E porta) OU se travar
# (processo vivo mas sem responder ao HTTP por 3 verificacoes seguidas ~30s).
# ROBUSTEZ FIX: a versao anterior so' detectava PROCESSO MORTO (HasExited).
# Um processo travado (deadlock, loop infinito no event loop do Node) fica
# "vivo" para o Windows para sempre e nunca era reiniciado automaticamente.
# Exige 3 falhas consecutivas (nao 1) antes de agir, para nao reiniciar por
# causa de uma lentidao pontual (ex: geracao de relatorio de periodo longo).
# ---------------------------------------------------------------------------
$script:falhasConsecutivas = 0
$watchTimer = New-Object System.Windows.Forms.Timer
$watchTimer.Interval = 10000
$watchTimer.Add_Tick({
    try {
        $procMorreu = ($null -eq $script:nodeProc -or $script:nodeProc.HasExited)
        if ($procMorreu) {
            $script:falhasConsecutivas = 0
            $portaLivre = Test-PortaLivre -Porta $PORT
            if ($portaLivre) {
                Write-TrayLog "Processo do servidor nao esta mais ativo - reiniciando automaticamente." "AVISO"
                $script:nodeProc = [System.Diagnostics.Process]::Start($psi)
                $tray.BalloonTipTitle = $APP_NAME
                $tray.BalloonTipText  = "Servidor reiniciado automaticamente."
                $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Warning
                $tray.ShowBalloonTip(2500)
            } else {
                $script:nodeProc = $null
            }
            return
        }

        # Processo "vivo" segundo o SO - confirma que esta REALMENTE respondendo.
        if (Test-ServidorAtivo) {
            $script:falhasConsecutivas = 0
        } else {
            $script:falhasConsecutivas++
            if ($script:falhasConsecutivas -ge 3) {
                Write-TrayLog "Servidor nao responde ha ~30s (processo vivo, porem travado) - forcando reinicio." "ERRO"
                $pidTravado = $script:nodeProc.Id
                # PRECISAO FIX: mesma verificacao real de Stop-ServidorRelatorio
                # (ver comentario completo na declaracao) -- sem isso, um
                # taskkill que "roda mas nao mata" deixava o processo travado
                # vivo E ORFAO (nodeProc vira null aqui embaixo de qualquer
                # jeito na versao antiga), enquanto um novo processo subia por
                # cima, escutando a mesma porta. Repetido ao longo do dia, isso
                # acumula varios node.exe travados na mesma maquina -- o
                # cenario que motivou "matar todos os node.exe" para o
                # SmallSoft voltar a responder.
                $encerrouOk = Stop-ServidorRelatorio -Proc $script:nodeProc
                $script:nodeProc = $null
                $script:falhasConsecutivas = 0

                if (-not $encerrouOk) {
                    Write-TrayLog "Processo travado (PID $pidTravado) nao pode ser encerrado - NAO reiniciando automaticamente para evitar acumular processos node.exe orfaos. Encerre manualmente." "ERRO"
                    $tray.BalloonTipTitle = "$APP_NAME - Atencao"
                    $tray.BalloonTipText  = "Servidor travado (PID $pidTravado) nao pode ser encerrado automaticamente.`nEncerre manualmente pelo Gerenciador de Tarefas."
                    $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Error
                    $tray.ShowBalloonTip(6000)
                    return
                }

                if (Test-PortaLivre -Porta $PORT) {
                    $script:nodeProc = [System.Diagnostics.Process]::Start($psi)
                    $tray.BalloonTipTitle = $APP_NAME
                    $tray.BalloonTipText  = "Servidor parou de responder e foi reiniciado automaticamente."
                    $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Warning
                    $tray.ShowBalloonTip(4000)
                } else {
                    Write-TrayLog "Processo travado encerrado, mas a porta $PORT continua ocupada logo em seguida - outro processo pode estar usando-a." "ERRO"
                }
            }
        }
    } catch {}
})
$watchTimer.Start()

# ---------------------------------------------------------------------------
# Timer 2: Verifica status do banco (uma vez apos 20s)
# ---------------------------------------------------------------------------
$script:dbChecked = $false
$dbTimer = New-Object System.Windows.Forms.Timer
$dbTimer.Interval = 20000
$dbTimer.Add_Tick({
    if ($script:dbChecked) { $dbTimer.Stop(); return }
    $script:dbChecked = $true
    $dbTimer.Stop()
    try {
        $r  = Invoke-WebRequest "$ADDR_LOCAL/api/db-status" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        $st = $r.Content | ConvertFrom-Json
        if ($st.scanCompleto -and -not $st.ok) {
            Write-TrayLog "Banco de dados inacessivel na checagem inicial: $($st.erro)" "ERRO"
            $tray.BalloonTipTitle = "$APP_NAME - Atencao!"
            $tray.BalloonTipText  = "Nao foi possivel conectar ao banco!`n$($st.erro)`nVerifique se o servidor esta ligado."
            $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Error
            $tray.ShowBalloonTip(10000)
        }
    } catch {}
})
$dbTimer.Start()

# ---------------------------------------------------------------------------
# Notificacao inicial
# ---------------------------------------------------------------------------
$tray.BalloonTipTitle = $APP_NAME
if ($MAQUINA_IP) {
    $tray.BalloonTipText = "Servidor iniciado!`nAcesso externo: http://${MAQUINA_IP}:${PORT}`nDuplo clique para abrir."
} else {
    $tray.BalloonTipText = "Servidor iniciado! Duplo clique para abrir."
}
$tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
$tray.ShowBalloonTip(3500)

# ---------------------------------------------------------------------------
# Loop de mensagens Windows
# ---------------------------------------------------------------------------
[System.Windows.Forms.Application]::Run()

$watchTimer.Stop(); $dbTimer.Stop()
$tray.Visible = $false; $tray.Dispose()
try { $mutex.ReleaseMutex() } catch {}