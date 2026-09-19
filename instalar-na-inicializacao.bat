@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

:: ---------------------------------------------------------------------------
:: PASTA DO SCRIPT (v1.9.0)
:: "cd /d" nao aceita UNC (\\servidor\pasta) como diretorio atual. "pushd"
:: aceita: cria uma unidade temporaria automaticamente. Em caminho local se
:: comporta como cd.
:: ---------------------------------------------------------------------------
pushd "%~dp0" 2>nul
if errorlevel 1 (
    echo.
    echo ERRO: nao foi possivel acessar a pasta do script: %~dp0
    echo.
    pause
    exit /b 1
)

:: ---------------------------------------------------------------------------
:: LOG (v1.9.0) - mesmo relatorio.log do servidor e do tray, e agora no MESMO
:: formato deles: [DD-MM-AAAA] [HH:MM:SS]. Antes usava %DATE% %TIME% crus, que
:: saiam como "11/08/2026 13:49:19,17" - fora do padrao e com centesimos.
:: _LD: %DATE% pode vir como "11/08/2026" ou "qua, 11/08/2026" conforme o
:: Windows, entao pega os 10 ultimos caracteres e troca "/" por "-".
:: _LT: %TIME% vem "13:49:19,17" (e com espaco a esquerda antes das 10h);
:: troca espaco por zero e corta em 8 caracteres.
:: ---------------------------------------------------------------------------
:: LOG DE EMERGENCIA (v1.10.2): o log principal fica na pasta do script, que
:: pode estar numa unidade de rede inacessivel para a instancia ELEVADA --
:: exatamente o cenario que estamos diagnosticando. Nesse caso a falha nao
:: deixava rastro nenhum, mascarando a causa. Testa a gravacao: se a pasta
:: nao aceitar escrita, cai para %TEMP%, que sempre existe e e' local.
set "LOGF=%~dp0relatorio.log"
copy /y nul "%~dp0_wtest.tmp" >nul 2>&1
if exist "%~dp0_wtest.tmp" (del /f /q "%~dp0_wtest.tmp" >nul 2>&1) else (set "LOGF=%TEMP%\relatorio-install.log")
set "_LD=%DATE%"
set "_LD=!_LD:~-10!"
set "_LD=!_LD:/=-!"
set "_LT=%TIME: =0%"
set "_LT=!_LT:~0,8!"
set "LOGP=[!_LD!] [!_LT!] [INSTALL]"
>>"%LOGF%" echo !LOGP! === iniciado - usuario=%USERNAME% maquina=%COMPUTERNAME% pasta=%~dp0 ===

:: ---------------------------------------------------------------------------
:: AUTO-ELEVACAO (ajuste solicitado): varios passos deste script exigem
:: privilegios de Administrador (regra de firewall, schtasks em algumas
:: configuracoes de conta) - sem isso, esses passos falhavam com avisos
:: confusos, exigindo que o usuario soubesse de antemao que precisava clicar
:: em "Executar como administrador" antes mesmo de abrir o arquivo.
:: "net session" so' retorna sucesso quando ja elevado (truque classico e
:: confiavel para checar elevacao em batch, sem depender de nenhuma
:: ferramenta externa). Se nao estiver elevado, relanca este MESMO script
:: (%~f0 = caminho completo dele) via UAC e encerra a instancia atual - mas
:: so' encerra se a elevacao realmente abriu uma nova janela; se o usuario
:: cancelar o prompt do UAC ou ele estiver bloqueado por politica, continua
:: rodando sem privilegios (mesmo comportamento de fallback de antes).
:: ---------------------------------------------------------------------------
:: BUG FIX (v1.5.0): este comentario PRECISA ficar FORA do bloco "if (...)"
:: abaixo. Em batch, "::" nao e' comentario de verdade - e' um rotulo
:: malformado, e rotulo DENTRO de bloco entre parenteses quebra o parsing do
:: bloco inteiro, fazendo o cmd abortar e a janela fechar sozinha. Foi
:: exatamente o que a v1.4.0 causou ao colocar comentarios "::" dentro do
:: bloco de auto-elevacao. Dentro de blocos, use "rem" (nunca "::").
::
:: Sobre o escape abaixo: %~f0/%~dp0 vao para dentro de aspas simples do
:: PowerShell. Se o caminho tiver apostrofo (ex: "C:\Users\O'Brien\..."),
:: quebra a sintaxe gerada - por isso sao escapados dobrando as aspas,
:: mesma tecnica usada mais abaixo com NOVO_NOME/LAUNCHER_PATH.
net session >nul 2>&1
if %errorlevel% equ 0 goto :ja_elevado

