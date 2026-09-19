<#
.SYNOPSIS
Cliente CLI robusto para servidor-relatorio.js
.DESCRIPTION
Interface PowerShell para interacao com API do servidor de relatorios.
- IP manual via parametro ou prompt interativo
- Retry exponencial e tratamento rigoroso de erros
- Menu interativo + modo direto para scripting
- Contem APENAS endpoints implementados no backend atual
.REQUIREMENTS
PowerShell 5.1+ ou 7+ | Salvar como UTF-8 sem BOM
@version 1.3.1
@changelog
  1.3.1 - 2026-08-12 21:30 - Revisao no eixo precisao (etapa 5/6).
    - upload-favicon: validava so' a existencia do caminho e ja chamava
      ReadAllBytes, que le o arquivo INTEIRO de uma vez. Apontar por engano
      para um video ou ISO travaria a maquina tentando alocar tudo em RAM.
      Agora confere antes: nao pode ser pasta, nao pode estar vazio, tem que
      caber no limite de 2 MB do servidor e a extensao precisa ser PNG/ICO/
      JPG. A validacao real continua no servidor (bytes magicos); esta e' um
      aviso amigavel e uma protecao contra upload longo fadado a falhar.
    - navigate-periodo: qualquer texto era interpolado direto na URL. Erro de
      digitacao so' viraria erro no servidor, com mensagem generica, e um
      valor com barra ou ".." alteraria o caminho da requisicao. Agora exige
      AAAA-MM-DD, confirma que a data existe no calendario e que a inicial
      nao e' posterior a final.
#>
[CmdletBinding()]
param(
    [string]$ConfigPath = "$PSScriptRoot\config.json",
    [ValidateSet("status","db-status","sse-clients","proibidos","config","salvar-fdb","abrir-picker","navigate-hoje","navigate-config","navigate-fdb","navigate-periodo","upload-favicon","restart","pronto","log-error","sse-test","menu")]
    [string]$Endpoint = "menu",
    [object]$Payload,
    [string]$MaquinaIP = $null
)

# ===========================================================================
# 1. CARREGAMENTO SEGURO DE CONFIG
# ===========================================================================
function Get-ConfigSegura {
    param([string]$Path)
    if (-not (Test-Path $Path)) { throw "ERRO: config.json nao encontrado em '${Path}'" }
    try {
        $raw = Get-Content $Path -Raw -Encoding UTF8
        $cfg = $raw | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $cfg.porta) { throw "config.json invalido: falta 'porta'" }
        return $cfg
    } catch { throw "Falha ao parsear config.json: $($_.Exception.Message)" }
}

$Config = Get-ConfigSegura -Path $ConfigPath

# TITULO FIX (ajuste solicitado): sem isso, a janela ficava com o titulo
# generico "Windows PowerShell" - nao dava para saber, so olhando a barra de
# tarefas, que aquela janela era o cliente CLI de relatorios da loja. Nunca
# derruba o script se falhar (ex: config.json sem appName) - titulo e so
# cosmetico, nao pode impedir o uso da ferramenta.
try {
    $__appName = if ($Config.appName) { $Config.appName } else { "Relatorios" }
    $host.UI.RawUI.WindowTitle = "$__appName - Cliente API"
} catch {}


# ===========================================================================
# 2. DEFINICAO DO IP (Parametro > Config > Prompt)
# ===========================================================================
$IpDefinido = $null
if (-not [string]::IsNullOrWhiteSpace($MaquinaIP)) {
    $IpDefinido = $MaquinaIP.Trim()
    Write-Host "[CONFIG] IP via parametro: ${IpDefinido}" -ForegroundColor DarkGray
} elseif ($null -ne $Config.maquinaIP -and -not [string]::IsNullOrWhiteSpace($Config.maquinaIP)) {
    $IpDefinido = $Config.maquinaIP.Trim()
    Write-Host "[CONFIG] IP do config.json: ${IpDefinido}" -ForegroundColor DarkGray
} else {
    Write-Host "[CONFIG] IP nao definido. Solicitando manualmente..." -ForegroundColor Yellow
    $IpDefinido = Read-Host "Informe o IP do servidor (ex: 192.168.1.50 ou localhost)"
    if ([string]::IsNullOrWhiteSpace($IpDefinido)) { throw "ERRO: IP nao informado." }
}

