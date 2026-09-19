@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
chcp 65001 >nul 2>&1

:: =========================================================
::  node-firebird.bat                                  v1.1.1
::  - Verifica / instala Node.js automaticamente
::  - Instala o modulo node-firebird via npm
::  - Pula instalacao se modulo ja estiver presente
::  - Tratamento robusto de erros e atualizacao de PATH
::
::  CHANGELOG 1.1.1 - 2026-08-08 05:10 - Quebras de linha convertidas para
::   CRLF, a convencao correta do Windows. Estes arquivos estavam com LF
::   puro; funcionavam porque so' usam "goto", mas "call :label" quebra
::   nesse formato (ver instalar-na-inicializacao.bat v1.8.1). Padronizado
::   em todo o projeto para evitar a armadilha em edicoes futuras.
::   Se for editar, use um editor que preserve CRLF.

set "APP_TITULO=Relatorios"
for /f "usebackq delims=" %%N in (`powershell -NoProfile -Command "try{$n=(Get-Content '%~dp0config.json' -Raw -Encoding UTF8 | ConvertFrom-Json).appName; if($n){$n}else{'Relatorios'}}catch{'Relatorios'}" 2^>nul`) do set "APP_TITULO=%%N"
title !APP_TITULO! - Instalador Node-Firebird

echo.
echo  [INFO] Verificando ambiente Node.js...
echo.

call :verificar_node
if %errorlevel% neq 0 (
    echo  [ERRO CRITICO] Falha ao preparar ambiente Node.js.
    pause
    exit /b 1
)

:: =========================================================
:: EXIBIR VERSOES CONFIRMADAS
:: =========================================================
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
for /f "tokens=*" %%v in ('npm -v 2^>nul') do set "NPM_VER=%%v"

echo  [OK] Node.js: %NODE_VER%
echo  [OK] NPM: %NPM_VER%
echo.

:: =========================================================
:: VERIFICA SE JA ESTA INSTALADO
:: =========================================================
node -e "require('node-firebird')" >nul 2>&1
if %errorlevel% equ 0 (
    echo  [OK] Modulo node-firebird ja esta instalado.
    echo.
    pause
    exit /b 0
)

:: =========================================================
:: INSTALAR MODULO node-firebird
:: =========================================================
echo  [INFO] Instalando modulo node-firebird...
echo.

:: Tenta com cache local primeiro (mais rapido, sem internet)
call npm install node-firebird --prefer-offline >nul 2>&1
if %errorlevel% equ 0 goto :validar_modulo

:: Fallback: instalacao completa com saida visivel para diagnostico
echo  [INFO] Cache local indisponivel. Baixando da internet...
call npm install node-firebird
if %errorlevel% neq 0 (
    echo.
    echo  [ERRO] Falha ao instalar node-firebird.
    echo  Possiveis causas:
    echo   - Sem conexao com a internet
    echo   - Proxy corporativo nao configurado
    echo   - Permissao de escrita negada em node_modules
    echo.
    echo  Solucoes:
    echo   1. Execute este arquivo como Administrador
    echo   2. Execute manualmente: npm install node-firebird
    echo   3. Configure o proxy: npm config set proxy http://seu-proxy:porta
    echo.
    pause
    exit /b 1
)

:validar_modulo
node -e "require('node-firebird')" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  [ERRO] node-firebird instalado mas nao reconhecido nesta sessao.
    echo  Feche este terminal, abra um novo e tente novamente.
    echo.
    pause
    exit /b 1
)

echo.
echo  [OK] node-firebird instalado e validado com sucesso.
echo.
pause
exit /b 0

:: -------------------------------------------------------
:: SUB-ROTINA: VERIFICAR E INSTALAR NODE.JS
:: -------------------------------------------------------
:verificar_node
where node >nul 2>&1
if %errorlevel% equ 0 exit /b 0

echo  [AVISO] Node.js nao detectado no PATH.
echo  [INFO] Iniciando instalacao silenciosa via _instalar-node.ps1...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive ^
-File "%~dp0_instalar-node.ps1"

if %errorlevel% neq 0 (
    echo.
    echo  [ERRO] Instalacao do Node.js falhou.
    echo  [INFO] Alternativa manual: https://nodejs.org/en/download
    echo.
    pause
    exit /b 1
)

:: Atualiza PATH da sessao atual com valor do PATH do sistema
for /f "usebackq tokens=*" %%P in (
    `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')"`
) do (
    set "PATH=%%P;%PATH%"
)

:: Validacao pos-instalacao
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  [ERRO] Node.js instalado mas nao reconhecido nesta sessao.
    echo  [INFO] Feche este terminal, abra um novo e execute novamente.
    echo.
    pause
    exit /b 1
)

exit /b 0