echo Solicitando privilegios de Administrador...
set "_LT=%TIME: =0%"
set "_LT=!_LT:~0,8!"
>>"%LOGF%" echo [!_LD!] [!_LT!] [INSTALL] Nao elevado - solicitando UAC a partir de %~f0

:: CAUSA RAIZ do "eleva e fecha no ato" nas maquinas de rede: a pasta esta
:: numa unidade MAPEADA (ex: H:\outros\Relatorios). Mapeamentos sao por
:: sessao de logon e a elevacao cria OUTRA sessao, entao "H:" nao existe
:: para o Administrador -- a instancia elevada nao consegue nem LER o
:: proprio .bat e morre antes da primeira linha.
:: Solucao: descobrir o UNC real da unidade e elevar usando ELE.
:: BUG FIX (v1.10.1): este trecho estava DENTRO do bloco "if (...)" da
:: elevacao. Num bloco entre parenteses o cmd expande as variaveis de uma
:: vez so', entao o valor lido pelo "for /f" so' ficaria visivel no ciclo
:: seguinte -- UNCBASE chegava SEMPRE vazia e a conversao para UNC nunca
:: acontecia. O relatorio.log confirmou: a linha "Unidade mapeada ...
:: resolvida para UNC" nunca aparecia, mesmo com a pasta em H:.
:: Agora esta fora de qualquer bloco, onde a expansao e' imediata.
set "SELF_PATH=%~f0"
set "SELF_DIR=%~dp0"
set "UNCBASE="
:: BUG FIX (v1.10.2): a versao anterior usava -Filter com aspas DUPLAS
:: escapadas (\") dentro dos crases do for /f. Esse escape e' interpretado
:: de formas diferentes por cmd e powershell e o comando nao devolvia nada,
:: entao UNCBASE ficava vazia e a conversao para UNC nunca acontecia -- o
:: log confirmou (linha "Unidade mapeada ... resolvida" nunca aparecia).
:: Agora usa Where-Object com aspas SIMPLES apenas: sem aspas duplas
:: internas, nao ha o que escapar.
for /f "usebackq delims=" %%U in (`powershell -NoProfile -Command "(Get-CimInstance Win32_LogicalDisk ^| Where-Object DeviceID -eq '%~d0').ProviderName" 2^>nul`) do set "UNCBASE=%%U"

:: Metodo 2 (independente do PowerShell): "net use" lista as unidades de
:: rede e o UNC de cada uma. Roda so' se o metodo acima nao devolveu nada,
:: cobrindo maquinas com PowerShell restrito por politica. O token 2 e' a
:: letra e o 3 e' o caminho remoto na saida de "net use".
if defined UNCBASE goto :unc_ok
for /f "usebackq tokens=2,3" %%A in (`net use 2^>nul`) do if /i "%%A"=="%~d0" set "UNCBASE=%%B"
:unc_ok

if not defined UNCBASE goto :sem_unc
set "SELF_PATH=!UNCBASE!%~pnx0"
set "SELF_DIR=!UNCBASE!%~p0"
set "_LT=%TIME: =0%"
set "_LT=!_LT:~0,8!"
>>"%LOGF%" echo [!_LD!] [!_LT!] [INSTALL] Unidade mapeada %~d0 resolvida para UNC: !UNCBASE!
echo   Pasta em unidade de rede - elevando via UNC: !UNCBASE!
:sem_unc

set "SELF_PATH_PS=!SELF_PATH:'=''!"
set "SELF_DIR_PS=!SELF_DIR:'=''!"
powershell -NoProfile -Command "Start-Process -FilePath '!SELF_PATH_PS!' -WorkingDirectory '!SELF_DIR_PS!' -Verb RunAs" 2>nul
if errorlevel 1 goto :sem_elevacao
echo Uma nova janela elevada foi aberta - pode fechar esta.
set "_LT=%TIME: =0%"
set "_LT=!_LT:~0,8!"
>>"%LOGF%" echo [!_LD!] [!_LT!] [INSTALL] UAC aceito - instancia elevada aberta; encerrando esta.
exit /b 0

:sem_elevacao
echo.
echo AVISO: nao foi possivel elevar automaticamente ^(UAC cancelado ou
echo bloqueado por politica^). Continuando SEM Administrador - firewall
echo e/ou tarefa agendada podem falhar. Para evitar, clique com o botao
echo direito neste arquivo e escolha "Executar como administrador".
echo.
set "_LT=%TIME: =0%"
set "_LT=!_LT:~0,8!"
>>"%LOGF%" echo [!_LD!] [!_LT!] [INSTALL] AVISO: elevacao recusada/bloqueada - seguindo sem Administrador.
timeout /t 5 >nul

:ja_elevado

:: =========================================================
:: instalar-na-inicializacao.bat                       v1.11.0
:: Configura o servidor para iniciar automaticamente no logon.
::
:: CHANGELOG 1.11.0 - 2026-08-12 22:30 - bootstrap.vbs deixou de ser GERADO
::                                         e passou a ser COPIADO.
::  - Gerar o arquivo linha a linha com "echo" exigia escapar ( ) & < > e
::    conviver com as regras de expansao do cmd. Falhou de tres formas
::    diferentes em producao: bloco fechando cedo (arquivo pela metade e
::    codigo aparecendo na tela), BOM que o wscript recusa (800A0408) e
::    escapes vazando ("Erro de sintaxe" na linha 6, 800A03EA -- o erro
::    apontava o caractere 54 de uma linha que so' deveria ter 52).
::  - Agora bootstrap.vbs e' arquivo do projeto, versionado como qualquer
::    outro, e o instalador so' faz "copy". Copiar nao tem escape, nem
::    expansao, nem encoding a definir -- elimina a classe inteira de falhas.
::  - O caminho do launcher (unico dado dinamico) vai em "launcher.path",
::    arquivo texto de uma linha gravado com um echo simples ao lado do
::    bootstrap, que o le em tempo de execucao.
::  - Removido o bloco de fallback do CMD (21 linhas): era codigo morto que
::    reproduzia a mesma geracao fragil.
::  - launcher.path tambem e' apagado junto com o bootstrap antigo.
::  - NOVO ARQUIVO NECESSARIO: bootstrap.vbs deve estar na pasta do sistema.
:: =========================================================

echo.
echo =======================================================
echo   Configurar Inicializacao Automatica
echo =======================================================
echo.
echo Configura o servidor para iniciar automaticamente ao fazer login.
echo O bootstrap fica LOCAL na maquina e aguarda ate 30 min pelo
echo servidor na rede antes de lanca-lo.
echo.

:: ---------------------------------------------------------------------------
:: 1. Verifica / instala Node.js
:: ---------------------------------------------------------------------------
:verificar_node
node --version >nul 2>&1
if %errorlevel% equ 0 goto :node_ok

echo Node.js nao encontrado. Instalando silenciosamente...
echo (acompanhe em %TEMP%\relatorio_node_install.log)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive ^
    -File "%~dp0_instalar-node.ps1"

:: Atualiza PATH da sessao atual
for /f "usebackq tokens=*" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')"`) do (
    set "PATH=%%P;%PATH%"
)

node --version >nul 2>&1
if %errorlevel% equ 0 goto :node_ok

echo.
echo ERRO: Node.js nao foi instalado corretamente.
echo Verifique: %TEMP%\relatorio_node_install.log
echo Ou instale em: https://nodejs.org
echo.
pause
exit /b 1

:node_ok
for /f "tokens=*" %%V in ('node --version 2^>nul') do echo Node.js: %%V
echo.

:: ---------------------------------------------------------------------------
:: 2. Verifica / instala modulo node-firebird
:: ---------------------------------------------------------------------------
node -e "require('node-firebird')" >nul 2>&1
if %errorlevel% equ 0 goto :modulos_ok

echo Modulo node-firebird nao encontrado. Instalando...
pushd "%~dp0"

call npm install node-firebird --prefer-offline >nul 2>&1
if %errorlevel% neq 0 (
    call npm install node-firebird
    if !errorlevel! neq 0 (
        echo.
        echo ERRO: Falha ao instalar node-firebird.
        echo Execute node-firebird.bat como Administrador e tente novamente.
        echo.
        popd
        pause
        exit /b 1
    )
)
popd

node -e "require('node-firebird')" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ERRO: node-firebird instalado mas nao reconhecido nesta sessao.
    echo Feche e reabra o terminal e tente novamente.
    echo.
    pause
    exit /b 1
)
echo [OK] node-firebird pronto.
echo.

