@echo off
chcp 65001 > nul
title Consulta Estoque

cd /d "%~dp0"

echo.
echo  ================================================
echo   Consulta de Estoque
echo   Porta: 7888
echo  ================================================
echo.

REM ---------------------------------------------------------------------------
REM Verificar Node.js
REM ---------------------------------------------------------------------------
where node > nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERRO] Node.js nao encontrado no sistema.
    echo.
    echo  Baixe e instale em: https://nodejs.org
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

if not exist "estoque-engine.js" (
    echo  [ERRO] estoque-engine.js nao encontrado.
    echo  Este arquivo e obrigatorio, deve estar na mesma pasta que consulta-estoque.js
    echo.
    pause
    exit /b 1
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
    if %errorlevel% neq 0 (
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
REM Iniciar
REM ---------------------------------------------------------------------------
echo  Iniciando servidor...
echo  Acesse: http://localhost:7888
echo.
echo  Pressione Ctrl+C para encerrar.
echo.

REM Abre o navegador automaticamente apos 2 segundos
start "" cmd /c "timeout /t 2 > nul && start http://localhost:7888"

REM Inicia o servidor (bloqueia aqui ate Ctrl+C)
node consulta-estoque.js

echo.
echo  Servidor encerrado.
pause