if ($IpDefinido -notmatch "^[a-zA-Z0-9.\-_:]+$") {
    Write-Warning "Formato atipico: '${IpDefinido}'. Tentando conexao..."
}

$BaseUri = "http://${IpDefinido}:$($Config.porta)"

# Anuncia a sessao no relatorio.log do SERVIDOR (v1.3.0). Feito via
# /api/log-error de proposito: e' a unica rota que ja aceita texto livre do
# cliente, e assim o registro cai no MESMO arquivo do servidor/tray/instalador,
# em vez de num log separado nesta maquina (que ninguem iria consultar).
# Best-effort: se o servidor estiver fora do ar, o menu abre normalmente -- o
# proprio uso do cliente e' o que vai revelar isso ao usuario.
try {
    $__corpoSessao = @{
        msg = "[API-CLIENTE] Sessao iniciada por $env:USERNAME em $env:COMPUTERNAME"
        src = "api.ps1"
    } | ConvertTo-Json -Compress
    Invoke-WebRequest -Uri "$BaseUri/api/log-error" -Method POST -Body $__corpoSessao `
        -ContentType "application/json" -Headers @{ "X-Cliente" = "$env:COMPUTERNAME/$env:USERNAME" } `
        -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop | Out-Null
} catch {}
Write-Host "[CONFIG] Servidor ativo: ${BaseUri}" -ForegroundColor Cyan

# ===========================================================================
# 3. ENGINE HTTP COM RETRY EXPONENCIAL
# ===========================================================================
function Invoke-ApiCall {
    param(
        [Parameter(Mandatory=$true)][string]$Rota,
        [string]$Metodo = "GET",
        [object]$Corpo,
        [string]$ContentType = "application/json; charset=utf-8",
        [int]$Timeout = 10,
        [int]$MaxRetries = 2
    )
    $uri = "${BaseUri}${Rota}"
    $tentativa = 0
    $ultimoErro = ""
    while ($tentativa -le $MaxRetries) {
        try {
            $params = @{
                Uri = $uri
                Method = $Metodo
                UseBasicParsing = $true
                TimeoutSec = $Timeout
                # X-Cliente (v1.3.0): identifica a maquina de origem no log do
                # servidor. Sem ele o relatorio.log so' mostraria o IP, que muda
                # com DHCP e nao diz de qual computador da loja veio o comando.
                Headers = @{ "Accept" = "application/json"; "X-Cliente" = "$env:COMPUTERNAME/$env:USERNAME" }
                ErrorAction = "Stop"
            }
            if ($Metodo -ne "GET" -and $null -ne $Corpo) {
                $params["Body"] = $Corpo
                $params["ContentType"] = $ContentType
            }
            $res = Invoke-WebRequest @params
            if ($res.StatusCode -ge 200 -and $res.StatusCode -lt 300) {
                if ([string]::IsNullOrWhiteSpace($res.Content)) { return $null }
                try { return $res.Content | ConvertFrom-Json -ErrorAction Stop }
                catch { return $res.Content }
            } else {
                $ultimoErro = "HTTP $($res.StatusCode) - $($res.StatusDescription)"
            }
        } catch [System.Net.WebException] {
            $ultimoErro = "Falha de rede: $($_.Exception.Message)"
        } catch {
            $ultimoErro = "Erro: $($_.Exception.Message)"
        }
        $tentativa++
        if ($tentativa -le $MaxRetries) {
            $delay = [math]::Pow(2, $tentativa) * 500
            Write-Warning "[RETRY ${tentativa}/${MaxRetries}] ${ultimoErro} | Aguardando $($delay/1000)s..."
            Start-Sleep -Milliseconds $delay
        }
    }
    throw "FALHA CRITICA apos ${MaxRetries} tentativas. Ultimo erro: ${ultimoErro}"
}