:modulos_ok

:: ---------------------------------------------------------------------------
:: 3. Le appName do config.json
:: ---------------------------------------------------------------------------
set "CFG=%~dp0config.json"
set "_TMP=%TEMP%\_relcfg_%RANDOM%.txt"
set "APP_NAME="

powershell -NoProfile -Command ^
    "try{(Get-Content '%CFG%' -Raw -Encoding UTF8 | ConvertFrom-Json).appName}catch{''}" ^
    > "!_TMP!" 2>nul
if exist "!_TMP!" ( set /p APP_NAME= < "!_TMP!" & del "!_TMP!" >nul 2>&1 )
set "APP_NAME=!APP_NAME: =!"

if not defined APP_NAME goto :pedir_nome
if "!APP_NAME!"=="" goto :pedir_nome
goto :nome_ok

:pedir_nome
echo Voce ainda nao configurou o nome do sistema.
echo Exemplos: Farmacia Central, Loja Silva, Mercado XYZ
echo.
set "NOVO_NOME="
set /p NOVO_NOME=Nome do sistema: 
if "!NOVO_NOME!"=="" set "NOVO_NOME=Relatorios"

:: BUG FIX (quebra silenciosa): NOVO_NOME e CFG sao embutidos dentro de
:: strings PowerShell delimitadas por aspas simples ($n = '...'). Nomes de
:: loja com apostrofo sao COMUNS ("Bob's Pet Shop", "D'Angelo Modas") e o
:: caminho do script pode estar sob um perfil de usuario com apostrofo
:: (ex: C:\Users\O'Brien\...) - sem escapar, a aspas simples fecha a string
:: PowerShell prematuramente, quebrando a sintaxe. O script gerado falhava
:: silenciosamente (stderr redirecionado para nul na linha de execucao
:: abaixo), e o config.json NUNCA era atualizado, sem nenhum aviso ao
:: usuario. Em PowerShell, uma aspa simples dentro de string de aspas
:: simples se escapa DOBRANDO-A (' vira '') - replicado aqui via
:: substituicao de variavel do proprio cmd.exe (!VAR:'=''!).
set "NOVO_NOME_PS=!NOVO_NOME:'=''!"
set "CFG_PS=!CFG:'=''!"

:: Salva appName no config.json via PowerShell (lida com BOM e JSON corrompido)
set "_TMPPS=%TEMP%\_relcfgwrite_%RANDOM%.ps1"
(
    echo $n = '!NOVO_NOME_PS!'
    echo $p = '!CFG_PS!'
    echo $o = @{}
    echo try{
    echo   $raw = [System.IO.File]::ReadAllText($p,[System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    echo   $o = $raw ^| ConvertFrom-Json ^| ForEach-Object{$h=@{};$_.PSObject.Properties^|ForEach-Object{$h[$_.Name]=$_.Value};$h}
    echo }catch{}
    echo $o['appName'] = $n
    echo if(-not $o.ContainsKey('porta')){$o['porta']=7734}
    echo [System.IO.File]::WriteAllText($p,($o^|ConvertTo-Json -Depth 10 -Compress),(New-Object System.Text.UTF8Encoding($false)))
) > "!_TMPPS!"
powershell -NoProfile -ExecutionPolicy Bypass -File "!_TMPPS!" 2>nul
if %errorlevel% neq 0 (
    echo.
    echo AVISO: nao foi possivel salvar o nome no config.json automaticamente.
    echo O sistema vai continuar com o nome "!NOVO_NOME!" apenas nesta sessao -
    echo edite config.json manualmente (campo "appName"^) se quiser persistir.
    echo.
)
del "!_TMPPS!" >nul 2>&1
set "APP_NAME=!NOVO_NOME!"
echo.

:nome_ok
title !APP_NAME! - Configurar Inicializacao Automatica
echo Sistema: !APP_NAME!
echo.

:: ---------------------------------------------------------------------------
:: 4. Gera o bootstrap LOCAL
::    O bootstrap aguarda o launcher.vbs ficar disponivel na rede (ate 30 min)
::    e entao o executa. Fica em %LOCALAPPDATA% - sempre acessivel sem rede.
:: ---------------------------------------------------------------------------
set "LAUNCHER_PATH=%~dp0launcher.vbs"
:: PRECISAO FIX (v1.4.0): avisa (sem abortar) se o launcher.vbs nao estiver
:: presente. Aqui NAO e' erro fatal de proposito: o bootstrap foi desenhado
:: para aguardar ate 30 min o launcher aparecer, justamente porque %~dp0
:: pode ser uma pasta de REDE ainda nao montada no momento da instalacao.
:: Mas se o arquivo simplesmente nao existe (instalacao incompleta - cenario
:: real, ele estava faltando no projeto original), o usuario terminaria a
:: instalacao achando que deu tudo certo e descobriria a falha so' no
:: proximo logon, esperando 30 min por algo que nunca vai aparecer.
if not exist "!LAUNCHER_PATH!" (
    echo.
    echo AVISO: launcher.vbs nao foi encontrado em:
    echo   !LAUNCHER_PATH!
    echo.
    echo Se essa pasta e' de REDE e ainda nao esta montada, pode ignorar -
    echo o bootstrap aguarda ate 30 min por ele no logon.
    echo Caso contrario, a instalacao esta incompleta e o servidor NAO vai
    echo iniciar automaticamente: copie o launcher.vbs para essa pasta.
    echo.
    timeout /t 8 >nul
)
set "TASK_NAME=!APP_NAME! - Relatorios"
set "BOOTSTRAP_DIR=%LOCALAPPDATA%\RelatoriosBootstrap"
set "BOOTSTRAP_FILE=!BOOTSTRAP_DIR!\bootstrap.vbs"

if not exist "!BOOTSTRAP_DIR!" md "!BOOTSTRAP_DIR!" >nul 2>&1

:: ---------------------------------------------------------------------------
:: LIMPEZA (v1.10.0) - remove o bootstrap anterior ANTES de gerar o novo.
:: Sem isso, um bootstrap.vbs invalido de uma execucao anterior podia
:: sobreviver: se a gravacao nova falhasse por qualquer motivo (permissao,
:: arquivo em uso, PowerShell bloqueado), a checagem "if not exist" mais
:: abaixo encontrava o arquivo VELHO e reportava "Bootstrap criado com
:: sucesso" -- mascarando a falha e mantendo em producao um arquivo quebrado.
:: Foi o que aconteceu com o bootstrap gravado com BOM (erro 800A0408): ele
:: continuava la depois da correcao, ate ser apagado na mao.
:: Apaga por NOME especifico, nunca a pasta inteira nem com curinga: a pasta
:: fica em %%LOCALAPPDATA%% e um "del *.*" ali seria destrutivo demais se a
:: variavel viesse vazia ou errada.
:: ---------------------------------------------------------------------------
if not exist "!BOOTSTRAP_FILE!" goto :bootstrap_limpo
del /f /q "!BOOTSTRAP_FILE!" >nul 2>&1
set "_LT=%TIME: =0%"
set "_LT=!_LT:~0,8!"
if exist "!BOOTSTRAP_FILE!" (
    echo.
    echo ERRO: nao foi possivel apagar o bootstrap anterior:
    echo   !BOOTSTRAP_FILE!
    echo O arquivo pode estar em uso. Feche o Windows Script Host
    echo ^(wscript.exe^) pelo Gerenciador de Tarefas e tente novamente.
    echo.
    >>"%LOGF%" echo [!_LD!] [!_LT!] [INSTALL] ERRO: bootstrap anterior nao pode ser apagado - arquivo em uso.
    pause
    exit /b 1
)
if exist "!BOOTSTRAP_DIR!\launcher.path" del /f /q "!BOOTSTRAP_DIR!\launcher.path" >nul 2>&1
>>"%LOGF%" echo [!_LD!] [!_LT!] [INSTALL] Bootstrap anterior removido antes de recriar.
echo Bootstrap anterior removido.
:bootstrap_limpo

echo Criando bootstrap local em:
echo   !BOOTSTRAP_FILE!
echo.

:: Gera bootstrap.vbs via PowerShell (aspas internas usam Chr(34))
:: BUG FIX: mesma classe de problema do appName acima - LAUNCHER_PATH e
:: BOOTSTRAP_FILE tambem sao caminhos de arquivo que podem conter apostrofo
:: (ex: perfil de usuario "C:\Users\O'Brien\..."), e sao embutidos em
:: strings PowerShell de aspas simples. Escapado da mesma forma.
:: ---------------------------------------------------------------------------
:: BOOTSTRAP (v1.11.0): COPIA o bootstrap.vbs do projeto em vez de gera-lo.
:: A geracao linha a linha por "echo" exigia escapar ( ) & < > e conviver
:: com as regras de expansao do cmd -- falhou de tres formas diferentes em
:: producao: bloco fechando cedo (arquivo pela metade), BOM que o wscript
:: recusa (800A0408) e escapes vazando (erro de sintaxe na linha 6,
:: 800A03EA). Copiar nao tem escape, nem expansao, nem encoding a definir.
:: O caminho do launcher vai num arquivo texto de uma linha ao lado --
:: unico dado dinamico, gravado com um echo simples e sem escape.
:: ---------------------------------------------------------------------------
if not exist "%~dp0bootstrap.vbs" (
    echo.
    echo ERRO: bootstrap.vbs nao encontrado em:
    echo   %~dp0
    echo Verifique se a pasta do sistema esta completa.
    echo.
    pause
    exit /b 1
)

copy /y "%~dp0bootstrap.vbs" "!BOOTSTRAP_FILE!" >nul 2>&1
if not exist "!BOOTSTRAP_FILE!" goto :bootstrap_falhou

:: Grava o caminho do launcher (unica informacao dinamica do bootstrap).
>"!BOOTSTRAP_DIR!\launcher.path" echo !LAUNCHER_PATH!
if not exist "!BOOTSTRAP_DIR!\launcher.path" goto :bootstrap_falhou

set "_LT=%TIME: =0%"
set "_LT=!_LT:~0,8!"
>>"%LOGF%" echo [!_LD!] [!_LT!] [INSTALL] Bootstrap copiado e launcher.path gravado.
echo Bootstrap criado com sucesso.
goto :bootstrap_ok

:bootstrap_falhou
echo.
echo ERRO: falha ao criar o bootstrap em:
echo   !BOOTSTRAP_DIR!
echo Verifique permissoes de escrita nessa pasta.
echo.
set "_LT=%TIME: =0%"
set "_LT=!_LT:~0,8!"
>>"%LOGF%" echo [!_LD!] [!_LT!] [INSTALL] ERRO: falha ao criar bootstrap/launcher.path.
pause
exit /b 1

:bootstrap_ok


:bootstrap_ok
if not exist "!BOOTSTRAP_FILE!" (
    echo ERRO: Nao foi possivel criar o bootstrap local.
    echo Verifique permissoes em: !BOOTSTRAP_DIR!
    pause
    exit /b 1
)
echo Bootstrap criado com sucesso.
echo.

:: ---------------------------------------------------------------------------
:: 5. Registra tarefa agendada apontando para o BOOTSTRAP LOCAL
::    - Nunca falha com "arquivo nao encontrado" (bootstrap e local)
::    - O delay de 2 min da tempo ao Windows de montar drives de rede
:: ---------------------------------------------------------------------------
schtasks /delete /tn "!TASK_NAME!" /f >nul 2>&1

schtasks /create /tn "!TASK_NAME!" ^
    /tr "wscript.exe \"!BOOTSTRAP_FILE!\"" ^
    /sc ONLOGON /ru "%USERNAME%" /rl LIMITED /delay 0002:00 /f >nul 2>&1

if %errorlevel% equ 0 (
    echo =======================================================
    echo   Sucesso^^!
    echo =======================================================
    echo.
    echo   Cadeia de inicializacao:
    echo     1. Tarefa agendada ONLOGON + delay 2 min
    echo     2. bootstrap.vbs LOCAL aguarda ate 30 min pelo launcher.vbs na rede
    echo     3. launcher.vbs lanca iniciar-tray.ps1 ^(oculto^)
    echo     4. iniciar-tray.ps1 aguarda ate 30 min pelo servidor-relatorio.js
    echo     5. servidor-relatorio.js aguarda ate 30 min pelo banco Firebird
    echo.
    echo   Bootstrap local ^(tarefa aponta aqui^):
    echo     !BOOTSTRAP_FILE!
    echo.
    echo   Launcher na rede ^(bootstrap espera este^):
    echo     !LAUNCHER_PATH!
    echo.
    echo   Para remover:
    echo     schtasks /delete /tn "!TASK_NAME!" /f
    echo.
    goto :iniciar_agora
)

:: Fallback: atalho na pasta Startup
echo  schtasks falhou. Usando pasta de Inicializacao como fallback...
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=!STARTUP!\!APP_NAME! Relatorios.vbs"

rem LIMPEZA (v1.10.0): remove o atalho anterior antes de recriar, pelo mesmo
rem motivo do bootstrap - um atalho velho apontando para um caminho antigo
rem sobreviveria a uma gravacao que falhasse, e a checagem "if exist" logo
rem abaixo confirmaria sucesso olhando para o arquivo ERRADO.
if exist "!SHORTCUT!" del /f /q "!SHORTCUT!" >nul 2>&1

(
    echo Dim sh
    echo Set sh = CreateObject^("WScript.Shell"^)
    echo sh.Run "wscript.exe " ^& Chr^(34^) ^& "!BOOTSTRAP_FILE!" ^& Chr^(34^), 0, False
) > "!SHORTCUT!"

if exist "!SHORTCUT!" (
    echo   Atalho criado em:
    echo     !SHORTCUT!
    echo.
) else (
    echo ERRO: Nao foi possivel configurar a inicializacao automatica.
    echo Tente executar como Administrador.
    pause
    exit /b 1
)

:iniciar_agora
:: BUG FIX (v1.6.0): este bloco ficava ANTES do label :iniciar_agora, e a
:: linha "goto :iniciar_agora" do caminho de sucesso do schtasks pulava por
:: cima dele. Ou seja: quando a tarefa agendada era criada com sucesso -- o
:: caminho NORMAL -- o firewall nunca era configurado. Movido para dentro do
:: label, garantindo que os dois caminhos (schtasks e fallback) passem aqui.
:: ---------------------------------------------------------------------------
:: 6. Libera a porta do servidor no Firewall do Windows
::    Sem isso, outros computadores da rede local nao conseguem abrir o
::    relatorio nem falar com a API (api.ps1) apos qualquer atualizacao do
::    Windows que reative o firewall ou reclassifique a rede como "Publica"
::    (perfil mais restritivo por padrao) - regra recriada em TODOS os
::    perfis de rede (privada, dominio, publica) de proposito, para nunca
::    depender de qual perfil o Windows decidiu usar desta vez.
:: ---------------------------------------------------------------------------
set "PORTA=7734"
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "try{$p=(Get-Content '%~dp0config.json' -Raw -Encoding UTF8 | ConvertFrom-Json).porta; if($p -gt 0){[int]$p}else{7734}}catch{7734}" 2^>nul`) do set "PORTA=%%P"

echo Liberando porta !PORTA! no Firewall do Windows...
set "FW_NOME=!APP_NAME! - Relatorios (porta !PORTA!)"
netsh advfirewall firewall delete rule name="!FW_NOME!" >nul 2>&1
netsh advfirewall firewall add rule name="!FW_NOME!" dir=in action=allow protocol=TCP localport=!PORTA! profile=any >nul 2>&1
if %errorlevel% equ 0 (
    echo   [OK] Porta !PORTA! liberada em todos os perfis de rede.
    set "_LT=%TIME: =0%"
    set "_LT=!_LT:~0,8!"
    >>"%LOGF%" echo [!_LD!] [!_LT!] [INSTALL] Firewall: porta !PORTA! liberada em todos os perfis.
) else (
    echo   [AVISO] Nao foi possivel configurar o firewall automaticamente
    echo   ^(normalmente exige execucao como Administrador^). Outros
    echo   computadores da rede podem nao conseguir acessar o relatorio ate
    echo   isso ser resolvido. Para liberar manualmente, execute como
    echo   Administrador:
    echo     netsh advfirewall firewall add rule name="!FW_NOME!" dir=in action=allow protocol=TCP localport=!PORTA! profile=any
)
echo.

set "_LT=%TIME: =0%"
set "_LT=!_LT:~0,8!"
>>"%LOGF%" echo [!_LD!] [!_LT!] [INSTALL] Instalacao concluida - iniciando servidor via launcher.
echo Iniciando servidor agora...
wscript.exe "!LAUNCHER_PATH!"
echo.
echo Pronto^^! O icone aparecera na bandeja em instantes.
echo.
pause
exit /b 0

