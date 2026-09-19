@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
chcp 65001 >nul 2>&1

:: =========================================================
::  Relatorio por Periodo                             v1.4.1
::  - Verifica / instala Node.js automaticamente
::  - Verifica / instala modulo node-firebird automaticamente
::  - Inicia servidor se necessario
::  - Abre relatorio no navegador
::
::  CHANGELOG 1.4.1 - 2026-08-08 05:10 - Quebras de linha convertidas para
::   CRLF, a convencao correta do Windows. Estes arquivos estavam com LF
::   puro; funcionavam porque so' usam "goto", mas "call :label" quebra
::   nesse formato (ver instalar-na-inicializacao.bat v1.8.1). Padronizado
::   em todo o projeto para evitar a armadilha em edicoes futuras.
::   Se for editar, use um editor que preserve CRLF.

call :verificar_node
if %errorlevel% neq 0 exit /b 1

call :verificar_modulos
if %errorlevel% neq 0 exit /b 1

call :ler_config

:: Ano padrao
for /f "tokens=2 delims==" %%a in ('wmic os get LocalDateTime /value ^| find "="') do set "LDT=%%a"
set "ANO_PADRAO=!LDT:~0,4!"
if not defined ANO_PADRAO set "ANO_PADRAO=2026"

echo.
echo =======================================================
echo     GERAR RELATORIO POR PERIODO
echo =======================================================
echo.

set "DATA_I="
set /p DATA_I=Data INICIAL (D/M ou DD/MM ou DD/MM/AAAA): 
if "!DATA_I!"=="" exit /b 1
call :ParseData "!DATA_I!" DI MI YI
if "!ERRO!"=="1" goto :data_invalida

set "DATA_F="
set /p DATA_F=Data FINAL   (D/M ou DD/MM ou DD/MM/AAAA): 
if "!DATA_F!"=="" exit /b 1
call :ParseData "!DATA_F!" DF MF YF
if "!ERRO!"=="1" goto :data_invalida

set "ISO_I=!YI!-!MI!-!DI!"
set "ISO_F=!YF!-!MF!-!DF!"

echo.
echo  Periodo: !DI!/!MI!/!YI! ate !DF!/!MF!/!YF!

:: Garante que o servidor esta rodando
call :iniciar_servidor

:: Abre URL com & de forma segura via PowerShell
set "_TMPURL=%TEMP%\_rel_url_%RANDOM%.txt"
set "_ISO_I=!ISO_I!"
set "_ISO_F=!ISO_F!"
powershell -NoProfile -Command "$i='!_ISO_I!'; $f='!_ISO_F!'; Set-Content -Path '!_TMPURL!' -Value ('http://localhost:!PORTA!/periodo?i='+$i+'&f='+$f) -Encoding UTF8"
powershell -NoProfile -Command "$u=(Get-Content '!_TMPURL!' -Encoding UTF8 | Select-Object -First 1).Trim(); Start-Process $u"
del "!_TMPURL!" >nul 2>&1
exit /b 0

:data_invalida
echo  Data invalida. Use formatos como 1/3, 01/03, 01/03/2026.
pause
exit /b 1

:: -------------------------------------------------------
:ParseData
set "ERRO=0"
set "INP=%~1"
if "!INP!"=="" (set "ERRO=1" & exit /b)
set "INP=!INP: =!"
set "INP=!INP:-=/!"
for /f "tokens=1-3 delims=/" %%a in ("!INP!") do (
    set "_d=%%a"
    set "_m=%%b"
    set "_y=%%c"
)
if not defined _d (set "ERRO=1" & exit /b)
if not defined _m (set "ERRO=1" & exit /b)
if not defined _y set "_y=!ANO_PADRAO!"

:: VALIDACAO FIX: garante que _d/_m sao numericos e estao numa faixa de
:: calendario plausivel ANTES de montar a URL - sem isso, um erro de
:: digitacao (ex: "99/13") so' era percebido depois, no processo filho
:: Node.js, com uma pagina de erro generica em vez de um aviso imediato.
powershell -NoProfile -Command "$d=0;$m=0;if([int]::TryParse('!_d!',[ref]$d) -and [int]::TryParse('!_m!',[ref]$m) -and $d -ge 1 -and $d -le 31 -and $m -ge 1 -and $m -le 12){exit 0}else{exit 1}" >nul 2>&1
if %errorlevel% neq 0 (set "ERRO=1" & exit /b)

if "!_d:~1,1!"=="" set "_d=0!_d!"
if "!_m:~1,1!"=="" set "_m=0!_m!"
set "%2=!_d!" & set "%3=!_m!" & set "%4=!_y!"
set "_d=" & set "_m=" & set "_y="
exit /b

