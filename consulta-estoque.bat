@echo off
REM ===========================================================================
REM  consulta-estoque.bat
REM  @version 5.26.0
REM  @changelog
REM    5.26.0 - 2026-08-08 - Passa a rodar as verificacoes de integridade
REM      (node -c, validar-client.js e node --test) automaticamente antes de
REM      iniciar o servidor; se alguma falhar, avisa e pede confirmacao em vez
REM      de abortar. estoque-engine.js deixou de ser tratado como obrigatorio
REM      (o motor vai embutido no consulta-estoque.js; o arquivo solto so e
REM      usado pela suite de testes). Corrigido o uso de errorlevel dentro de
REM      blocos ( ), onde a variavel era expandida antes do comando rodar e
REM      falhas de verificacao passavam despercebidas.
REM ===========================================================================
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