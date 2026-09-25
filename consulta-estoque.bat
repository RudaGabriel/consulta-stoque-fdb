@echo off
REM ===========================================================================
REM  consulta-estoque.bat
REM  @version 5.29.3
REM  @changelog
REM    5.29.3 - 2026-09-21 - Desativa o "Modo de Edicao Rapida" (QuickEdit) do
REM      console ao iniciar o servidor. Nesse modo, um simples clique na janela
REM      do cmd inicia uma selecao de texto que CONGELA a saida do Node (e o
REM      servidor trava, ex.: requisicoes da interface ficam "sincronizando")
REM      ate uma tecla ser pressionada. Sem o QuickEdit, clicar na janela nao
REM      trava mais nada. O efeito vale so para esta janela.
REM ===========================================================================
chcp 65001 > nul
title Consulta Estoque

cd /d "%~dp0"

REM Guarda o caminho deste .bat: dentro de "call :rotina" o %0 deixa de ser o
REM arquivo, e o bloco PowerShell no final precisa ler este proprio arquivo.
set "ESTOQUE_BAT=%~f0"

REM Instancia elevada: quando o .bat se reabre como administrador ele recebe o
REM argumento /instalar-node e faz SOMENTE a instalacao do Node.js.
if /i "%~1"=="/instalar-node" goto :modo_instalador

echo.
echo  ================================================
echo   Consulta de Estoque
echo   Porta: 7888
echo  ================================================
echo.

REM ---------------------------------------------------------------------------
REM Verificar Node.js (instala silenciosamente se nao existir)
REM ---------------------------------------------------------------------------
where node > nul 2>&1
if errorlevel 1 call :instalar_node
where node > nul 2>&1
if errorlevel 1 (
    echo  [ERRO] Node.js nao encontrado e nao foi possivel instala-lo.
    echo.
    echo  Baixe e instale manualmente em: https://nodejs.org
    echo  Log da instalacao: %TEMP%\consulta_estoque_node_install.log
    echo.
    pause
    exit /b 1
)

REM ---------------------------------------------------------------------------
REM Verificar arquivos obrigatorios
REM ---------------------------------------------------------------------------
if not exist "consulta-estoque.js" (
    echo  [ERRO] consulta-estoque.js nao encontrado.
    echo  Certifique-se de que o .bat esta na mesma pasta que os .js
    echo.
    pause
    exit /b 1
)

REM estoque-engine.js NAO e necessario para o servidor rodar: o conteudo dele
REM esta embutido dentro de consulta-estoque.js (constante _ENGINE_SRC) e e
REM injetado no HTML enviado ao navegador. O arquivo solto so e usado pela
REM suite de testes, que faz require("./estoque-engine.js"). Por isso aqui ele
REM e apenas um AVISO, e nao mais um erro que impedia o servidor de iniciar.
if not exist "estoque-engine.js" (
    echo  [AVISO] estoque-engine.js nao encontrado.
    echo  O servidor funciona normalmente sem ele ^(o motor vai embutido^),
    echo  mas a suite de testes nao podera ser executada.
    echo.
)

REM config.json e opcional: sem ele o servidor usa deteccao automatica de rede
if not exist "config.json" (
    echo  [AVISO] config.json nao encontrado, usando deteccao automatica de rede.
    echo.
)

REM ---------------------------------------------------------------------------
REM Verificar node-firebird
REM ---------------------------------------------------------------------------
node -e "require('node-firebird')" > nul 2>&1
if %errorlevel% neq 0 (
    echo  [AVISO] Modulo node-firebird nao instalado.
    echo  Instalando automaticamente...
    echo.
    npm install node-firebird
    REM Mesmo motivo do bloco de verificacao: dentro de ( ) o %errorlevel% seria
    REM expandido antes do npm rodar, e uma falha de instalacao passaria batido.
    if errorlevel 1 (
        echo.
        echo  [ERRO] Falha ao instalar node-firebird.
        echo  Tente manualmente: npm install node-firebird
        echo.
        pause
        exit /b 1
    )
    echo.
    echo  Modulo instalado com sucesso!
    echo.
)

