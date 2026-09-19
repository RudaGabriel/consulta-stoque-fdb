@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
:: ENCODING FIX: sem chcp 65001 os "echo" com acentuacao (a, e, c, etc.)
:: podem sair como caracteres corrompidos no console, dependendo da code
:: page padrao do Windows (comum em instalacoes em portugues do Brasil).
:: node-firebird.bat ja fazia isso; os demais .bat nao - padronizado agora.
chcp 65001 >nul 2>&1

:: =========================================================
::  Relatorio do Dia                                 v1.4.1
::  - Verifica / instala Node.js automaticamente
::  - Verifica / instala modulo node-firebird automaticamente
::  - Inicia servidor se necessario
::  - Abre relatorio de hoje no navegador
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

:: Verifica se o servidor ja esta rodando
powershell -NoProfile -Command "try{$t=New-Object Net.Sockets.TcpClient;$t.Connect('127.0.0.1',!PORTA!);$t.Close();exit 0}catch{exit 1}" >nul 2>&1
if %errorlevel% equ 0 goto :servidor_pronto

:: Servidor nao esta rodando - inicia
:: PRECISAO FIX (v1.4.0): verifica launcher.vbs ANTES de chamar. Sem esta
:: checagem, um launcher.vbs ausente ou renomeado fazia o wscript falhar
:: silenciosamente; o .bat entao esperava 30s por um servidor que nunca ia
:: subir e abria o navegador numa pagina morta, sem nenhuma pista do motivo.
:: Cenario real: este arquivo estava FALTANDO no projeto original.
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
echo Iniciando servidor de relatorios...
wscript.exe "%~dp0launcher.vbs"

:: Aguarda o servidor responder
call :aguardar_servidor

:servidor_pronto
start "" "http://localhost:!PORTA!"
exit /b 0

:: -------------------------------------------------------
:: Le porta e nome do app/loja de config.json (campos "porta" e "appName").
:: Fallback silencioso para 7734 / "Relatorios" se o arquivo nao existir,
:: estiver corrompido ou os campos nao estiverem definidos. Uma unica
:: chamada powershell busca os dois valores (evita abrir dois processos so'
:: para isso). !APP_TITULO! (expansao adiada, nao %APP_TITULO%) no "title"
:: abaixo de proposito: se o nome da loja algum dia contiver um caractere
:: especial de cmd.exe (& | < > ^), expansao imediata seria interpretada
:: pelo parser ANTES do "title" rodar - risco real de injecao de comando.
:: Expansao adiada so' substitui DEPOIS do parsing da linha, entao o valor
:: chega ao "title" como texto literal, inofensivo.
:: -------------------------------------------------------
:ler_config
:: ROBUSTEZ FIX: a versao anterior buscava porta+nome numa unica chamada
:: powershell, devolvendo os dois valores numa linha so' (delimitados por
:: "|") e separando com "for /f tokens=1,*". Essa forma combinada nunca foi
:: testada de verdade neste ambiente (sem cmd.exe disponivel para validar) -
:: voltado para duas chamadas simples e separadas, cada uma buscando UM
:: valor por vez, no mesmo formato ja comprovado que o restante do arquivo
:: usa (ver :verificar_node, abaixo, que atualiza o PATH da sessao com essa
:: mesma tecnica). Custa um processo powershell a mais, mas reduz risco.
set "PORTA=7734"
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "try{$p=(Get-Content '%~dp0config.json' -Raw -Encoding UTF8 | ConvertFrom-Json).porta; if($p -gt 0){[int]$p}else{7734}}catch{7734}" 2^>nul`) do set "PORTA=%%P"
set "APP_TITULO=Relatorios"
for /f "usebackq delims=" %%N in (`powershell -NoProfile -Command "try{$n=(Get-Content '%~dp0config.json' -Raw -Encoding UTF8 | ConvertFrom-Json).appName; if($n){$n}else{'Relatorios'}}catch{'Relatorios'}" 2^>nul`) do set "APP_TITULO=%%N"
title !APP_TITULO! - Relatorio do Dia
exit /b 0

:: -------------------------------------------------------
:aguardar_servidor
set "_t=0"
:_loop
set /a "_t+=1"
if %_t% gtr 15 exit /b 0
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "try{$t=New-Object Net.Sockets.TcpClient;$t.Connect('127.0.0.1',!PORTA!);$t.Close();exit 0}catch{exit 1}" >nul 2>&1
if %errorlevel% neq 0 goto :_loop
exit /b 0

:: -------------------------------------------------------
:: Verifica se node-firebird esta instalado.
:: Se nao estiver, executa npm install diretamente.
:: -------------------------------------------------------
:verificar_modulos
node -e "require('node-firebird')" >nul 2>&1
if %errorlevel% equ 0 exit /b 0

echo.
echo  Modulo node-firebird nao encontrado. Instalando...
echo.
pushd "%~dp0"

:: Tentativa silenciosa primeiro (ideal para uso em producao)
call npm install node-firebird --prefer-offline >nul 2>&1
if %errorlevel% equ 0 goto :_mod_validar

:: Se falhou (sem cache local), instala com saida visivel
call npm install node-firebird
if %errorlevel% neq 0 (
    echo.
    echo  ERRO: Falha ao instalar node-firebird.
    echo  Possiveis causas:
    echo    - Sem acesso a internet
    echo    - Permissao negada em node_modules
    echo  Solucao: execute node-firebird.bat como Administrador.
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
echo
exit /b 0

:: -------------------------------------------------------
:: Verifica se Node.js esta instalado; se nao, executa o instalador.
:: Atualiza o PATH da sessao atual apos instalar.
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
:: Atualiza PATH da sessao para encontrar o node recem instalado
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