:: -------------------------------------------------------
:: Le porta e nome do app/loja de config.json (campos "porta" e "appName").
:: Fallback silencioso para 7734 / "Relatorios". Uma unica chamada
:: powershell busca os dois valores. !APP_TITULO! (expansao adiada) no
:: "title" abaixo evita risco de injecao caso o nome da loja contenha
:: caractere especial de cmd.exe (& | < > ^) - ver comentario completo em
:: gerar_relatorio_do_dia.bat.
:: -------------------------------------------------------
:ler_config
:: ROBUSTEZ FIX: a versao anterior buscava porta+nome numa unica chamada
:: powershell (dois valores numa linha so', separados por "|"). Voltado
:: para duas chamadas simples e separadas, no mesmo formato ja comprovado
:: usado no restante do arquivo - reduz risco por simplicidade.
set "PORTA=7734"
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "try{$p=(Get-Content '%~dp0config.json' -Raw -Encoding UTF8 | ConvertFrom-Json).porta; if($p -gt 0){[int]$p}else{7734}}catch{7734}" 2^>nul`) do set "PORTA=%%P"
set "APP_TITULO=Relatorios"
for /f "usebackq delims=" %%N in (`powershell -NoProfile -Command "try{$n=(Get-Content '%~dp0config.json' -Raw -Encoding UTF8 | ConvertFrom-Json).appName; if($n){$n}else{'Relatorios'}}catch{'Relatorios'}" 2^>nul`) do set "APP_TITULO=%%N"
title !APP_TITULO! - Relatorio por Periodo
exit /b 0

:: -------------------------------------------------------
:iniciar_servidor
powershell -NoProfile -Command ^
    "try{$t=New-Object Net.Sockets.TcpClient;$ok=$t.ConnectAsync('127.0.0.1',!PORTA!).Wait(1500);$t.Close();if($ok){exit 0}else{exit 1}}catch{exit 1}" >nul 2>&1
if %errorlevel% equ 0 exit /b 0

:: PRECISAO FIX (v1.4.0): verifica launcher.vbs ANTES de chamar - ver
:: comentario completo em gerar_relatorio_do_dia.bat. Sem isso, o .bat
:: esperava 30s por um servidor que nunca subiria, sem pista do motivo.
if not exist "%~dp0launcher.vbs" (
    echo.
    echo ERRO: launcher.vbs nao encontrado em:
    echo   %~dp0
    echo.
    echo Esse arquivo e necessario para iniciar o servidor.
    echo Verifique se a pasta do sistema esta completa.
    echo.
    pause
    exit /b 1
)
echo  Iniciando servidor de relatorios...
start "" wscript.exe "%~dp0launcher.vbs"

set "_t=0"
:_loop_ini
set /a "_t+=1"
if %_t% gtr 30 exit /b 0
powershell -NoProfile -Command ^
    "try{$t=New-Object Net.Sockets.TcpClient;$ok=$t.ConnectAsync('127.0.0.1',!PORTA!).Wait(1500);$t.Close();if($ok){exit 0}else{exit 1}}catch{exit 1}" >nul 2>&1
if %errorlevel% equ 0 exit /b 0
timeout /t 2 /nobreak >nul
goto :_loop_ini

:: -------------------------------------------------------
:: Verifica se node-firebird esta instalado.
:: Se nao estiver, instala via npm.
:: -------------------------------------------------------
:verificar_modulos
node -e "require('node-firebird')" >nul 2>&1
if %errorlevel% equ 0 exit /b 0

echo.
echo  Modulo node-firebird nao encontrado. Instalando...
echo.
pushd "%~dp0"

call npm install node-firebird --prefer-offline >nul 2>&1
if %errorlevel% equ 0 goto :_mod_validar

call npm install node-firebird
if %errorlevel% neq 0 (
    echo.
    echo  ERRO: Falha ao instalar node-firebird.
    echo  Execute node-firebird.bat como Administrador.
    echo.
    popd
    pause
    exit /b 1
)

:_mod_validar
popd
node -e "require('node-firebird')" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERRO: node-firebird instalado mas nao reconhecido nesta sessao.
    echo  Feche e reabra o terminal e tente novamente.
    echo.
    pause
    exit /b 1
)
echo  [OK] node-firebird pronto.
exit /b 0

:: -------------------------------------------------------
:verificar_node
where node >nul 2>&1
if %errorlevel% equ 0 exit /b 0

echo.
echo  Node.js nao encontrado. Instalando...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive ^
    -File "%~dp0_instalar-node.ps1"
if %errorlevel% neq 0 (
    echo.
    echo  ERRO: Falha na instalacao do Node.js.
    echo  Instale manualmente em: https://nodejs.org/en/download
    echo.
    pause
    exit /b 1
)
for /f "usebackq tokens=*" %%P in (
    `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')"`) do (
    set "PATH=%%P;%PATH%"
)
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERRO: Node.js instalado mas nao encontrado no PATH.
    echo  Feche e reabra o terminal e tente novamente.
    echo.
    pause
    exit /b 1
)
exit /b 0