REM ---------------------------------------------------------------------------
REM Verificacao automatica de integridade (antes de subir o servidor)
REM ---------------------------------------------------------------------------
REM Por que isto existe: "node -c consulta-estoque.js" valida apenas o codigo do
REM SERVIDOR. Todo o JavaScript da interface vive dentro de um template literal
REM (a string do HTML), entao para o Node e apenas texto: um erro de sintaxe ali
REM passa despercebido e so aparece como pagina quebrada no navegador. O
REM validar-client.js extrai esses blocos <script> e roda o parser do Node sobre
REM eles, fechando essa lacuna. Os testes cobrem o estoque-engine.js.
REM
REM Tudo aqui e OPCIONAL e nao impede o servidor de subir: se um arquivo de
REM verificacao nao estiver presente, apenas pula. Se uma verificacao FALHAR,
REM avisa e pede confirmacao, porque uma loja parada por causa de um teste
REM quebrado seria pior que o proprio defeito.
set "VERIFICACAO_FALHOU="

node -c "consulta-estoque.js" > nul 2>&1
if errorlevel 1 (
    echo  [ERRO] consulta-estoque.js tem erro de sintaxe no codigo do servidor.
    set "VERIFICACAO_FALHOU=1"
)

if exist "validar-client.js" (
    node "validar-client.js" > nul 2>&1
    REM "if errorlevel 1" e avaliado em tempo de execucao. Usar %errorlevel%
    REM aqui dentro NAO funcionaria: dentro de um bloco ( ) a variavel e
    REM expandida quando o bloco inteiro e lido, antes do node rodar, entao o
    REM teste compararia o valor ANTERIOR e a falha passaria despercebida.
    if errorlevel 1 (
        echo  [ERRO] Erro de sintaxe no JavaScript da interface ^(client-side^).
        echo         Rode: node validar-client.js
        set "VERIFICACAO_FALHOU=1"
    )
)

if exist "consulta-estoque_test.js" (
    if exist "estoque-engine.js" (
        node --test "consulta-estoque_test.js" > nul 2>&1
        if errorlevel 1 (
            echo  [AVISO] A suite de testes do estoque-engine.js falhou.
            echo          Rode: node --test consulta-estoque_test.js
            set "VERIFICACAO_FALHOU=1"
        )
    )
)

if defined VERIFICACAO_FALHOU (
    echo.
    echo  ================================================
    echo   Uma ou mais verificacoes falharam.
    echo   O servidor AINDA PODE ser iniciado, mas algo
    echo   pode nao funcionar corretamente.
    echo  ================================================
    echo.
    choice /c SN /n /m "  Iniciar mesmo assim? [S/N]: "
    if errorlevel 2 (
        echo.
        echo  Cancelado pelo usuario.
        pause
        exit /b 1
    )
    echo.
) else (
    echo  [OK] Verificacoes de integridade concluidas.
    echo.
)

REM ---------------------------------------------------------------------------
REM Iniciar
REM ---------------------------------------------------------------------------
REM Se a porta 7888 ja estiver ocupada (ex.: servidor antigo esquecido rodando),
REM avisa antes de subir, em vez de deixar o Node falhar com "porta em uso".
set "PORTA_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":7888 .*LISTENING"') do set "PORTA_PID=%%p"
if not defined PORTA_PID goto :iniciar_servidor

tasklist /fi "PID eq %PORTA_PID%" /fo csv /nh 2>nul | find /i "node.exe" > nul
if errorlevel 1 goto :porta_ocupada_outro

echo  [AVISO] Ja existe um servidor Node em execucao na porta 7888 ^(PID %PORTA_PID%^).
echo          Provavelmente uma janela anterior ficou aberta ou rodando oculta.
echo.
choice /c SN /n /m "  Encerrar o servidor antigo e iniciar um novo? [S/N]: "
if errorlevel 2 goto :cancelar_porta
taskkill /pid %PORTA_PID% /t /f > nul 2>&1
ping -n 2 127.0.0.1 > nul
echo.
goto :iniciar_servidor

:porta_ocupada_outro
echo  [ERRO] A porta 7888 esta ocupada por outro programa ^(PID %PORTA_PID%^).
echo         Feche esse programa e execute o .bat novamente.
echo.
pause
exit /b 1

:cancelar_porta
echo.
echo  Cancelado pelo usuario.
pause
exit /b 0

REM ---------------------------------------------------------------------------
REM Iniciar servidor (visivel nesta janela) e aguardar a tecla 0
REM ---------------------------------------------------------------------------
:iniciar_servidor
title Consulta Estoque - pressione 0 para encerrar tudo

REM Desativa o QuickEdit desta janela (ver @changelog). Falha aqui e ignorada:
REM no pior caso o comportamento e o de antes.
set "ESTOQUE_ACAO=quickedit"
call :executar_ps > nul 2>&1
set "ESTOQUE_ACAO="
echo  Iniciando servidor...
echo  Acesse: http://localhost:7888
echo.
echo  Pressione 0 nesta janela para encerrar tudo ^(ou Ctrl+C / fechar a janela^).
echo.