# ===========================================================================
# 3.1 NORMALIZACAO DE PAYLOAD
# ===========================================================================
# BUG FIX: -Payload aceitava apenas [hashtable] nos endpoints "config" e
# "log-error" (.ContainsKey / -isnot [hashtable]). Quando o parametro e
# fornecido via linha de comando com um objeto vindo de ConvertFrom-Json
# (uso comum em scripting: -Payload (Get-Content x.json | ConvertFrom-Json)),
# o resultado e um [PSCustomObject], que nao tem .ContainsKey() e nao passa
# no teste -isnot [hashtable] - o comando falhava com erro pouco claro.
# Esta funcao aceita hashtable, PSCustomObject ou $null e sempre devolve uma
# [hashtable] (ou $null), permitindo os dois estilos de chamada.
function ConvertTo-HashtableSegura {
    param([object]$Objeto)
    if ($null -eq $Objeto) { return $null }
    if ($Objeto -is [hashtable]) { return $Objeto }
    if ($Objeto -is [System.Collections.IDictionary]) { return $Objeto }
    if ($Objeto -is [pscustomobject]) {
        $h = @{}
        foreach ($p in $Objeto.PSObject.Properties) { $h[$p.Name] = $p.Value }
        return $h
    }
    throw "Payload em formato nao suportado: $($Objeto.GetType().FullName). Use hashtable (@{...}) ou objeto JSON."
}

