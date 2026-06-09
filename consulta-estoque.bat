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

:: Verificar se o Node.js esta instalado
where node > nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERRO] Node.js nao encontrado no sistema.
    echo.
    echo  Baixe e instale em: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Verificar se o arquivo principal existe
if not exist "consulta-estoque.js" (
    echo  [ERRO] Arquivo consulta-estoque.js nao encontrado.
    echo  Certifique-se de que o .bat esta na mesma pasta que o .js
    echo.
    pause
    exit /b 1
)

:: Verificar se node-firebird esta instalado
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

:: Abrir navegador automaticamente apos 2 segundos
echo  Iniciando servidor...
echo  Acesse: http://localhost:7888
echo.
echo  Pressione Ctrl+C para encerrar.
echo.

:: Aguarda 2s e abre o navegador em background
start "" cmd /c "timeout /t 2 > nul && start http://localhost:7888"

:: Iniciar o servidor
node consulta-estoque.js

echo.
echo  Servidor encerrado.
pause