REM O servidor roda na MESMA janela (-NoNewWindow): os logs aparecem aqui. O
REM PowerShell so o inicia e grava o PID num arquivo (nao pode devolver por
REM stdout, senao a saida do servidor seria capturada em vez de aparecer).
set "ESTOQUE_PIDFILE=%TEMP%\consulta_estoque_server.pid"
del "%ESTOQUE_PIDFILE%" > nul 2>&1
set "SERVER_PID="
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $p=Start-Process -FilePath 'node' -ArgumentList 'consulta-estoque.js' -WorkingDirectory (Get-Location).Path -NoNewWindow -PassThru; Set-Content -LiteralPath $env:ESTOQUE_PIDFILE -Value $p.Id -Encoding ASCII } catch { exit 1 }"
if errorlevel 1 goto :falha_iniciar
if exist "%ESTOQUE_PIDFILE%" set /p SERVER_PID=<"%ESTOQUE_PIDFILE%"
if not defined SERVER_PID goto :falha_iniciar

REM Da ~2s para o servidor subir; se ja tiver morrido, os logs acima mostram o motivo.
ping -n 3 127.0.0.1 > nul
tasklist /fi "PID eq %SERVER_PID%" /fo csv /nh 2>nul | find /i "node.exe" > nul
if errorlevel 1 goto :servidor_caiu

REM Abre o navegador direto daqui: "start" com URL nao abre janela de cmd.
start "" "http://localhost:7888"

:loop_menu
REM Espera a tecla 0 por 3s; sem tecla, assume N e apenas verifica o servidor.
REM (Ctrl+C retorna errorlevel 0 e tambem cai no encerramento, sem deixar o
REM servidor orfao.) "if errorlevel 2" e avaliado em tempo de execucao.
choice /c 0N /n /t 3 /d N > nul
if errorlevel 2 goto :checar_servidor
goto :encerrar_servidor

:checar_servidor
tasklist /fi "PID eq %SERVER_PID%" /fo csv /nh 2>nul | find /i "node.exe" > nul
if errorlevel 1 goto :servidor_caiu
goto :loop_menu

:falha_iniciar
echo.
echo  [ERRO] Nao foi possivel iniciar o servidor.
echo.
pause
exit /b 1

:servidor_caiu
del "%ESTOQUE_PIDFILE%" > nul 2>&1
echo.
echo  [ERRO] O servidor foi encerrado. Veja as mensagens acima.
echo.
pause
exit /b 1

:encerrar_servidor
echo.
echo  Encerrando servidor...
taskkill /pid %SERVER_PID% /t /f > nul 2>&1
del "%ESTOQUE_PIDFILE%" > nul 2>&1
echo  Servidor encerrado.
ping -n 2 127.0.0.1 > nul
exit /b 0

REM ===========================================================================
REM  MODO INSTALADOR (instancia elevada, chamada com /instalar-node)
REM  Roda apenas o instalador do Node.js e devolve o codigo de saida.
REM  Em caso de falha, mantem a janela aberta para o usuario ler o erro.
REM ===========================================================================
:modo_instalador
call :executar_ps
set "PS_RC=%errorlevel%"
if not "%PS_RC%"=="0" (
    echo.
    echo  [ERRO] A instalacao do Node.js falhou. Veja o log em:
    echo         %TEMP%\consulta_estoque_node_install.log
    echo.
    pause
)
exit /b %PS_RC%

REM ===========================================================================
REM  SUBROTINA: instalar_node
REM  Garante privilegio de administrador (auto-elevacao) e instala o Node.js.
REM  Retorna errorlevel 0 se o Node.js ficou disponivel, 1 caso contrario.
REM ===========================================================================
:instalar_node
echo  Node.js nao encontrado. Instalando silenciosamente...
echo  (acompanhe em %TEMP%\consulta_estoque_node_install.log)
echo.

where powershell > nul 2>&1
if errorlevel 1 (
    echo  [ERRO] PowerShell nao encontrado; nao e possivel instalar automaticamente.
    exit /b 1
)

REM "fltmc" so funciona com privilegio de administrador (nao depende do servico
REM Server, ao contrario de "net session").
fltmc > nul 2>&1
if errorlevel 1 goto :elevar_e_instalar

call :executar_ps
set "PS_RC=%errorlevel%"
goto :pos_instalacao