# ===========================================================================
# 4. EXECUCAO DE ENDPOINTS (VALIDADOS NO BACKEND)
# ===========================================================================
function Executar-Endpoint {
    param([string]$Ep, [object]$Data)
    switch ($Ep) {
        "status" { return Invoke-ApiCall -Rota "/api/status" }
        "db-status" { return Invoke-ApiCall -Rota "/api/db-status" }
        "sse-clients" { return Invoke-ApiCall -Rota "/api/sse-clients" }
        "proibidos" {
            # BUG FIX: a checagem antiga "if ($Data)" tratava um array VAZIO
            # (@()) como "nao informado" - PowerShell avalia @() como $false
            # em contexto booleano. Resultado: enviar uma lista vazia (para
            # LIMPAR os proibidos) silenciosamente virava um GET, sem nunca
            # limpar nada e sem nenhum erro visivel ao usuario.
            # "$null -ne $Data" distingue corretamente "parametro omitido"
            # (Data = $null) de "array vazio fornecido de proposito".
            if ($null -ne $Data) {
                if ($Data -isnot [array]) { throw "Payload deve ser array de strings" }
                return Invoke-ApiCall -Rota "/api/proibidos" -Metodo POST -Corpo (@($Data) | ConvertTo-Json -Compress)
            }
            return Invoke-ApiCall -Rota "/api/proibidos"
        }
        "config" {
            if ($null -ne $Data) {
                $Data = ConvertTo-HashtableSegura -Objeto $Data
                $valido = @{}
                if ($Data.ContainsKey("appName")) { $valido["appName"] = $Data.appName }
                if ($Data.ContainsKey("pollInterval")) { $valido["pollInterval"] = [int]$Data.pollInterval }
                if ($Data.ContainsKey("maxLogLines")) { $valido["maxLogLines"] = [int]$Data.maxLogLines }
                if ($Data.ContainsKey("proibidos")) { $valido["proibidos"] = $Data.proibidos }
                if ($Data.ContainsKey("favicon")) { $valido["favicon"] = $Data.favicon }
                if ($valido.Count -eq 0) { throw "Nenhum campo valido informado no Payload (aceitos: appName, pollInterval, maxLogLines, proibidos, favicon)." }
                return Invoke-ApiCall -Rota "/api/config" -Metodo POST -Corpo ($valido | ConvertTo-Json -Compress)
            }
            return Invoke-ApiCall -Rota "/api/config"
        }
        "salvar-fdb" {
            if ($Data -isnot [string] -or [string]::IsNullOrWhiteSpace($Data)) { throw "Informe caminho do .fdb" }
            if (-not $Data.EndsWith(".fdb", [StringComparison]::OrdinalIgnoreCase)) { throw "Caminho deve terminar com .fdb" }
            return Invoke-ApiCall -Rota "/api/salvar-fdb" -Metodo POST -Corpo (@{caminho=$Data} | ConvertTo-Json -Compress)
        }
        "abrir-picker" { return Invoke-ApiCall -Rota "/api/abrir-picker-fdb" }
        "navigate-hoje" { return Invoke-ApiCall -Rota "/api/navigate/hoje" }
        "navigate-config" { return Invoke-ApiCall -Rota "/api/navigate/config" }
        "navigate-fdb" { return Invoke-ApiCall -Rota "/api/navigate/selecionar-fdb" }
        "navigate-periodo" {
            if ($Data -isnot [array] -or $Data.Count -ne 2) { throw "Informe 2 datas: @('YYYY-MM-DD','YYYY-MM-DD')" }
            $d1 = $Data[0] -replace '/','-'; $d2 = $Data[1] -replace '/','-'
            # PRECISAO FIX (v1.3.1): valida o formato ANTES de montar a URL. Antes,
            # qualquer texto era interpolado direto na rota -- um erro de digitacao
            # so' viraria erro la' no servidor, com mensagem generica, e um valor
            # com barra ou ".." alteraria o caminho da requisicao.
            foreach ($__d in @($d1, $d2)) {
                if ($__d -notmatch '^\d{4}-\d{2}-\d{2}$') {
                    throw "Data invalida: '$__d'. Use o formato AAAA-MM-DD (ex: 2026-08-12)."
                }
                $__dt = [datetime]::MinValue
                if (-not [datetime]::TryParseExact($__d, 'yyyy-MM-dd', $null, [Globalization.DateTimeStyles]::None, [ref]$__dt)) {
                    throw "Data inexistente no calendario: '$__d'."
                }
            }
            if ([datetime]::ParseExact($d1,'yyyy-MM-dd',$null) -gt [datetime]::ParseExact($d2,'yyyy-MM-dd',$null)) {
                throw "A data inicial ($d1) e posterior a final ($d2)."
            }
            return Invoke-ApiCall -Rota "/api/navigate/periodo/${d1}/${d2}"
        }
        "upload-favicon" {
            if ($Data -isnot [string] -or -not (Test-Path $Data)) { throw "Caminho de imagem invalido" }
            # PRECISAO FIX (v1.3.1): valida ANTES de carregar o arquivo na memoria.
            # ReadAllBytes le o arquivo INTEIRO de uma vez: apontar por engano para
            # um video ou ISO travaria a maquina tentando alocar tudo em RAM. O
            # servidor tem limite de 2MB para favicon, entao checar aqui evita
            # tambem um upload longo que seria rejeitado no fim.
            $__fi = Get-Item -LiteralPath $Data -ErrorAction Stop
            if ($__fi.PSIsContainer) { throw "O caminho informado e uma pasta, nao um arquivo de imagem." }
            if ($__fi.Length -eq 0)  { throw "Arquivo de imagem vazio: $Data" }
            if ($__fi.Length -gt 2MB) {
                throw ("Imagem muito grande ({0:N1} MB). O limite do servidor e 2 MB." -f ($__fi.Length / 1MB))
            }
            # Extensao conferida contra os formatos que o servidor aceita. E' so'
            # uma checagem previa amigavel -- o servidor valida os bytes magicos
            # do arquivo, que e' a verificacao que realmente vale.
            if ($__fi.Extension -notmatch '^\.(png|ico|jpe?g)$') {
                throw "Formato nao suportado ($($__fi.Extension)). Use PNG, ICO ou JPG."
            }
            $bytes = [System.IO.File]::ReadAllBytes($Data)
            return Invoke-ApiCall -Rota "/api/upload-favicon" -Metodo POST -ContentType "application/octet-stream" -Corpo $bytes
        }
        "restart" {
            Write-Warning "Solicitando restart do servidor..."
            # ROBUSTEZ FIX (usuario reportou "restart" falhando com "Impossivel
            # conectar-se ao servidor remoto"): /api/restart so' funciona se o
            # servidor JA estiver rodando - o handler responde primeiro e SO'
            # DEPOIS se desliga sozinho (1.4s depois, para o tray reiniciar).
            # Uma falha de conexao logo na PRIMEIRA tentativa (antes de
            # qualquer retry) significa que nao havia nada escutando naquela
            # porta - ou seja, o servidor ja estava fora do ar por outro
            # motivo, e nao existe nada para "reiniciar". O erro de rede
            # generico nao deixava isso claro. Agora detecta esse caso
            # especifico e tenta subir o servidor do zero via launcher.vbs
            # (mesmo caminho que os .bat de relatorio usam para iniciar o
            # servidor quando ele nao esta rodando), confirmando o resultado
            # antes de reportar sucesso ou falha.
            try {
                return Invoke-ApiCall -Rota "/api/restart"
            } catch {
                # ROBUSTEZ FIX (v1.2.3): "Falha de rede" e' o rotulo generico que
                # Invoke-ApiCall poe em QUALQUER excecao do WebRequest - inclusive
                # respostas HTTP de erro como 403. Tratar 403 como "servidor fora
                # do ar" era errado no sentido mais perigoso possivel: um 403 so'
                # existe porque o servidor ESTA VIVO e respondeu. O fallback
                # entao chamava o launcher.vbs para "subir" um servidor que ja
                # estava rodando. Agora so' cai no fallback quando a conexao
                # realmente nao se estabeleceu (recusada/timeout/host inacessivel);
                # qualquer resposta HTTP do servidor e' repassada como erro real.
                $_msgErro = $_.Exception.Message
                $_respondeuHttp = ($_msgErro -match "\(\d{3}\)") -or ($_msgErro -match "HTTP \d{3}")
                if ($_respondeuHttp) {
                    if ($_msgErro -match "403") {
                        throw ("Restart negado pelo servidor (403). O servidor esta no ar, mas so' aceita " +
                               "restart de si mesmo ou da maquina registrada em 'maquinaIP' no config.json. " +
                               "Rode o api.ps1 na propria maquina do servidor, ou atualize " +
                               "servidor-relatorio.js para v2.7.8+, que passou a aceitar tambem a rede local.")
                    }
                    throw $_msgErro
                }
                if ($_msgErro -notmatch "Falha de rede") { throw }
                Write-Warning "Servidor nao respondeu - ja estava fora do ar (isso e' um START do zero, nao um restart de verdade)."
                $launcherPath = Join-Path $PSScriptRoot "launcher.vbs"
                if (-not (Test-Path $launcherPath)) {
                    throw "Servidor fora do ar e launcher.vbs nao foi encontrado em '$PSScriptRoot' para tentar iniciar automaticamente. Inicie manualmente (ex: gerar_relatorio_do_dia.bat) ou verifique relatorio.log."
                }
                Write-Warning "Iniciando servidor via launcher.vbs..."
                try {
                    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$launcherPath`"" -WindowStyle Hidden -ErrorAction Stop
                } catch {
                    throw "Falha ao executar launcher.vbs: $($_.Exception.Message)"
                }
                Write-Warning "Aguardando o servidor responder (ate 30s)..."
                for ($i = 0; $i -lt 15; $i++) {
                    Start-Sleep -Seconds 2
                    try {
                        $chk = Invoke-WebRequest -Uri "${BaseUri}/api/status" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
                        if ($chk.StatusCode -ge 200 -and $chk.StatusCode -lt 300) {
                            Write-Host "[OK] Servidor iniciado e respondendo." -ForegroundColor Green
                            return @{ ok = $true; msg = "Servidor nao estava rodando - iniciado do zero via launcher.vbs." }
                        }
                    } catch {}
                }
                throw "launcher.vbs foi executado mas o servidor nao respondeu em 30s. Verifique relatorio.log na pasta do sistema (pode ser Node.js ausente ou Firebird inacessivel)."
            }
        }
        "pronto" {
            if ($Data -isnot [string]) { throw "Informe chave de polling" }
            $escaped = [System.Uri]::EscapeDataString($Data)
            return Invoke-ApiCall -Rota "/pronto?k=${escaped}"
        }
        "log-error" {
            if ($null -eq $Data) { throw "Informe um Payload com pelo menos o campo 'msg'." }
            $Data = ConvertTo-HashtableSegura -Objeto $Data
            return Invoke-ApiCall -Rota "/api/log-error" -Metodo POST -Corpo ($Data | ConvertTo-Json -Compress)
        }
        "sse-test" {
            Write-Host "[SSE] Verificando conexao Server-Sent Events..." -ForegroundColor Cyan
            try {
                $uri = "${BaseUri}/api/sse-clients"
                $req = [System.Net.HttpWebRequest]::Create($uri)
                $req.Timeout = 8000
                $res = $req.GetResponse()
                $reader = New-Object System.IO.StreamReader($res.GetResponseStream())
                $linha = $reader.ReadLine()
                $reader.Close(); $res.Close()
                return @{ conectado = $true; primeira_mensagem = $linha }
            } catch {
                return @{ conectado = $false; erro = $_.Exception.Message }
            }
        }
        default { throw "Endpoint desconhecido: ${Ep}" }
    }
}

# ===========================================================================
# 5. MENU INTERATIVO
# ===========================================================================
function Mostrar-Menu {
    Write-Host "`n================================================================" -ForegroundColor Cyan
    Write-Host " CLIENTE API - SERVIDOR RELATORIO (${BaseUri})" -ForegroundColor Cyan
    Write-Host " IP Ativo: ${IpDefinido}" -ForegroundColor DarkGray
    Write-Host "================================================================`n" -ForegroundColor Cyan
    Write-Host "=== OPERACOES PRINCIPAIS ==="
    Write-Host " 1. status           | Qt/vendas e total do dia"
    Write-Host " 2. db-status        | Status conexao Firebird (fbHost)"
    Write-Host " 3. sse-clients      | Abas conectadas via SSE"
    Write-Host " 4. proibidos (GET)  | Listar produtos filtrados"
    Write-Host " 5. proibidos (POST) | Atualizar lista (array de strings)"
    Write-Host " 6. config (GET)     | Ler configuracoes ativas"
    Write-Host " 7. config (POST)    | Alterar appName, pollInterval, etc."
    Write-Host " 8. salvar-fdb       | Definir caminho do SMALL.FDB"
    Write-Host " 9. abrir-picker     | Abrir seletor nativo do Windows"
    Write-Host "10. navigate-hoje    | Focar abas em / (hoje)"
    Write-Host "11. navigate-config  | Focar abas em /#config"
    Write-Host "12. navigate-fdb     | Focar abas em /selecionar-fdb"
    Write-Host "13. navigate-periodo | Navegar para periodo especifico"
    Write-Host "14. upload-favicon   | Enviar novo icone PNG/ICO/JPG"
    Write-Host "15. restart          | Reiniciar servidor (process-safe)"
    Write-Host "16. pronto           | Polling de geracao (?k=...)"
    Write-Host "17. log-error        | Simular envio de erro do browser"
    Write-Host "18. sse-test         | Testar conexao Server-Sent Events"
    Write-Host "19. alterar-ip       | Redefinir IP manualmente agora"
    Write-Host "`n 0. Sair"
    Write-Host "================================================================`n" -ForegroundColor Cyan
}

# ===========================================================================
# 6. EXECUCAO PRINCIPAL
# ===========================================================================
if ($Endpoint -eq "menu") {
    Mostrar-Menu
    while ($true) {
        $escolha = Read-Host "Selecione a operacao"
        if ($escolha -eq "0") { exit }

        if ($escolha -eq "19") {
            $novoIp = Read-Host "Novo IP do servidor"
            if (-not [string]::IsNullOrWhiteSpace($novoIp)) {
                $IpDefinido = $novoIp.Trim()
                $BaseUri = "http://${IpDefinido}:$($Config.porta)"
                Write-Host "[SUCESSO] IP alterado para ${IpDefinido}" -ForegroundColor Green
                Mostrar-Menu
            } else {
                Write-Host "[AVISO] IP nao alterado." -ForegroundColor Yellow
            }
            continue
        }

        try {
            $epMap = @{
                "1"="status"; "2"="db-status"; "3"="sse-clients"
                "4"="proibidos"; "5"="proibidos"; "6"="config"; "7"="config"
                "8"="salvar-fdb"; "9"="abrir-picker"; "10"="navigate-hoje"
                "11"="navigate-config"; "12"="navigate-fdb"; "13"="navigate-periodo"
                "14"="upload-favicon"; "15"="restart"; "16"="pronto"; "17"="log-error"
                "18"="sse-test"
            }
            $epNome = $epMap[$escolha]
            if (-not $epNome) { Write-Warning "Opcao invalida"; continue }

            $dados = $null
            switch ($escolha) {
                "5" {
                    $inp = Read-Host "Proibidos (separados por virgula; deixe vazio para LIMPAR a lista)"
                    # BUG FIX: envolver em @(...) garante que $dados seja SEMPRE um
                    # array (mesmo vazio) e nunca $null - sem isso, quando o pipeline
                    # nao produz nenhum item (ex: entrada vazia), o PowerShell atribui
                    # $null a $dados em vez de um array vazio, e a intencao de "limpar
                    # a lista" se perdia silenciosamente (ver bug fix em Executar-Endpoint).
                    $dados = @($inp.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
                }
                "7" {
                    $dados = @{}
                    $an = Read-Host "appName (Enter para manter)"
                    if ($an) { $dados["appName"] = $an }
                    $pi = Read-Host "pollInterval ms (Enter para manter)"
                    if ($pi -and [int]::TryParse($pi, [ref]$null)) { $dados["pollInterval"] = [int]$pi }
                    $ml = Read-Host "maxLogLines (Enter para manter)"
                    if ($ml -and [int]::TryParse($ml, [ref]$null)) { $dados["maxLogLines"] = [int]$ml }
                    if ($dados.Count -eq 0) { Write-Warning "Nenhum valor informado"; continue }
                }
                "8" { $dados = Read-Host "Caminho completo do .fdb" }
                "13" {
                    $d1 = Read-Host "Data inicio (YYYY-MM-DD)"
                    $d2 = Read-Host "Data fim (YYYY-MM-DD)"
                    $dados = @($d1, $d2)
                }
                "14" { $dados = Read-Host "Caminho da imagem (PNG/ICO/JPG)" }
                "16" { $dados = Read-Host "Chave de polling" }
                "17" { $dados = @{ msg = Read-Host "Mensagem de erro"; stack = "Simulado CLI" } }
            }

            $resultado = Executar-Endpoint -Ep $epNome -Data $dados
            Write-Host "`n[RESPOSTA] " -ForegroundColor Green
            if ($resultado) { $resultado | ConvertTo-Json -Depth 5 | Write-Host }
            else { Write-Host "(sem conteudo)" -ForegroundColor DarkGray }
        } catch {
            Write-Host "`n[ERRO] $($_.Exception.Message)" -ForegroundColor Red
        }
        Write-Host "`nPressione ENTER para continuar..."
        $null = Read-Host
    }
} else {
    try {
        $resultado = Executar-Endpoint -Ep $Endpoint -Data $Payload
        if ($resultado) { $resultado | ConvertTo-Json -Depth 5 }
        else { Write-Host "Operacao concluida." -ForegroundColor Green }
    } catch {
        Write-Host "[ERRO] $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}