:elevar_e_instalar
echo  Permissao de administrador necessaria para instalar o Node.js.
echo  Confirme o aviso do Windows (UAC) que sera exibido...
echo.
REM Reabre este mesmo .bat elevado, com /instalar-node, e ESPERA terminar.
REM As aspas do cmd /c sao montadas com [char]34 para nao quebrar o quoting
REM desta linha (caminhos com espacos funcionam). O codigo de saida da
REM instancia elevada e repassado para ca.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $q=[char]34; $arg='/c '+$q+$q+$env:ESTOQUE_BAT+$q+' /instalar-node'+$q; $p=Start-Process -FilePath 'cmd.exe' -ArgumentList $arg -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { Write-Host ('[ERRO] Elevacao cancelada ou negada: ' + $_.Exception.Message); exit 1 }"
set "PS_RC=%errorlevel%"

:pos_instalacao
echo.
if not "%PS_RC%"=="0" exit /b 1

REM O PATH desta sessao nao enxerga o Node recem-instalado: adiciona manualmente
REM as pastas padrao para continuar sem precisar reabrir o terminal.
set "PATH=%ProgramFiles%\nodejs;%ProgramW6432%\nodejs;%APPDATA%\npm;%PATH%"

where node > nul 2>&1
if errorlevel 1 (
    echo  [AVISO] Node.js instalado, mas nao localizado no PATH desta sessao.
    echo          Feche esta janela e execute o .bat novamente.
    exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo  Node.js: %%v
echo.
exit /b 0

REM ===========================================================================
REM  SUBROTINA: executar_ps
REM  Executa o instalador PowerShell embutido no final deste arquivo.
REM ===========================================================================
:executar_ps
REM O marcador e montado em duas partes ('#PS1_' + 'INICIO') para que a propria
REM linha de comando nao seja confundida com o marcador real no fim do arquivo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=[IO.File]::ReadAllText($env:ESTOQUE_BAT); $m='#PS1_'+'INICIO'; $i=$c.IndexOf($m); if($i -lt 0){ Write-Host '[ERRO] Bloco do instalador nao encontrado no .bat'; exit 1 }; Invoke-Expression $c.Substring($i)"
exit /b %errorlevel%

REM ===========================================================================
REM  Tudo abaixo e PowerShell (lido pela subrotina acima). O cmd nunca chega
REM  aqui porque todos os caminhos anteriores terminam em "exit /b".
REM ===========================================================================
#PS1_INICIO
if ($env:ESTOQUE_ACAO -eq 'quickedit') {
    try {
        Add-Type -Namespace Estoque -Name Con -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@
        $h = [Estoque.Con]::GetStdHandle(-10)
        $m = [uint32]0
        if ([Estoque.Con]::GetConsoleMode($h, [ref]$m)) {
            # 0x40 = ENABLE_QUICK_EDIT_MODE (limpa), 0x80 = ENABLE_EXTENDED_FLAGS (necessario para aplicar)
            $novo = ($m -bor 0x80) -bxor ($m -band 0x40)
            [void][Estoque.Con]::SetConsoleMode($h, [uint32]$novo)
        }
    } catch { }
    exit 0
}
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
$versao  = '20.19.0'
$logFile = Join-Path $env:TEMP 'consulta_estoque_node_install.log'
$msiLog  = Join-Path $env:TEMP 'consulta_estoque_node_msi.log'

function Escrever-Log([string]$nivel, [string]$msg) {
    $linha = '[{0}][{1}] {2}' -f (Get-Date -Format 'HH:mm:ss'), $nivel, $msg
    Write-Host $linha
    try { Add-Content -LiteralPath $logFile -Value $linha -Encoding UTF8 } catch { }
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-NodeInstalado {
    if (Get-Command node -ErrorAction SilentlyContinue) { return $true }
    foreach ($base in @($env:ProgramFiles, $env:ProgramW6432, ${env:ProgramFiles(x86)})) {
        if ($base -and (Test-Path -LiteralPath (Join-Path $base 'nodejs\node.exe'))) { return $true }
    }
    return $false
}

try {
    Escrever-Log 'INFO' "=== Instalador Node.js v$versao ==="

    if (-not (Test-Admin)) {
        Escrever-Log 'ERRO' 'Este instalador precisa de privilegio de administrador.'
        exit 1
    }

    # ---- 1) winget (rapido, se existir) ----
    try {
        Escrever-Log 'INFO' 'Tentando instalar via winget...'
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "winget nao disponivel" }
        $pw = Start-Process -FilePath 'winget' -ArgumentList @('install','--id','OpenJS.NodeJS.LTS','-e','--silent','--accept-package-agreements','--accept-source-agreements') -Wait -PassThru -NoNewWindow
        if ($pw.ExitCode -ne 0) { throw "winget retornou $($pw.ExitCode)" }
        if (-not (Test-NodeInstalado)) { throw 'node nao encontrado apos o winget' }
        Escrever-Log 'OK' 'Node.js instalado via winget!'
        exit 0
    } catch {
        Escrever-Log 'AVISO' ('winget nao disponivel ou falhou: ' + $_.Exception.Message)
    }

    # ---- 2) MSI oficial do nodejs.org ----
    $a = $env:PROCESSOR_ARCHITEW6432
    if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
    switch ($a) {
        'ARM64' { $arq = 'arm64' }
        'x86'   { $arq = 'x86' }
        default { $arq = 'x64' }
    }
    $arquivo = "node-v$versao-$arq.msi"
    $url     = "https://nodejs.org/dist/v$versao/$arquivo"
    $dest    = Join-Path $env:TEMP $arquivo
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

    Escrever-Log 'INFO' "Baixando Node.js $versao..."
    Escrever-Log 'INFO' "URL: $url"
    $baixou = $false
    for ($t = 1; ($t -le 3) -and (-not $baixou); $t++) {
        Escrever-Log 'INFO' "Tentativa de download $t de 3 (timeout: 180s)..."
        try {
            if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 180
            $tam = (Get-Item -LiteralPath $dest).Length
            if ($tam -lt 1MB) { throw "arquivo baixado muito pequeno ($tam bytes)" }
            $baixou = $true
            Escrever-Log 'OK' ('Download OK. Tamanho: {0:N1} MB' -f ($tam / 1MB))
        } catch {
            Escrever-Log 'AVISO' ('Falha no download: ' + $_.Exception.Message)
            if ($t -lt 3) { Start-Sleep -Seconds (3 * $t) }
        }
    }
    if (-not $baixou) {
        Escrever-Log 'ERRO' 'Nao foi possivel baixar o Node.js apos 3 tentativas. Verifique a internet.'
        exit 1
    }

    # ---- 3) Conferir SHA256 contra o SHASUMS256.txt oficial ----
    try {
        $sums  = (Invoke-WebRequest -Uri "https://nodejs.org/dist/v$versao/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 60).Content
        if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
        $linha = ($sums -split "`n" | Where-Object { $_ -match ([regex]::Escape($arquivo) + '\s*$') } | Select-Object -First 1)
        if ($linha) {
            $esperado = (($linha.Trim() -split '\s+')[0]).ToLower()
            $real     = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
            if ($esperado -ne $real) {
                Escrever-Log 'ERRO' 'SHA256 do instalador NAO confere com o oficial. Instalacao abortada.'
                Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
                exit 1
            }
            Escrever-Log 'OK' 'SHA256 conferido com o SHASUMS256.txt oficial.'
        } else {
            Escrever-Log 'AVISO' 'Arquivo nao listado no SHASUMS256.txt; checksum nao verificado.'
        }
    } catch {
        Escrever-Log 'AVISO' ('Nao foi possivel verificar o checksum: ' + $_.Exception.Message)
    }

    # ---- 4) Instalar via MSI (silencioso) ----
    Escrever-Log 'INFO' 'Instalando via MSI (modo silencioso)...'
    $argMsi = @('/i', ('"' + $dest + '"'), '/qn', '/norestart', '/L*v', ('"' + $msiLog + '"'))
    try {
        $pm = Start-Process -FilePath 'msiexec.exe' -ArgumentList $argMsi -Wait -PassThru
    } catch {
        Escrever-Log 'ERRO' ('Nao foi possivel executar o msiexec: ' + $_.Exception.Message)
        exit 1
    }
    Escrever-Log 'INFO' ('msiexec retornou: ' + $pm.ExitCode)

    # 0 = ok, 3010 = ok (reinicio recomendado), 1641 = ok (reiniciando)
    if (@(0, 3010, 1641) -notcontains $pm.ExitCode) {
        Escrever-Log 'ERRO' "Falha na instalacao (codigo $($pm.ExitCode)). Detalhes em: $msiLog"
        exit 1
    }

    Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    if (Test-NodeInstalado) {
        Escrever-Log 'OK' "Node.js v$versao instalado com sucesso!"
        exit 0
    }
    Escrever-Log 'ERRO' 'A instalacao terminou, mas o node.exe nao foi encontrado.'
    exit 1
} catch {
    Escrever-Log 'ERRO' ('Erro inesperado: ' + $_.Exception.Message)
    exit 1
}