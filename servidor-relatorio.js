"use strict";

/**
 * servidor-relatorio.js
 * @version 2.9.6
 * @description Servidor HTTP + Firebird de relatórios com SSE, fast-poll e
 *              geração em subprocesso.
 * @changelog
 *   2.9.6 - 2026-08-15 21:30 - REVERT GERAL A PEDIDO DO USUÁRIO: volta à
 *                              base da v2.8.4 (última versão comprovadamente
 *                              estável), reaproveitando só o que é seguro e
 *                              independente da instabilidade das últimas
 *                              versões + fast-poll mais rápido + anti-spam
 *                              genérico no log.
 *     - CONTEXTO: mesmo depois da v2.9.5 (correção real do double-counting
 *       de pagamento), o usuário reportou que o problema de regeneração
 *       ainda não estava resolvido. Depois de v2.9.0→v2.9.5 tentando
 *       consertar peça por peça (schema dinâmico, dedup de gerencial,
 *       aritmética de qt/tot) — cada tentativa resolvendo um sintoma e
 *       ocasionalmente introduzindo outro (v2.9.2 chegou a travar o
 *       SmallSoft real) — decisão: parar de tentar consertar em cima da
 *       base instável e voltar à última base comprovadamente estável,
 *       reconstruindo só o que for seguro por cima dela.
 *     - REMOVIDO (tudo introduzido a partir da v2.9.0, específico da
 *       detecção/reconciliação que gerou a instabilidade):
 *         • _reconciliarNumeracaoHoje() e seu agendamento (setTimeout de
 *           5s + setInterval de 30s) — a varredura periódica de
 *           completude de numeração. Volta a existir a limitação antiga
 *           (números fora da janela ativa de correção podem ficar sem
 *           registro no cache) — trade-off aceito de propósito.
 *         • _detectarSchemaNfce() (sondagem dinâmica de NUMERONF/
 *           cancelado/hora/vendedor/gerencial) — substituída de volta por
 *           _detectarCampoHora(), que só sonda "dhora" vs "hora" (forma
 *           anterior à v2.9.1).
 *         • Toda a lógica condicional de numero/cancelado dinâmicos em
 *           fast-poll, pollStatus e nas rotinas de correção — voltam a
 *           hardcodar "numero"/"cancelado", exatamente como na v2.8.4.
 *         • Guards de auto-desativação por ausência de coluna de hora
 *           (não fazem mais sentido sem _detectarSchemaNfce).
 *         • HORA_CACHE_SEM_HORA (marcador que só _reconciliarNumeracaoHoje
 *           usava) — ficaria morto sem a função que o consumia.
 *     - MANTIDO por ser seguro e não ter relação com a instabilidade
 *       (nenhuma dessas mudanças mexe em query nem em schema):
 *         • v2.9.0: janela de correção gerencial ampliada de 30min para
 *           1h + renomeação _threshD30/horaLimite30 → _threshJanela/
 *           horaLimiteJanela.
 *         • v2.9.0/v2.7.0: classificação CANCELADA/CONVERTIDA/SEM VALOR
 *           em _corrigirHorariosGerencial (evita buracos na numeração
 *           para quem passa pela janela ativa) — só a reconciliação FORA
 *           da janela foi removida, não essa parte.
 *         • v2.9.1: normalização de zeros à esquerda (idRaw/idCache) ao
 *           gravar chave no hora-fixada-cache.json — mantém consistência
 *           com gerar-relatorio-html.js independente do resto.
 *         • v2.9.4: banner "=== Servidor iniciado ===" grava em todo
 *           boot, não só uma vez por dia.
 *         • v2.9.5: qt/tot do pollStatus sem somar qtPAG/totPAG — fix de
 *           aritmética simples, sem relação com schema/subquery.
 *     - NOVO (pedido do usuário): fast-poll de 50ms para 30ms — moderado
 *       de propósito, não o mais rápido possível (mesmo com conexão
 *       persistente, é uma consulta a mais por ciclo contra um Firebird
 *       remoto compartilhado por várias máquinas — ver decisão completa
 *       na declaração de _FP_INTERVAL_MS).
 *     - NOVO (pedido do usuário): anti-spam genérico em logTs() — mensagem
 *       IDÊNTICA repetida em menos de 30s colapsa num resumo ("repetida
 *       Nx") em vez de uma linha por ocorrência. Ataca a causa estrutural
 *       do spam (qualquer condição futura que dispare a mesma mensagem
 *       sem parar), não só os casos específicos de hoje.
 *     - RESULTADO NESTA INSTALAÇÃO (SmallSoft com NUMERONF/sem cancelado/
 *       sem hora separada): fast-poll, pollStatus e as rotinas de correção
 *       voltam a não detectar nada automaticamente — mas SILENCIOSAMENTE,
 *       sem erro no log, sem custo de query (a query falha na preparação,
 *       antes de tocar em qualquer linha). Os relatórios continuam
 *       corretos ao abrir/atualizar a página manualmente —
 *       gerar-relatorio-html.js nunca dependeu de nada disso.
 */


// Versão deste arquivo — mantida em sincronia manual com @version no header.
// Registrada na linha de início do log para que se saiba, ao investigar
// qualquer ocorrência, qual versão do servidor estava no ar naquele momento
// (o gerar-relatorio-html.js já faz o mesmo via SCRIPT_VERSION).
const SERVER_VERSION = "2.9.6";

// ===== Logger Global seguro — flush debounced 300ms =====
const _fs = require('fs');
const _util = require('util');
const _path = require('path');
const LOG_PATH = _path.join(__dirname, 'relatorio.log');

// ORDEM FIX: padDois é usado dentro de logToFile(). Antes estava declarado ~90
// linhas abaixo; como `var` é içado sem valor, qualquer log emitido durante o
// carregamento do módulo caía no catch silencioso de logToFile e era perdido.
// Declarado aqui, no topo absoluto, o logger passa a funcionar desde a linha 1.
var padDois = function(n) { return String(n).padStart(2, "0"); };

// Gravação atômica: escreve num arquivo temporário e renomeia por cima.
// rename() é atômico no mesmo volume, então uma queda de energia ou kill no meio
// da escrita nunca deixa config.json / hora-fixada-cache.json truncados.
// Retorna true em sucesso, false em falha (nunca lança).
var _gravarArquivoAtomico = function(destino, conteudo) {
    var tmp = destino + ".tmp" + process.pid;
    try {
        _fs.writeFileSync(tmp, conteudo, "utf8");
        _fs.renameSync(tmp, destino);
        return true;
    } catch(e) {
        // Fallback: se o rename falhar (antivírus segurando o handle no Windows,
        // volume diferente, etc.), tenta a escrita direta antes de desistir.
        try { _fs.writeFileSync(destino, conteudo, "utf8"); return true; } catch(_) {}
        try { if (_fs.existsSync(tmp)) _fs.unlinkSync(tmp); } catch(_) {}
        return false;
    }
};

// MAX_LOG_LINES é sobrescrito depois que config.json é carregado (ver abaixo)
var MAX_LOG_LINES = 1000;
let _logBuffer = [];       // histórico recente em memória — usado como fallback de leitura, não é mais a fonte de gravação
let _logPendentes = [];    // linhas ainda não gravadas em disco desde o último flush
let _logFlushTimer = null;
// Conta linhas ACRESCENTADAS desde a última rotação (ao contrário de
// _logBuffer, que fica sempre travado em MAX_LOG_LINES e por isso nunca
// serviria como sinal de "já é hora de rotacionar" — bug encontrado durante
// os próprios testes desta revisão).
let _logLinhasDesdeRotacao = 0;
// Carrega linhas existentes no buffer ao iniciar (só leitura, não afeta o arquivo)
try {
    const _existing = _fs.readFileSync(LOG_PATH, "utf8");
    _logBuffer = _existing.split("\n").filter(l => l.trim()).slice(-MAX_LOG_LINES);
} catch(e) {}

// CONCORRÊNCIA FIX (pedido do usuário: consolidar tray.log em relatorio.log):
// iniciar-tray.ps1 (processo PowerShell independente) também grava neste
// mesmo arquivo. A versão anterior deste logger REESCREVIA O ARQUIVO INTEIRO
// a cada flush (writeFileSync com todo o _logBuffer em memória) — qualquer
// linha que outro processo tivesse acabado de acrescentar seria APAGADA no
// próximo flush do Node, porque o buffer em memória do Node não sabia que
// ela existia. Agora _flushLog só ACRESCENTA (appendFileSync) as linhas
// novas desde o último flush — nunca sobrescreve o arquivo inteiro em uso
// normal, então dois processos gravando no mesmo arquivo é seguro (cada
// appendFileSync é uma operação atômica no nível do SO para escritas deste
// tamanho). A rotação (manter só as últimas MAX_LOG_LINES) roda raramente
// (só quando já foram acrescentadas MAX_LOG_LINES linhas novas desde a
// última rotação) e sempre relê o arquivo do disco na hora — nunca a partir
// de _logBuffer, que não conhece as linhas que outros processos gravaram —
// usando gravação atômica (tmp + rename) para minimizar a janela de colisão
// quando de fato acontece.
function _rotacionarLogSeNecessario() {
    try {
        if (_logLinhasDesdeRotacao < MAX_LOG_LINES) return; // ainda longe do limite, nao vale o custo de reler o arquivo
        const _atual = _fs.readFileSync(LOG_PATH, "utf8");
        const _linhas = _atual.split("\n").filter(l => l.trim()).slice(-MAX_LOG_LINES);
        if (_gravarArquivoAtomico(LOG_PATH, _linhas.join("\n") + "\n")) {
            _logBuffer = _linhas;
            _logLinhasDesdeRotacao = 0;
        }
    } catch(e) {}
}
function _flushLog() {
    if (!_logPendentes.length) return;
    try {
        _fs.appendFileSync(LOG_PATH, _logPendentes.join("\n") + "\n");
        _logLinhasDesdeRotacao += _logPendentes.length;
        _logPendentes = [];
    } catch(e) {}
    _rotacionarLogSeNecessario();
}
function logToFile(...args) {
    try {
        const msg = args.map(a => typeof a === "string" ? a : _util.inspect(a)).join(" ");
        const d = new Date();
        const ts = "[" + padDois(d.getDate()) + "-" + padDois(d.getMonth()+1) + "-" + d.getFullYear() + "]";
        const linha = ts + " " + msg;
        _logBuffer.push(linha);
        // PERF FIX: slice() criava novo array a cada push que ultrapassava o limite.
        // splice(0,1) remove o primeiro elemento in-place — O(1) vs O(n).
        if (_logBuffer.length > MAX_LOG_LINES) _logBuffer.splice(0, _logBuffer.length - MAX_LOG_LINES);
        _logPendentes.push(linha);
        clearTimeout(_logFlushTimer);
        _logFlushTimer = setTimeout(_flushLog, 300);
    } catch(e) {}
}

const origLog = console.log, origError = console.error, origWarn = console.warn, origInfo = console.info;
console.log = function(...args) { logToFile(...args); origLog.apply(console, args); };
console.error = function(...args) { logToFile('ERROR:', ...args); origError.apply(console, args); };
console.warn = function(...args) { logToFile('WARN:', ...args); origWarn.apply(console, args); };
console.info = function(...args) { logToFile(...args); origInfo.apply(console, args); };

process.on("uncaughtException", function (err) {
    logToFile("[UNCAUGHT EXCEPTION]", err && (err.stack || err));
    origError("[UNCAUGHT EXCEPTION]", err && (err.stack || err));
    clearTimeout(_logFlushTimer); _flushLog();
});
process.on("unhandledRejection", function (reason) {
    logToFile("[UNHANDLED REJECTION]", reason && (reason.stack || reason));
    origError("[UNHANDLED REJECTION]", reason && (reason.stack || reason));
    clearTimeout(_logFlushTimer); _flushLog();
});
process.on("exit", function() { clearTimeout(_logFlushTimer); _flushLog(); });

var http        = require("http");
var net         = require("net");
var childProc   = require("child_process"); // usado em spawn, taskkill e _matarTodosFilhos
var spawn       = childProc.spawn;
var path        = require("path");
var fs          = require("fs");
var os          = require("os");
var TextDecoder = require("util").TextDecoder;

// Decoder Windows-1252 — constante de módulo: evita recriar a cada request /api/itens-detalhe.
var _win1252Decoder = new TextDecoder("windows-1252");

// Formatador de quantidade — constante de módulo: converte número para string BR sem recriar a cada request.
var _fmtQuantidade = function(v) {
    var n = Number(v || 0);
    if (!Number.isFinite(n)) return "0";
    var r = Math.round(n);
    if (Math.abs(n - r) < 1e-9) return String(r);
    return String(n).replace(".", ",");
};

var Firebird = null;
try { Firebird = require("node-firebird"); } catch(e) {}

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ANTI-SPAM (v2.9.6): a mesma mensagem repetindo sem parar (falha de rede
// persistente, qualquer condição que dispare o mesmo aviso a cada poll)
// podia inundar o log e empurrar informação relevante pra fora da rotação
// (MAX_LOG_LINES). Mensagens IDÊNTICAS repetidas dentro de
// _LOG_REPETICAO_JANELA_MS são colapsadas: a 1ª ocorrência grava normal; as
// seguintes só incrementam um contador (sem escrever nada); ao passar da
// janela, um resumo ("repetida Nx") fecha o ciclo antes da próxima
// ocorrência normal. Mensagens DIFERENTES nunca são afetadas — só repetição
// exata da mesma string colide. Zerado à meia-noite junto com _logProtSet
// (ver _agendarResetLogProt), para não crescer sem limite ao longo dos dias.
// ---------------------------------------------------------------------------
var _LOG_REPETICAO_JANELA_MS = 30000; // 30s
var _logRepeticoes = new Map(); // msg -> { contador, ultimoFlushTs }
var logTs = function(msg) {
    var agora = Date.now();
    var rep = _logRepeticoes.get(msg);
    if (rep && (agora - rep.ultimoFlushTs) < _LOG_REPETICAO_JANELA_MS) {
        rep.contador++;
        return; // suprime -- mesma mensagem já registrada recentemente
    }
    if (rep && rep.contador > 0) {
        var d0 = new Date();
        console.log("[" + padDois(d0.getHours()) + ":" + padDois(d0.getMinutes()) + ":" + padDois(d0.getSeconds()) +
                     "] (mensagem anterior repetida mais " + rep.contador + "x nos últimos ~" +
                     Math.round(_LOG_REPETICAO_JANELA_MS / 1000) + "s)");
    }
    _logRepeticoes.set(msg, { contador: 0, ultimoFlushTs: agora });
    var d=new Date();
    console.log("["+padDois(d.getHours())+":"+padDois(d.getMinutes())+":"+padDois(d.getSeconds())+"] "+msg);
};

// ---------------------------------------------------------------------------
// NÍVEIS DE LOG (v2.7.3 — "log só com relevâncias do sistema")
// ---------------------------------------------------------------------------
// logTs()    → sempre registra. Reservado para o que importa operacionalmente:
//              início/parada do servidor, estado do banco, erros e avisos,
//              mudanças de configuração, correções de horário, eventos do tray.
// logDebug() → só registra quando "logDebug": true está no config.json.
//              Para ruído de rotina que se repete a cada venda/geração/aba e
//              que, no volume de uma loja em movimento, empurra a informação
//              útil para fora do arquivo pela rotação: cronometragem de
//              queries, "Atualizando DD/MM", caminho do HTML gerado, sincronia
//              de fuso de cada aba, gerações supersedidas pelo fast-poll.
// Padrão desligado de propósito: quem abre o relatorio.log quer ver o que
// aconteceu de relevante, não o batimento cardíaco normal do sistema. Para
// investigar um problema específico, basta ligar logDebug no config.json.
var LOG_DEBUG = false; // sobrescrito ao carregar config.json (ver abaixo)
var logDebug = function(msg) { if (LOG_DEBUG) logTs("[DEBUG] " + msg); };
var hoje = function() {
    var d=new Date();
    return d.getFullYear()+"-"+padDois(d.getMonth()+1)+"-"+padDois(d.getDate());
};
var isoParaBR = function(iso) {
    var m=String(iso||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? (m[3]+"/"+m[2]+"/"+m[1]) : String(iso||"");
};
var escH = function(s) {
    return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
};

// NOTA: padDois foi movido para o topo do arquivo (acima do logger) na v2.4.1 —
// logToFile() depende dele e era chamado antes desta linha ser executada.

// ---------------------------------------------------------------------------
// Argumentos CLI
// ---------------------------------------------------------------------------
var args=process.argv.slice(2);
var pegar=function(k){
    var i=args.indexOf(k);
    return (i>=0&&i+1<args.length)?String(args[i+1]||"").trim():"";
};
var PORT   = parseInt(pegar("--porta")||"7734",10);
var USER   = pegar("--user") || "SYSDBA";
var PASS   = pegar("--pass") || "masterkey";
var SCRIPT = path.join(__dirname,"gerar-relatorio-html.js");
var FAVICON= path.join(__dirname,"favicon.png");
var CONFIG = path.join(__dirname,"config.json");
var NO_BROWSER    = args.includes("--no-browser");
var TMP_DIR       = os.tmpdir();

// ─── Constantes globais — eliminam magic numbers espalhados no código ────────
var FIREBIRD_PORT          = 3050;          // porta padrão do Firebird
var FB_CHARSET             = "UTF8";        // charset padrão do Firebird
var MAX_TENTATIVAS_SPAWN   = 5;             // máximo de retentativas de gerarEmBackground
var _SCAN_CONCORRENCIA_MAX = 40;            // máximo de sockets simultâneos no scan de rede
var _FAVICON_CACHE         = null;          // buffer em memória do favicon (evita readFileSync a cada request)
var _FAVICON_CACHE_MTIME   = 0;            // mtime do favicon na última leitura — invalida cache se o arquivo mudar
var TIMEOUT_SSE_HEARTBEAT_MS = 15000;       // ping SSE a cada 15s — mantém proxies/load balancers de conexão aberta
var INTERVALO_SYNC_HORA_MS   = 30000;       // cliente resincroniza hora/fuso com o servidor a cada 30s
var POLL_WATCHDOG_MS         = 12000;       // watchdog do pollStatus — libera _pollBusy se travar por mais que este tempo
var POLL_RETRY_MULTIPLIER    = 5;           // intervalo de retry após falha = POLL_INTERVAL × POLL_RETRY_MULTIPLIER
var HORA_FIXADA_CACHE = path.join(__dirname, "hora-fixada-cache.json");

// SEGURANÇA FIX (auditoria v2.5.0): sem esta validação, o campo "favicon" de
// /api/config aceitava QUALQUER caminho de arquivo — inclusive caminhos UNC
// (\\host\share\arquivo) — e esse valor era depois lido via fs.readFileSync e
// servido em /favicon.ico. Isso permitia LEITURA ARBITRÁRIA DE ARQUIVO LOCAL
// (qualquer arquivo legível pelo processo Node, servido como se fosse a
// imagem do favicon), e no caso de UNC, forçava o Windows a autenticar via
// SMB contra um host controlado por quem enviou o caminho — vetor de
// vazamento de hash NTLM. O upload real (/api/upload-favicon, que valida
// bytes mágicos PNG/ICO/JPEG e sempre grava dentro de __dirname) continua
// sendo o caminho recomendado para trocar o ícone; este validador restringe
// o campo de texto livre a arquivos que já estejam DENTRO da pasta do
// próprio app — cobre o caso legítimo de referenciar um arquivo colocado
// manualmente ali, sem abrir a porta para ler qualquer arquivo do sistema
// ou forçar autenticação de rede.
var _faviconCaminhoSeguro = function(caminhoBruto) {
    var s = String(caminhoBruto == null ? "" : caminhoBruto).trim();
    if (!s) return { ok: true, valor: "" }; // vazio = usa favicon.png padrão
    if (/^\\\\|^\/\//.test(s)) return { ok: false, motivo: "caminhos de rede (UNC) não são permitidos" };
    var raizApp = path.resolve(__dirname);
    var resolvido;
    try { resolvido = path.resolve(raizApp, s); } catch(_e) { return { ok: false, motivo: "caminho inválido" }; }
    if (resolvido !== raizApp && resolvido.indexOf(raizApp + path.sep) !== 0) {
        return { ok: false, motivo: "o arquivo precisa estar dentro da pasta do sistema (" + raizApp + ")" };
    }
    return { ok: true, valor: resolvido };
};

// ---------------------------------------------------------------------------
// Config persistente
// ---------------------------------------------------------------------------
var loadConfig = function() {
    var raw = "";
    try {
        raw = fs.readFileSync(CONFIG, "utf8").replace(/^\uFEFF/, "");
    } catch(e) {
        // Loga apenas se o arquivo já existir — ausência no 1º boot é esperada.
        try { if (fs.existsSync(CONFIG)) logToFile("WARN loadConfig: falha ao ler config.json — usando padrões. Erro: " + e.message); } catch(_) {}
        return {};
    }
    // BUG FIX: a regex de "remove zero à esquerda" (para tolerar JSON inválido
    // do tipo "porta": 07734, que JSON.parse rejeita) era aplicada SEMPRE, no
    // texto bruto INTEIRO, antes até de tentar o parse normal — isso corrompe
    // qualquer valor de STRING que contenha um padrão ":0" em qualquer lugar
    // (ex: um campo futuro "hora":"08:00" viraria "08: 0"), mesmo quando o
    // JSON já era 100% válido. Agora só é usada como reparo de ÚLTIMO RECURSO,
    // quando o parse direto falha — a grande maioria dos carregamentos nunca
    // toca nessa regex e nunca corre esse risco.
    try {
        return JSON.parse(raw);
    } catch (eOriginal) {
        try {
            var reparado = raw.replace(/:\s*0+(\d+)/g, ": $1");
            var obj = JSON.parse(reparado);
            logToFile("WARN loadConfig: config.json tinha número(s) com zero à esquerda inválido para JSON — reparado automaticamente nesta leitura. Corrija o arquivo manualmente para evitar depender deste reparo.");
            return obj;
        } catch (eReparo) {
            try { if (fs.existsSync(CONFIG)) logToFile("WARN loadConfig: config.json inválido mesmo após tentativa de reparo — usando padrões. Erro: " + eOriginal.message); } catch(_) {}
            return {};
        }
    }
};
// DRY FIX: saveConfig e updateConfigKey compartilhavam ~90% da lógica.
// _writeConfigMerge(patch, contexto) lê → valida JSON → merge → grava.
var _writeConfigMerge = function(patch, contexto) {
    try {
        var rawAtual = "";
        try { rawAtual = fs.readFileSync(CONFIG, "utf8").replace(/^\uFEFF/, "").trim(); } catch(e) {}
        var base = {};
        if (rawAtual) {
            try { base = JSON.parse(rawAtual); }
            catch(e) {
                logToFile("WARN " + contexto + ": JSON inválido em config.json — gravação abortada. Erro: " + e.message);
                return false;
            }
        }
        if (typeof base !== "object" || Array.isArray(base)) base = {};
        var merged = Object.assign({}, base, patch);
        if (Object.keys(merged).length === 0) {
            logToFile("WARN " + contexto + ": merge resultou em objeto vazio — gravação abortada.");
            return false;
        }
        // INTEGRIDADE FIX: writeFileSync direto podia deixar config.json truncado
        // se o processo caísse no meio da escrita — e um config.json corrompido
        // faz o servidor perder appName, fbHost, proibidos e maquinaIP de uma vez.
        if (!_gravarArquivoAtomico(CONFIG, JSON.stringify(merged, null, 2))) {
            logToFile("WARN " + contexto + ": falha ao gravar config.json.");
            return false;
        }
        return true;
    } catch(e) { logToFile("WARN " + contexto + ": " + e.message); return false; }
};

var saveConfig = function(obj) {
    return _writeConfigMerge(obj, "saveConfig");
};

var updateConfigKey = function(key, value) {
    var patch = {};
    patch[key] = value;
    return _writeConfigMerge(patch, "updateConfigKey(" + key + ")");
};

// _config é a única leitura de config.json no boot — elimina o segundo loadConfig()
// que estava em cfg=loadConfig() na linha 267. Ambas as variáveis eram idênticas;
// manter duas causava inconsistência se o arquivo mudasse entre as duas leituras.
var _config       = loadConfig();
// Alias de compatibilidade — mantido para não alterar referências espalhadas no arquivo.
var appCfg        = _config;
var APP_NAME      = (appCfg.appName&&appCfg.appName.trim()) ? appCfg.appName.trim() : "Relatorios";
// BUG FIX (v2.5.0): FAVICON nunca era inicializado a partir de config.json no
// boot — só era atualizado em memória pelas rotas /api/config e
// /api/upload-favicon durante a sessão. Resultado: um favicon customizado
// salvo pelo usuário "sumia" (voltava ao padrão) toda vez que o servidor
// reiniciava, mesmo com o caminho certinho salvo em config.json — o campo
// parecia configurado (a tela de configurações mostrava o valor salvo), mas
// o ícone servido de fato revertia silenciosamente. Revalidado aqui com o
// mesmo validador de caminho seguro usado em /api/config, por segurança
// (config.json pode ter sido editado manualmente por alguém com acesso ao
// disco).
(function() {
    var _favBoot = _faviconCaminhoSeguro(appCfg.favicon);
    if (_favBoot.ok && _favBoot.valor) FAVICON = _favBoot.valor;
})();
var POLL_INTERVAL = (appCfg.pollInterval && parseInt(appCfg.pollInterval,10) >= 100)
    ? parseInt(appCfg.pollInterval,10) : 200; // mínimo absoluto de 100ms — previne loop sem pausa
// CONTRATO FIX: padrão unificado com gerar-relatorio-html.js (ambos usam 5000ms agora).
var TOAST_DURATION = (appCfg.toastDuration && parseInt(appCfg.toastDuration,10)>=500)
    ? parseInt(appCfg.toastDuration,10) : 5000; // ms — duração padrão do toast de notificação
// spawnTimeoutMs configurável via config.json.
// Padrão: 10 s. Mínimo: 5 s. Máximo: 120 s (clamp ampliado — comporta bancos remotos lentos).
// O clamp anterior (10 s) ignorava silenciosamente valores maiores definidos pelo usuário.
// TIMEOUT FIX (contrato servidor↔filho): o filho precisa de no mínimo 90s para
// conectar ao Firebird e rodar as queries de 1 dia (_tGlobal mínimo = 90000ms).
// O default anterior de 10s causava kill imediato + 5 tentativas = erro permanente.
// Novo default: 120s. Para períodos históricos maiores o usuário deve configurar
// spawnTimeoutMs no config.json (max aceito: 600s para meses inteiros).
var _cfgTms = appCfg.spawnTimeoutMs ? parseInt(appCfg.spawnTimeoutMs, 10) : 120000;
var SPAWN_TIMEOUT_CFG = Math.min(Math.max(isNaN(_cfgTms) ? 120000 : _cfgTms, 30000), 600000);

LOG_DEBUG = (appCfg.logDebug === true || String(appCfg.logDebug).toLowerCase() === "true");
if (appCfg.maxLogLines && parseInt(appCfg.maxLogLines,10) >= 100) {
    MAX_LOG_LINES = parseInt(appCfg.maxLogLines,10);
}
if (_logBuffer.length > MAX_LOG_LINES) _logBuffer.splice(0, _logBuffer.length - MAX_LOG_LINES); // in-place

if (appCfg.porta&&appCfg.porta>0) PORT = parseInt(appCfg.porta,10);

// ---------------------------------------------------------------------------
// Auto-deteccao do caminho FDB
// ---------------------------------------------------------------------------
var _fdbCandidatos=function(){
    var pf86=process.env["ProgramFiles(x86)"]||"C:\\Program Files (x86)";
    var pf  =process.env["ProgramFiles"]      ||"C:\\Program Files";
    var pd  =process.env["ProgramData"]       ||"C:\\ProgramData";
    return [
        pf86+"\\SmallSoft\\Small Commerce\\SMALL.FDB",
        pf  +"\\SmallSoft\\Small Commerce\\SMALL.FDB",
        pd  +"\\SmallSoft\\Small Commerce\\SMALL.FDB",
        "C:\\SmallSoft\\Small Commerce\\SMALL.FDB",
        "C:\\Dados\\SMALL.FDB",
        "C:\\SmallCommerce\\SMALL.FDB",
    ];
};

var detectFdbLocal=function(){
    var cands=_fdbCandidatos();
    for(var i=0;i<cands.length;i++){
        try{
            if(fs.existsSync(cands[i])){
                logTs("FDB local encontrado: "+cands[i]);
                return cands[i];
            }
        }catch(e){ logTs("WARN detectFdbLocal: "+e.message); }
    }
    return null;
};

var detectFdbPath=function(){
    var local=detectFdbLocal();
    if(local)return local;
    var pf86=process.env["ProgramFiles(x86)"]||"C:\\Program Files (x86)";
    return pf86+"\\SmallSoft\\Small Commerce\\SMALL.FDB";
};

var parseFdb=function(fdb){
    var m=String(fdb||"").match(/^([0-9.]+|[a-zA-Z0-9_-]+):([a-zA-Z]:\\.*|\/.*)/);
    if(m)return{host:m[1],dbPath:m[2]};
    return{host:"127.0.0.1",dbPath:fdb};
};

// detectLocalIP melhorada: ignora adapters virtuais/VPN, usa score por sub-rede
// e aceita fbHostHint para priorizar o IP na mesma /24 do banco.
var detectLocalIP = function(fbHostHint) {
    var ifaces = os.networkInterfaces();
    var SKIP_NAMES = ["vmware","virtualbox","vbox","hyper-v","loopback","pseudo","isatap",
                      "teredo","tunnel","vpn","tap","tun","wsl","docker","radio","bluetooth",
                      "6to4","vethernet"];
    function isSkip(name) {
        var nl = String(name||"").toLowerCase();
        return SKIP_NAMES.some(function(s){ return nl.indexOf(s) >= 0; });
    }
    // Prefixo /24 do host do banco — aumenta score de IPs na mesma sub-rede
    var subnetPrefix = null;
    if (fbHostHint && /^\d{1,3}\.\d{1,3}\.\d{1,3}\./.test(fbHostHint)) {
        subnetPrefix = fbHostHint.split(".").slice(0,3).join(".") + ".";
    }
    var candidates = [];
    for (var n in ifaces) {
        if (isSkip(n)) continue;
        var list = ifaces[n];
        for (var i = 0; i < list.length; i++) {
            var a = list[i];
            var isV4 = (a.family === "IPv4" || a.family === 4);
            if (!isV4 || a.internal || a.address === "127.0.0.1") continue;
            var score = 0;
            if (subnetPrefix && a.address.indexOf(subnetPrefix) === 0) score += 100;
            if (/^192\.168\./.test(a.address))                          score += 10;
            else if (/^10\./.test(a.address))                           score += 5;
            else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address))     score += 4;
            candidates.push({addr: a.address, score: score});
        }
    }
    if (!candidates.length) return null;
    candidates.sort(function(a,b){ return b.score - a.score; });
    return candidates[0].addr;
};

// cfg reusa _config — sem segundo readFileSync; fdbArg lê do processo.
var cfg      = _config;
var fdbArg   = pegar("--fdb");

// ---------------------------------------------------------------------------
// logProtegido — evita duplicar linhas fixas no log ao reiniciar no mesmo dia.
// Zera automaticamente à meia-noite.
// NOTA: "=== Servidor iniciado ===" (mais abaixo) NÃO usa mais este
// mecanismo — grava sempre, a cada boot, de propósito (ver comentário na
// própria declaração).
// ---------------------------------------------------------------------------
var _logProtSet = new Set();
var _logProtDia = (function() {
    var d = new Date();
    return padDois(d.getDate()) + "-" + padDois(d.getMonth()+1) + "-" + d.getFullYear();
})();
try {
    var _logFullRaw = _fs.readFileSync(LOG_PATH, "utf8").split("\n");
    _logFullRaw.forEach(function(linha) {
        if (linha.indexOf("[" + _logProtDia) === 0) {
            var m = linha.match(/^\[[^\]]+\]\s*\[[^\]]+\]\s*(.+)$/);
            if (m) _logProtSet.add(m[1].trim());
        }
    });
} catch(e) {
    _logBuffer.forEach(function(linha) {
        if (linha.indexOf("[" + _logProtDia) === 0) {
            var m = linha.match(/^\[[^\]]+\]\s*\[[^\]]+\]\s*(.+)$/);
            if (m) _logProtSet.add(m[1].trim());
        }
    });
}
(function _agendarResetLogProt() {
    var agora  = new Date();
    var amanha = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1, 0, 0, 3);
    setTimeout(function() {
        _logProtSet.clear();
        _logRepeticoes.clear();
        _queryLogsHoje = false;
        _nfceCorrigidasHoje.clear();
        _pagCorrigidosHoje.clear();
        _statusChangeTs = 0; // reseta a meia-noite — evita reloads espúrios no dia seguinte
        // Limpa entradas antigas do hora-fixada-cache (dias anteriores ao atual)
        try {
            var _dhHoje = hoje();
            Object.keys(_horaFixadaCache).forEach(function(k) {
                var kDate = k.split("|")[0];
                if (kDate && kDate < _dhHoje) delete _horaFixadaCache[k];
            });
            _salvarHoraFixadaCache();
        } catch(_hfc) {}
        _logProtDia = (function() {
            var d = new Date();
            return padDois(d.getDate()) + "-" + padDois(d.getMonth()+1) + "-" + d.getFullYear();
        })();
        _agendarResetLogProt();
    }, amanha.getTime() - agora.getTime());
})();
function logProtegido(msg) {
    if (_logProtSet.has(msg)) return;
    _logProtSet.add(msg);
    logTs(msg);
}

// Flag: linhas de progresso do filho (>>, OK:) só aparecem na 1ª geração do dia.
// Resetado à meia-noite junto com _logProtSet (ver _agendarResetLogProt acima).
var _queryLogsHoje = false;

// ---------------------------------------------------------------------------
// SVG Icons (Lucide-style, stroke="currentColor") — substituem todos os emojis.
// Usados em botões HTML, spans decorativos e innerHTML de elementos de status.
// ---------------------------------------------------------------------------

// Pasta aberta — botões "Procurar" (14 × 14)
var SVG_FOLDER =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"' +
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
    ' style="display:inline;vertical-align:-2px;margin-right:5px">' +
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5' +
    'H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>' +
    '</svg>';

// Banco de dados — ícone decorativo grande (48 × 48)
var SVG_DATABASE =
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"' +
    ' fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<ellipse cx="12" cy="5" rx="9" ry="3"/>' +
    '<path d="M3 5v14a9 3 0 0 0 18 0V5"/>' +
    '<path d="M3 12a9 3 0 0 0 18 0"/>' +
    '</svg>';

// Timer / stopwatch — status "encerrando processo" (13 × 13, para innerHTML)
var SVG_TIMER =
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"' +
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
    ' style="display:inline;vertical-align:-2px;margin-right:4px">' +
    '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="2" y2="5"/>' +
    '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/>' +
    '</svg>';

// Seta anti-horária — status "tentativa N/M" (13 × 13, para innerHTML)
var SVG_RETRY =
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"' +
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
    ' style="display:inline;vertical-align:-2px;margin-right:4px">' +
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
    '<path d="M3 3v5h5"/>' +
    '</svg>';

// Triângulo de aviso — status "sem resposta" (13 × 13, para innerHTML)
var SVG_WARN =
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"' +
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
    ' style="display:inline;vertical-align:-2px;margin-right:4px">' +
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
    '<line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/>' +
    '</svg>';


var _descreverMudanca = function(qtAntes, qtDepois, totAntes, totDepois) {
    var partes = [];
    if (qtAntes !== qtDepois) {
        // agora mostra qtDepois primeiro, depois o sinal, depois qtAntes
        partes.push("vendas " + qtDepois + (qtDepois > qtAntes ? " > " : " < ") + qtAntes);
    }
    if (Math.abs(totDepois - totAntes) > 0.005) {
        // mesmo padrão: valor depois, sinal, valor antes
        partes.push("total R$" + totDepois.toFixed(2) + (totDepois > totAntes ? " > " : " < ") + "R$" + (totAntes||0).toFixed(2));
    }
    return partes.length ? partes.join(" | ") : "sem diferença detectável";
};

// Compara estado anterior × atual por tipo (G = gerencial, NFC = NFC-e, NF = NF-e).
// Emite ">" quando o valor subiu e "<" quando caiu — detectado via POLL_INTERVAL.
// Retorna {mudou:bool, descricao:string}.
var _descreverMudancaTipo = function(ant, atu) {
    var partes = [];
    var tipos = [
        {chave:"g",   rotulo:"Ger"},
        {chave:"nfc", rotulo:"NFC-e"},
        {chave:"nf",  rotulo:"NF-e"}
    ];
    tipos.forEach(function(t) {
        var a = ant[t.chave], b = atu[t.chave];
        if (!a || a.qt < 0) return;
        if (a.qt !== b.qt) {
            // Agora valor novo primeiro, sinal de comparação, valor antigo
            partes.push(t.rotulo+" vendas "+b.qt+(b.qt > a.qt ? " > " : " < ")+a.qt);
        }
        if (Math.abs(b.tot - a.tot) > 0.005) {
            partes.push(t.rotulo+" total R$"+b.tot.toFixed(2)+(b.tot > a.tot ? " > " : " < ")+"R$"+a.tot.toFixed(2));
        }
    });
    return {mudou: partes.length > 0, descricao: partes.join(" | ")};
};

// Lê a versão do gerar-relatorio-html.js a partir do @version no cabeçalho dele.
// Os dois arquivos são atualizados juntos com frequência, e uma combinação
// incompatível já causou sintomas confusos antes (ex: marcador "CANCELADA"
// aparecendo na coluna de hora quando só o servidor havia sido trocado).
// Registrar as duas versões lado a lado na abertura do log torna esse tipo de
// desencontro imediato de identificar.
// Lê o arquivo em vez de usar require(): o gerador é um script executável que
// abre conexão com o banco ao ser carregado, não um módulo. Só o topo é lido.
var _versaoGerador = function() {
    try {
        var _cab = fs.readFileSync(path.join(__dirname, "gerar-relatorio-html.js"), "utf8").slice(0, 600);
        var _m = _cab.match(/@version\s+([0-9]+\.[0-9]+\.[0-9]+)/);
        // Prefixo "v" só quando há versão real, para não sair "vausente".
        return _m ? "v" + _m[1] : "(versao nao identificada)";
    } catch (e) {
        return "(arquivo ausente)";
    }
};

// Primeira linha do log a cada boot — SEMPRE grava, mesmo que o servidor já
// tenha subido antes hoje.
// FIX (pedido do usuário): antes passava pelo mesmo dedup de logProtegido,
// que compara o TEXTO EXATO da linha contra o que já foi logado hoje. Como
// o texto inclui as versões (Servidor + Gerador), um reinício no MESMO dia
// com a MESMA versão — o caso comum: reiniciar sem nenhuma atualização de
// código — produzia o texto idêntico ao da primeira subida do dia, e o
// dedup suprimia a linha. Isso escondia exatamente o evento que ela existe
// para marcar: quando cada instância do processo começou a rodar. Virou
// logTs() direto, sem checagem de duplicidade — cada boot grava a sua
// própria linha, sempre, não fica mais restrito a "uma vez por dia".
(function() {
    var _marcaDia = "=== Servidor iniciado " + isoParaBR(hoje()) + " === Servidor v" +
                    SERVER_VERSION + " | Gerador " + _versaoGerador();
    logTs(_marcaDia);
    clearTimeout(_logFlushTimer); _flushLog();
})();

var FDB_PATH, FDB_HOST;
if (fdbArg) {
    // BUG FIX: parseFdb era chamado duas vezes para o mesmo argumento.
    // Agora guarda o resultado uma única vez.
    var _fdbParsed = parseFdb(fdbArg);
    FDB_PATH = _fdbParsed.dbPath;
    FDB_HOST = _fdbParsed.host;
    logTs("FDB via argumento CLI: "+FDB_HOST+":"+FDB_PATH);
} else {
    var _fdbLocal = detectFdbLocal();
    if (_fdbLocal) {
        FDB_PATH = _fdbLocal;
        FDB_HOST = "127.0.0.1";
        logTs("FDB local detectado → conectando em 127.0.0.1");
    } else {
        // BUG FIX (v2.6.8 — configurações): "fdbPath" era GRAVADO no
        // config.json por aplicarNovoFdb() (seletor de banco / rota
        // /api/salvar-fdb) mas NUNCA era lido de volta no boot — a única
        // função consultada aqui, detectFdbPath(), procura caminhos locais
        // conhecidos e, não achando, devolve um caminho padrão fixo. Efeito
        // prático: o usuário selecionava o .fdb pelo seletor, o servidor
        // confirmava e salvava, e no reinício seguinte a escolha era
        // silenciosamente descartada, voltando ao caminho padrão. Como neste
        // ramo já sabemos que detectFdbLocal() falhou (é a condição do else),
        // detectFdbPath() só pode devolver o padrão fixo — então preferir o
        // valor salvo pelo usuário é estritamente melhor e não muda nenhum
        // outro cenário.
        var _fdbCfg = (cfg.fdbPath && String(cfg.fdbPath).trim()) ? String(cfg.fdbPath).trim() : null;
        if (_fdbCfg) {
            FDB_PATH = _fdbCfg;
            logTs("FDB do config.json (fdbPath salvo pelo usuário): " + FDB_PATH);
        } else {
            FDB_PATH = detectFdbPath();
        }
        FDB_HOST = (cfg.fbHost && String(cfg.fbHost).trim()) ? String(cfg.fbHost).trim() : "127.0.0.1";
        logTs("FDB não encontrado localmente → tentando host de rede: "+FDB_HOST);
    }
}
var FDB = FDB_HOST+":"+FDB_PATH;

var _maquinaIPCfg    = (cfg.maquinaIP && String(cfg.maquinaIP).trim()) ? String(cfg.maquinaIP).trim() : null;
var _maquinaIPDetect = detectLocalIP(FDB_HOST);
var _maquinaIP       = _maquinaIPDetect || _maquinaIPCfg || null;
var BIND_ADDR        = _maquinaIP ? "0.0.0.0" : "127.0.0.1";

// ---------------------------------------------------------------------------
// Limite de tamanho para corpos de requisições POST — protege contra DoS.
// ---------------------------------------------------------------------------
var MAX_BODY_BYTES = 512 * 1024; // 512 KB — suficiente para todos os payloads esperados

// Lê o corpo de uma requisição com limite de tamanho.
// Chama cb(null, bodyString) em sucesso ou cb(err) se exceder o limite.
var lerBodySeguro = function(req, cb) {
    var chunks = [], totalBytes = 0, _cbCalled = false;
    var _done = function(err, val) {
        if (_cbCalled) return; // previne double-callback: req.destroy → cb(err) + req.on("error")
        _cbCalled = true;
        cb(err, val);
    };
    req.on("data", function(chunk) {
        if (_cbCalled) return; // descarta chunks após limite excedido
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
            try { req.destroy(); } catch(_) {}
            _done(new Error("Payload muito grande (máx " + MAX_BODY_BYTES + " bytes)."));
            return;
        }
        chunks.push(chunk);
    });
    req.on("end",   function()  { _done(null, Buffer.concat(chunks).toString("utf8")); });
    req.on("error", function(e) { _done(e); });
};

// maquinaIP detectado sempre sobrescreve config.json — garante que mudanças
// de rede (DHCP, troca de adapter) sejam sempre refletidas no próximo boot.
if (_maquinaIPDetect) {
    try { updateConfigKey("maquinaIP", _maquinaIPDetect); } catch(e) {}
    logTs("maquinaIP detectado e salvo: " + _maquinaIPDetect +
          (_maquinaIPCfg && _maquinaIPCfg !== _maquinaIPDetect ? " (substituiu: " + _maquinaIPCfg + ")" : ""));
} else if (_maquinaIPCfg) {
    logTs("maquinaIP não detectado — usando config como fallback: " + _maquinaIPCfg);
} else {
    logTs("AVISO: maquinaIP não detectado e não configurado — acesso externo desabilitado");
}

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------
var cache       = Object.create(null);

// Fila de notificações de correção de horário — consumida pelo browser via /api/status.
// O servidor empurra mensagens aqui; o poll do browser exibe como toast.
//
// BUG FIX (auditoria v2.5.0 — ESTADO COMPARTILHADO): antes, a leitura em
// /api/status fazia splice(0) — um "consume-once" GLOBAL. Em lojas com mais
// de uma tela/aba abertas ao mesmo tempo (cenário comum, é o próprio motivo
// de existir um relatório em rede), a primeira aba cujo poll chegasse ao
// servidor esvaziava a fila inteira; todas as outras telas conectadas
// simplesmente NUNCA viam o toast de "hora corrigida", sem nenhum erro ou
// indício de que a notificação existiu. Agora cada entrada carrega um
// timestamp (ts) e /api/status devolve (sem remover) tudo que for mais
// recente que _CORRECOES_JANELA_MS — toda tela conectada dentro dessa
// janela recebe a notificação pelo menos uma vez. Entradas mais antigas que
// _CORRECOES_TTL_MS são podadas no próprio push, então o array nunca cresce
// sem limite (também protegido pelo teto de 50 itens já existente).
var _correcoesPendentes  = [];
// PRECISÃO FIX (v2.6.5): a janela era fixa em 3000ms, mas POLL_INTERVAL é
// configurável pelo usuário e só valida um mínimo de 100ms — nada impede
// alguém de configurar 5000ms na tela de configurações. Nesse caso a
// notificação expiraria ANTES do próximo poll do browser e o toast seria
// perdido de vez, silenciosamente (a versão original, com splice(0)
// consume-once, nunca perdia — só entregava a uma única aba). Agora a
// janela acompanha o POLL_INTERVAL real: no mínimo 3s, e sempre pelo menos
// 3 ciclos de poll, garantindo que toda aba conectada tenha chance de ver.
var _CORRECOES_JANELA_MS = Math.max(3000, POLL_INTERVAL * 3);
// TTL sempre com folga sobre a janela — entradas só são descartadas bem
// depois de já terem sido entregues a todas as abas.
var _CORRECOES_TTL_MS    = _CORRECOES_JANELA_MS + 5000;
// Contador monotônico — usado pelo cliente para deduplicar (ver _poll no HTML).
// Não usar apenas 'ts' (Date.now()) para isso: duas correções diferentes (ex:
// nfce e pagament) podem ser empurradas no mesmo milissegundo dentro do mesmo
// ciclo de pollStatus, e nesse caso ts sozinho não distingue uma da outra.
var _correcoesSeq = 0;
var _pushCorrecao = function(msg, cor) {
    var agora = Date.now();
    // Poda oportunista de entradas velhas — evita que o array cresça para sempre
    // em uma sessão de dias sem nunca reiniciar o servidor.
    _correcoesPendentes = _correcoesPendentes.filter(function(c) { return (agora - c.ts) < _CORRECOES_TTL_MS; });
    if (_correcoesPendentes.length < 50) {
        _correcoesPendentes.push({ msg: msg, cor: cor, reload: true, ts: agora, seq: ++_correcoesSeq });
    }
};

// Evict de entradas antigas do cache — mantém no máximo MAX_CACHE_ENTRIES períodos.
// Entradas de hoje e entradas ainda gerando nunca são removidas.
var MAX_CACHE_ENTRIES = 30;
var _evictarCacheAntigo = function() {
    try {
        var dh = hoje();
        var chaves = Object.keys(cache).filter(function(k) {
            return k !== dh && !(cache[k] && cache[k].gerando);
        });
        if (chaves.length <= MAX_CACHE_ENTRIES) return;
        // Remove as mais antigas (ordem lexicográfica funciona para chaves ISO e "ISO|ISO")
        chaves.sort();
        var remover = chaves.slice(0, chaves.length - MAX_CACHE_ENTRIES);
        remover.forEach(function(k) { delete cache[k]; });
    } catch(e) {}
};

// qt/total = totais combinados (compat. com SSE e arScript)
// g / nfc / nf = por tipo — usados pelo poll para detectar > e < por tipo
var statusAtual = {
    qt:-1, total:-1, ts:0,
    g:   {qt:-1, tot:-1},  // gerencial  (modelo=99)
    nfc: {qt:-1, tot:-1},  // NFC-e      (modelo=65)
    nf:  {qt:-1, tot:-1}   // NF-e       (modelo=55)
};
// Timestamp da última mudança detectada (fast-poll ou pollStatus).
// Incluído em /api/status como "changeTs" para o browser comparar com
// _loadTs (quando a página foi carregada). Se changeTs > _loadTs → há
// dados mais novos → reload. Resolve o caso em que _q===d.qt porque o
// HTML já estava atualizado quando o browser carregou a página.
var _statusChangeTs = 0;
var dbStatus    = {ok:false,ip:FDB_HOST,erro:null,scanCompleto:false,scanning:false};

// ---------------------------------------------------------------------------
// Hora-fixada cache — persiste correções de horário entre execuções.
// Escrito por este arquivo (gerencial) e por gerar-relatorio-html.js (nfc-e,
// nf-e e gerencial). Chave: "YYYY-MM-DD|numero". Valor: {tipo, hora}.
//
// FORMATO FIX (ajuste solicitado — ordenação + bug de gerenciais ignorados):
//   1) BUG CONCRETO ENCONTRADO: o valor era antes uma STRING solta ("OK" ou
//      "HH:MM"/"HH:MM:SS"), sem informação de tipo. Este arquivo gravava a
//      marca de "dentro da tolerância" como "ok" (minúsculo), mas
//      gerar-relatorio-html.js comparava com "OK" (maiúsculo, ===). Toda
//      venda gerencial marcada aqui como tolerável era lida do outro lado
//      como se "ok" fosse a PRÓPRIA HORA (a comparação falhava, caindo no
//      branch seguinte, que atribui o valor do cache direto a finalHora) —
//      corrompendo a hora exibida e, na prática, fazendo a venda nunca mais
//      ser reavaliada corretamente. HORA_CACHE_OK agora é uma constante
//      única usada nas duas pontas, e a comparação passou a ser
//      case-insensitive como defesa adicional (ver _normalizarEntradaHoraCache).
//   2) Sem informação de tipo não era possível ordenar o arquivo por
//      categoria. _ordenarHoraCache() (chamada sempre antes de salvar)
//      reordena as chaves: nfc-e primeiro, depois nf-e, depois gerencial —
//      ascendente por hora dentro de cada grupo. Como JSON.stringify
//      preserva a ordem de inserção das chaves do objeto, o arquivo em disco
//      reflete sempre essa ordem, independentemente da ordem em que as
//      correções foram descobertas ao longo do dia (poll não garante ordem).
//   3) Valores de hora agora são sempre gravados como "HH:MM" (sem
//      segundos) — antes este arquivo gravava "HH:MM:SS" enquanto
//      gerar-relatorio-html.js gravava "HH:MM", uma inconsistência de
//      formato entre vendas do mesmo horário.
// Compatibilidade: entradas antigas (string solta, de antes desta versão)
// continuam sendo lidas corretamente por _normalizarEntradaHoraCache — não é
// necessário migrar o arquivo manualmente, ele se reescreve sozinho no novo
// formato à medida que cada entrada é reprocessada.
// ---------------------------------------------------------------------------
var HORA_CACHE_OK = "OK";
// Marcadores de gerenciais que NÃO recebem hora fixada (v2.7.1). Existem para
// que essas vendas apareçam no cache e a numeração não fique com buracos,
// deixando claro no próprio arquivo POR QUE aquele número não tem horário.
// Importante: são MARCADORES, não horários — quem lê o cache precisa tratar
// como "não use isto como hora" (ver a checagem de formato HH:MM no
// gerar-relatorio-html.js, que aceita apenas HH:MM e ignora o resto).
var HORA_CACHE_CANCELADA  = "CANCELADA";   // cancelado = 'S'
var HORA_CACHE_CONVERTIDA = "CONVERTIDA";  // cancelado = 'T' — virou NFC-e ou NF-e
var HORA_CACHE_SEM_VALOR  = "SEM VALOR";   // total <= 0 (não cancelada nem convertida)

// Aceita tanto o formato antigo (string solta) quanto o novo ({tipo,hora}) —
// nunca lança, entrada inesperada vira tipo "desconhecido" em vez de
// derrubar o poll. "OK" é sempre normalizado para a grafia exata de
// HORA_CACHE_OK, não-sensível a maiúsculas/minúsculas.
var _normalizarEntradaHoraCache = function(bruto) {
    if (bruto && typeof bruto === "object" && !Array.isArray(bruto)) {
        var horaObj = String(bruto.hora == null ? "" : bruto.hora).trim();
        return {
            tipo: String(bruto.tipo || "desconhecido"),
            hora: horaObj.toUpperCase() === HORA_CACHE_OK ? HORA_CACHE_OK : horaObj
        };
    }
    var s = String(bruto == null ? "" : bruto).trim();
    return { tipo: "desconhecido", hora: s.toUpperCase() === HORA_CACHE_OK ? HORA_CACHE_OK : s };
};

// Ordem pedida (v2.6.9): gerencial primeiro, depois nfc-e, por último nf-e.
var _HORA_CACHE_TIPO_RANK = { gerencial: 0, nfce: 1, nfe: 2 };

// Extrai o número do documento a partir da chave "YYYY-MM-DD|numero".
// Retorna null se não conseguir parsear como inteiro (chave em formato
// inesperado) — nesse caso o desempate final por string cuida do resto.
var _numeroDaChaveHoraCache = function(chave) {
    var partes = String(chave).split("|");
    var n = parseInt(partes.length > 1 ? partes[1] : chave, 10);
    return isNaN(n) ? null : n;
};

var _ordenarHoraCache = function(cacheObj) {
    var chaves = Object.keys(cacheObj);
    chaves.sort(function(a, b) {
        var ea = _normalizarEntradaHoraCache(cacheObj[a]);
        var eb = _normalizarEntradaHoraCache(cacheObj[b]);
        var ra = _HORA_CACHE_TIPO_RANK.hasOwnProperty(ea.tipo) ? _HORA_CACHE_TIPO_RANK[ea.tipo] : 99;
        var rb = _HORA_CACHE_TIPO_RANK.hasOwnProperty(eb.tipo) ? _HORA_CACHE_TIPO_RANK[eb.tipo] : 99;
        if (ra !== rb) return ra - rb;
        // AJUSTE (v2.6.9): dentro do mesmo tipo, ordem DECRESCENTE por número do
        // documento (do maior para o menor) — o mais recente primeiro, já que o
        // número é sequencial por natureza.
        var na = _numeroDaChaveHoraCache(a);
        var nb = _numeroDaChaveHoraCache(b);
        if (na !== null && nb !== null && na !== nb) return nb - na;
        return a < b ? 1 : (a > b ? -1 : 0); // desempate final determinístico (também decrescente)
    });
    var ordenado = {};
    chaves.forEach(function(k) { ordenado[k] = cacheObj[k]; });
    return ordenado;
};

var _horaFixadaCache = (function() {
    try {
        var raw = fs.readFileSync(HORA_FIXADA_CACHE, "utf8").replace(/^\uFEFF/, "");
        var obj = JSON.parse(raw);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch(e) {}
    return {};
})();

// _salvarHoraFixadaCache() → debounce de 500 ms (uso normal).
// _salvarHoraFixadaCache.flush() → grava imediatamente (usado no exit).
// PERDA FIX: sem o flush, correções gravadas nos últimos 500 ms antes de um
// restart eram perdidas e as mesmas notas voltavam a ser "corrigidas" no boot.
var _salvarHoraFixadaCache = (function() {
    var _timer = null;
    var _gravar = function() {
        try {
            // ORDENAÇÃO FIX: reordena por (tipo, hora) antes de cada gravação —
            // ver comentário completo acima de _ordenarHoraCache.
            _horaFixadaCache = _ordenarHoraCache(_horaFixadaCache);
            if (!_gravarArquivoAtomico(HORA_FIXADA_CACHE, JSON.stringify(_horaFixadaCache, null, 2))) {
                logTs("WARN _salvarHoraFixadaCache: falha ao gravar o cache de hora fixada.");
            }
        } catch(e) {
            logTs("WARN _salvarHoraFixadaCache: " + e.message);
        }
    };
    var api = function() {
        clearTimeout(_timer);
        _timer = setTimeout(_gravar, 500);
    };
    api.flush = function() { clearTimeout(_timer); _gravar(); };
    return api;
})();

// ---------------------------------------------------------------------------
// Flag de aguardo de seleção manual do FDB
// Ativado quando todas as tentativas automáticas falham.
// ---------------------------------------------------------------------------
var _aguardandoFdbManual = false;

// ---------------------------------------------------------------------------
// SSE — clientes conectados
// ---------------------------------------------------------------------------
var sseClients   = [];
var sseIdCounter = 0;

var broadcastSSE = function(data) {
    var msg  = "data: "+JSON.stringify(data)+"\n\n";
    var vivos = [];
    sseClients.forEach(function(c){
        var ok = false;
        try {
            // res.destroyed cobre o caso em que o socket caiu mas req.on("close")
            // ainda não rodou — write() nesse estado não lança, só falha silenciosa.
            if (!c.res.destroyed && c.res.writable !== false) {
                c.res.write(msg);
                try { if (c.res.socket) { c.res.socket.uncork && c.res.socket.uncork(); } } catch(_f) {}
                ok = true;
            }
        } catch(e) { ok = false; }
        if (ok) {
            vivos.push(c);
        } else {
            // LEAK FIX: cliente descartado aqui nunca passava por req.on("close"),
            // então o setInterval de heartbeat continuava rodando para sempre.
            try { if (c.hb) clearInterval(c.hb); } catch(_h) {}
            try { c.res.end(); } catch(_e) {}
        }
    });
    sseClients = vivos;

    return vivos.length;
};

// ---------------------------------------------------------------------------
// Aguarda FDB ficar acessível
// ---------------------------------------------------------------------------
var aguardarFDB = function(onPronto) {
    var MAX_RETRY = 120;
    var RETRY_MS  = 15000;
    var n = 0;

    var tentarHostAtual = function() {
        n++;
        logTs("Verificando banco [" + n + "/" + MAX_RETRY + "] em " + FDB_HOST + "...");
        testarFdb(FDB_HOST, FDB_PATH, function(ok, erro) {
            if (ok) {
                logTs("Banco OK em " + FDB_HOST + " (tentativa " + n + ").");
                dbStatus = {ok:true, ip:FDB_HOST, erro:null, scanCompleto:true, scanning:false};
                updateConfigKey("fbHost", FDB_HOST);
                onPronto(true);
                return;
            }
            if (n < MAX_RETRY) {
                logTs("Banco indisponível (" + (erro||"timeout") + "). Próxima tentativa em "+(RETRY_MS/1000)+"s...");
                setTimeout(tentarHostAtual, RETRY_MS);
            } else {
                logTs("Máximo de tentativas atingido. Iniciando scan de rede...");
                descobrirIPFirebird(function(scanOk) { onPronto(scanOk); });
            }
        });
    };

    var _tryLocal = function(onLocalDone) {
        var _local = detectFdbLocal();
        if (!_local || FDB_HOST === "127.0.0.1") {
            onLocalDone(false);
            return;
        }
        logTs("Arquivo FDB encontrado localmente (" + _local + ") — testando 127.0.0.1 antes da rede...");
        testarFdb("127.0.0.1", _local, function(okLocal) {
            if (okLocal) {
                logTs("Banco local OK em 127.0.0.1! Trocando de " + FDB_HOST + " para local.");
                FDB_PATH = _local;
                FDB_HOST = "127.0.0.1";
                FDB      = "127.0.0.1:" + _local;
                dbStatus = {ok:true, ip:"127.0.0.1", erro:null, scanCompleto:true, scanning:false};
                updateConfigKey("fbHost", "127.0.0.1");
                onLocalDone(true);
            } else {
                logTs("Arquivo local existe mas Firebird local não respondeu — tentando host de rede " + FDB_HOST + "...");
                onLocalDone(false);
            }
        });
    };

    _tryLocal(function(localOk) {
        if (localOk) { onPronto(true); return; }

        testarFdb(FDB_HOST, FDB_PATH, function(okImediato, erroImediato) {
            if (okImediato) {
                dbStatus = {ok:true, ip:FDB_HOST, erro:null, scanCompleto:true, scanning:false};
                updateConfigKey("fbHost", FDB_HOST);
                onPronto(true);
            } else {
                logTs("Banco não respondeu em " + FDB_HOST + " (" + (erroImediato||"timeout") + "). Tentando scan de rede...");
                descobrirIPFirebird(function(scanOk) {
                    if (scanOk) {
                        onPronto(true);
                    } else {
                        logTs("Nenhum servidor Firebird encontrado. Aguardando... (retry a cada " + (RETRY_MS/1000) + "s)");
                        setTimeout(tentarHostAtual, RETRY_MS);
                    }
                });
            }
        });
    });
};
var detectSubnet=function(){
    var ifaces=os.networkInterfaces();
    for(var n in ifaces){
        var list=ifaces[n];
        for(var i=0;i<list.length;i++){
            var a=list[i];
            var isV4=(a.family==="IPv4"||a.family===4);
            if(isV4&&!a.internal){
                var p=a.address.split(".");
                if(p[0]!=="127")return p[0]+"."+p[1]+"."+p[2];
            }
        }
    }
    return null;
};

var scanFirebird=function(subnet,callback){
    logTs("Escaneando "+subnet+".1-254 na porta "+FIREBIRD_PORT+"...");
    var found=[],total=254,done=0,active=0,MAX=_SCAN_CONCORRENCIA_MAX,queue=[];
    for(var i=1;i<=254;i++)queue.push(subnet+"."+i);
    var checkFim=function(){if(done===total)callback(found);else launch();};
    var launch=function(){
        while(active<MAX&&queue.length>0){
            active++;
            (function(ip){
                var sock=new net.Socket(),resolved=false;
                var finish=function(ok){
                    if(resolved)return;resolved=true;
                    sock.destroy();
                    if(ok)found.push(ip);
                    active--;done++;checkFim();
                };
                sock.setTimeout(450);
                sock.on("connect",function(){finish(true);});
                sock.on("error",  function(){finish(false);});
                sock.on("timeout",function(){finish(false);});
                try{sock.connect(FIREBIRD_PORT,ip);}catch(e){finish(false);}
            })(queue.shift());
        }
    };
    launch();
};

var testarFdb=function(host,dbPath,cb){
    if(!Firebird){cb(false,"node-firebird nao disponivel");return;}
    var opts={host:host,port:FIREBIRD_PORT,database:dbPath,user:USER,password:PASS,
              role:null,charset:FB_CHARSET};
    // _done previne double-callback: se timeout disparar E attach responder depois,
    // apenas o primeiro vencedor chama cb; o segundo é descartado (e db.detach() é feito).
    var _done=false;
    var t=setTimeout(function(){
        if(_done)return; _done=true;
        cb(false,"Timeout 5s");
    },5000);
    Firebird.attach(opts,function(err,db){
        if(_done){
            // Timeout já disparou: descarta mas fecha conexão para não vazar
            if(!err&&db){try{db.detach();}catch(_){}}
            return;
        }
        _done=true;
        clearTimeout(t);
        if(err){cb(false,String(err.message||err));return;}
        // PRECISÃO FIX (v2.6.7): detach() sem try/catch aqui era um HANG.
        // Se ele lançasse, cb(true,null) nunca era chamado — e testarFdb é
        // usado por encontrarIPFirebird(), que varre os IPs candidatos em
        // cadeia: sem a callback, a varredura para no meio para sempre, o
        // banco nunca é dado como encontrado, dbStatus.ok nunca vira true e
        // o fast-poll nunca inicia. O servidor ficaria de pé, respondendo
        // HTTP, e simplesmente nunca detectaria venda nenhuma. Repare que a
        // linha equivalente logo acima (caminho do timeout) já tinha essa
        // proteção — esta passou despercebida. A conexão de teste já cumpriu
        // seu papel: fechá-la é best-effort e nunca deve impedir a resposta.
        try { db.detach(); } catch(_) {}
        cb(true,null);
    });
};

var encontrarIPFirebird=function(ips,cb){
    if(ips.length===0){cb(null);return;}
    var ip=ips.shift();
    testarFdb(ip,FDB_PATH,function(ok){if(ok)cb(ip);else encontrarIPFirebird(ips,cb);});
};

var descobrirIPFirebird=function(onPronto){
    dbStatus.scanning=true;dbStatus.scanCompleto=false;
    testarFdb(FDB_HOST,FDB_PATH,function(ok,erro){
        if(ok){
            logTs("Banco Firebird OK em "+FDB_HOST);
            dbStatus={ok:true,ip:FDB_HOST,erro:null,scanCompleto:true,scanning:false};
            onPronto(true);return;
        }
        logTs("Banco nao respondeu em "+FDB_HOST+" ("+erro+"). Scan de rede...");
        var subnet=detectSubnet();
        if(!subnet){
            dbStatus={ok:false,ip:null,erro:"Nao foi possivel detectar a rede local.",scanCompleto:true,scanning:false};
            onPronto(false);return;
        }
        scanFirebird(subnet,function(found){
            logTs("Hosts com porta "+FIREBIRD_PORT+": "+(found.length?found.join(", "):"nenhum"));
            if(found.length===0){
                dbStatus={ok:false,ip:null,erro:"Nenhum servidor Firebird em "+subnet+".x:"+FIREBIRD_PORT+".",scanCompleto:true,scanning:false};
                onPronto(false);return;
            }
            encontrarIPFirebird(found.slice(),function(ipOk){
                if(ipOk){
                    logTs("Banco encontrado em "+ipOk+"! Salvando...");
                    FDB_HOST=ipOk; FDB=ipOk+":"+FDB_PATH;
                    dbStatus={ok:true,ip:ipOk,erro:null,scanCompleto:true,scanning:false};
                    updateConfigKey("fbHost", ipOk);
                    onPronto(true);
                } else {
                    var ip1=found[0];
                    FDB_HOST=ip1; FDB=ip1+":"+FDB_PATH;
                    dbStatus={ok:false,ip:ip1,erro:"Porta "+FIREBIRD_PORT+" em "+ip1+" mas FDB nao respondeu.",scanCompleto:true,scanning:false};
                    onPronto(false);
                }
            });
        });
    });
};

// ---------------------------------------------------------------------------
// Extrai qt/total
// ---------------------------------------------------------------------------
var extrairStatusDoHtml = function(html) {
    var qt = 0, tot = 0;

    var mDados = html.match(/<script[^>]+id=["']dados["'][^>]*>([\s\S]*?)<\/script>/i);
    if (mDados) {
        try {
            var dados = JSON.parse(mDados[1]);
            if (dados && dados.totais) {
                qt  = Number(dados.totais.qtd   || 0);
                tot = Number(dados.totais.total  || 0);
            }
            if (!qt && dados && Array.isArray(dados.vendas)) {
                qt = dados.vendas.length;
                for (var i = 0; i < dados.vendas.length; i++) {
                    var v = dados.vendas[i];
                    tot += Number(v.total_nfce || v.total_pag || v.total || 0);
                }
            }
            return { qt: qt, tot: tot };
        } catch(e) {}
    }

    // SEGURANÇA FIX (ReDoS): a regex anterior /\[[\s\S]{0,400000}?\]/ ainda sofre
    // backtracking quadrático em HTMLs grandes com múltiplos "]" antes do fechamento
    // real do array (comum em JSON de vendas com itens aninhados). Um HTML hostil ou
    // corrompido de ~400 KB podia bloquear o event loop por segundos.
    // _extrairArrayBalanceado faz scan sequencial O(n) contando profundidade de
    // colchetes/chaves, ignorando os que estão dentro de strings — sem backtracking.
    var idxVendas = html.indexOf('"vendas"');
    if (idxVendas !== -1) {
        var idxAbre = html.indexOf("[", idxVendas);
        if (idxAbre !== -1) {
            var trechoArr = _extrairArrayBalanceado(html, idxAbre);
            if (trechoArr) {
                try {
                    var arr = JSON.parse(trechoArr);
                    qt = arr.length;
                    for (var j = 0; j < arr.length; j++) {
                        var x = arr[j];
                        // CONTRATO FIX: x.gerencial não existe em dados.vendas.
                        // Filho exporta cada venda com { total, total_nfce, total_pag }.
                        // A ordem correta é: total_nfce (NFC-e/NF-e) → total_pag (gerencial) → total (consolidado).
                        tot += Number(x.total_nfce || x.total_pag || x.total || 0);
                    }
                } catch(e) {
                    var n = html.match(/"numero"\s*:/g);
                    if (n) qt = n.length;
                }
            }
        }
    }
    return { qt: qt, tot: tot };
};

// Extrai um array JSON balanceado a partir do índice do "[" de abertura — O(n),
// sem backtracking. Respeita strings (ignora colchetes dentro de "...") e escapes.
// Retorna a substring "[...]" completa ou null se o array não fechar dentro do html.
var _extrairArrayBalanceado = function(html, idxAbre) {
    var profundidade = 0;
    var dentroDeString = false;
    var escapando = false;
    for (var i = idxAbre; i < html.length; i++) {
        var ch = html[i];
        if (escapando) { escapando = false; continue; }
        if (dentroDeString) {
            if (ch === "\\") { escapando = true; }
            else if (ch === '"') { dentroDeString = false; }
            continue;
        }
        if (ch === '"') { dentroDeString = true; continue; }
        if (ch === "[") { profundidade++; }
        else if (ch === "]") {
            profundidade--;
            if (profundidade === 0) return html.slice(idxAbre, i + 1);
        }
    }
    return null; // array não fechou — HTML truncado/corrompido
};

// ---------------------------------------------------------------------------
// Rastreamento de PIDs dos processos filhos
// Usado pelo /api/restart para matar todos antes de sair.
// ---------------------------------------------------------------------------
var _spawnedPids = [];

// ---------------------------------------------------------------------------
// Timeout máximo para o processo filho gerar o relatório.
// Padrão 10 s, configurável entre 5 s e 120 s via spawnTimeoutMs no config.json.
// Valores fora do range são silenciosamente clampeados (não rejeitados).
// NOTA: o gerar-relatorio-html.js tem query timeout interno de 80 s/query e
// global de 90 s. Defina spawnTimeoutMs maior que o tempo real esperado das queries.
var _SPAWN_TIMEOUT_MS = SPAWN_TIMEOUT_CFG;
var _gerarTentativas  = Object.create(null); // chave → nº tentativas consecutivas
// _gerarIdCounter: ID monotônico por chave — incrementado em cada gerarEmBackground.
// Em proc.on("close"), ID divergente = geração supersedida (kill-and-restart) → descarta.
var _gerarIdCounter   = Object.create(null); // chave → ID da geração atual
// _gerandoKill: função kill da geração em andamento. _fpPoll usa para matar geração
// velha imediatamente ao detectar mudança, sem esperar os ~300ms restantes.
var _gerandoKill      = Object.create(null); // chave → function() mata o proc atual

// ---------------------------------------------------------------------------
// Gerador em background — com timeout e retry automático
// ---------------------------------------------------------------------------
var gerarEmBackground=function(inicio,fim,chave,_pollTriggered){
    var ent=cache[chave];
    if(ent&&ent.gerando)return;

    // Snapshot do HTML anterior — usado em proc.on("close") para detectar
    // mudanças (subida OU queda) sem depender de statusAtual, que pode ser
    // atualizado pelo pollStatus DURANTE a geração (race condition):
    //   ex: agendarRegen gera qt=10 → poll detecta cancelamento → statusAtual.qt=9
    //       → proc.on("close") compara 9 vs statusAtual(9) → false → sem SSE → BUG.
    // Com snapshot de ent.qt (qt do HTML anterior), a comparação é sempre correta.
    var _qtSnapshot  = (ent && typeof ent.qt  === "number" && ent.qt  >= 0) ? ent.qt  : -1;
    var _totSnapshot = (ent && typeof ent.tot === "number" && ent.tot >= 0) ? ent.tot : -1;

    // Timestamp de início — marca quando esta geração começou.
    // Em proc.on("close"), se statusAtual.ts > _genStartTs significa que
    // _fpPoll ou pollStatus escreveu dados MAIS FRESCOS durante os ~300ms de geração.
    // Nesse caso: não sobrescreve statusAtual com o HTML potencialmente antigo.
    var _genStartTs = Date.now();

    // ID desta geração — se _gerarIdCounter[chave] divergir em proc.on("close"),
    // significa que _fpPoll iniciou uma geração mais nova (kill-and-restart): descarta.
    _gerarIdCounter[chave] = (_gerarIdCounter[chave] || 0) + 1;
    var _meuId = _gerarIdCounter[chave];

    // Evita crescimento ilimitado do cache de períodos
    _evictarCacheAntigo();

    // Controle de tentativas — incrementa ANTES de escrever no cache
    _gerarTentativas[chave] = (_gerarTentativas[chave] || 0) + 1;
    var _tentativa = _gerarTentativas[chave];
    // MAX_TENTATIVAS_SPAWN definido como constante global no topo do arquivo
    var MAX_TENTATIVAS = MAX_TENTATIVAS_SPAWN;

    cache[chave]={html:null,gerando:true,erro:null,qt:0,tot:0,tentativa:_tentativa};

    var label=(inicio===fim)?isoParaBR(inicio):(isoParaBR(inicio)+" a "+isoParaBR(fim));
    // Geração iniciada — logs de progresso controlados por _queryLogsHoje.

    var _tmpSafe = String(chave).replace(/[^a-zA-Z0-9_\-]/g,"_").slice(0,80);
    var _tmpFile = path.join(TMP_DIR, "relatorio_srv_" + _tmpSafe + ".html");

    // Passa o timeout configurado para o filho via --timeout.
    // Filho usa este valor para calibrar _tGlobal e _tQuery em vez de calcular sozinho.
    var nArgs=[SCRIPT,"--fdb",FDB,"--data-inicio",inicio,"--data-fim",fim,
               "--saida",_tmpFile,"--user",USER,"--pass",PASS,
               "--timeout",String(_SPAWN_TIMEOUT_MS)];
    // Repassa o nível de log ao filho: sem "--debug" ele omite a cronometragem
    // por etapa (7 linhas por geração), que é ruído no uso normal.
    if (LOG_DEBUG) nArgs.push("--debug");
    // CRASH FIX: spawn() pode lançar de forma SÍNCRONA (EMFILE por esgotamento de
    // descritores, ENOMEM, execPath inválido). Como gerarEmBackground é chamado
    // direto de dentro do handler HTTP (rotas / e /periodo), a exceção subia até
    // o handler e derrubava a request — pior: cache[chave] ficava travado em
    // {gerando:true} para sempre, deixando a página presa no paginaLoading.
    var proc = null;
    try {
        proc = spawn(process.execPath, nArgs, {stdio:["ignore","pipe","pipe"]});
    } catch(spawnErr) {
        logTs("ERRO spawn síncrono ("+label+"): "+(spawnErr && spawnErr.message || spawnErr));
        cache[chave] = {html:null, gerando:false, erro:"Falha ao iniciar o gerador: "+(spawnErr && spawnErr.message || String(spawnErr))};
        _gerarTentativas[chave] = 0;
        delete _gerandoKill[chave];
        return;
    }
    if (proc.pid) {
        _spawnedPids.push(proc.pid);
    } else {
        logTs("WARN: spawn sem PID para "+label+" — processo pode ter falhado ao iniciar.");
    }

    // Mata o processo filho de forma assíncrona — NÃO bloqueia o event loop.
    // execSync("taskkill") bloqueava até 3000ms, impedindo qualquer poll do browser
    // durante o kill e fazendo o estado matando:true ser invisível ao usuário.
    // Agora usa spawn (async) no Windows e SIGKILL (não-bloqueante) no Unix.
    // onKilled() é chamado quando o kill concluiu (ou após fallback de 5 s).
    var _matarProcessoFilho = function(onKilled) {
        if (!proc.pid) { if (onKilled) setTimeout(onKilled, 0); return; }
        if (process.platform === "win32") {
            var _tkFeito = false;
            var _tkFallback = setTimeout(function() {
                if (_tkFeito) return;
                _tkFeito = true;
                logTs("WARN: taskkill PID "+proc.pid+" não respondeu em 5 s — prosseguindo.");
                if (onKilled) onKilled();
            }, 5000);
            try {
                var tkProc = childProc.spawn(
                    "taskkill", ["/F", "/T", "/PID", String(proc.pid)],
                    {stdio: "ignore"}
                );
                tkProc.on("close", function() {
                    if (_tkFeito) return;
                    _tkFeito = true;
                    clearTimeout(_tkFallback);
                    if (onKilled) onKilled();
                });
                tkProc.on("error", function(e) {
                    if (_tkFeito) return;
                    _tkFeito = true;
                    clearTimeout(_tkFallback);
                    logTs("WARN taskkill erro: " + e.message);
                    if (onKilled) onKilled();
                });
            } catch(e) {
                clearTimeout(_tkFallback);
                logTs("WARN _matarProcessoFilho spawn falhou: " + e.message);
                if (onKilled) onKilled();
            }
        } else {
            try { proc.kill("SIGKILL"); } catch(_) {}
            if (onKilled) setTimeout(onKilled, 0);
        }
    };

    // Expõe a função kill desta geração para o _fpPoll usar no kill-and-restart.
    // Quando _fpPoll detectar mudança com gerando=true, chama _gerandoKill[chave]()
    // para matar esta geração imediatamente e iniciar nova com dados frescos.
    _gerandoKill[chave] = _matarProcessoFilho;

    // RACE FIX (v2.4.1): remove de _gerandoKill APENAS se o slot ainda apontar
    // para esta geração. Antes, o close handler de uma geração supersedida fazia
    // `delete _gerandoKill[chave]` cego e apagava a função kill da geração NOVA
    // que o fast-poll acabara de registrar — desarmando o kill-and-restart e
    // fazendo a próxima venda esperar o timeout inteiro para ser detectada.
    var _liberarKillProprio = function() {
        if (_gerandoKill[chave] === _matarProcessoFilho) delete _gerandoKill[chave];
    };

    // Flag para evitar que o close handler execute após timeout
    var _procEncerrado = false;

    // Hard-timeout do processo filho — mata e relança se travar no banco.
    // CORREÇÃO 1: matando:true é setado ANTES do kill, para que o browser
    //             veja o estado no próximo poll (800 ms) sem depender do kill ter concluído.
    // CORREÇÃO 2: kill é assíncrono (spawn, não execSync) — event loop livre durante o kill.
    // CORREÇÃO 3: retry só é agendado APÓS o kill concluir (callback de _matarProcessoFilho).
    var _spawnTimer = setTimeout(function() {
        if (_procEncerrado) return;
        _procEncerrado = true;
        logTs("Timeout "+(_SPAWN_TIMEOUT_MS/1000)+"s gerando "+label+" — matando processo e refazendo.");

        // Seta matando:true IMEDIATAMENTE — browser vê no próximo poll sem esperar o kill
        if (_tentativa < MAX_TENTATIVAS) {
            cache[chave] = {html:null, gerando:false, erro:null, qt:0, tot:0, matando:true, tentativa:_tentativa};
        }

        _matarProcessoFilho(function() {
            // Kill concluiu (ou fallback de 5 s) — agora limpa e agenda retry
            try { if (fs.existsSync(_tmpFile)) fs.unlinkSync(_tmpFile); } catch(_) {}
            if (proc.pid) _spawnedPids = _spawnedPids.filter(function(p){ return p !== proc.pid; });
            if (_tentativa < MAX_TENTATIVAS) {
                // matando:true já foi setado antes do kill — browser teve tempo de ver.
                // Aguarda 3200ms (4× poll de 800ms) antes de relançar.
                setTimeout(function() { gerarEmBackground(inicio, fim, chave, _pollTriggered); }, 3200);
            } else {
                logTs("ERRO: "+MAX_TENTATIVAS+" tentativas falharam para "+label+". Abortando.");
                cache[chave] = {html:null, gerando:false, erro:"Geração falhou após "+MAX_TENTATIVAS+" tentativas (timeout de "+(_SPAWN_TIMEOUT_MS/1000)+"s cada)."};
                _gerarTentativas[chave] = 0;
                // LEAK/BUG FIX: sem isso a função kill deste processo (já morto)
                // permanecia registrada. Se o SO reciclasse o PID, um kill futuro
                // do fast-poll executaria taskkill /F /T contra processo alheio.
                _liberarKillProprio();
            }
        });
    }, _SPAWN_TIMEOUT_MS);

    // Roteia stdout/stderr do filho pelo console.log do servidor.
    // ROBUSTEZ FIX: proc.stdout/proc.stderr podem ser null se o SO recusar a
    // criação dos pipes — acessar .on() nesse caso lançava TypeError dentro do
    // handler HTTP. Os blocos abaixo só são instalados se os streams existirem.
    var _stdoutBuf = "";
    if (proc.stdout) proc.stdout.on("data", function(d) {
        _stdoutBuf += d.toString();
        var lines = _stdoutBuf.split("\n");
        _stdoutBuf = lines.pop(); // guarda linha incompleta
        lines.forEach(function(l) {
            var t = l.trim();
            if (!t) return;
            // Linhas ">> arquivo gravado:" eram tratadas por um bloco removido
            // que causava confusão — agora caem no filtro isPrimeiraVez abaixo.
            // Linhas de conexão e progresso somente na 1ª geração do dia
            var isPrimeiraVez =
                t.charAt(0) === ">" ||
                t.indexOf("OK:") === 0 ||
                t.indexOf("Conectando em:") === 0 ||
                t.indexOf("Conectado!") === 0;
            if (isPrimeiraVez) {
                // Cronometragem de queries e caminho do HTML gerado sao rotina —
                // relevantes so quando se investiga desempenho (ver logDebug).
                if (!_queryLogsHoje) logDebug(t);
            }
        });
    });
    // CORREÇÃO: stderr do filho passava direto para process.stderr sem ser gravado no
    // relatorio.log — erros do gerar-relatorio-html.js (ex: query timeout interno,
    // unhandledRejection) ficavam invisíveis no log. Agora passam por logToFile().
    if (proc.stderr) proc.stderr.on("data", function(d) {
        var msg = d.toString().trim();
        if (msg) logTs("[filho stderr] " + msg);
        try { process.stderr.write(d); } catch(_) {}
    });


    proc.on("error",function(e){
        if (_procEncerrado) return;
        _procEncerrado = true;
        clearTimeout(_spawnTimer);
        logTs("ERRO spawn: "+e.message);
        cache[chave]={html:null,gerando:false,erro:"Falha ao iniciar node: "+e.message};
        _gerarTentativas[chave] = 0;
        // Remove o PID da lista e libera a referência de kill desta geração.
        if (proc.pid) _spawnedPids = _spawnedPids.filter(function(p){ return p !== proc.pid; });
        _liberarKillProprio();
    });
    proc.on("close",function(code){
        if (_procEncerrado) return; // timeout já tratou este processo
        _procEncerrado = true;
        clearTimeout(_spawnTimer);
        // Flush de qualquer conteúdo restante no buffer (linha sem \n final)
        if (_stdoutBuf.trim()) { logTs(_stdoutBuf.trim()); }
        _stdoutBuf = "";
        if (proc.pid) _spawnedPids = _spawnedPids.filter(function(p){ return p !== proc.pid; });

        // Verifica se esta geração ainda é a ativa.
        // _fpPoll pode ter iniciado uma geração mais nova (kill-and-restart) enquanto
        // este processo rodava — nesse caso o resultado aqui é obsoleto: descarta.
        if (_gerarIdCounter[chave] !== _meuId) {
            logDebug("Geração " + chave + " #" + _meuId + " superada por #" + _gerarIdCounter[chave] + " — descartando.");
            _liberarKillProprio(); // NUNCA remove a função kill da geração nova
            try { if (fs.existsSync(_tmpFile)) fs.unlinkSync(_tmpFile); } catch(_) {}
            return;
        }
        _liberarKillProprio(); // limpa referência — geração concluída

        _gerarTentativas[chave] = 0; // sucesso ou erro definitivo — zera contador
        try {
        if(code!==0){
            var msg="Script terminou com codigo "+code+". Verifique se o Firebird esta rodando.";
            logTs("ERRO: "+msg);cache[chave]={html:null,gerando:false,erro:msg};return;
        }
        if(!fs.existsSync(_tmpFile)){
            cache[chave]={html:null,gerando:false,erro:"Arquivo de saida nao criado."};return;
        }
        var html;
        try{html=fs.readFileSync(_tmpFile,"utf8");}
        catch(e){cache[chave]={html:null,gerando:false,erro:"Erro lendo HTML: "+e.message};return;}
        try{fs.unlinkSync(_tmpFile);}catch(_){}

        var st   = extrairStatusDoHtml(html);
        var qt   = st.qt, tot = st.tot;
        var ehHje= (inicio===fim && inicio===hoje());
        // Polling do browser sincronizado com POLL_INTERVAL — garante que se o SSE
        // falhar, o browser detecta a mudança no mesmo ritmo do servidor.
        var pollMs = POLL_INTERVAL;

        // Marca que já logamos as linhas de progresso hoje — próximas gerações ficam silenciosas
        if (!_queryLogsHoje) _queryLogsHoje = true;

        var _statusChanged = false;
        if (ehHje && _qtSnapshot >= 0) {
            // Compara novo HTML contra snapshot do HTML anterior (não statusAtual):
            // statusAtual pode já ter sido atualizado pelo pollStatus durante a geração,
            // tornando a comparação qt===statusAtual.qt sempre verdadeira e perdendo o evento.
            if (qt !== _qtSnapshot || Math.abs(tot - _totSnapshot) > 0.005) {
                logTs("Dados alterados: " + _descreverMudanca(_qtSnapshot, qt, _totSnapshot, tot));
                _statusChanged = true;
            }
        }

        var SC = "</" + "script>";
        var arScript =
            "<script>(function(){" +
            // ── Handlers globais (sempre — relatório hoje e histórico) ─────────
            "window.onerror=function(msg,src,line,col,err){" +
            "try{fetch('/api/log-error',{method:'POST',headers:{'Content-Type':'application/json'}," +
            "body:JSON.stringify({msg:String(msg),src:String(src||''),line:line,col:col," +
            "stack:err&&err.stack?String(err.stack):''})});}catch(_){}" +
            "};" +
            "window.onunhandledrejection=function(ev){" +
            "try{var r=ev&&ev.reason;fetch('/api/log-error',{method:'POST'," +
            "headers:{'Content-Type':'application/json'}," +
            "body:JSON.stringify({msg:'UnhandledRejection: '+String(r&&r.message||r)," +
            "stack:r&&r.stack?String(r.stack):''})});}catch(_){}" +
            "};" +
            "try{var _th=localStorage.getItem('fdb_theme')||" +
            "(document.cookie.match(/fdb_theme=([^;]+)/)||[])[1]||'ultra-dark';" +
            "document.documentElement.setAttribute('data-theme',_th);" +
            "}catch(e){};" +
            // ── Auto-reload (apenas relatório de hoje) ────────────────────────
            (ehHje ? (
            // Badge visual confirma que auto-reload está ativo
            "try{var _badge=document.createElement('div');" +
            "_badge.id='__srv_badge';" +
            "_badge.title='Auto-atualizacao ativa — detecta vendas em ~200ms';" +
            "_badge.style.cssText='position:fixed;bottom:8px;left:8px;z-index:2147483646;" +
            "background:rgba(0,200,80,.18);border:1px solid rgba(0,200,80,.35);border-radius:6px;" +
            "padding:3px 8px;font-size:10px;color:rgba(0,220,80,.9);font-family:monospace;" +
            "pointer-events:none;transition:opacity .5s;opacity:1';" +
            "_badge.textContent='\\u21bb auto';" +
            "document.body.appendChild(_badge);" +
            "setTimeout(function(){_badge.style.opacity='0.18';},3000);" +
            "}catch(_){}" +
            // Estado interno — _loadTs marca quando esta página foi carregada
            "var _q="+qt+",_t="+(Math.round(tot*100)/100)+",_loadTs=Date.now();" +
            "console.log('[srv] auto-reload ativo | qt='+_q+' tot='+_t+' loadTs='+_loadTs);" +
            // SSE (primário)
            "var _es=null,_connTry=0;" +
            "var _conn=function(){" +
            "try{" +
            "_es=new EventSource('/api/events');" +
            "_es.onmessage=function(ev){" +
            "try{var d=JSON.parse(ev.data);" +
            "if(d.type==='reload'||d.type==='navigate')window.location.replace(window.location.href);" +
            "if(d.type==='navigate-hash'&&d.hash){" +
            "if(typeof __abrirModalConfig==='function'&&d.hash==='config'){__abrirModalConfig();}" +
            "else if(typeof __abrirModalPeriodo==='function'&&d.hash==='periodo'){__abrirModalPeriodo();}" +
            "}" +
            "}catch(e){};};" +
            "_es.onopen=function(){_connTry=0;console.log('[srv] SSE conectado');};" +
            "_es.onerror=function(){if(_es){_es.close();_es=null;}" +
            "_connTry++;var delay=Math.min(2000*_connTry,30000);" +
            "console.log('[srv] SSE erro #'+_connTry+' — reconectando em '+delay+'ms');" +
            "setTimeout(_conn,delay);};" +
            "}catch(e){console.log('[srv] SSE falhou: '+e.message);setTimeout(_conn,5000);}" +
            "};" +
            "_conn();" +
            // Poll HTTP (fallback — detecta mesmo sem SSE)
            "var _pollErros=0;" +
            // DEDUP FIX (auditoria v2.5.0): /api/status agora devolve 'correcoes' por
            // JANELA DE TEMPO (não-destrutivo — ver _pushCorrecao/_CORRECOES_JANELA_MS
            // no servidor), então a MESMA correção aparece em várias respostas seguidas
            // de poll. Sem este controle de 'já vista', o mesmo toast reapareceria a
            // cada ciclo de poll (a cada "+pollMs+"ms) enquanto durar a janela. Usa 'seq'
            // (contador monotônico do servidor) em vez de 'ts' para o rastreio: duas
            // correções diferentes podem compartilhar o mesmo milissegundo, mas nunca
            // o mesmo seq.
            "var _ultimaCorrecaoSeq=0;" +
            "var _poll=function(){" +
            "fetch('/api/status',{cache:'no-store'})" +
            ".then(function(r){return r.ok?r.json():Promise.reject(r.status);})" +
            ".then(function(d){" +
            "_pollErros=0;" +
            "if(d.correcoes&&d.correcoes.length){" +
            "var _deveReload=false;" +
            "d.correcoes.forEach(function(c){" +
            "if(c.seq&&c.seq<=_ultimaCorrecaoSeq)return;" + // já exibida nesta aba — pula
            "if(c.seq&&c.seq>_ultimaCorrecaoSeq)_ultimaCorrecaoSeq=c.seq;" +
            "try{" +
            "var _tw=document.getElementById('__srv_tw')||" +
            "(function(){var e=document.createElement('div');e.id='__srv_tw';" +
            "e.style.cssText='position:fixed;bottom:20px;right:20px;z-index:2147483647;" +
            "display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none;max-width:320px';" +
            "document.body.appendChild(e);return e;})();" +
            "var _t=document.createElement('div');" +
            "_t.style.cssText='background:#0f172a;border:1px solid '+(c.cor||'rgba(14,165,233,.4)')" +
            "+';border-radius:10px;padding:10px 14px;font-size:12px;line-height:1.5;" +
            "color:#e2e8f0;font-family:Inter,Arial,sans-serif;" +
            "box-shadow:0 4px 24px rgba(0,0,0,.65);opacity:1;transition:opacity .5s ease;" +
            "pointer-events:none;word-break:break-word';" +
            "_t.textContent=c.msg;" +
            "_tw.appendChild(_t);" +
            "setTimeout(function(){_t.style.opacity='0';" +
            "setTimeout(function(){try{_t.parentNode&&_t.parentNode.removeChild(_t);}catch(_){}},550);}," +
            TOAST_DURATION + ");" +
            "}catch(_){}" +
            "if(c.reload)_deveReload=true;" +
            "});" +
            "if(_deveReload){setTimeout(function(){window.location.replace(window.location.href);},800);}}" +
            "if(d.qt>=0&&(" +
            // Mecanismo 1 (primário): changeTs > _loadTs — detecta mudanças ocorridas
            // APÓS esta página ter sido carregada, mesmo que _q===d.qt (HTML já atualizado).
            "(d.changeTs&&d.changeTs>_loadTs)||" +
            // Mecanismo 2 (backup): comparação direta — captura divergências de qt/tot
            "d.qt!==_q||Math.abs(d.total-_t)>0.01)){" +
            "console.log('[srv] reload: changeTs='+d.changeTs+' loadTs='+_loadTs+' qt='+d.qt+'/'+_q);" +
            "_q=d.qt;_t=d.total;_loadTs=Date.now();" + // atualiza para evitar loops
            "window.location.replace(window.location.href);}}" +
            ")" +
            ".catch(function(err){_pollErros++;" +
            "if(_pollErros<=3)console.log('[srv] poll erro #'+_pollErros+': '+err);" +
            "});};" +
            "setInterval(_poll,"+pollMs+");"
            ) : "") +
            // ── Sincronização de fuso horário (sempre) ────────────────────────
            "var _syncHo=function(){try{fetch('/api/hora-usuario',{method:'POST'," +
            "headers:{'Content-Type':'application/json'}," +
            "body:JSON.stringify({ts:Date.now()," +
            "tzOffsetMs:new Date().getTimezoneOffset()*60000})," +
            "cache:'no-store'}).catch(function(){});}catch(_){}};" +
            "_syncHo();setInterval(_syncHo,"+INTERVALO_SYNC_HORA_MS+");" +
            "})();" + SC;

        var serverModeSnip =
            "<script>" +
            "window.__SERVER_MODE__=true;" +
            "window.__STATUS_INICIAL__={qt:"+qt+",total:"+(Math.round(tot*100)/100)+"};" +
            "<\/script>";

        try {
            // ── serverModeSnip → injeta antes de </head> ──────────────────────
            var headClose = html.lastIndexOf("</head>");
            if (headClose >= 0) {
                html = html.slice(0, headClose) + serverModeSnip + html.slice(headClose);
            } else {
                var bOpen = html.indexOf("<body");
                if (bOpen >= 0) { html = html.slice(0, bOpen) + serverModeSnip + html.slice(bOpen); }
                else             { html = serverModeSnip + html; }
                logTs("AVISO: </head> nao encontrado — SERVER_MODE injetado como fallback.");
            }

            // ── arScript → injeta ANTES de </body> ───────────────────────────
            // USA lastIndexOf("</body>") em vez de replace("</body></html>", ...)
            // para ser robusto a:  "</body>\n</html>",  "</body>  </html>",  etc.
            // String.replace() com string longa falha se houver '$' no arScript
            // (padrões de substituição como $&, $', $1) — corrompendo o script.
            if (arScript) {
                var bodyClose = html.lastIndexOf("</body>");
                if (bodyClose >= 0) {
                    html = html.slice(0, bodyClose) + arScript + html.slice(bodyClose);
                } else {
                    html = html + arScript;
                    logTs("ERRO: </body> nao encontrado no HTML — arScript injetado no fim. Auto-reload pode nao funcionar.");
                }
            }
        } catch(injErr) {
            logTs("ERRO na injecao HTML: " + (injErr && injErr.stack || injErr));
        }

        // Detecta se _fpPoll ou pollStatus gravaram statusAtual DURANTE esta geração
        // COM dados diferentes dos que nosso HTML produziu.
        // Apenas timestamp (ts > _genStartTs) NÃO é suficiente: pollStatus atualiza
        // statusAtual.ts mesmo sem detectar mudança, causando falsos positivos que
        // disparariam re-gerações desnecessárias a cada ciclo de poll.
        var _statusAtualizadoDurante = ehHje &&
            statusAtual.ts > _genStartTs &&
            (statusAtual.qt !== qt || Math.abs(statusAtual.total - tot) > 0.005);

        cache[chave]={html:html,gerando:false,erro:null,qt:qt,tot:tot,geradoEm:Date.now()};

        if (ehHje) {
            if (!_statusAtualizadoDurante) {
                // Nossa geração é a fonte mais fresca — atualiza statusAtual normalmente
                statusAtual = Object.assign({}, statusAtual, {qt:qt, total:tot, ts:Date.now()});
            }
            // Se _statusAtualizadoDurante=true: _fpPoll/pollStatus gravou dados mais recentes
            // durante a geração. Preserva esses dados — NÃO sobrescreve com o HTML antigo.
            // (o revert era o bug: página ficava presa com datos velhos indefinidamente)
        }

        // SSE dispatch: dispara quando:
        //   1. _pollTriggered=true — fast-poll/pollStatus detectou mudança e iniciou esta geração.
        //      SSE emitido AQUI (após HTML pronto) — browser recarrega direto para HTML final,
        //      sem passar por paginaLoading.
        //   2. _statusChanged — mudança detectada vs snapshot do HTML anterior (agendarRegen path).
        //   Nota: correções de horário usam reload:true nos toasts.
        if ((_statusChanged || (ehHje && !!_pollTriggered)) && sseClients.length > 0) {
            _statusChangeTs = Date.now(); // HTML pronto — poll HTTP também recarrega direto para página final
            broadcastSSE({type:"reload"});
        } else if (_statusChanged || (ehHje && !!_pollTriggered)) {
            // Sem clientes SSE — atualiza changeTs para que o poll HTTP detecte e recarregue
            _statusChangeTs = Date.now();
        }

        // Re-trigger: _fpPoll/pollStatus detectou mudança DURANTE esta geração
        // mas o filho leu o BD antes da venda (HTML está antigo).
        // Agenda nova geração imediata para capturar os dados frescos.
        // Só re-aciona se não houve _statusChanged nem _pollTriggered — nesses casos
        // o HTML já tem os dados corretos e o SSE já disparou (não precisa repetir).
        if (_statusAtualizadoDurante && !_statusChanged && !_pollTriggered && ehHje) {
            logTs("Dados atualizados durante geração — re-acionando para capturar dados frescos...");
            setImmediate(function() {
                if (!cache[chave] || !cache[chave].gerando) {
                    delete cache[chave];
                    gerarEmBackground(chave, chave, chave, true);
                }
            });
        }
        } catch(fatalErr) {
            logTs("ERRO FATAL em proc.close ("+chave+"): "+(fatalErr&&fatalErr.stack||fatalErr));
            try { cache[chave]={html:null,gerando:false,erro:"Erro interno: "+(fatalErr&&fatalErr.message||String(fatalErr))}; } catch(_) {}
        }
    });
};

// ---------------------------------------------------------------------------
// FAST-POLL: detecção de vendas em < 300 ms via conexão Firebird persistente.
//
// Arquitetura dois níveis:
//   1. Fast-poll (200ms fixo, este bloco): query mínima (COUNT+SUM) em conexão
//      persistente. Detecta qualquer variação em qt ou total → aciona
//      gerarEmBackground imediato via _pollTriggered=true → SSE após HTML pronto.
//      Sem overhead de attach/detach por ciclo — conexão reutilizada entre 200ms.
//      Se a conexão morrer (banco reiniciado, rede, crash): _fpDb=null e reconecta
//      no próximo ciclo (silencioso, sem spam de log).
//
//   2. pollStatus (POLL_INTERVAL, fallback / validador): query completa com IIF
//      por tipo (Gerencial/NFC-e/NF-e). Roda correções de horário, valida breakdown
//      por modelo e serve como net de segurança se o fast-poll falhar.
//      Ao detectar mudança já acionada pelo fast-poll, gerarEmBackground retorna
//      early (ent.gerando=true) sem custo extra.
//
// Resultado: detecção em 200-400ms; POLL_INTERVAL vira fallback de segurança.
// ---------------------------------------------------------------------------
// VELOCIDADE (v2.9.6, pedido do usuário): reduzido de 50ms para 30ms.
// Moderado de propósito, não "o mais rápido possível": mesmo com conexão
// persistente (sem custo de reconectar), isso ainda é uma consulta por
// ciclo contra um Firebird REMOTO que várias máquinas acessam ao mesmo
// tempo — e hoje mesmo uma consulta cara nesse mesmo caminho (v2.9.2, já
// revertida) chegou a travar o SmallSoft real. 30ms preserva boa margem de
// segurança para múltiplas máquinas simultâneas.
var _FP_INTERVAL_MS  = 30;    // detecção a cada 30ms (conexão persistente: sem overhead de reconexão)
var _fpDb            = null;  // conexão Firebird persistente (reutilizada entre ciclos)
var _fpConectando    = false; // evita tentativas de attach paralelas
var _fpBusy          = false; // evita ciclos sobrepostos
var _fpUltimoQt      = -1;    // última contagem vista (-1 = sem baseline ainda)
var _fpUltimoTot     = -1;    // último total visto
var _fpUltimoPend    = -1;    // últimas NFC-e pendentes de autorização vistas
var _fpUltimoSvend   = -1;    // últimas vendas sem vendedor vistas
var _fpUltimoSforma  = -1;    // últimos pagamentos sem forma definida vistos
var _fpDhAtual       = null;  // data do último ciclo — detecta virada de dia e reseta baseline
var _fpIntervalId    = null;
// _fpGen: token de geração do fast-poll. Incrementado por _iniciarFastPoll().
// RACE FIX (v2.4.1): se _iniciarFastPoll() era chamado enquanto um Firebird.attach
// estava em voo (ex.: reconfiguração manual do FDB durante a reconexão), a callback
// tardia gravava a conexão ANTIGA em _fpDb — que aponta para o banco anterior.
// Comparando o token, a callback obsoleta apenas descarta a conexão.
var _fpGen           = 0;

// SQL mínima: COUNT+SUM sem IIF/tipo breakdown.
// Mais rápida que a query completa do pollStatus — ideal para detecção contínua.
// Inclui nfce (cancelado filtrado) e pagament (formas ignoradas: 00/13).
// FP_PEND (v2.7.4): conta as NFC-e AINDA NAO AUTORIZADAS (total vazio).
// Sem essa terceira medida, o fast-poll so' enxerga qt/total — e o momento em
// que a SEFAZ autoriza a nota, preenchendo VENDEDOR/HORA/NATUREZA, nao muda
// necessariamente nenhum dos dois (o valor ja estava sendo contado pelo
// PAGAMENT). O usuario ficava olhando "(aguardando autorizacao)" na tela e
// precisava apertar atualizar na mao. Com FP_PEND, a transicao
// pendente -> autorizada e' detectada explicitamente e dispara a regeneracao
// + reload automatico como qualquer outra mudanca.
// FP_SVEND (v2.7.6): conta as vendas do dia SEM VENDEDOR definido. Fecha a
// ultima lacuna de deteccao: quando alguem atribui o vendedor a uma venda que
// ja estava contabilizada, qt e total NAO mudam — e a tela continuaria
// mostrando "(sem vendedor)" ate' alguem apertar atualizar na mao. As demais
// situacoes de "nao identificado" ja eram cobertas indiretamente: a forma de
// pagamento so' fica vazia enquanto nao ha linha em PAGAMENT, e a chegada
// dessa linha ja altera qt/total.
// So' e' incluida quando a coluna nfce.VENDEDOR existe de fato (ver sondagem
// em _fpConectar) — referenciar coluna inexistente derrubaria toda a consulta
// e mataria a deteccao de vendas.
var _montarFpSql = function(temVendedor) {
    var _selVend = temVendedor
        ? "  SELECT 0 AS qt, 0 AS tot, 0 AS pend, 1 AS svend, 0 AS sforma" +
          "  FROM nfce" +
          "  WHERE data >= ? AND data < ? + 1" +
          "  AND COALESCE(cancelado,'N') NOT IN ('S','T')" +
          "  AND total > 0" +
          "  AND (VENDEDOR IS NULL OR TRIM(VENDEDOR) = '')" +
          "  UNION ALL"
        : "";
    return "SELECT COALESCE(SUM(qt),0) AS FP_QT, COALESCE(SUM(tot),0) AS FP_TOT," +
           " COALESCE(SUM(pend),0) AS FP_PEND, COALESCE(SUM(svend),0) AS FP_SVEND," +
           " COALESCE(SUM(sforma),0) AS FP_SFORMA" +
           " FROM (" +
           _selVend +
           "  SELECT 1 AS qt, total AS tot, 0 AS pend, 0 AS svend, 0 AS sforma" +
           "  FROM nfce" +
           "  WHERE data >= ? AND data < ? + 1" +
           "  AND COALESCE(cancelado,'N') NOT IN ('S','T')" +
           "  AND total > 0" +
           "  UNION ALL" +
           "  SELECT 0 AS qt, 0 AS tot, 1 AS pend, 0 AS svend, 0 AS sforma" +
           "  FROM nfce" +
           "  WHERE data >= ? AND data < ? + 1" +
           "  AND COALESCE(cancelado,'N') NOT IN ('S','T')" +
           "  AND COALESCE(total,0) <= 0" +
           // ESCOPO: so' documento fiscal aguarda autorizacao da SEFAZ. Sem este
           // filtro, toda gerencial ABERTA (venda em andamento no caixa, total
           // ainda vazio) entrava na contagem de "pendentes" — e cada item
           // lancado no cupom mudava esse numero, disparando regeneracao do
           // relatorio sem que nada relevante tivesse mudado.
           "  AND COALESCE(modelo,65) IN (65,55)" +
           "  UNION ALL" +
           "  SELECT 1 AS qt, valor AS tot, 0 AS pend, 0 AS svend, 0 AS sforma" +
           "  FROM pagament" +
           "  WHERE data >= ? AND data < ? + 1" +
           "  AND valor > 0" +
           "  AND SUBSTRING(forma FROM 1 FOR 2) NOT IN ('00','13')" +
           "  UNION ALL" +
           // FP_SFORMA (v2.7.7): pagamentos do dia cuja FORMA ainda esta em
           // branco. Fecha a lacuna do "nao identificado" que sobrava: quando um
           // pagamento JA EXISTE mas sem forma definida, e alguem preenche a
           // forma depois, nem a quantidade nem o valor mudam — o fast-poll nao
           // via nada e a tela ficava em "nao identificado" ate' alguem apertar
           // atualizar. (O caso de um pagamento NOVO chegando ja era detectado,
           // porque a linha nova altera qt/total.)
           "  SELECT 0 AS qt, 0 AS tot, 0 AS pend, 0 AS svend, 1 AS sforma" +
           "  FROM pagament" +
           "  WHERE data >= ? AND data < ? + 1" +
           "  AND (forma IS NULL OR TRIM(forma) = '')" +
           " ) t";
};
// Numero de pares (data,data) que a consulta espera, para montar os parametros.
var _fpNumBlocos = function(temVendedor) { return temVendedor ? 5 : 4; };
var _fpTemVendedor = null;  // null = ainda nao sondado; true/false = resultado do esquema
var _FP_SQL = _montarFpSql(false); // substituido apos a sondagem em _fpConectar

// Conecta (ou reconecta) a conexão persistente do fast-poll.
// _done flag previne double-callback (timeout + attach concorrentes).
var _fpConectar = function(cb) {
    if (_fpConectando) { cb(false); return; }
    _fpConectando = true;
    var _minhaGen = _fpGen; // token no momento do attach
    var opts = {host:FDB_HOST, port:FIREBIRD_PORT, database:FDB_PATH, user:USER, password:PASS,
                role:null, charset:FB_CHARSET, lowercase_keys:false};
    var _done = false;
    var _t = setTimeout(function() {
        if (_done) return; _done = true;
        _fpConectando = false;
        if (_minhaGen === _fpGen) _fpDb = null;
        cb(false);
    }, 3000);
    try {
        Firebird.attach(opts, function(err, db) {
            if (_done) { if (!err && db) { try { db.detach(); } catch(_) {} } return; }
            _done = true;
            clearTimeout(_t);
            _fpConectando = false;
            // Geração obsoleta: o fast-poll foi reiniciado durante o attach.
            // Descarta esta conexão sem tocar em _fpDb (que já é da nova geração).
            if (_minhaGen !== _fpGen) {
                if (!err && db) { try { _matarConexao(db); } catch(_) {} }
                cb(false);
                return;
            }
            if (err || !db) { _fpDb = null; cb(false); return; }
            _fpDb = db;
            // Sonda se a tabela nfce tem a coluna VENDEDOR. Necessario porque
            // _FP_SQL e' montado a partir desta checagem: referenciar coluna
            // inexistente faria TODA consulta do fast-poll falhar, e a deteccao
            // de vendas pararia por completo.
            //
            // BUG FIX (v2.7.9): a sondagem rodava — e LOGAVA — a cada reconexao.
            // Num ambiente com Firebird remoto instavel, o fast-poll reconecta
            // varias vezes por segundo; no log real do usuario isso gerou 6987
            // de 7000 linhas (99,8%), ~17 por segundo, apagando todo o resto
            // pela rotacao do arquivo. Alem do ruido, era uma query extra por
            // reconexao contra um banco ja sobrecarregado, o que so' piorava a
            // instabilidade que causava as reconexoes.
            // O resultado e' propriedade do ESQUEMA do banco: nao muda entre
            // reconexoes. Agora e' sondado UMA vez (estado nulo = ainda
            // desconhecido) e reaproveitado; o log sai so' quando o valor e'
            // determinado ou de fato muda (ex: troca do arquivo .fdb).
            if (_fpTemVendedor !== null) { cb(true); return; }
            db.query(
                "SELECT COUNT(*) AS TEM FROM RDB$RELATION_FIELDS " +
                "WHERE TRIM(RDB$RELATION_NAME) = 'NFCE' AND TRIM(RDB$FIELD_NAME) = 'VENDEDOR'",
                [],
                function(errV, rowsV) {
                    if (errV) {
                        // Falha na sondagem: NAO fixa o estado (segue null) para
                        // tentar de novo na proxima conexao, e mantem a variante
                        // sem VENDEDOR, que funciona em qualquer esquema.
                        cb(true);
                        return;
                    }
                    var _tem = 0;
                    try {
                        if (rowsV && rowsV[0]) {
                            var r0 = rowsV[0];
                            _tem = Number(r0.TEM || r0.tem || 0);
                        }
                    } catch(_) {}
                    var _novo = _tem > 0;
                    if (_fpTemVendedor !== _novo) {
                        _fpTemVendedor = _novo;
                        _FP_SQL = _montarFpSql(_fpTemVendedor);
                        // logDebug: é informação de ESQUEMA do banco, não evento
                        // operacional. Numa base sem a coluna a mensagem se repetia a
                        // cada reinício do servidor sem nunca mudar de conteúdo.
                        logDebug("FastPoll: coluna nfce.VENDEDOR " + (_fpTemVendedor ? "detectada" : "ausente") +
                              " — monitoramento de vendedor " + (_fpTemVendedor ? "ativo" : "desativado") + ".");
                    }
                    cb(true);
                }
            );
        });
    } catch(syncErr) {
        // Firebird.attach nunca deveria lançar sincronamente, mas por segurança:
        if (!_done) {
            _done = true; clearTimeout(_t); _fpConectando = false;
            if (_minhaGen === _fpGen) _fpDb = null;
            cb(false);
        }
    }
};

// Executa um ciclo do fast-poll.
// Reutiliza _fpDb se disponível; reconecta silenciosamente se necessário.
var _fpPoll = function() {
    if (!Firebird || !dbStatus.ok || _fpBusy || _fpConectando) return;
    _fpBusy = true;
    var dh = hoje();

    // Virada de dia: reseta baseline para não comparar hoje com ontem
    if (_fpDhAtual && _fpDhAtual !== dh) {
        _fpUltimoQt    = -1;
        _fpUltimoTot   = -1;
        _fpUltimoPend  = -1;
        _fpUltimoSvend  = -1;
        _fpUltimoSforma = -1;
        logTs("FastPoll: virada de dia (" + _fpDhAtual + " → " + dh + ") — baseline resetado.");
    }
    _fpDhAtual = dh;

    var _executar = function() {
        // Watchdog: se query não responder em 2s → conexão morta
        var _wdFired = false;
        var _wdFp = setTimeout(function() {
            _wdFired = true;
            try { if (_fpDb) _matarConexao(_fpDb); } catch(_) {}
            _fpDb   = null;
            _fpBusy = false;
        }, 2000);

        var _fpParams = [];
        for (var _b = 0; _b < _fpNumBlocos(_fpTemVendedor); _b++) { _fpParams.push(dh, dh); }
        _fpDb.query(_FP_SQL, _fpParams, function(err, rows) {
            clearTimeout(_wdFp);
            // Se watchdog já disparou, descarta callback para evitar duplo processamento
            if (_wdFired) return;

            if (err || !rows || !rows.length) {
                try { if (_fpDb) _matarConexao(_fpDb); } catch(_) {}
                _fpDb   = null;
                _fpBusy = false;
                return;
            }
            var r   = rows[0];
            var n   = function(k) { return Number(r[k] || r[k.toLowerCase()] || 0); };
            var qt    = n("FP_QT");
            var tot   = n("FP_TOT");
            var pend  = n("FP_PEND");
            var svend  = n("FP_SVEND");
            var sforma = n("FP_SFORMA");

            // pend != anterior cobre a autorização de uma NFC-e convertida: o valor
            // já estava sendo contado pelo PAGAMENT, então qt/tot podem não mudar —
            // mas VENDEDOR/HORA/NATUREZA acabaram de ser preenchidos e a tela
            // precisa recarregar para sair de "(aguardando autorização)".
            if (_fpUltimoQt >= 0 &&
                (qt !== _fpUltimoQt || Math.abs(tot - _fpUltimoTot) > 0.005 ||
                 pend !== _fpUltimoPend || svend !== _fpUltimoSvend ||
                 sforma !== _fpUltimoSforma)) {

                logTs("FastPoll: " + _descreverMudanca(_fpUltimoQt, qt, _fpUltimoTot, tot) +
                      (pend !== _fpUltimoPend ? " | NFC-e aguardando autorização: " + _fpUltimoPend + " → " + pend : "") +
                      (svend !== _fpUltimoSvend ? " | vendas sem vendedor: " + _fpUltimoSvend + " → " + svend : "") +
                      (sforma !== _fpUltimoSforma ? " | pagamentos sem forma: " + _fpUltimoSforma + " → " + sforma : "") +
                      " → regerando.");
                // NÃO atualiza statusAtual nem dispara SSE aqui.
                // Ambos ocorrem em gerarEmBackground proc.on("close") quando HTML está pronto,
                // garantindo que o browser recarregue direto para a página final sem paginaLoading.

                var _ent = cache[dh];
                if (_ent && _ent.gerando) {
                    var _killFn = _gerandoKill[dh];
                    _gerarIdCounter[dh] = (_gerarIdCounter[dh] || 0) + 1;
                    delete _gerandoKill[dh];
                    delete cache[dh];
                    gerarEmBackground(dh, dh, dh, true);
                    if (_killFn) { try { _killFn(); } catch(_) {} }
                } else {
                    delete cache[dh];
                    gerarEmBackground(dh, dh, dh, true);
                }
            }

            _fpUltimoQt    = qt;
            _fpUltimoTot   = tot;
            _fpUltimoPend  = pend;
            _fpUltimoSvend  = svend;
            _fpUltimoSforma = sforma;
            _fpBusy = false;
        });
    };

    if (_fpDb) {
        _executar();
    } else {
        _fpConectar(function(ok) {
            if (ok) _executar();
            else     _fpBusy = false;
        });
    }
};

// Inicia (ou reinicia limpo) o fast-poll.
// Chamada sempre que o banco é configurado ou reconectado.
var _iniciarFastPoll = function() {
    if (_fpIntervalId) clearInterval(_fpIntervalId);
    _fpGen++;               // invalida qualquer attach em voo da geração anterior
    _fpUltimoQt = _fpUltimoTot = _fpUltimoPend = _fpUltimoSvend = _fpUltimoSforma = -1;
    _fpDhAtual  = null;
    _fpBusy     = false;
    _fpConectando = false;  // libera o flag caso um attach anterior tenha ficado preso
    if (_fpDb) { try { _matarConexao(_fpDb); } catch(_) {} _fpDb = null; }
    _fpIntervalId = setInterval(_fpPoll, _FP_INTERVAL_MS);
    logTs("Fast-poll iniciado (" + _FP_INTERVAL_MS + " ms) — detecção de vendas em tempo real.");
};

// ---------------------------------------------------------------------------
// Polling direto via Firebird — executa a cada POLL_INTERVAL (config.json).
//  • Query única com IIF detecta mudanças por tipo: Gerencial(99), NFC-e(65), NF-e(55)
//    e emite ">" (subiu) ou "<" (caiu) por tipo no log antes de regenerar.
//  • Timeout de 5 s por consulta (_QUERY_TIMEOUT_MS): se ultrapassar, cancela
//    o socket TCP e refaz após 500 ms.
//  • Após detecção chama _corrigirHorariosVelhos e _corrigirHorariosGerencial,
//    que usam agoraAjustado() — hora sincronizada com o browser do usuário.
// ---------------------------------------------------------------------------
var _pollBusy = false;
var _pollIntervalId = null; // guarda o ID do setInterval ativo — evita acúmulo de loops
var _QUERY_TIMEOUT_MS = 5000;   // 5 segundos — cancela e refaz se exceder
var _HORA_VELHA_MS               =  1 * 60 * 1000; // 1 minuto  — corrige horário de venda stale (NFC-e/NF-e)
// REGRA DE HORA FIXA (v2.7.7) — janela ampliada de 30 min para 1 HORA a
// pedido do usuário. Define até quando olhar para trás procurando vendas
// com horário a corrigir (e ATUALIZAR o banco). Vendas mais antigas que isso
// são deixadas em paz (assume-se que o horário delas é o correto, não um
// relógio adiantado).
// NOTA DE NOMENCLATURA: esta janela já foi de 30 min e mudou para 1 hora
// sem que os nomes de variável internos (_threshD30, horaLimite30)
// acompanhassem a mudança — eles diziam "30" enquanto o valor real já era
// 60 havia várias versões, o que atrapalhou o diagnóstico de um bug antigo.
// Corrigido para _threshJanela/horaLimiteJanela (neutro quanto ao valor).
var _HORA_GERENCIAL_JANELA_MS    = 60 * 60 * 1000; // 1 hora — janela de verificação/correção ativa para gerenciais
var _HORA_GERENCIAL_TOLERANCIA_MS =  3 * 60 * 1000; // 3 minutos  — notas com hora dentro desse intervalo passam sem ajuste

// Throttle das funções de correção de horário.
// Elas abrem conexão Firebird própria — chamá-las a cada poll (200ms) gera
// 10 conexões extras/segundo ao banco, atrasando o próprio poll de detecção.
// Solução: busy-flag por função — retorna imediatamente se já estiver em andamento.
// Elimina throttle fixo de 5s: detecção dispara a cada poll (≤200ms), bloqueando
// apenas enquanto a query Firebird anterior não terminou (~10-100ms em banco local).
var _corriVelhosEmAndamento    = false; // true = _corrigirHorariosVelhos rodando
var _corriGerencialEmAndamento = false; // true = _corrigirHorariosGerencial rodando

// REVERT (v2.9.6, a pedido do usuário — estabilidade acima de tudo): volta
// à forma anterior à v2.9.1, _detectarCampoHora — só sonda "dhora" vs
// "hora". As tentativas de tornar numero/cancelado/gerencial dinâmicos
// (v2.9.1 a v2.9.5) resolveram alguns sintomas mas cada uma trouxe um
// problema novo (subquery cara demais pro Firebird compartilhado, soma
// errada de pagamento com venda) — nenhuma delas fica, todas as rotinas
// que dependiam de _schemaNfce voltam a hardcodar "numero"/"cancelado",
// exatamente como na v2.8.4 (a última versão comprovadamente estável).
// Nesta base real (SmallSoft com NUMERONF/sem cancelado), isso significa
// fast-poll/pollStatus/correções voltam a não detectar nada automaticamente
// — mas silenciosamente, sem erro, sem log, sem custo de query nenhum. Os
// relatórios continuam corretos via geração manual (gerar-relatorio-html.js
// nunca dependeu disso).
var _campoHoraCache = null; // null = ainda não determinado; "dhora" | "hora" após a 1ª sondagem
var _detectarCampoHora = function(db, dh, callback) {
    if (_campoHoraCache) { callback(_campoHoraCache); return; }
    // Sonda sem filtro de modelo: existência de coluna é fato de esquema,
    // independe de quais linhas existem.
    db.query("SELECT FIRST 1 dhora FROM nfce WHERE data >= ? AND data < ? + 1", [dh, dh], function(errProbe) {
        _campoHoraCache = errProbe ? "hora" : "dhora";
        callback(_campoHoraCache);
    });
};

// ---------------------------------------------------------------------------
// Sincronização de fuso horário com o browser do usuário.
// O browser envia getTimezoneOffset()*60000 via POST /api/hora-usuario a cada 30 s.
//
// _clientTzOffsetMs = browser.getTimezoneOffset() * 60000
//   ex: UTC-4 → 240 min × 60000 = 14 400 000 ms
//   (positivo = fuso atrás de UTC; negativo = fuso à frente)
//
// agoraAjustado() retorna um pseudo-objeto cujos métodos getHours/getMinutes/
// getSeconds usam getUTCHours/etc. num Date deslocado pelo tzOffset, produzindo
// exatamente o que `new Date().getHours()` retornaria no BROWSER do usuário.
//
// Isso corrige o bug onde o servidor (potencialmente em UTC) calculava
// horaAtual e horaLimite com getHours() do seu próprio fuso, enquanto o banco
// gravava os horários no fuso local do usuário.
// ---------------------------------------------------------------------------
var _clientTzOffsetMs = 0; // atualizado via /api/hora-usuario

var agoraAjustado = function() {
    // Date deslocado: getUTCHours() == hora local do usuário
    // Ex: UTC 18:00 - 14400000 ms (UTC-4) → UTC 14:00 → getUTCHours() = 14 ✓
    var d = new Date(Date.now() - _clientTzOffsetMs);
    return {
        getHours:   function() { return d.getUTCHours(); },
        getMinutes: function() { return d.getUTCMinutes(); },
        getSeconds: function() { return d.getUTCSeconds(); },
        getTime:    function() { return d.getTime(); }
    };
};

// Destrói a conexão Firebird na força — corta o socket TCP imediatamente,
// sem esperar o banco responder (db.detach() aguarda; socket.destroy() não).
var _matarConexao = function(db) {
    // node-firebird expõe o socket em propriedades que variam por versão.
    // Tenta as variações conhecidas em ordem para garantir destroy real.
    try {
        var conn = db && db._connection;
        var sock = conn && (conn._socket || conn._Socket || conn.socket || conn._sock);
        if (sock && typeof sock.destroy === "function") {
            sock.destroy();
        } else if (conn && typeof conn.destroy === "function") {
            conn.destroy(); // fallback: destrói o objeto de conexão inteiro
        }
    } catch(_) {}
    try { if (db && typeof db.detach === "function") db.detach(); } catch(_) {}
};

// Mata todos os processos filhos pendentes (gerarEmBackground).
// Chamado quando poll ou attach ultrapassam o timeout — garante que
// subprocessos aguardando o mesmo banco também sejam encerrados.
var _matarTodosFilhos = function() {
    var pids = _spawnedPids.slice();
    if (!pids.length) return;
    logTs("Matando " + pids.length + " processo(s) filho(s) por timeout de poll.");
    pids.forEach(function(pid) {
        if (process.platform === "win32") {
            // spawn (não-bloqueante) evita travar o event loop até 3s/pid
            try { childProc.spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {stdio:"ignore", detached:true}); } catch(_) {}
        } else {
            try { process.kill(pid, "SIGKILL"); } catch(_) {}
        }
    });
    _spawnedPids = [];
};

// Executa uma query com hard-timeout de _QUERY_TIMEOUT_MS ms.
// Se estourar: destrói o socket TCP (cancela de verdade), mata processos filhos
// pendentes e chama cb(null, null). O caller detecta (rows===null && e===null) e agenda retry.
var _executarConsultaPoll = function(db, sql, params, cb) {
    var encerrado = false;

    var timer = setTimeout(function() {
        if (encerrado) return;
        encerrado = true;
        logTs("Poll: query passou de " + (_QUERY_TIMEOUT_MS/1000) + "s — cortando socket e refazendo.");
        // BUG FIX (auditoria v2.5.0 — CONCORRÊNCIA/DANO COLATERAL): esta função
        // chamava _matarTodosFilhos(), que mata TODA geração de relatório em
        // andamento no processo — inclusive relatórios por período/intervalo
        // que podem estar rodando há vários minutos de forma totalmente
        // legítima (ver SPAWN_TIMEOUT_CFG, que aceita até 600s) e SEM NENHUMA
        // relação com esta query de poll específica travar. Um soluço
        // passageiro de rede/disco no poll (5s) não deveria derrubar um
        // relatório de meses que um usuário está esperando pacientemente.
        // O poll já se recupera sozinho apenas cortando a SUA PRÓPRIA conexão
        // (_matarConexao(db), abaixo) — não precisa (e não deve) matar
        // subprocessos de terceiros para isso.
        _matarConexao(db);
        cb(null, null);
    }, _QUERY_TIMEOUT_MS);

    db.query(sql, params, function(e, rows) {
        if (encerrado) return; // timeout já disparou — ignora resposta tardia
        encerrado = true;
        clearTimeout(timer);
        cb(e, rows);
    });
};

// Sets de IDs já corrigidos hoje — garantem que cada venda/pagamento
// seja ajustado UMA ÚNICA VEZ. Resetados à meia-noite em _agendarResetLogProt.
var _nfceCorrigidasHoje    = new Set(); // chave: String(numero)
var _pagCorrigidosHoje     = new Set(); // chave: String(numero) ou "seq:N"

// Corrige vendas cujo horário registrado está mais de 1 min no passado,
// atualizando o campo de hora para o instante atual do relógio local do servidor
// (new Date().getHours() — mesmo fuso do Firebird, sem dependência de _clientTzOffsetMs).
// Cada venda/pagamento é corrigido UMA ÚNICA VEZ por dia (controlado pelos Sets).
// Executa de forma assíncrona sem bloquear o poll principal.
// NOTA: abre sua própria conexão Firebird — não usa o db do poll para evitar
// race condition com _liberar(db) que pode destruir a conexão antes das
// queries de correção completarem.
var _corrigirHorariosVelhos = function(_dbIgnorado, dh) {
    // Busy-flag: evita chamadas paralelas (poll a cada 200ms, query ~10-100ms).
    if (_corriVelhosEmAndamento) return;
    _corriVelhosEmAndamento = true;

    // USA O RELÓGIO LOCAL DO SERVIDOR DIRETAMENTE — servidor e Firebird estão
    // na mesma máquina e compartilham o mesmo clock.
    // Bug anterior: usava agoraAjustado() que depende de _clientTzOffsetMs (inicia em 0).
    // Com _clientTzOffsetMs=0 numa máquina UTC-3, horaLimite ficava 3h adiantada →
    // todas as vendas do dia eram "detectadas" erradas e gravadas com hora UTC incorreta.
    // Depois que _nfceCorrigidasHoje absorvia esses IDs, vendas novas com hora velha
    // ficavam travadas no Set e nunca eram corrigidas novamente.
    var _nowMs    = Date.now();
    var _agoraD   = new Date(_nowMs);
    var _threshD  = new Date(_nowMs - _HORA_VELHA_MS);
    // getHours()/getMinutes()/getSeconds() = hora LOCAL do servidor (mesmo fuso do Firebird)
    var horaAtual = padDois(_agoraD.getHours()) + ":" + padDois(_agoraD.getMinutes()) + ":" + padDois(_agoraD.getSeconds());
    var horaLimite= padDois(_threshD.getHours()) + ":" + padDois(_threshD.getMinutes()) + ":" + padDois(_threshD.getSeconds());

    // Guard meia-noite: nos primeiros _HORA_VELHA_MS ms do dia, threshold cruza a
    // meia-noite LOCAL e horaLimite fica "23:5x:xx" (ontem). A comparação SQL de
    // strings retornaria "00:0x:xx" < "23:5x:xx" = true — corrigiria todas as
    // vendas do dia novo indevidamente. Aguarda o próximo ciclo de poll.
    // Bug anterior: usava floor(getTime()/86400000) = dia UTC, não dia LOCAL —
    // o guard disparava na hora errada em máquinas com fuso diferente de UTC.
    var _agoraDiaStr  = _agoraD.getFullYear() + "-" + padDois(_agoraD.getMonth()+1) + "-" + padDois(_agoraD.getDate());
    var _threshDiaStr = _threshD.getFullYear() + "-" + padDois(_threshD.getMonth()+1) + "-" + padDois(_threshD.getDate());
    if (_threshDiaStr < _agoraDiaStr) {
        // guard meia-noite — silencioso para não inundar o log
        _corriVelhosEmAndamento = false;
        return;
    }

    // NÃO loga no início — essa função é chamada a cada poll (200ms).
    // Logar aqui geraria ~5 msgs/s, esgotando MAX_LOG_LINES em minutos.
    // Logs apenas quando efetivamente corrige algo ou ocorre erro.

    // _pend: contador de ramos async pendentes (nfce + pagament = 2).
    // Começa em 1 (nfce); incrementado para 2 quando pagament é iniciado.
    // Chega a 0 quando ambos terminam (ou erram) → limpa _corriVelhosEmAndamento.
    var _pend = 1;
    var _liberar = function() {
        if (--_pend <= 0) _corriVelhosEmAndamento = false;
    };

    var opts = {host:FDB_HOST, port:FIREBIRD_PORT, database:FDB_PATH, user:USER, password:PASS,
                role:null, charset:FB_CHARSET, lowercase_keys:false};

    // Timeout global para a conexão nfce — impede que conexão pendurada vaze
    // para sempre se o Firebird travar após o poll principal já ter liberado.
    var _cvDb = null, _cvEncerrado = false;
    var _cvTimer = setTimeout(function() {
        if (_cvEncerrado) return;
        _cvEncerrado = true;
        logTs("_corrigirHorariosVelhos(nfce): timeout de " + (_QUERY_TIMEOUT_MS/1000) + "s — encerrando conexão.");
        if (_cvDb) _matarConexao(_cvDb);
        _liberar(); // timeout = fim do ramo nfce
    }, _QUERY_TIMEOUT_MS);

    Firebird.attach(opts, function(errConn, db) {
        if (_cvEncerrado) { if (db) _matarConexao(db); return; } // timeout já chamou _liberar
        _cvDb = db;
        if (errConn || !db) { clearTimeout(_cvTimer); _liberar(); return; } // banco indisponível — tenta no próximo ciclo
        var _fechar = function() {
            if (_cvEncerrado) return;
            _cvEncerrado = true;
            clearTimeout(_cvTimer);
            try { db.detach(); } catch(_) {}
            _liberar(); // fim normal do ramo nfce
        };

    // ---- nfce: SELECT IDs ainda não corrigidos ----
    // Tenta campo DHORA; se falhar, retenta com campo HORA.
    // IMPORTANTE: exclui modelo=99 (gerenciais) — eles são tratados exclusivamente
    // por _corrigirHorariosGerencial, que usa _horaFixadaCache (persistente).
    // Sem esse filtro, o mesmo gerencial seria corrigido em paralelo por ambas as
    // funções no mesmo poll, e após restart o _nfceCorrigidasHoje (volátil) seria
    // zerado enquanto o _horaFixadaCache permanece — causando re-correção infinita.
    var _corrigirNfceComCampo = function(campo) {
        var sqlSel =
            "SELECT numero FROM nfce " +
            "WHERE data >= ? AND data < ? + 1 " +
            "AND COALESCE(modelo,65) <> 99 " +
            "AND " + campo + " IS NOT NULL " +
            "AND " + campo + " < ? " +
            "AND COALESCE(cancelado,'N') NOT IN ('S','T') " +
            "AND total > 0";
        db.query(sqlSel, [dh, dh, horaLimite], function(errS, rows) {
            if (errS) { logTs("Correção nfce."+campo+": erro na query — "+errS.message); _fechar(); return; }
            if (!rows || !rows.length) { _fechar(); return; } // nenhum para corrigir — silencioso

            // Filtra apenas os que ainda não foram corrigidos nesta sessão do dia
            var novos = rows
                .map(function(r) { return String(r.NUMERO || r.numero || ""); })
                .filter(function(id) { return id && !_nfceCorrigidasHoje.has(id); });

            if (!novos.length) { _fechar(); return; } // todos já corrigidos — silencioso

            // Registra no Set ANTES do UPDATE para evitar dupla correção
            // mesmo que o UPDATE demore ou seja chamado em paralelo
            novos.forEach(function(id) { _nfceCorrigidasHoje.add(id); });

            // Monta placeholders: UPDATE ... WHERE numero IN (?,?,?)
            // Guard extra: AND COALESCE(modelo,65) <> 99 garante que mesmo que
            // a SELECT acima retorne algum gerencial por race condition, o UPDATE
            // nunca os toque — proteção em profundidade.
            var placeholders = novos.map(function() { return "?"; }).join(",");
            var sqlUpd =
                "UPDATE nfce SET " + campo + " = ? " +
                "WHERE numero IN (" + placeholders + ") " +
                "AND COALESCE(modelo,65) <> 99";
            db.query(sqlUpd, [horaAtual].concat(novos), function(errU) {
                if (errU) {
                    // Reverte o Set — UPDATE falhou, poderá tentar novamente depois
                    novos.forEach(function(id) { _nfceCorrigidasHoje.delete(id); });
                    logTs("Poll: ERRO ao corrigir nfce." + campo + ": " + errU.message);
                } else {
                    logTs("Poll: " + novos.length + " venda(s) nfce corrigida(s) para " + horaAtual +
                          " (campo " + campo + ", numero(s): " + novos.join(",") + ").");
                    _pushCorrecao(
                        "🕐 " + novos.length + " venda(s) NFC-e com hora antiga corrigida(s) para " + horaAtual,
                        "rgba(251,191,36,.45)"
                    );
                    // Regenera para que o HTML com hora corrigida esteja pronto quando o browser recarregar.
                    var _dhNfce = dh;
                    try {
                        if (!cache[_dhNfce] || !cache[_dhNfce].gerando) {
                            delete cache[_dhNfce];
                            gerarEmBackground(_dhNfce, _dhNfce, _dhNfce);
                        }
                    } catch(_rgErr) { logTs("WARN _corrigirNfce regen: " + _rgErr.message); }
                }
                _fechar();
            });
        });
    };

    // v2.9.0: sondagem unificada em _detectarCampoHora — ver comentário
    // completo na declaração (elimina query redundante a cada poll; a
    // existência da coluna "dhora" é a mesma para o banco inteiro,
    // independente de modelo).
    _detectarCampoHora(db, dh, function(campo) { _corrigirNfceComCampo(campo); });

    // ---- pagament: SELECT IDs ainda não corrigidos ----
    // NOTA: usa uma segunda conexão própria para não conflitar com a query nfce acima.
    // Incrementa _pend ANTES de abrir a conexão — garante que _liberar() do ramo nfce
    // não zere o contador antes de pagament ser registrado.
    _pend++; // agora _pend = 2 (nfce ainda em andamento + pagament iniciando)
    var opts2 = {host:FDB_HOST, port:FIREBIRD_PORT, database:FDB_PATH, user:USER, password:PASS,
                 role:null, charset:FB_CHARSET, lowercase_keys:false};
    // Timeout global para a conexão pagament — mesma proteção da conexão nfce acima.
    var _cv2Db = null, _cv2Encerrado = false;
    var _cv2Timer = setTimeout(function() {
        if (_cv2Encerrado) return;
        _cv2Encerrado = true;
        logTs("_corrigirHorariosVelhos(pagament): timeout de " + (_QUERY_TIMEOUT_MS/1000) + "s — encerrando conexão.");
        if (_cv2Db) _matarConexao(_cv2Db);
        _liberar(); // timeout = fim do ramo pagament
    }, _QUERY_TIMEOUT_MS);
    Firebird.attach(opts2, function(errConn2, db2) {
        if (_cv2Encerrado) { if (db2) _matarConexao(db2); return; } // timeout já chamou _liberar
        _cv2Db = db2;
        if (errConn2 || !db2) { clearTimeout(_cv2Timer); _liberar(); return; }
        var _fechar2 = function() {
            if (_cv2Encerrado) return;
            _cv2Encerrado = true;
            clearTimeout(_cv2Timer);
            try { db2.detach(); } catch(_) {}
            _liberar(); // fim normal do ramo pagament
        };
        var sqlPagSel =
            "SELECT numero FROM pagament " +
            "WHERE data >= ? AND data < ? + 1 " +
            "AND hora IS NOT NULL " +
            "AND hora < ? " +
            "AND valor > 0";
        db2.query(sqlPagSel, [dh, dh, horaLimite], function(errPS, rowsP) {
            if (errPS) { logTs("Correção pagament.hora: erro na query — "+errPS.message); _fechar2(); return; }
            if (!rowsP || !rowsP.length) { _fechar2(); return; } // silencioso — chamado a cada 200ms

            var novosP = rowsP
                .map(function(r) { return String(r.NUMERO || r.numero || ""); })
                .filter(function(id) { return id && !_pagCorrigidosHoje.has(id); });

            if (!novosP.length) { _fechar2(); return; } // silencioso

            novosP.forEach(function(id) { _pagCorrigidosHoje.add(id); });

            var phP = novosP.map(function() { return "?"; }).join(",");
            var sqlPagUpd =
                "UPDATE pagament SET hora = ? WHERE numero IN (" + phP + ")";
            db2.query(sqlPagUpd, [horaAtual].concat(novosP), function(errPU) {
                if (errPU) {
                    novosP.forEach(function(id) { _pagCorrigidosHoje.delete(id); });
                    logTs("Poll: ERRO ao corrigir pagament.hora: " + errPU.message);
                } else {
                    logTs("Poll: " + novosP.length + " pagamento(s) corrigido(s) para " + horaAtual +
                          " (numero(s): " + novosP.join(",") + ").");
                    _pushCorrecao(
                        "🕐 " + novosP.length + " pagamento(s) com hora antiga corrigido(s) para " + horaAtual,
                        "rgba(251,191,36,.45)"
                    );
                    // Regenera para que o HTML com hora corrigida esteja pronto quando o browser recarregar.
                    var _dhPag = dh;
                    try {
                        if (!cache[_dhPag] || !cache[_dhPag].gerando) {
                            delete cache[_dhPag];
                            gerarEmBackground(_dhPag, _dhPag, _dhPag);
                        }
                    } catch(_rgPErr) { logTs("WARN _corrigirPag regen: " + _rgPErr.message); }
                }
                _fechar2();
            });
        });
    });

    }); // fecha Firebird.attach principal
};

// ---------------------------------------------------------------------------
// Corrige horários de vendas GERENCIAIS (modelo=99 OU modelo IS NULL) com hora futura ou mais
// de 1 minuto atrás.  NFC-e (65) e NF-e (55) nunca são tocados aqui.
// BUG FIX: SmallSoft pode gravar vendas gerenciais com modelo=NULL (em vez de 99).
// Usando (modelo = 99 OR modelo IS NULL) capturamos ambos os casos.
// Persiste no hora-fixada-cache.json para não repetir entre reinicializações.
// NOTA: abre sua própria conexão Firebird — não usa o db do poll para evitar
// race condition com _liberar(db).
// ---------------------------------------------------------------------------
var _corrigirHorariosGerencial = function(_dbIgnorado, dh) {
    // Busy-flag: evita chamadas paralelas (poll a cada 200ms, query ~10-100ms).
    if (_corriGerencialEmAndamento) return;
    _corriGerencialEmAndamento = true;

    // USA O RELÓGIO LOCAL DO SERVIDOR DIRETAMENTE — mesma razão de _corrigirHorariosVelhos.
    // Bug anterior: usava agoraAjustado() com _clientTzOffsetMs=0 → hora UTC errada.
    var _nowMs    = Date.now();
    var _agoraD   = new Date(_nowMs);
    // NOMENCLATURA FIX (v2.9.0): esta janela já foi de 30 min (nome antigo
    // "_threshD30"/"horaLimite30") — renomeada para _threshJanela/
    // horaLimiteJanela, neutra quanto ao valor exato, porque o valor real
    // (_HORA_GERENCIAL_JANELA_MS) já mudou uma vez sem que o nome acompanhasse,
    // o que atrapalhou diagnosticar o bug de numeração corrigido nesta versão.
    var _threshJanela = new Date(_nowMs - _HORA_GERENCIAL_JANELA_MS);     // limite retroativo da janela ativa
    var _threshD3     = new Date(_nowMs - _HORA_GERENCIAL_TOLERANCIA_MS); // 3 min atrás — limite da tolerância
    var horaAtual       = padDois(_agoraD.getHours())      + ":" + padDois(_agoraD.getMinutes())      + ":" + padDois(_agoraD.getSeconds());
    var horaLimiteJanela = padDois(_threshJanela.getHours()) + ":" + padDois(_threshJanela.getMinutes()) + ":" + padDois(_threshJanela.getSeconds());
    var horaLimite3      = padDois(_threshD3.getHours())     + ":" + padDois(_threshD3.getMinutes())     + ":" + padDois(_threshD3.getSeconds());

    // Guard meia-noite: usa _threshJanela (mais conservador dos dois) para detectar
    // cruzamento do dia local. Idêntico à lógica de _corrigirHorariosVelhos.
    var _agoraDiaStr  = _agoraD.getFullYear() + "-" + padDois(_agoraD.getMonth()+1) + "-" + padDois(_agoraD.getDate());
    var _threshDiaStr = _threshJanela.getFullYear() + "-" + padDois(_threshJanela.getMonth()+1) + "-" + padDois(_threshJanela.getDate());
    if (_threshDiaStr < _agoraDiaStr) {
        // guard meia-noite — silencioso para não inundar o log
        _corriGerencialEmAndamento = false;
        return;
    }

    // NÃO loga no início — chamado a cada poll (200ms).
    // Logs apenas quando efetivamente corrige ou ocorre erro.

    var opts = {host:FDB_HOST, port:FIREBIRD_PORT, database:FDB_PATH, user:USER, password:PASS,
                role:null, charset:FB_CHARSET, lowercase_keys:false};

    // Timeout global para a conexão gerencial — mesma proteção de _corrigirHorariosVelhos:
    // impede que conexão pendurada vaze para sempre se o Firebird travar após o poll.
    var _cgDb = null, _cgEncerrado = false;
    var _cgTimer = setTimeout(function() {
        if (_cgEncerrado) return;
        _cgEncerrado = true;
        logTs("_corrigirHorariosGerencial: timeout de " + (_QUERY_TIMEOUT_MS/1000) + "s — encerrando conexão.");
        if (_cgDb) _matarConexao(_cgDb);
        _corriGerencialEmAndamento = false; // timeout = fim da função
    }, _QUERY_TIMEOUT_MS);

    Firebird.attach(opts, function(errConn, db) {
        if (_cgEncerrado) { if (db) _matarConexao(db); return; } // timeout já limpou flag
        _cgDb = db;
        if (errConn || !db) { clearTimeout(_cgTimer); _corriGerencialEmAndamento = false; return; }
        var _fechar = function() {
            if (_cgEncerrado) return;
            _cgEncerrado = true;
            clearTimeout(_cgTimer);
            try { db.detach(); } catch(_) {}
            _corriGerencialEmAndamento = false; // fim normal
        };

    var _corrigirComCampo = function(campo) {
        var campoNum = "numero";
        var campoCancSel = "COALESCE(cancelado,'N')";
        // Busca gerenciais de hoje fora do intervalo aceitável PARA CORREÇÃO ATIVA:
        //   hora futura → campo > horaAtual
        //   hora dentro da janela (inclui zona de tolerância de 3 min) → campo >= horaLimiteJanela AND campo < horaAtual
        // Notas com campo > horaAtual (futuro) e campo < horaLimiteJanela (mais
        // velhas que a janela) são ignoradas AQUI e não são mais alcançadas por
        // nenhuma outra rotina (v2.9.6, revert de estabilidade: a reconciliação
        // periódica que cobria esse caso, sem filtro de janela, foi removida —
        // trade-off aceito de propósito, ver changelog).
        // BUG FIX: (modelo = 99 OR modelo IS NULL) captura gerenciais com campo NULL.
        //
        // AJUSTE (v2.7.0 — "não pule as numerações"): os filtros
        // "COALESCE(cancelado,'N') NOT IN ('S','T')" e "total > 0" foram
        // REMOVIDOS daqui. Eram eles que abriam buracos na numeração do
        // hora-fixada-cache.json: uma gerencial cancelada ou convertida
        // simplesmente nunca entrava no cache, então a sequência ficava
        // 54891, 54890, 54889, 54886... sem explicação visível no arquivo.
        // Agora essas vendas TAMBÉM entram no cache — mas apenas como
        // registro (marcadas com HORA_CACHE_CANCELADA); elas nunca entram
        // no UPDATE, porque reescrever a hora de uma venda cancelada no
        // banco seria alterar um registro que não deve mais mudar. As
        // colunas cancelado/total passam a ser lidas para permitir essa
        // classificação. Cobre quem PASSA pela janela ativa; quem nunca é
        // selecionado por causa da janela (ou por "campo IS NOT NULL") pode
        // voltar a ficar sem explicação — ver nota acima.
        var sqlSel =
            "SELECT " + campoNum + " AS ID, " + campo + " AS HORA_VAL, " +
            campoCancSel + " AS CANC, COALESCE(total,0) AS TOT FROM nfce " +
            "WHERE data >= ? AND data < ? + 1 " +
            "AND (modelo = 99 OR modelo IS NULL) " +
            "AND " + campo + " IS NOT NULL " +
            "AND (" + campo + " > ? OR (" + campo + " >= ? AND " + campo + " < ?))";
        //  params: dh, dh, horaAtual (futuro), horaLimiteJanela (janela início), horaAtual (janela fim)

        db.query(sqlSel, [dh, dh, horaAtual, horaLimiteJanela, horaAtual], function(errS, rows) {
            if (errS) { logTs("Correção gerencial."+campo+": erro na query — "+errS.message); _fechar(); return; }
            if (!rows || !rows.length) { _fechar(); return; } // nenhum para corrigir — silencioso

            // Separa em três grupos — filtrados pelo cache persistente:
            //   novosSemHora:    cancelada/convertida/sem valor → só registra no cache (não altera o banco)
            //   novosParaFixar:  hora futura OU dentro da janela mas fora da tolerância (> 3 min atrás)
            //   novosParaMarcar: hora dentro da tolerância (≤ 3 min atrás) — passa sem ajuste, apenas marca no cache
            var novosParaFixar  = [];
            var novosParaMarcar = [];
            var novosSemHora    = []; // [{idRaw, idCache, marcador}]

            rows.forEach(function(r) {
                var idRaw = String(r.ID || r.id || "").trim();
                if (!idRaw) return;
                // NORMALIZAÇÃO FIX (v2.9.1): gerar-relatorio-html.js remove
                // zeros à esquerda ao montar a chave do cache (ver primaryId
                // em idIndex/validCols). Sem a mesma normalização aqui, uma
                // gerencial "056006" gravava a chave "dia|056006" neste
                // processo mas "dia|56006" no gerador de relatório — nunca
                // batiam, e o cache nunca deduplicava entre os dois
                // processos. idRaw segue servindo pro SQL (WHERE/UPDATE usam
                // o valor real da coluna); idCache é só pra chave do cache
                // compartilhado.
                var idCache = idRaw.replace(/^0+/, "") || idRaw; // não vira "" se for só zeros
                if (_horaFixadaCache[dh + "|" + idCache]) return; // já processado (fixado ou marcado ok)
                var canc = String(r.CANC || r.canc || "N").trim().toUpperCase();
                var tot  = parseFloat(r.TOT !== undefined ? r.TOT : r.tot);
                // AJUSTE (v2.7.1): 'S' e 'T' agora são distinguidos no cache em vez de
                // caírem os dois em "CANCELADA" — no Small Commerce, 'T' significa que
                // a gerencial foi CONVERTIDA em documento fiscal (NFC-e ou NF-e), que é
                // um desfecho bem diferente de um cancelamento e merece aparecer como tal.
                if (canc === "S") { novosSemHora.push({idRaw:idRaw, idCache:idCache, marcador:HORA_CACHE_CANCELADA});  return; }
                if (canc === "T") { novosSemHora.push({idRaw:idRaw, idCache:idCache, marcador:HORA_CACHE_CONVERTIDA}); return; }
                if (!(tot > 0))   { novosSemHora.push({idRaw:idRaw, idCache:idCache, marcador:HORA_CACHE_SEM_VALOR});  return; }
                var hv = String(r.HORA_VAL || "").trim().substring(0, 8);
                if (hv > horaAtual) {
                    // hora futura → sempre fixar
                    novosParaFixar.push({idRaw:idRaw, idCache:idCache});
                } else if (hv >= horaLimite3) {
                    // dentro da tolerância de 3 min → passou sem ajuste, marca no cache
                    novosParaMarcar.push({idRaw:idRaw, idCache:idCache});
                } else {
                    // mais de 3 min atrás mas dentro da janela de 30 min → fixar
                    novosParaFixar.push({idRaw:idRaw, idCache:idCache});
                }
            });

            // ── Registro de canceladas/convertidas/sem valor (sem tocar no banco) ──
            if (novosSemHora.length) {
                novosSemHora.forEach(function(item) {
                    _horaFixadaCache[dh + "|" + item.idCache] = { tipo: "gerencial", hora: item.marcador };
                });
                _salvarHoraFixadaCache();
                var _resumo = {};
                novosSemHora.forEach(function(item){ _resumo[item.marcador] = (_resumo[item.marcador]||0) + 1; });
                logTs("Poll: " + novosSemHora.length + " gerencial(is) registrada(s) no cache sem hora fixada (numeração sem buracos; banco não alterado) — " +
                      Object.keys(_resumo).map(function(k){ return _resumo[k] + "x " + k; }).join(", ") + ".");
            }

            // ── Marcação sem ajuste (tolerância) ─────────────────────────────
            // Grava HORA_CACHE_OK no cache para que essas notas não entrem mais
            // na janela de 30 min. BUG FIX: gravava "ok" minúsculo antes — ver
            // comentário completo na declaração de HORA_CACHE_OK.
            if (novosParaMarcar.length) {
                novosParaMarcar.forEach(function(item) {
                    _horaFixadaCache[dh + "|" + item.idCache] = { tipo: "gerencial", hora: HORA_CACHE_OK };
                });
                _salvarHoraFixadaCache();
                logTs("Poll: " + novosParaMarcar.length + " gerencial(is) dentro da tolerância (≤3 min) — marcado(s) sem ajuste.");
            }

            if (!novosParaFixar.length) { _fechar(); return; } // só havia notas na tolerância

            // ── Fixação ───────────────────────────────────────────────────────
            // Marca no cache ANTES do UPDATE — evita dupla correção em paralelo.
            // FORMATO FIX: grava "HH:MM" (sem segundos) — horaAtual tem segundos
            // (precisão necessária para a comparação SQL acima), mas o valor
            // persistido no cache precisa bater com o formato "HH:MM" que
            // gerar-relatorio-html.js grava e exibe, senão os dois lados
            // comparam formatos diferentes para o mesmo horário.
            var horaAtualCache = horaAtual.substring(0, 5);
            novosParaFixar.forEach(function(item) {
                _horaFixadaCache[dh + "|" + item.idCache] = { tipo: "gerencial", hora: horaAtualCache };
            });
            _salvarHoraFixadaCache();

            var _idsRawFixar = novosParaFixar.map(function(item) { return item.idRaw; });
            var placeholders = _idsRawFixar.map(function() { return "?"; }).join(",");
            // BUG FIX: UPDATE também usa (modelo = 99 OR modelo IS NULL)
            // para garantir que a mesma venda encontrada pelo SELECT seja atualizada.
            var sqlUpd =
                "UPDATE nfce SET " + campo + " = ? " +
                "WHERE " + campoNum + " IN (" + placeholders + ") " +
                "AND (modelo = 99 OR modelo IS NULL)";

            db.query(sqlUpd, [horaAtual].concat(_idsRawFixar), function(errU) {
                if (errU) {
                    // Reverte entradas do cache — poderá tentar novamente depois
                    novosParaFixar.forEach(function(item) { delete _horaFixadaCache[dh + "|" + item.idCache]; });
                    _salvarHoraFixadaCache();
                    logTs("Poll: ERRO ao corrigir gerencial." + campo + ": " + errU.message);
                } else {
                    logTs("Poll: " + novosParaFixar.length + " gerencial(is) corrigido(s) para " + horaAtual +
                          " (campo " + campo + ", numero(s): " + _idsRawFixar.join(",") + ").");
                    _pushCorrecao(
                        "🕐 " + novosParaFixar.length + " gerencial(is) com hora corrigido(s) para " + horaAtual,
                        "rgba(167,139,250,.45)"
                    );
                    // Regenera para que o HTML com hora corrigida esteja pronto quando o browser recarregar.
                    var _dhGer = dh;
                    try {
                        if (!cache[_dhGer] || !cache[_dhGer].gerando) {
                            delete cache[_dhGer];
                            gerarEmBackground(_dhGer, _dhGer, _dhGer);
                        }
                    } catch(_rgGErr) { logTs("WARN _corrigirGer regen: " + _rgGErr.message); }
                }
                _fechar();
            });
        });
    };

    // v2.9.0: sondagem unificada em _detectarCampoHora — ver comentário
    // completo na declaração.
    _detectarCampoHora(db, dh, function(campo) { _corrigirComCampo(campo); });

    }); // fecha Firebird.attach
};

var pollStatus = function() {
    if (!Firebird || _pollBusy || !dbStatus.ok) return;
    _pollBusy = true;
    var dh   = hoje();
    var opts = {host:FDB_HOST, port:FIREBIRD_PORT, database:FDB_PATH, user:USER, password:PASS,
                role:null, charset:FB_CHARSET, lowercase_keys:false};

    // RACE FIX (v2.4.1): antes, o watchdog liberava _pollBusy sem marcar o ciclo
    // como encerrado. Se o attach/query respondesse depois, o ciclo velho seguia
    // até o fim e chamava _liberar(db) — zerando o _pollBusy de um ciclo NOVO já
    // em andamento e permitindo dois pollStatus simultâneos sobre o mesmo banco
    // (duas conexões, dois _corrigirHorarios*, statusAtual escrito fora de ordem).
    // _cicloFim garante que apenas o primeiro desfecho encerre o ciclo.
    var _cicloFim = false;

    // Libera recursos e _pollBusy após qualquer desfecho
    var _liberar = function(db, reagendar) {
        if (_cicloFim) { if (db) { try { _matarConexao(db); } catch(_) {} } return; }
        _cicloFim = true;
        clearTimeout(_watchdog);
        clearTimeout(_attachTimer);
        if (db) { try { _matarConexao(db); } catch(_) {} }
        _pollBusy = false;
        if (reagendar) setTimeout(pollStatus, 500);
    };

    // Watchdog de segurança — impede _pollBusy travado para sempre
    var _watchdog = setTimeout(function() {
        if (_cicloFim) return;
        logTs("Poll: watchdog geral de "+(POLL_WATCHDOG_MS/1000)+"s disparado — liberando _pollBusy.");
        // BUG FIX (auditoria v2.5.0): não mata mais subprocessos de geração de
        // relatório aqui — ver justificativa detalhada em _executarConsultaPoll.
        _liberar(_dbRef, false);
    }, POLL_WATCHDOG_MS);

    // --- Timeout no próprio attach (banco pode demorar a aceitar conexão) ---
    var _dbRef       = null;
    var _attachFeito = false;
    var _attachTimer = setTimeout(function() {
        if (_attachFeito || _cicloFim) return;
        _attachFeito = true;
        logTs("Poll: attach passou de " + (_QUERY_TIMEOUT_MS/1000) + "s — abortando e refazendo.");
        // BUG FIX (auditoria v2.5.0): não mata mais subprocessos de geração de
        // relatório aqui — ver justificativa detalhada em _executarConsultaPoll.
        _liberar(_dbRef, true);
    }, _QUERY_TIMEOUT_MS);

    Firebird.attach(opts, function(err, db) {
        // Ciclo já encerrado (timeout de attach ou watchdog): descarta a conexão.
        if (_attachFeito || _cicloFim) { if (db) { try { _matarConexao(db); } catch(_) {} } return; }
        _attachFeito = true;
        clearTimeout(_attachTimer);
        _dbRef = db;

        if (err) { _liberar(db, false); return; }

        // SQL única com IIF por tipo: gerencial(99), NFC-e(65), NF-e(55) e pagamentos.
        // Detecta > e < para cada tipo a cada POLL_INTERVAL (config.json).
        // NF-e (modelo=55) estava ausente na versão anterior — agora incluído.
        var sql =
            "SELECT" +
            " COALESCE(SUM(IIF(tipo=99,1,0)),0) AS QT_G," +
            " COALESCE(SUM(IIF(tipo=99,tot,0)),0) AS TOT_G," +
            " COALESCE(SUM(IIF(tipo=65,1,0)),0) AS QT_NFC," +
            " COALESCE(SUM(IIF(tipo=65,tot,0)),0) AS TOT_NFC," +
            " COALESCE(SUM(IIF(tipo=55,1,0)),0) AS QT_NF," +
            " COALESCE(SUM(IIF(tipo=55,tot,0)),0) AS TOT_NF," +
            " COALESCE(SUM(IIF(tipo=0,1,0)),0) AS QT_PAG," +
            " COALESCE(SUM(IIF(tipo=0,tot,0)),0) AS TOT_PAG" +
            " FROM (" +
            " SELECT COALESCE(modelo,65) AS tipo, total AS tot" +
            " FROM nfce" +
            " WHERE data >= ? AND data < ? + 1" +
            " AND COALESCE(cancelado,'N') NOT IN ('S','T')" +
            " AND total > 0" +
            " UNION ALL" +
            " SELECT 0 AS tipo, valor AS tot" +
            " FROM pagament" +
            " WHERE data >= ? AND data < ? + 1" +
            " AND valor > 0" +
            " AND SUBSTRING(forma FROM 1 FOR 2) NOT IN ('00','13')" +
            " ) t";

        _executarConsultaPoll(db, sql, [dh, dh, dh, dh], function(e, rows) {
            // rows===null && e===null → timeout do socket — _matarConexao já foi chamado
            if (rows === null && e === null) {
                _liberar(null, true); // refaz após 500 ms
                return;
            }

            if (e || !rows || !rows.length) { _liberar(db, false); return; }

            // Se o watchdog disparou enquanto a query rodava, este ciclo já foi
            // encerrado e um novo pode estar ativo — não escreve statusAtual.
            if (_cicloFim) { try { _matarConexao(db); } catch(_) {} return; }

            var r = rows[0];
            // Suporte a casing variável retornado pelo node-firebird
            var n = function(k) { return Number(r[k] || r[k.toLowerCase()] || 0); };

            var qtG   = n("QT_G"),   totG   = n("TOT_G");
            var qtNFC = n("QT_NFC"), totNFC = n("TOT_NFC");
            var qtNF  = n("QT_NF"),  totNF  = n("TOT_NF");
            var qtPAG = n("QT_PAG"), totPAG = n("TOT_PAG");

            // CAUSA RAIZ REAL (v2.9.5) do "regenerando sem parar, sem dados
            // alterados de verdade": qt/tot somava a contagem de VENDAS
            // (qtG+qtNFC+qtNF, de nfce) com a contagem de PAGAMENTOS
            // (qtPAG, de pagament) como se fossem a mesma grandeza. Como
            // quase toda venda tem exatamente 1 registro de pagamento
            // (dinheiro, cartão ou pix — sem split), qtPAG ≈ qtG+qtNFC+qtNF
            // SEMPRE, e a soma ficava ≈ 2× o número real de vendas — não
            // "às vezes um pouco mais", mas EXATAMENTE o dobro, toda vez
            // (confirmado em produção: 190/95, 186/93, 188/94, 72/36 — 2,0
            // exato em toda medição). gerar-relatorio-html.js só conta
            // vendas (nunca soma pagamentos ao total), então statusAtual.qt
            // e o "qt" da geração nunca batiam — cada um sobrescrevia o
            // outro, causando a regeneração infinita.
            // FIX: qt/tot voltam a representar só vendas (qtG+qtNFC+qtNF),
            // batendo com o que o relatório de verdade mostra. qtPAG/totPAG
            // continuam calculados (podem servir a outro propósito
            // futuramente) — só pararam de entrar na soma comparada contra
            // a geração.
            var qt  = qtG + qtNFC + qtNF;
            var tot = totG + totNFC + totNF;

            // Busy-flag interno de cada função impede paralelismo — detecção a cada poll (≤200ms).
            // Não precisa de throttle: o flag libera assim que a query Firebird termina (~10-100ms local).
            _corrigirHorariosVelhos(db, dh);
            _corrigirHorariosGerencial(db, dh);

            // -------------------------------------------------------------------
            // Detecção de mudança por tipo: gerencial, NFC-e, NF-e
            // Emite ">" quando subiu e "<" quando caiu.
            // Detectado a cada POLL_INTERVAL (config.json).
            // -------------------------------------------------------------------
            var novoTipo = {
                g:   {qt: qtG,   tot: totG},
                nfc: {qt: qtNFC, tot: totNFC},
                nf:  {qt: qtNF,  tot: totNF}
            };
            var resultado = _descreverMudancaTipo(statusAtual, novoTipo);

            // Fallback: se os campos por tipo ainda não têm baseline (primeira execução
            // do poll), usa a comparação global para não perder mudanças na inicialização.
            if (!resultado.mudou && statusAtual.qt >= 0 &&
                (qt !== statusAtual.qt || Math.abs(tot - statusAtual.total) > 0.005)) {
                resultado = {
                    mudou: true,
                    descricao: _descreverMudanca(statusAtual.qt, qt, statusAtual.total||0, tot)
                };
            }

            if (resultado.mudou) {
                logTs("Dados alterados: " + resultado.descricao + " → regerando.");
                // SSE NÃO é disparado aqui. É disparado em gerarEmBackground (proc.on("close"))
                // quando o HTML está pronto, via _pollTriggered=true.
                // Disparar SSE antes do HTML existir forçava o browser para paginaLoading,
                // adicionando 800ms de poll + 600ms de animação a cada detecção de venda.
                delete cache[dh];
                gerarEmBackground(dh, dh, dh, true); // _pollTriggered=true → SSE após HTML pronto
            }

            statusAtual = Object.assign({}, statusAtual, {
                qt: qt, total: tot, ts: Date.now(),
                g:   {qt: qtG,   tot: totG},
                nfc: {qt: qtNFC, tot: totNFC},
                nf:  {qt: qtNF,  tot: totNF}
            });
            _liberar(db, false);
        });
    });
};

// ---------------------------------------------------------------------------
// Regeneração periódica do relatório de hoje — loop intencional que garante
// que o HTML esteja sempre atualizado em disco.
// A DETECÇÃO de mudanças de dados é feita exclusivamente pelo pollStatus;
// agendarRegen apenas regenera se nenhuma geração estiver em andamento.
// ---------------------------------------------------------------------------

// Cooldown mínimo entre regenerações após sucesso.
// CORREÇÃO DE BUG: sem esse cooldown, o agendarRegen deletava o cache e
// relançava a geração (gerando:true) antes que o browser conseguisse redirecionar
// e exibir o HTML (o redirect leva ~600ms após o paginaLoading detectar pronto:true).
// Resultado: loop infinito em paginaLoading mesmo com o HTML já gerado.
// O cooldown precisa ser maior que: SPAWN_TIMEOUT_CFG + 600ms de animação + margem.
// Bug do loop em paginaLoading foi eliminado (SSE só dispara após HTML pronto).
//
// REVERTIDO PARA 500ms (v2.6.4) — a auditoria v2.5.0 tinha elevado este valor
// para 5 min tratando agendarRegen como "regeneração desnecessária", mas isso
// causou uma REGRESSÃO REAL na detecção de vendas, relatada pelo usuário
// ("fast-poll não detecta imediatamente"). O motivo: o fast-poll detecta a
// venda em 50ms e chama gerarEmBackground corretamente — mas gerarEmBackground
// não é a única coisa que precisa acontecer. Quando o cache do dia acabou de
// ser regravado (ent.geradoEm recente), este cooldown de 5 min BLOQUEAVA a
// próxima regeneração do agendarRegen por 5 minutos inteiros; qualquer venda
// cuja regeneração falhasse ou fosse superada (kill-and-restart do fast-poll,
// spawn que estourou timeout, erro transitório do Firebird) só voltava a ser
// refletida na tela na próxima janela de 5 min, em vez de nos ~200ms
// seguintes. O custo que a auditoria quis eliminar existe, mas é o preço
// dessa rede de segurança funcionar de fato: 500ms é o valor original,
// validado em produção pelo autor, e a latência percebida de venda na tela
// vale muito mais que o custo de CPU ocioso.
var _REGEN_COOLDOWN_MS = 500;  // ent.gerando já bloqueia concorrência — cooldown só evita thrash

// Intervalo de verificação da regeneração periódica — INDEPENDENTE do POLL_INTERVAL.
// BUG FIX: comentário anterior dizia "30s" mas a variável estava em 200ms — contradição
// que causava confusão sobre o comportamento real. O valor correto é 200ms (fallback rápido).
// Mudanças reais chegam via fast-poll/pollStatus; agendarRegen é apenas safety net.
var _REGEN_CHECK_MS = 200;  // checa a cada 200ms — se fast-poll falhar, detecta em ≤2s

var agendarRegen = function() {
    setTimeout(function() {
        var dh = hoje();
        var ent = cache[dh];
        // Bloqueia regeneração se:
        //   ent.gerando   → geração em andamento
        //   ent.matando   → processo sendo encerrado por timeout
        //   ent.geradoEm presente e dentro do cooldown → HTML recém-gerado,
        //       browser ainda não teve chance de redirecionar e exibir o conteúdo.
        var _podeRegen = !ent
            || (!ent.gerando && !ent.matando
                && (!ent.geradoEm || (Date.now() - ent.geradoEm) >= _REGEN_COOLDOWN_MS));
        if (_podeRegen) {
            delete cache[dh];
            gerarEmBackground(dh, dh, dh);
        }
        agendarRegen();
    }, _REGEN_CHECK_MS);
};

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
var htmlFavicon="<link rel=\"icon\" type=\"image/png\" href=\"/favicon.png\">";

var paginaLoading=function(titulo,sub,chavePoll,urlDest){
    var p="/pronto?k="+encodeURIComponent(chavePoll);
    var dJs=JSON.stringify(urlDest);
    var SC2="</"+"script>";
    // SVGs injetados como variáveis JS — browser usa sem depender do servidor
    var jsVars=
        "var _TMS="+_SPAWN_TIMEOUT_MS+";" + // timeout configurado no servidor
        "var _SVGT="+JSON.stringify(SVG_TIMER)+";" +
        "var _SVGR="+JSON.stringify(SVG_RETRY)+";" +
        "var _SVGW="+JSON.stringify(SVG_WARN)+";";

    return "<!doctype html><html lang=\"pt-br\"><head><meta charset=\"utf-8\">"+htmlFavicon+
        "<title>Gerando...</title>"+
        // Aplica tema antes do primeiro render — evita flash
        "<script>(function(){try{var t=localStorage.getItem('fdb_theme')||(document.cookie.match(/fdb_theme=([^;]+)/)||[])[1]||'ultra-dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();"+SC2+
        "<style>" +
        "*{box-sizing:border-box}" +
        "body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:Inter,Arial,sans-serif;color:#ededed}" +
        ".box{text-align:center;padding:40px 28px;max-width:440px;width:100%}" +
        // Spinner — velocidade e cor mudam conforme estado
        ".spin{width:48px;height:48px;border:3px solid rgba(255,255,255,.1);border-top-color:#0ea5e9;" +
        "border-radius:50%;animation:sp .8s linear infinite;margin:0 auto 24px;transition:border-top-color .25s,animation-duration .25s}" +
        ".spin.kill{border-top-color:#f87171;animation-duration:.35s}" +
        ".spin.retry{border-top-color:#fb923c;animation-duration:.55s}" +
        ".spin.semresp{border-top-color:#71717a;animation-duration:1.2s}" +
        ".spin.pronto{border-top-color:#4ade80;animation-duration:.5s}" +
        "@keyframes sp{to{transform:rotate(360deg)}}" +
        // Título muda de cor conforme estado
        "h2{margin:0 0 6px;font-size:20px;font-weight:700;transition:color .25s}" +
        "h2.kill{color:#f87171}" +
        "h2.retry{color:#fb923c}" +
        "h2.semresp{color:#71717a}" +
        "h2.pronto{color:#4ade80}" +
        ".sub{color:#a1a1aa;font-size:14px}" +
        ".tempo{color:#71717a;font-size:13px;margin-top:12px;font-variant-numeric:tabular-nums}" +
        // Caixa de status — aparece abaixo do contador, animada
        "#sb{display:none;margin-top:18px;padding:13px 16px;border-radius:10px;" +
        "font-size:13px;font-weight:600;line-height:1.5;text-align:left;animation:fdin .2s ease}" +
        "@keyframes fdin{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}" +
        "#sb.kill{background:rgba(248,113,113,.1);color:#f87171;border:1px solid rgba(248,113,113,.35)}" +
        "#sb.retry{background:rgba(251,146,60,.1);color:#fb923c;border:1px solid rgba(251,146,60,.35)}" +
        "#sb.semresp{background:rgba(113,113,122,.1);color:#a1a1aa;border:1px solid rgba(113,113,122,.25)}" +
        "#sb.pronto{background:rgba(74,222,128,.08);color:#4ade80;border:1px solid rgba(74,222,128,.3)}" +
        ".sr{display:flex;align-items:flex-start;gap:10px}" +   // sb-row
        ".si{flex-shrink:0;margin-top:1px}" +                   // sb-icon
        ".st strong{display:block}" +                            // sb-title
        ".st span{display:block;font-size:11px;font-weight:400;opacity:.8;margin-top:3px}" + // sb-detail
        "</style></head><body>" +
        "<div class=\"box\">" +
        "<div class=\"spin\" id=\"_sp\"></div>" +
        "<h2 id=\"_ht\">"+escH(titulo)+"</h2>" +
        "<div class=\"sub\">"+escH(sub)+"</div>" +
        "<div class=\"tempo\" id=\"_t\">Aguarde...</div>" +
        "<div id=\"sb\"></div>" +
        "</div>" +
        "<script>" +
        jsVars +
        "var _t0=Date.now(),_dest="+dJs+";" +
        "var _el=document.getElementById('_t');" +
        "var _sp=document.getElementById('_sp');" +
        "var _ht=document.getElementById('_ht');" +
        "var _sb=document.getElementById('sb');" +
        "var _MAX=5,_prev=null;" +
        // _setState: aplica estado visual em todos os elementos de uma vez.
        // _prev guarda o último cls — evita redraw idêntico no estado normal,
        // mas sempre re-renderiza quando html é fornecido (kill, retry, semresp).
        "function _setState(cls,html){" +
        "var same=cls===_prev;" +
        "if(same&&!html){return;}" + // normal→normal: sem nada a mudar
        "_prev=cls;" +
        "if(_sp)_sp.className='spin'+(cls?' '+cls:'');" +
        "if(_ht)_ht.className=cls||'';" +
        "if(_sb){" +
        "if(html){_sb.className=cls;_sb.innerHTML=html;_sb.style.display='block';}" +
        "else{_sb.style.display='none';_sb.innerHTML='';_sb.className='';}" +
        "}}" +
        // _sbHtml: monta o HTML interno da caixa de status
        "function _sbHtml(ico,title,detail){" +
        "return '<div class=\"sr\"><span class=\"si\">'+ico+'</span><span class=\"st\"><strong>'+title+'</strong><span>'+detail+'</span></span></div>';}" +
        // poll principal — 80ms quando ativo (era 150ms), 500ms em erro de rede
        "var _poll=function(){fetch('"+p+"',{cache:'no-store'})" +
        ".then(function(r){return r.ok?r.json():r.json().catch(function(){return{pronto:false,erro:null,tentativa:1,matando:false};});})" +
        ".then(function(d){" +
        "try{" +
        "if(!d||typeof d!=='object'){setTimeout(_poll,300);return;}" +
        "var seg=Math.floor((Date.now()-_t0)/1000);" +
        // Erro definitivo → substitui a página inteira
        // XSS FIX: d.erro pode conter e.message com < > & (ex: path do SO, args do spawn).
        // Sanitiza com replace antes de inserir em innerHTML.
        "var _esc=function(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};" +
        "if(d.erro){document.body.innerHTML='<div style=\"padding:40px;font-family:monospace\">" +
        "<h2 style=\"color:#f87171\">Erro</h2>" +
        "<pre style=\"color:#f87171;white-space:pre-wrap\">'+_esc(d.erro)+'<\\/pre>" +
        "<p><a href=\"/\" style=\"color:#0ea5e9\">Tentar novamente<\\/a><\\/p><\\/div>';return;}" +
        // Pronto → mostra estado verde por 100ms antes de redirecionar (era 600ms)
        "if(d.pronto){" +
        "var _svgOk='<svg xmlns=\"http:\\/\\/www.w3.org\\/2000\\/svg\" width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"display:inline;vertical-align:-2px;margin-right:4px\"><path d=\"M20 6 9 17l-5-5\"\\/><\\/svg>';" +
        "if(_sp)_sp.className='spin pronto';" +
        "if(_ht)_ht.className='pronto';" +
        "if(_sb){_sb.className='pronto';_sb.innerHTML=_sbHtml(_svgOk,'Relatório pronto!','Redirecionando...');_sb.style.display='block';}" +
        "setTimeout(function(){window.location.replace(_dest);},100);return;}" +
        // Atualiza contador de segundos
        "if(_el)_el.textContent='Consultando banco... '+seg+'s';" +
        // Estado KILL — processo filho encerrado por timeout, aguardando relançamento
        "if(d.matando){" +
        "_setState('kill',_sbHtml(_SVGT," +
        "'Processo encerrado — timeout de '+(_TMS/1000)+'s'," +
        "'Aguardando relançamento da consulta em 3s...'));" +
        // Estado RETRY — nova tentativa em andamento após kill anterior
        "}else if(d.tentativa>1){" +
        "_setState('retry',_sbHtml(_SVGR," +
        "'Tentativa '+d.tentativa+' de '+_MAX," +
        "'Tentativa anterior excedeu '+(_TMS/1000)+'s — refazendo consulta ao banco...'));" +
        // Estado NORMAL — geração em progresso sem intercorrências
        "}else{_setState('',null);}" +
        "setTimeout(_poll,80);" +
        "}catch(e){console.error('[poll]',e);setTimeout(_poll,300);}" +
        "})" +
        // Erro de rede puro (sem resposta) — estado semresp
        ".catch(function(){" +
        "_setState('semresp',_sbHtml(_SVGW," +
        "'Sem resposta do servidor'," +
        "'Aguardando reconexão...'));" +
        "setTimeout(_poll,500);});" +
        // SSE na paginaLoading — redireciona no exato instante que proc.on("close") emite reload,
        // sem depender do ciclo de poll (eliminando até 80ms + 100ms de espera no caminho feliz).
        "};var _pEs=null,_pConn=function(){" +
        "try{_pEs=new EventSource('/api/events');" +
        "_pEs.onmessage=function(ev){try{var d=JSON.parse(ev.data);" +
        "if(d.type==='reload'){window.location.replace(_dest);}" +
        "}catch(_){};};" +
        "_pEs.onopen=function(){" +
        // Ao conectar SSE, verifica /pronto imediatamente — HTML pode já estar pronto
        // se a geração terminou antes da conexão SSE ser estabelecida.
        "fetch('"+p+"',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;})" +
        ".then(function(d){if(d&&d.pronto)window.location.replace(_dest);}).catch(function(){});" +
        "};" +
        "_pEs.onerror=function(){if(_pEs){_pEs.close();_pEs=null;}setTimeout(_pConn,3000);};" +
        "}catch(e){setTimeout(_pConn,5000);}};_pConn();" +
        "setTimeout(_poll,80);" +
        SC2+"</body></html>";
};

var paginaErro=function(titulo,msg,href){
    return "<!doctype html><html lang=\"pt-br\"><head><meta charset=\"utf-8\">"+htmlFavicon+
        "<title>Erro</title><style>body{background:#000;color:#ededed;font-family:monospace;padding:40px;max-width:700px;margin:0 auto}a{color:#0ea5e9}</style></head><body>"+
        "<h2 style=\"color:#f87171\">"+escH(titulo)+"</h2>"+
        "<pre style=\"color:#f87171;white-space:pre-wrap\">"+escH(msg)+"</pre>"+
        "<p><a href=\""+escH(href)+"\">Tentar novamente</a></p>"+
        "<p><a href=\"/selecionar-fdb\">Selecionar banco manualmente (SMALL.FDB)</a></p>"+
        "</body></html>";
};

var paginaFormPeriodo=function(dHoje){
    return "<!doctype html><html lang=\"pt-br\"><head><meta charset=\"utf-8\">"+htmlFavicon+
        "<title>Gerar por periodo</title>"+
        "<style>*{box-sizing:border-box}body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:Inter,Arial,sans-serif;color:#ededed}.box{background:#0a0a0a;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:36px 40px;width:90%;max-width:380px}h2{margin:0 0 24px;font-size:20px;font-weight:700}label{display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#a1a1aa;margin-bottom:6px}input[type=date]{display:block;width:100%;background:#000;color:#ededed;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px 14px;font-size:14px;margin-bottom:20px;color-scheme:dark;outline:none}input[type=date]:focus{border-color:#0ea5e9}button{width:100%;padding:14px;background:#0ea5e9;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer}button:hover{background:#0284c7}button:disabled{opacity:.5;cursor:not-allowed}.back{display:block;text-align:center;margin-top:14px;color:#a1a1aa;font-size:13px;text-decoration:none}.back:hover{color:#ededed}#err{display:none;color:#f87171;font-size:13px;margin-bottom:12px;padding:10px;background:rgba(248,113,113,.1);border-radius:6px}"+
        "</style></head><body><div class=\"box\"><h2>Gerar por periodo</h2>"+
        "<div id=\"err\"></div><label>Data inicial</label>"+
        "<input type=\"date\" id=\"ini\" value=\""+dHoje+"\">"+
        "<label>Data final</label><input type=\"date\" id=\"fim\" value=\""+dHoje+"\">"+
        "<button id=\"bg\" onclick=\"gerar()\">Gerar Relatorio</button>"+
        "<a href=\"/\" class=\"back\">Voltar para hoje</a></div>"+
        "<script>function gerar(){var i=document.getElementById('ini').value,"+
        "f=document.getElementById('fim').value,"+
        "e=document.getElementById('err'),b=document.getElementById('bg');"+
        "if(!i||!f){e.textContent='Informe as duas datas.';e.style.display='block';return;}"+
        "if(i>f){e.textContent='Data inicial deve ser anterior ou igual a final.';e.style.display='block';return;}"+
        "e.style.display='none';b.disabled=true;b.textContent='Gerando...';"+
        "window.location.href='/periodo?i='+encodeURIComponent(i)+'&f='+encodeURIComponent(f);}"+
        "['ini','fim'].forEach(function(id){document.getElementById(id).addEventListener('keydown',function(e){if(e.key==='Enter')gerar();});});"+
        "</script></body></html>";
};

// ---------------------------------------------------------------------------
// paginaEscolherFdb — exibida quando FDB não é encontrado automaticamente.
// Permite ao usuario informar o caminho do SMALL.FDB via:
//   1) Dialogo nativo Windows (OpenFileDialog via PowerShell — botao Procurar)
//   2) Campo de texto (colar o caminho manualmente)
// ---------------------------------------------------------------------------
// CLEAN FIX: parâmetro erroAnterior removido — a função era chamada sempre sem argumento.
// O campo de erro (#err) começa oculto e é exibido via JS quando o fetch de /api/salvar-fdb falha.
var paginaEscolherFdb = function() {
    var SC4 = "</" + "script>";
    var msgErro = "<div id=\"err\" style=\"display:none\"></div>";

    return "<!doctype html><html lang=\"pt-br\"><head><meta charset=\"utf-8\">" + htmlFavicon +
        "<title>Selecionar Banco de Dados</title>" +
        "<script>(function(){try{var t=localStorage.getItem('fdb_theme')||(document.cookie.match(/fdb_theme=([^;]+)/)||[])[1]||'ultra-dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();" + SC4 +
        "<style>" +
        "*{box-sizing:border-box}" +
        "body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:Inter,Arial,sans-serif;color:#ededed;padding:16px}" +
        ".box{background:#0a0a0a;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:36px 40px;width:100%;max-width:520px}" +
        ".ico{font-size:40px;margin-bottom:16px;display:block;text-align:center}" +
        "h2{margin:0 0 6px;font-size:20px;font-weight:700;text-align:center}" +
        ".sub{color:#71717a;font-size:13px;margin-bottom:24px;text-align:center;line-height:1.5}" +
        "label{display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#a1a1aa;margin-bottom:7px}" +
        ".row-inp{display:flex;gap:8px;margin-bottom:8px}" +
        "input[type=text]{flex:1;background:#000;color:#ededed;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px 14px;font-size:13px;font-family:monospace;outline:none;min-width:0}" +
        "input[type=text]:focus{border-color:#0ea5e9}" +
        ".btn{padding:10px 18px;background:#0ea5e9;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap}" +
        ".btn:hover{background:#0284c7}.btn:disabled{opacity:.5;cursor:not-allowed}" +
        ".btn-sec{background:rgba(255,255,255,.08);color:#ededed}" +
        ".btn-sec:hover{background:rgba(255,255,255,.14)}" +
        ".btn-full{width:100%;padding:14px;font-size:15px;margin-top:4px}" +
        ".hint{font-size:12px;color:#52525b;margin-bottom:20px;line-height:1.5}" +
        ".sep{border:none;border-top:1px solid rgba(255,255,255,.07);margin:20px 0}" +
        ".cands{margin:0;padding:0;list-style:none}" +
        ".cands li{font-size:12px;font-family:monospace;color:#52525b;padding:3px 0;cursor:pointer;transition:color .15s}" +
        ".cands li:hover{color:#0ea5e9}" +
        "#spin{display:none;width:16px;height:16px;border:2px solid rgba(255,255,255,.15);border-top-color:#0ea5e9;border-radius:50%;animation:s .7s linear infinite;margin:0 auto}" +
        "@keyframes s{to{transform:rotate(360deg)}}" +
        "</style></head><body>" +
        "<div class=\"box\">" +
        "<span class=\"ico\">" + SVG_DATABASE + "</span>" +
        "<h2>Banco de dados não encontrado</h2>" +
        "<p class=\"sub\">O arquivo <strong>SMALL.FDB</strong> não foi localizado automaticamente.<br>Informe o caminho correto para continuar.</p>" +
        msgErro +
        "<label>Caminho do arquivo SMALL.FDB</label>" +
        "<div class=\"row-inp\">" +
        "<input type=\"text\" id=\"fdbPath\" placeholder=\"Ex: C:\\Program Files (x86)\\SmallSoft\\Small Commerce\\SMALL.FDB\">" +
        "<button class=\"btn btn-sec\" id=\"btnPicker\" title=\"Abrir seletor de arquivos do Windows\">" + SVG_FOLDER + "Procurar</button>" +
        "</div>" +
        "<p class=\"hint\">Cole o caminho completo ou use o botão <strong>Procurar</strong> para abrir o explorador de arquivos do Windows.</p>" +
        "<button class=\"btn btn-full\" id=\"btnSalvar\" onclick=\"salvar()\">Conectar ao Banco</button>" +
        "<div id=\"spin\" style=\"margin-top:16px\"></div>" +
        "<hr class=\"sep\">" +
        "<p style=\"font-size:12px;color:#52525b;margin:0 0 8px\">Locais comuns:</p>" +
        "<ul class=\"cands\" id=\"cands\"></ul>" +
        "</div>" +
        "<script>" +
        "(function(){" +
        // Candidatos comuns — clique para preencher o campo
        "var cands=[" +
        "'C:\\\\Program Files (x86)\\\\SmallSoft\\\\Small Commerce\\\\SMALL.FDB'," +
        "'C:\\\\Program Files\\\\SmallSoft\\\\Small Commerce\\\\SMALL.FDB'," +
        "'C:\\\\ProgramData\\\\SmallSoft\\\\Small Commerce\\\\SMALL.FDB'," +
        "'C:\\\\SmallSoft\\\\Small Commerce\\\\SMALL.FDB'," +
        "'C:\\\\Dados\\\\SMALL.FDB'," +
        "'C:\\\\SmallCommerce\\\\SMALL.FDB'" +
        "];" +
        "var ul=document.getElementById('cands');" +
        "cands.forEach(function(c){" +
        "var li=document.createElement('li');" +
        "li.textContent=c;" +
        "li.title='Clique para usar este caminho';" +
        "li.addEventListener('click',function(){document.getElementById('fdbPath').value=c;});" +
        "ul.appendChild(li);" +
        "});" +
        // Botão Procurar — chama /api/abrir-picker-fdb que spawna OpenFileDialog nativo
        "document.getElementById('btnPicker').addEventListener('click',function(){" +
        "var btn=this;" +
        "btn.disabled=true;btn.textContent='Aguarde...';" +
        "document.getElementById('spin').style.display='block';" +
        "fetch('/api/abrir-picker-fdb',{cache:'no-store'})" +
        ".then(function(r){return r.json();})" +
        ".then(function(d){" +
        "btn.disabled=false;btn.innerHTML=" + JSON.stringify(SVG_FOLDER + "Procurar") + ";" +
        "document.getElementById('spin').style.display='none';" +
        "if(d.ok&&d.caminho){document.getElementById('fdbPath').value=d.caminho;}" +
        "else if(d.cancelado){/* usuario cancelou — sem acao */}" +
        "else{mostrarErro(d.erro||'Não foi possível abrir o seletor de arquivos.');}}" +
        ")" +
        ".catch(function(e){" +
        "btn.disabled=false;btn.innerHTML=" + JSON.stringify(SVG_FOLDER + "Procurar") + ";" +
        "document.getElementById('spin').style.display='none';" +
        "mostrarErro('Erro ao abrir seletor: '+e.message);" +
        "});" +
        "});" +
        // Tecla Enter no campo dispara salvar
        "document.getElementById('fdbPath').addEventListener('keydown',function(e){" +
        "if(e.key==='Enter')salvar();" +
        "});" +
        "})();" +
        "function salvar(){" +
        "var p=document.getElementById('fdbPath').value.trim();" +
        "var btn=document.getElementById('btnSalvar');" +
        "if(!p){mostrarErro('Informe o caminho do arquivo SMALL.FDB.');return;}" +
        "if(!/\\.fdb$/i.test(p)){mostrarErro('O arquivo deve ter extensão .fdb');return;}" +
        "btn.disabled=true;btn.textContent='Conectando...';" +
        "document.getElementById('spin').style.display='block';" +
        "document.getElementById('err').style.display='none';" +
        "fetch('/api/salvar-fdb',{method:'POST'," +
        "headers:{'Content-Type':'application/json'}," +
        "body:JSON.stringify({caminho:p})})" +
        ".then(function(r){return r.json();})" +
        ".then(function(d){" +
        "if(d.ok){window.location.replace('/');}" +
        "else{" +
        "btn.disabled=false;btn.textContent='Conectar ao Banco';" +
        "document.getElementById('spin').style.display='none';" +
        "mostrarErro(d.erro||'Não foi possível conectar ao banco.');}" +
        "})" +
        ".catch(function(e){" +
        "btn.disabled=false;btn.textContent='Conectar ao Banco';" +
        "document.getElementById('spin').style.display='none';" +
        "mostrarErro('Erro de rede: '+e.message);" +
        "});" +
        "}" +
        "function mostrarErro(t){" +
        "var e=document.getElementById('err');" +
        "e.textContent=t;e.style.display='block';" +
        "window.scrollTo({top:0,behavior:'smooth'});" +
        "}" +
        SC4 +
        "</body></html>";
};

// ---------------------------------------------------------------------------
// Abre diálogo nativo Windows para selecionar arquivo .fdb.
// Usa PowerShell + System.Windows.Forms:
//   • Form pai criado com Text=APP_NAME e Icon=FAVICON (branding da loja).
//   • OpenFileDialog exibido via ShowDialog($form) para herdar o branding.
// Retorna { ok, caminho } | { ok:false, erro } | { cancelado:true }.
// ---------------------------------------------------------------------------
var abrirPickerFdbWindows = function(cb) {
    // ROBUSTEZ FIX (v2.4.1): o diálogo só existe no Windows (System.Windows.Forms).
    // Em qualquer outra plataforma o powershell.exe simplesmente não existe e o
    // spawn cairia no proc.on("error") — mas é mais claro e mais rápido recusar
    // antes de tentar.
    if (process.platform !== "win32") {
        cb({ ok: false, erro: "Seletor de arquivos nativo disponível apenas no Windows." });
        return;
    }

    // Escapa aspas simples para PowerShell (single-quoted strings: ' → '')
    var psNome  = APP_NAME.replace(/'/g, "''");
    var psIcone = FAVICON.replace(/'/g, "''"); // backslashes são literais em PS single-quoted

    // Script PowerShell: cria Form pai (com nome e ícone da loja) antes de chamar
    // ShowDialog($f), garantindo que o diálogo nativo exiba o branding correto.
    var ps = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "Add-Type -AssemblyName System.Drawing;",
        "$f = New-Object System.Windows.Forms.Form;",
        "$f.Text = '" + psNome + "';",
        "$f.ShowInTaskbar = $true;",
        "$f.WindowState = [System.Windows.Forms.FormWindowState]::Minimized;",
        "try { if (Test-Path '" + psIcone + "') { $f.Icon = New-Object System.Drawing.Icon('" + psIcone + "') } } catch {};",
        "$f.Show();",
        "$d = New-Object System.Windows.Forms.OpenFileDialog;",
        "$d.Title = '" + psNome + " \u2014 Selecionar banco de dados (.fdb)';",
        "$d.Filter = 'Banco Firebird (*.fdb)|*.fdb|Todos os arquivos (*.*)|*.*';",
        "$d.InitialDirectory = 'C:\\';",
        "if ($d.ShowDialog($f) -eq 'OK') { Write-Output $d.FileName } else { Write-Output '__CANCELADO__' };",
        "$f.Close()"
    ].join(" ");

    // CRASH FIX (v2.4.1): proc.on("error") e proc.on("close") podiam disparar os
    // DOIS para o mesmo processo (ex.: ENOENT do powershell.exe emite "error" e,
    // dependendo da versão do Node, ainda emite "close" com code=null) — cb() era
    // chamada duas vezes, e a segunda resposta na mesma request HTTP derrubava o
    // processo inteiro com ERR_HTTP_HEADERS_SENT.
    var _cbFeito = false;
    var _chamarCb = function(resultado) {
        if (_cbFeito) return;
        _cbFeito = true;
        clearTimeout(_pkTimer);
        cb(resultado);
    };

    var resultado = "";
    var proc;
    try {
        proc = spawn("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command", ps
        ], { stdio: ["ignore", "pipe", "pipe"] });
    } catch(spawnErr) {
        _chamarCb({ ok: false, erro: "Falha ao iniciar o PowerShell: " + (spawnErr && spawnErr.message || spawnErr) });
        return;
    }

    // Timeout de segurança: o diálogo fica aberto indefinidamente esperando o
    // usuário. 5 minutos é generoso o bastante para não incomodar, mas garante
    // que um PowerShell travado (ex.: pop-up de erro do .NET escondido atrás de
    // outra janela) não deixe o processo pendurado para sempre — mata o processo
    // e libera o botão "Procurar" no browser.
    var _pkTimer = setTimeout(function() {
        try { proc.kill(); } catch(_) {}
        if (process.platform === "win32" && proc.pid) {
            try { childProc.spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {stdio:"ignore"}); } catch(_) {}
        }
        _chamarCb({ ok: false, erro: "Seletor de arquivos não respondeu a tempo (5 min)." });
    }, 5 * 60 * 1000);

    if (proc.stdout) proc.stdout.on("data", function(d) { resultado += d.toString(); });
    if (proc.stderr) proc.stderr.on("data", function(){}); // drena para não travar o pipe

    proc.on("error", function(e) {
        _chamarCb({ ok: false, erro: "PowerShell não disponível: " + e.message });
    });

    proc.on("close", function(code) {
        var caminho = resultado.trim().replace(/\r?\n[\s\S]*$/, "").trim();
        if (!caminho || caminho === "__CANCELADO__") {
            _chamarCb({ ok: false, cancelado: true });
        } else {
            _chamarCb({ ok: true, caminho: caminho });
        }
    });
};

// ---------------------------------------------------------------------------
// Aplica novo caminho FDB em memória e reinicia conexão com o banco.
// Salva fdbPath e fbHost no config.json para persistir entre reinicializações.
// ---------------------------------------------------------------------------
var aplicarNovoFdb = function(caminhoBruto, cb) {
    // Aceita formatos: "C:\...\SMALL.FDB" ou "192.168.1.10:C:\...\SMALL.FDB"
    var parsed = parseFdb(caminhoBruto);
    var novoHost = parsed.host;
    var novoPath = parsed.dbPath;

    // Validação: arquivo deve existir localmente se host for 127.0.0.1
    if (novoHost === "127.0.0.1") {
        try {
            if (!fs.existsSync(novoPath)) {
                cb({ ok: false, erro: "Arquivo não encontrado: " + novoPath });
                return;
            }
        } catch(e) {
            cb({ ok: false, erro: "Erro ao verificar arquivo: " + e.message });
            return;
        }
    }

    logTs("[FDB Manual] Testando conexão em " + novoHost + ":" + novoPath + "...");

    testarFdb(novoHost, novoPath, function(ok, erro) {
        if (!ok) {
            // Avisa mas permite salvar mesmo assim (banco pode estar offline temporariamente)
            logTs("[FDB Manual] Conexão de teste falhou (" + (erro||"timeout") + ") — salvando mesmo assim.");
        }

        // Atualiza vars globais
        FDB_PATH = novoPath;
        FDB_HOST = novoHost;
        FDB      = novoHost + ":" + novoPath;

        // Persiste no config.json
        updateConfigKey("fdbPath", novoPath);
        updateConfigKey("fbHost",  novoHost);

        // Atualiza dbStatus
        if (ok) {
            dbStatus = { ok: true, ip: novoHost, erro: null, scanCompleto: true, scanning: false };
        } else {
            dbStatus = { ok: false, ip: novoHost, erro: erro || "Sem conexão no momento", scanCompleto: true, scanning: false };
        }

        // Desativa modo de seleção manual — servidor volta ao comportamento normal
        _aguardandoFdbManual = false;

        // Limpa cache e força regeneração imediata
        cache = Object.create(null);
        var dh = hoje();
        gerarEmBackground(dh, dh, dh);

        logTs("[FDB Manual] Banco configurado: " + FDB + " | Aguardando geração...");

        // Inicia polling se Firebird disponível e conexão OK
        if (Firebird && ok) {
            setTimeout(function() {
                pollStatus();
                // pollStatus: fallback de segurança + funções de correção de horário.
                // Fast-poll (50ms, conexão persistente) trata toda a detecção de mudanças.
                // pollStatus usa attach/detach por ciclo — rodar em excesso sobrecarrega
                // o Firebird desnecessariamente. Mínimo 2s independente de POLL_INTERVAL.
                if (_pollIntervalId) clearInterval(_pollIntervalId);
                _pollIntervalId = setInterval(pollStatus, Math.max(POLL_INTERVAL * POLL_RETRY_MULTIPLIER, 2000));
                _iniciarFastPoll(); // detecção em tempo real via conexão persistente
            }, 3000);
        }

        cb({ ok: true });
    });
};

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------
var server=http.createServer(function(req,res){
    
    if(/^\/(favicon\.(ico|png)|apple-touch-icon\.png)/.test(req.url)){
        if(fs.existsSync(FAVICON)){
            try{
                // PERF FIX: favicon em memória — evita readFileSync a cada request.
                // Cache invalidado quando mtime muda (upload de novo favicon).
                var _fMtime = 0;
                try { _fMtime = fs.statSync(FAVICON).mtimeMs; } catch(_sm) {}
                if (!_FAVICON_CACHE || _fMtime !== _FAVICON_CACHE_MTIME) {
                    _FAVICON_CACHE = fs.readFileSync(FAVICON);
                    _FAVICON_CACHE_MTIME = _fMtime;
                }
                res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"public,max-age=86400"});
                res.end(_FAVICON_CACHE);
            }
            catch(e){ logTs("WARN favicon read: "+e.message); res.writeHead(204);res.end();}
        }else{res.writeHead(204);res.end();}
        return;
    }

    var parsed;
    try{parsed=new URL(req.url,"http://localhost");}
    catch(_){res.writeHead(400);res.end("URL invalida.");return;}
    var rota=parsed.pathname||"/";

    // LOG DE API (v2.8.0): registra toda chamada a /api/* com origem, para
    // saber DE QUAL máquina veio cada comando — pedido do usuário e essencial
    // quando algo é alterado remotamente (proibidos, config, restart) e é
    // preciso descobrir quem fez.
    // Fica de fora: /api/status, /api/pronto e /api/events, que são o
    // batimento normal do relatório (várias chamadas por segundo, por aba) e
    // afogariam o log — o mesmo erro que a sondagem do fast-poll cometeu.
    // O nome do computador vem do cabeçalho X-Cliente que o api.ps1 envia;
    // navegador não envia, então nesses casos registra só o IP.
    // Rotas de POLLING não entram no log: são chamadas em intervalo fixo pelo
    // relatório e pelo tray (db-status a cada 10s, hora-usuario a cada 30s,
    // status/pronto/events várias vezes por segundo). Registrá-las enche o
    // arquivo de linhas idênticas e empurra o que importa para fora pela
    // rotação — foi o que aconteceu no log real do usuário.
    var _ROTAS_SEM_LOG = ["/api/status","/api/pronto","/api/events","/api/db-status","/api/hora-usuario"];
    if (rota.indexOf("/api/") === 0 && _ROTAS_SEM_LOG.indexOf(rota) === -1) {
        var _ipOrigem = ((req.socket && req.socket.remoteAddress) || "?").replace(/^::ffff:/, "");
        // Só registra chamadas vindas de OUTRO computador (v2.8.2). Requisição da
        // própria máquina é o funcionamento interno normal — o relatório aberto
        // aqui, o tray, o api.ps1 local — e enchia o log de linhas sem
        // informação. O valor do registro está em saber quando outra máquina da
        // rede age sobre este servidor: aí sim importa o que foi feito, quando e
        // por quem.
        // "Própria máquina" = loopback (127.x / ::1) ou o IP de rede deste
        // servidor (_maquinaIP): o SO entrega tráfego auto-endereçado das duas
        // formas, dependendo de como o cliente montou a URL — o api.ps1, por
        // exemplo, usa o IP de rede mesmo rodando localmente.
        var _ehLoopback   = /^127\./.test(_ipOrigem) || _ipOrigem === "::1";
        var _ehEstaMaquina = _ehLoopback || (_maquinaIP && _ipOrigem === _maquinaIP);
        if (!_ehEstaMaquina) {
            var _cliente = String(req.headers["x-cliente"] || "").trim().slice(0, 40);
            logTs("API: " + req.method + " " + rota + " de " + _ipOrigem +
                  (_cliente ? " (" + _cliente + ")" : ""));
        }
    }

    var sendJson = function(obj, code) {
        res.writeHead(code||200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
        res.end(JSON.stringify(obj||{}));
    };

    // /pronto
    if(rota==="/pronto"){
        var k=parsed.searchParams.get("k")||"",ek=cache[k];
        var rk=!ek||ek.gerando
            ?{pronto:false,erro:null,tentativa:ek?(ek.tentativa||1):1,matando:false}
            :ek.matando
            ?{pronto:false,erro:null,tentativa:ek.tentativa||1,matando:true}
            :ek.erro
            ?{pronto:false,erro:ek.erro,tentativa:1,matando:false}
            :{pronto:true,erro:null,tentativa:1,matando:false};
        res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-cache,no-store"});
        res.end(JSON.stringify(rk));return;
    }

    // /api/status
    if(rota==="/api/status"){
        // BUG FIX (auditoria v2.5.0): splice(0) era "consume-once" GLOBAL — só a
        // primeira aba/tela a chamar /api/status via de fato a notificação; as
        // demais, mesmo conectadas e pollando normalmente, nunca a recebiam
        // (ver _pushCorrecao acima para o detalhe completo). Agora é uma leitura
        // NÃO destrutiva por janela de tempo: toda tela que fizer poll dentro de
        // _CORRECOES_JANELA_MS após o evento recebe a notificação.
        var _agoraStatus = Date.now();
        var _corr = _correcoesPendentes.filter(function(c) { return (_agoraStatus - c.ts) < _CORRECOES_JANELA_MS; });
        var _statusPayload = Object.assign({}, statusAtual,
            {changeTs: _statusChangeTs},
            _corr.length ? {correcoes: _corr} : {});
        res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-cache,no-store"});
        res.end(JSON.stringify(_statusPayload));return;
    }

    // /api/restart
    if(rota==="/api/restart"){
        // SEGURANÇA: /api/restart só aceita requisições do próprio localhost.
        // Sem isso, qualquer host na rede local pode desligar o servidor.
        // BUG FIX (usuário reportou 403 usando api.ps1 NA PRÓPRIA máquina do
        // servidor): a checagem só reconhecia 127.0.0.1/::1 como "local" —
        // mas api.ps1 monta a URL a partir do IP de rede da máquina
        // (maquinaIP, ex: 192.168.1.33), não de localhost, mesmo quando
        // roda no mesmo computador. O SO frequentemente entrega esse
        // tráfego "auto-endereçado" com o IP de rede como remoteAddress em
        // vez de 127.0.0.1, fazendo a própria máquina do servidor ser
        // barrada como se fosse outro computador da rede. Corrigido para
        // também aceitar quando o IP de origem é EXATAMENTE o IP que este
        // servidor já reconhece como o seu próprio (_maquinaIP) — isso
        // continua bloqueando qualquer OUTRA máquina da rede (cujo IP de
        // origem seria o dela mesma, nunca igual a _maquinaIP), preservando
        // a intenção original de segurança.
        // ESCOPO (v2.7.8): passou a aceitar também a REDE LOCAL, além de
        // localhost e da própria máquina do servidor. Motivo: reiniciar o
        // servidor pelo api.ps1 a partir de outro PC da loja é justamente o
        // uso previsto da ferramenta — e era bloqueado com 403, sem alternativa
        // prática (o restart pela própria máquina exige ir até ela). Todo o
        // resto do sistema (relatório, /api/config, proibidos, upload de
        // favicon) já é aberto à rede local por design; manter só o restart
        // fechado protegia pouco e atrapalhava muito.
        // Endereços FORA da rede local continuam bloqueados: nenhuma máquina
        // de outra rede consegue derrubar o servidor.
        var _remoteIp = (req.socket && req.socket.remoteAddress) || "";
        var _remoteIpLimpo = _remoteIp.replace(/^::ffff:/, ""); // normaliza IPv4-mapeado-em-IPv6
        var _ehRedeLocal = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(_remoteIpLimpo)
            || _remoteIp === "::1";
        if (!_ehRedeLocal && _maquinaIP && BIND_ADDR === "0.0.0.0") {
            res.writeHead(403, {"Content-Type":"application/json; charset=utf-8"});
            res.end(JSON.stringify({ok:false,erro:"Acesso negado — restart disponível apenas a partir da rede local."}));
            return;
        }
        logTs("Reinicialização solicitada via API ("
            + (req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "local")
            + "). Encerrando em 1s...");
        res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});
        res.end(JSON.stringify({ok:true,msg:"Servidor encerrando. O tray reiniciará em ~10s."}));
        setTimeout(function(){
            // BUG FIX: usava loop inline sem /T (kill tree) no Windows, diferente de
            // _matarTodosFilhos que usa /F /T. Agora reutiliza a função centralizada.
            _matarTodosFilhos();
            setTimeout(function(){ process.exit(0); }, 400);
        }, 1000);
        return;
    }

    // /api/db-status
    if(rota==="/api/db-status"){
        res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-cache,no-store"});
        res.end(JSON.stringify(dbStatus));return;
    }

    // /api/proibidos GET
    if(rota==="/api/proibidos" && req.method === "GET"){
        // PERF FIX: usa _config em memória — /api/proibidos é chamado pelo poll do browser
        // a cada POLL_INTERVAL; loadConfig() a cada request causava readFileSync excessivo.
        // _config é atualizado via /api/config POST quando o usuário salva configurações.
        res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-cache,no-store"});
        res.end(JSON.stringify({proibidos: _config.proibidos || []}));
        return;
    }

    // ---------------------------------------------------------------------------
    // /api/itens-detalhe?data=YYYY-MM-DD&chave=PEDIDO
    // Retorna os itens detalhados de uma venda diretamente do Firebird.
    // Usado pelo modal de detalhes via lazy loading — itensDetalhe não é mais
    // embutido no JSON inline do HTML, reduzindo drasticamente o tamanho da página.
    // Formato de resposta: [ { desc, qtd, total, cancelado } ]
    // ---------------------------------------------------------------------------
    if (rota === "/api/itens-detalhe" && req.method === "GET") {
        if (!Firebird || !dbStatus.ok) {
            res.writeHead(503, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-cache,no-store"});
            res.end(JSON.stringify({ok:false,erro:"Banco indisponivel.",itens:[]}));
            return;
        }
        var _idData  = (parsed.searchParams.get("data")  || "").trim();
        var _idChave = (parsed.searchParams.get("chave") || "").trim();

        // Validações básicas para evitar injeção SQL via parâmetros
        if (!/^\d{4}-\d{2}-\d{2}$/.test(_idData) || !_idChave || _idChave.length > 60) {
            res.writeHead(400, {"Content-Type":"application/json; charset=utf-8"});
            res.end(JSON.stringify({ok:false,erro:"Parametros invalidos.",itens:[]}));
            return;
        }

        var _idOpts = {host:FDB_HOST,port:FIREBIRD_PORT,database:FDB_PATH,user:USER,password:PASS,
                       role:null,charset:FB_CHARSET};

        // CRASH FIX (v2.4.1): antes existia apenas _idEncerrado, usado ao mesmo tempo
        // como "já respondi" e como "já fechei a conexão". Quando o timeout de 8 s
        // disparava, ele respondia 504 e marcava _idEncerrado=true; a callback tardia
        // da query então chamava _idFechar() (que retornava sem fazer nada, vazando a
        // conexão) e seguia para res.writeHead(200/500) — segunda resposta na mesma
        // request → ERR_HTTP_HEADERS_SENT → uncaughtException no processo inteiro.
        // Agora são dois estados independentes e uma referência externa da conexão.
        var _idRespondido = false;   // resposta HTTP já enviada
        var _idFechado    = false;   // conexão Firebird já encerrada
        var _idDbRef      = null;    // referência acessível pelo timeout

        var _idFechar = function(){
            if (_idFechado) return;
            _idFechado = true;
            clearTimeout(_idTimer);
            if (_idDbRef) { try { _idDbRef.detach(); } catch(_) { try { _matarConexao(_idDbRef); } catch(__) {} } }
            _idDbRef = null;
        };
        var _idResponder = function(code, payload){
            if (_idRespondido || res.headersSent) return;
            _idRespondido = true;
            try {
                res.writeHead(code,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-cache,no-store"});
                res.end(JSON.stringify(payload));
            } catch(e) { logTs("WARN /api/itens-detalhe resposta: "+e.message); }
        };

        var _idTimer = setTimeout(function(){
            _idResponder(504, {ok:false,erro:"Timeout ao consultar itens.",itens:[]});
            _idFechar(); // fecha a conexão que ficou pendurada — antes vazava
        }, 8000);

        // Se o cliente abandonar a request, encerra a conexão sem tentar responder.
        req.on("close", function(){ _idRespondido = true; _idFechar(); });

        Firebird.attach(_idOpts, function(errConn, idDb){
            if (_idFechado || _idRespondido) { if (idDb) { try{idDb.detach();}catch(_){} } return; }
            if (errConn || !idDb) {
                _idFechar();
                _idResponder(503, {ok:false,erro:"Falha ao conectar ao banco.",itens:[]});
                return;
            }
            _idDbRef = idDb;

            // DADO ERRADO FIX (v2.4.1): o probe anterior era
            //   SELECT FIRST 1 TOTAL, PRECO FROM ALTERACA WHERE 1=2
            // "WHERE 1=2" nunca retorna linhas, então probeRows era [] e
            // `"TOTAL" in rows[0]` avaliava sobre um objeto vazio → SEMPRE false.
            // Resultado: _colTotal caía sempre em "cast(null as double precision)"
            // e TODO item do modal de detalhes vinha com total = null.
            // (A premissa do comentário antigo também estava errada: o Firebird
            //  aborta a instrução inteira ao encontrar coluna inexistente, não
            //  devolve o campo como null.)
            // Correção: ler o catálogo do sistema — determinístico, 1 query, sem
            // depender de existir linha na tabela.
            idDb.query(
                "SELECT TRIM(RDB$FIELD_NAME) AS COLUNA FROM RDB$RELATION_FIELDS " +
                "WHERE TRIM(RDB$RELATION_NAME) = 'ALTERACA'",
                [],
                function(errProbe, probeRows){
                var _cols = {};
                if (!errProbe && Array.isArray(probeRows)) {
                    probeRows.forEach(function(pr){
                        if (!pr) return;
                        var nome = pr.COLUNA || pr.coluna;
                        if (Buffer.isBuffer(nome)) { try { nome = _win1252Decoder.decode(nome); } catch(_) { nome = ""; } }
                        nome = String(nome || "").trim().toUpperCase();
                        if (nome) _cols[nome] = true;
                    });
                }
                var _temTotal = !!_cols.TOTAL;
                var _temPreco = !!_cols.PRECO;
                var _temQtd   = !!_cols.QUANTIDADE;
                var _colQtd   = _temQtd ? "coalesce(QUANTIDADE,1)" : "1";
                var _colTotal = _temTotal
                    ? "cast(TOTAL as double precision)"
                    : (_temPreco ? "cast(PRECO as double precision) * cast(" + _colQtd + " as double precision)" : "cast(null as double precision)");
                if (errProbe) {
                    logTs("WARN /api/itens-detalhe: falha ao ler colunas de ALTERACA (" + errProbe.message + ") — total virá nulo.");
                }

                // Normaliza o pedido: tenta com zeros e sem zeros para cobrir ambos os formatos
                var _pedidos = [_idChave];
                var _stripped = _idChave.replace(/^0+/, "") || _idChave;
                if (_stripped !== _idChave) _pedidos.push(_stripped);
                var _ph = _pedidos.map(function(){ return "?"; }).join(",");

                // ROBUSTEZ: QUANTIDADE e ITEM só entram na SQL se existirem no
                // catálogo — em bases antigas do Small Commerce a ausência de uma
                // delas fazia a query inteira falhar com "column unknown".
                var _sqlAlt =
                    "SELECT cast(DESCRICAO as varchar(120)) as DESC_A," +
                    "       cast(" + _colQtd + " as double precision) as QTD_A," +
                    "       " + _colTotal + " as TOT_A " +
                    "FROM ALTERACA " +
                    "WHERE DATA >= cast(? as date) AND DATA < cast(? as date) + 1 " +
                    "  AND cast(PEDIDO as varchar(60)) IN (" + _ph + ") " +
                    (_cols.ITEM ? "ORDER BY ITEM" : "");

                idDb.query(_sqlAlt, [_idData, _idData].concat(_pedidos), function(errQ, rows){
                    // O cliente pode ter desconectado ou o timeout de 8s já pode ter
                    // respondido enquanto esta query rodava — não processa nem responde de novo.
                    if (_idRespondido) { _idFechar(); return; }

                    if (errQ || !rows) {
                        _idFechar();
                        _idResponder(500, {ok:false,erro:"Erro na consulta: "+(errQ&&errQ.message||"desconhecido"),itens:[]});
                        return;
                    }

                    // _win1252Decoder e _fmtQuantidade são constantes de módulo (topo do arquivo).
                    // Evitam recriar TextDecoder e a função de formatação a cada request.
                    var itens = [];
                    for (var ri = 0; ri < rows.length; ri++) {
                        var row = rows[ri];
                        // Decodifica campos Buffer que possam vir como Windows-1252
                        for (var k in row) {
                            if (Buffer.isBuffer(row[k])) row[k] = _win1252Decoder.decode(row[k]);
                        }
                        var desc = String(row.DESC_A || row.desc_a || "").trim();
                        if (!desc) continue;
                        var isCancelado = /cancelad/i.test(desc) || desc === "<CANCELADO>";
                        if (isCancelado) continue;
                        var qtd    = _fmtQuantidade(row.QTD_A || row.qtd_a || 1);
                        var totVal = (row.TOT_A !== null && row.TOT_A !== undefined) ? Number(row.TOT_A || row.tot_a || null) : null;
                        itens.push({
                            desc: desc,
                            qtd: qtd,
                            total: (totVal !== null && Number.isFinite(totVal)) ? totVal : null,
                            cancelado: false
                        });
                    }

                    _idFechar();
                    _idResponder(200, {ok:true, itens:itens});
                });
            });
        });
        return;
    }

    // /api/proibidos POST
    if(rota==="/api/proibidos" && req.method === "POST"){
        lerBodySeguro(req, function(err, body) {
            if (err) { res.writeHead(413, {"Content-Type":"application/json; charset=utf-8"}); res.end(JSON.stringify({ok:false,erro:err.message})); return; }
            try {
                var payload = JSON.parse(body);
                // VALIDAÇÃO FIX: aceita apenas arrays de strings — evita salvar tipos inválidos
                // como [1, {}, null] que poderiam corromper config.json ou crashar o filtro de relatório.
                if (!Array.isArray(payload)) {
                    res.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});
                    res.end(JSON.stringify({ok:false,erro:"Payload deve ser um array de strings."}));
                    return;
                }
                var proibidosLimpos = payload
                    .filter(function(i){ return typeof i === "string"; })
                    .map(function(s){ return s.trim(); })
                    .filter(function(s){ return s.length > 0; });
                updateConfigKey("proibidos", proibidosLimpos);
                appCfg.proibidos = proibidosLimpos;
                _config.proibidos = proibidosLimpos;
                cache = Object.create(null);
                var dh = hoje();
                gerarEmBackground(dh, dh, dh);
                res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});
                res.end(JSON.stringify({ok:true}));
            } catch(e) {
                // CATCH FIX: catch silencioso → log + resposta estruturada de erro
                logTs("ERRO /api/proibidos POST: "+e.message);
                res.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});
                res.end(JSON.stringify({ok:false,erro:e.message}));
            }
        });
        return;
    }

    // /api/config GET — usa _config em memória (sem readFileSync por request)
    if(rota==="/api/config" && req.method==="GET"){
        sendJson({
            appName:               _config.appName              || "",
            pollInterval:          _config.pollInterval         || 200,
            maxLogLines:           _config.maxLogLines          || 1000,
            favicon:               _config.favicon              || "",
            toastDuration:         _config.toastDuration        || 5000, // CONTRATO FIX: padrão unificado com filho (era 4000)
            spawnTimeoutMs:        _SPAWN_TIMEOUT_MS,
            proibidos:             Array.isArray(_config.proibidos) ? _config.proibidos : [],
            teclasPersonalizadas:  Array.isArray(_config.teclasPersonalizadas) ? _config.teclasPersonalizadas : []
        });
        return;
    }

    // /api/config POST
    if(rota==="/api/config" && req.method==="POST"){
        lerBodySeguro(req, function(errBody, cfgBody) {
            if (errBody) { res.writeHead(413,{"Content-Type":"application/json; charset=utf-8"}); res.end(JSON.stringify({ok:false,erro:errBody.message})); return; }
            try{
                var p=JSON.parse(cfgBody);
                var rawCfg="";
                try{ rawCfg=fs.readFileSync(CONFIG,"utf8").replace(/^\uFEFF/,"").trim(); }catch(e){}
                var obj={};
                if(rawCfg){ try{ obj=JSON.parse(rawCfg); }catch(e){ res.writeHead(500); res.end(JSON.stringify({ok:false,erro:"config.json corrompido"})); return; } }
                if(typeof obj!=="object"||Array.isArray(obj)) obj={};

                if(p.appName       !== undefined){ var n=String(p.appName||"").trim();    if(n) obj.appName=n; }
                if(p.pollInterval  !== undefined){ var pi=parseInt(p.pollInterval,10);    if(pi>=200) obj.pollInterval=pi; }
                if(p.maxLogLines   !== undefined){ var ml=parseInt(p.maxLogLines,10);     if(ml>=100) obj.maxLogLines=ml; }
                if(p.favicon       !== undefined){
                    // SEGURANÇA FIX (v2.5.0): ver _faviconCaminhoSeguro — rejeita caminhos
                    // fora da pasta do app e caminhos UNC, em vez de aceitar qualquer string.
                    var _favChk = _faviconCaminhoSeguro(p.favicon);
                    if (!_favChk.ok) {
                        res.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});
                        res.end(JSON.stringify({ok:false,erro:"Favicon inválido: " + _favChk.motivo}));
                        return;
                    }
                    obj.favicon = _favChk.valor;
                }
                if(p.toastDuration !== undefined){ var td=parseInt(p.toastDuration,10);   if(td>=500&&td<=60000) obj.toastDuration=td; }
                if(p.proibidos            !== undefined && Array.isArray(p.proibidos)){ obj.proibidos=p.proibidos; }
                if(p.teclasPersonalizadas !== undefined && Array.isArray(p.teclasPersonalizadas)){
                    obj.teclasPersonalizadas = p.teclasPersonalizadas.filter(function(t){
                        return t && typeof t.tecla === "string" && typeof t.comando === "string";
                    });
                }

                // PRECISÃO FIX (v2.6.7): gravação atômica do config.json. Este
                // arquivo já era gravado direto (writeFileSync no destino),
                // enquanto o hora-fixada-cache.json — MUITO menos crítico — já
                // usava _gravarArquivoAtomico neste mesmo arquivo. A assimetria
                // era perigosa porque o tray encerra este processo com
                // "taskkill /F /T" (kill imediato, sem chance de terminar a
                // escrita) sempre que o usuário clica em "Reiniciar servidor" ou
                // o watchdog detecta travamento. Um kill no meio do writeFileSync
                // deixava config.json truncado — e como loadConfig() descarta JSON
                // inválido e volta aos padrões, a loja perderia de uma vez
                // appName, porta, lista de proibidos e, o pior de tudo, fdbPath:
                // sem ele o servidor não acha o banco e o relatório para de
                // funcionar até alguém reconfigurar na mão.
                if (!_gravarArquivoAtomico(CONFIG, JSON.stringify(obj,null,2))) {
                    logTs("ERRO /api/config: falha ao gravar config.json em disco.");
                    res.writeHead(500,{"Content-Type":"application/json; charset=utf-8"});
                    res.end(JSON.stringify({ok:false,erro:"Falha ao gravar config.json em disco."}));
                    return;
                }

                // CONFIG RELOAD FIX: não relê o arquivo que acabou de escrever.
                // Usa diretamente o objeto 'obj' já construído em memória — uma única operação.
                if(obj.appName&&obj.appName.trim()) APP_NAME=obj.appName.trim();
                if(obj.pollInterval&&parseInt(obj.pollInterval,10)>0){
                    POLL_INTERVAL=parseInt(obj.pollInterval,10);
                    // PRECISÃO FIX (v2.6.5): a janela de entrega das notificações de
                    // correção de hora é derivada do POLL_INTERVAL — sem recalcular
                    // aqui, alterar o intervalo na tela de configurações deixava a
                    // janela com o valor ANTIGO até o servidor reiniciar, e um
                    // intervalo novo maior que a janela antiga faria os toasts serem
                    // perdidos silenciosamente. Mantido em sincronia com a fórmula
                    // usada na inicialização (procure por "_CORRECOES_JANELA_MS").
                    _CORRECOES_JANELA_MS = Math.max(3000, POLL_INTERVAL * 3);
                    _CORRECOES_TTL_MS    = _CORRECOES_JANELA_MS + 5000;
                    // BUG FIX (v2.4.1): o setInterval de pollStatus é criado uma única
                    // vez no boot com o valor original de POLL_INTERVAL×POLL_RETRY_MULTIPLIER.
                    // Sem recriá-lo aqui, alterar o intervalo de polling na tela de
                    // configurações não tinha efeito nenhum até o servidor reiniciar —
                    // o campo "salvava" mas o comportamento real não mudava.
                    if (Firebird && dbStatus.ok) {
                        if (_pollIntervalId) clearInterval(_pollIntervalId);
                        _pollIntervalId = setInterval(pollStatus, Math.max(POLL_INTERVAL * POLL_RETRY_MULTIPLIER, 2000));
                    }
                }
                if(obj.maxLogLines&&parseInt(obj.maxLogLines,10)>=100){
                    MAX_LOG_LINES=parseInt(obj.maxLogLines,10);
                    if(_logBuffer.length>MAX_LOG_LINES) _logBuffer.splice(0, _logBuffer.length - MAX_LOG_LINES);
                    // PRECISÃO FIX (v2.6.5): com o logger append-only (v2.6.2), podar
                    // apenas o buffer em memória não encolhe mais o ARQUIVO — ele só
                    // seria cortado na próxima rotação natural, que pode demorar
                    // MAX_LOG_LINES linhas. Quem acabou de REDUZIR o limite espera
                    // ver efeito agora, não daqui a milhares de linhas. Força a
                    // rotação imediata zerando o contador (a própria função relê o
                    // arquivo do disco e grava de forma atômica).
                    _logLinhasDesdeRotacao = MAX_LOG_LINES;
                    _rotacionarLogSeNecessario();
                }
                if(p.favicon !== undefined){
                    // BUG FIX (v2.5.0): antes, só um valor NÃO-VAZIO atualizava FAVICON —
                    // limpar o campo (voltar ao padrão, exatamente como a própria tela de
                    // configurações promete: "vazio para padrão") não tinha efeito nenhum
                    // em memória (o config.json salvava vazio, mas o ícone servido
                    // continuava sendo o customizado anterior até reiniciar o servidor).
                    // obj.favicon já foi validado acima por _faviconCaminhoSeguro.
                    FAVICON = obj.favicon ? obj.favicon : path.join(__dirname, "favicon.png");
                    _FAVICON_CACHE = null; // invalida o cache em memória do favicon servido
                }
                if(obj.toastDuration&&parseInt(obj.toastDuration,10)>=500) TOAST_DURATION=parseInt(obj.toastDuration,10);

                // Sincroniza _config em memória com o objeto já processado (sem novo readFileSync).
                try { Object.assign(_config, obj); appCfg = _config; cfg = _config; } catch(_sc) {}

                cache=Object.create(null);
                var dh=hoje(); gerarEmBackground(dh,dh,dh);

                logTs("Configurações salvas via modal.");
                res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});
                res.end(JSON.stringify({ok:true}));
            }catch(e){
                logTs("ERRO /api/config POST: "+e.message);
                res.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});
                res.end(JSON.stringify({ok:false,erro:e.message}));
            }
        });
        return;
    }

    // /config — página HTML
    if(rota==="/config"){
        var SC3="</"+"script>";
        var cfgHtml=(function(){
            // Usa _config em memória — sem readFileSync por request de página
            var cc=_config;
            var _pn=escH(APP_NAME);
            var _pi=parseInt(cc.pollInterval||POLL_INTERVAL,10);
            var _ml=parseInt(cc.maxLogLines||MAX_LOG_LINES,10);
            var _td=parseInt(cc.toastDuration||TOAST_DURATION||5000,10);
            var _fv=escH(cc.favicon||"");
            var _pr=JSON.stringify(Array.isArray(cc.proibidos)?cc.proibidos:[]);
            return "<!doctype html><html lang=\"pt-br\"><head><meta charset=\"utf-8\">"+htmlFavicon+"<title>Configuracoes</title>"+
            "<script>(function(){try{var t=localStorage.getItem('fdb_theme')||(document.cookie.match(/fdb_theme=([^;]+)/)||[])[1]||'ultra-dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();"+SC3+
            "<style>"+
            "*{box-sizing:border-box}"+
            "body{margin:0;background:#000;display:flex;align-items:flex-start;justify-content:center;min-height:100vh;font-family:Inter,Arial,sans-serif;color:#ededed;padding:40px 16px}"+
            ".box{background:#0a0a0a;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:36px 40px;width:100%;max-width:520px}"+
            "h2{margin:0 0 6px;font-size:20px;font-weight:700}"+
            ".sub{color:#71717a;font-size:13px;margin-bottom:15px}"+
            ".field{margin-bottom:15px}"+
            "label{display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#a1a1aa;margin-bottom:7px}"+
            ".hint{font-size:12px;color:#52525b;margin-top:5px}"+
            "input[type=text],input[type=number]{display:block;width:100%;background:#000;color:#ededed;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:10px 14px;font-size:14px;outline:none}"+
            "input:focus{border-color:#0ea5e9}"+
            "textarea{display:block;width:100%;background:#000;color:#ededed;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:10px 14px;font-size:13px;font-family:monospace;outline:none;resize:vertical;min-height:90px}"+
            "textarea:focus{border-color:#0ea5e9}"+
            ".row{display:flex;gap:12px}.row .field{flex:1}"+
            ".btn{width:100%;padding:14px;background:#0ea5e9;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-top:8px}"+
            ".btn:hover{background:#0284c7}.btn:disabled{opacity:.5;cursor:not-allowed}"+
            ".btn-sec{background:rgba(255,255,255,.07);color:#ededed}.btn-sec:hover{background:rgba(255,255,255,.13)}"+
            "#msg{display:none;padding:12px 16px;border-radius:8px;font-size:14px;margin-bottom:16px}"+
            ".ok{background:rgba(34,197,94,.12);color:#4ade80;border:1px solid rgba(34,197,94,.25)}"+
            ".er{background:rgba(248,113,113,.12);color:#f87171;border:1px solid rgba(248,113,113,.25)}"+
            ".sep{border:none;border-top:1px solid rgba(255,255,255,.07);margin:12px 0}"+
            "</style></head><body><div class=\"box\">"+
            "<h2>Configuracoes</h2><p class=\"sub\">Apenas campos editaveis pelo painel. Outras opcoes: edite config.json diretamente.</p>"+
            "<div id=\"msg\"></div>"+
            "<div class=\"field\"><label>Nome do sistema (appName)</label><input type=\"text\" id=\"appName\" value=\""+_pn+"\"><p class=\"hint\">Exibido no titulo da pagina e no icone da bandeja.</p></div>"+
            "<div class=\"row\">"+
            "<div class=\"field\"><label>Intervalo de polling (ms)</label><input type=\"number\" id=\"pollInterval\" value=\""+_pi+"\" min=\"200\" step=\"100\"><p class=\"hint\">Minimo: 200 ms</p></div>"+
            "<div class=\"field\"><label>Maximo de linhas de log</label><input type=\"number\" id=\"maxLogLines\" value=\""+_ml+"\" min=\"100\" step=\"100\"><p class=\"hint\">Minimo: 100 linhas</p></div>"+
            "</div>"+
            "<div class=\"field\"><label>Duracao do toast (ms)</label><input type=\"number\" id=\"toastDuration\" value=\""+_td+"\" min=\"500\" max=\"60000\" step=\"500\"><p class=\"hint\">Tempo que a notificacao de mudanca fica visivel. Minimo: 500 ms, maximo: 60 000 ms.</p></div>"+
            "<div class=\"field\">"+
              "<label>Ícone (favicon)</label>"+
              "<div style=\"display:flex;gap:2px;align-items:center;flex-wrap:wrap\">"+
                "<input type=\"text\" id=\"favicon\" placeholder=\"Caminho do arquivo ou vazio para usar favicon na mesma pasta\" value=\""+_fv+"\" style=\"flex:1;min-width:0\">"+
                "<button class=\"btn btn-sec\" type=\"button\" id=\"favPick\" style=\"white-space:nowrap;height:38px;padding:0 14px\" title=\"Selecionar arquivo do computador\">" + SVG_FOLDER + "Procurar</button>"+
                "<input type=\"file\" id=\"favFile\" accept=\".png,.ico,.jpg,.jpeg\" style=\"display:none\">"+
              "</div>"+
              "<p class=\"hint\" id=\"favHint\">"+(_fv?"Atual: "+_fv:"Usando favicon.png padrao na mesma pasta dos arquivos")+"</p>"+
            "</div>"+
            "<hr class=\"sep\">"+
            "<div class=\"field\"><label>Proibidos (um por linha)</label>"+
            "<textarea id=\"proibidos\" placeholder=\"Nome1\nNome2\nProduto A\"></textarea>"+
            "<p class=\"hint\">Vendas com esses termos serao ocultadas do relatorio.</p></div>"+
            "<button class=\"btn\" id=\"salvarBtn\" onclick=\"salvar()\">Salvar configuracoes</button>"+
            "<button class=\"btn btn-sec\" style=\"margin-top:10px\" onclick=\"window.location.href='/'\">Voltar para o relatorio</button>"+
            "</div>"+
            "<script>"+
            "(function(){"+
            "var pr="+_pr+";"+
            "document.getElementById('proibidos').value=Array.isArray(pr)?pr.join('\\n'):'';"+
            "var _fi=document.getElementById('favFile');"+
            "document.getElementById('favPick').addEventListener('click',function(){_fi.click();});"+
            "_fi.addEventListener('change',function(){"+
            "var f=_fi.files&&_fi.files[0];"+
            "if(!f)return;"+
            "var h=document.getElementById('favHint');"+
            "if(h)h.textContent='Arquivo selecionado: '+f.name+' ('+Math.round(f.size/1024)+' KB) — sera enviado ao salvar.';"+
            "document.getElementById('favicon').value='';"+
            "});"+
            "})();"+
            "function salvar(){"+
            "var btn=document.getElementById('salvarBtn'),msg=document.getElementById('msg');"+
            "btn.disabled=true;btn.textContent='Salvando...';msg.style.display='none';"+
            "var an=document.getElementById('appName').value.trim();"+
            "var pi=parseInt(document.getElementById('pollInterval').value,10)||200;"+
            "var ml=parseInt(document.getElementById('maxLogLines').value,10)||1000;"+
            "var td=parseInt(document.getElementById('toastDuration').value,10)||4000;"+
            "var fv=document.getElementById('favicon').value.trim();"+
            "var praw=document.getElementById('proibidos').value;"+
            "var pr=praw.split('\\n').map(function(s){return s.trim();}).filter(function(s){return s.length>0;});"+
            "var favFile=document.getElementById('favFile').files&&document.getElementById('favFile').files[0];"+
            "if(!an){showMsg('O nome do sistema nao pode estar vazio.','er');btn.disabled=false;btn.textContent='Salvar configuracoes';return;}"+
            "if(pi<200){showMsg('Intervalo minimo e 200 ms.','er');btn.disabled=false;btn.textContent='Salvar configuracoes';return;}"+
            "if(ml<100){showMsg('Maximo de linhas minimo e 100.','er');btn.disabled=false;btn.textContent='Salvar configuracoes';return;}"+
            "if(td<500||td>60000){showMsg('Duracao do toast deve estar entre 500 e 60 000 ms.','er');btn.disabled=false;btn.textContent='Salvar configuracoes';return;}"+
            "var doSave=function(){"+
            "fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},"+
            "body:JSON.stringify({appName:an,pollInterval:pi,maxLogLines:ml,toastDuration:td,favicon:fv,proibidos:pr})})"+
            ".then(function(r){return r.json();})"+
            ".then(function(d){"+
            "if(d.ok){showMsg('Configuracoes salvas com sucesso! O relatorio sera atualizado.','ok');}"+
            "else{showMsg('Erro: '+(d.erro||'Falha desconhecida'),'er');}"+
            "btn.disabled=false;btn.textContent='Salvar configuracoes';"+
            "})"+
            ".catch(function(e){showMsg('Erro de rede: '+e.message,'er');btn.disabled=false;btn.textContent='Salvar configuracoes';});"+
            "};"+
            "if(favFile){"+
            "var reader=new FileReader();"+
            "reader.onload=function(ev){"+
            "fetch('/api/upload-favicon',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:ev.target.result})"+
            ".then(function(r){return r.json();})"+
            ".then(function(d){"+
            "if(d.ok){fv='';var h=document.getElementById('favHint');if(h)h.textContent='Favicon atualizado com sucesso!';}"+
            "else{showMsg('Aviso favicon: '+(d.erro||'Falha no upload'),'er');}"+
            "doSave();"+
            "}).catch(function(){showMsg('Aviso: falha no upload do favicon — salvando demais configuracoes.','er');doSave();});"+
            "};"+
            "reader.readAsArrayBuffer(favFile);"+
            "}else{doSave();}"+
            "}"+
            "function showMsg(t,cls){var m=document.getElementById('msg');m.textContent=t;m.className=cls;m.style.display='block';window.scrollTo({top:0,behavior:'smooth'});}"+
            SC3+
            "</body></html>";
        })();
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
        res.end(cfgHtml);
        return;
    }

    // /api/log-error
    if(rota==="/api/log-error" && req.method==="POST"){
        lerBodySeguro(req, function(err, errBody) {
            if (!err) {
                try{
                    var e=JSON.parse(errBody);
                    // RUÍDO FIX (v2.7.2): descarta erros originados de EXTENSÕES DO
                    // NAVEGADOR. O filtro principal fica no cliente
                    // (gerar-relatorio-html.js v2.6.7), mas esta segunda camada é
                    // necessária porque abas já abertas continuam rodando o HTML
                    // ANTIGO, sem o filtro, até serem recarregadas — e um relatório
                    // costuma ficar aberto o dia inteiro numa tela de loja. Caso
                    // real: uma extensão do Chrome falhando ~1x/s gerou 92% de todo
                    // o relatorio.log (1360 de 1478 linhas), empurrando para fora a
                    // informação de diagnóstico útil pela rotação do arquivo.
                    var _stackTxt = String(e.stack||"") + " " + String(e.src||"");
                    if(/(?:chrome|moz|safari|ms-browser)-extension:\/\//i.test(_stackTxt)){
                        res.writeHead(204);res.end();return;
                    }
                    logTs("[BROWSER-ERROR] "+String(e.msg||"")+(e.src?" | "+e.src:"")+(e.line?" L"+e.line:"")+(e.col?":"+e.col:"")+(e.stack?"\n"+e.stack:""));
                }catch(_){}
            }
            res.writeHead(204);res.end();
        });
        return;
    }

    // /api/hora-usuario POST — browser envia Date.now() para sincronizar relógio.
    if(rota==="/api/hora-usuario" && req.method==="POST"){
        lerBodySeguro(req, function(errHora, _horaBody) {
            if (errHora) { res.writeHead(413); res.end(); return; }
            try{
                var _hp=JSON.parse(_horaBody);
                // tzOffsetMs = browser.getTimezoneOffset() * 60000
                // Válido entre -720 min (UTC+12) e +840 min (UTC-14)
                var tzMs=Number(_hp.tzOffsetMs);
                if(!isNaN(tzMs) && tzMs >= -720*60000 && tzMs <= 840*60000){
                    var mudou = Math.abs(tzMs - _clientTzOffsetMs) > 60000; // >1 min de diferença
                    if(mudou){
                        var h = Math.abs(Math.round(tzMs/3600000));
                        var sinal = tzMs >= 0 ? "-" : "+";
                        logDebug("Fuso do usuário sincronizado: UTC"+sinal+h+"h (tzOffsetMs="+tzMs+").");
                    }
                    _clientTzOffsetMs = tzMs;
                }
                res.writeHead(204);res.end();
            }catch(e){
                res.writeHead(400);res.end();
            }
        });
        return;
    }

    // /api/sse-clients
    if(rota==="/api/sse-clients"){
        sendJson({clients: sseClients.length});return;
    }

    // -----------------------------------------------------------------------
    // /selecionar-fdb — página HTML de seleção manual do FDB
    // Acessível sempre (mesmo quando dbStatus.ok=true) para reconfiguração.
    // -----------------------------------------------------------------------
    if(rota==="/selecionar-fdb"){
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
        res.end(paginaEscolherFdb());
        return;
    }

    // -----------------------------------------------------------------------
    // /api/abrir-picker-fdb GET — abre OpenFileDialog nativo do Windows
    // Responde: { ok:true, caminho:"C:\..." } | { ok:false, cancelado:true } | { ok:false, erro:"..." }
    // -----------------------------------------------------------------------
    if(rota==="/api/abrir-picker-fdb" && req.method==="GET"){
        abrirPickerFdbWindows(function(resultado) {
            res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
            res.end(JSON.stringify(resultado));
        });
        return;
    }

    // -----------------------------------------------------------------------
    // /api/salvar-fdb POST — recebe { caminho } e aplica o novo FDB
    // Valida existência do arquivo, testa conexão, persiste e limpa cache.
    // Responde: { ok:true } | { ok:false, erro:"..." }
    // -----------------------------------------------------------------------
    if(rota==="/api/salvar-fdb" && req.method==="POST"){
        lerBodySeguro(req, function(errFdb, fdbBody) {
            if (errFdb) { sendJson({ok:false, erro:errFdb.message}); return; }
            try{
                var payload = JSON.parse(fdbBody);
                var caminho = String(payload.caminho||"").trim();
                if(!caminho){
                    sendJson({ok:false, erro:"Caminho não informado."}); return;
                }
                if(!/\.fdb$/i.test(caminho)){
                    sendJson({ok:false, erro:"O arquivo deve ter extensão .fdb"}); return;
                }
                logTs("[FDB Manual] Caminho recebido: "+caminho);
                aplicarNovoFdb(caminho, function(r){
                    sendJson(r);
                });
            }catch(e){
                logTs("ERRO /api/salvar-fdb: "+e.message);
                sendJson({ok:false, erro:e.message});
            }
        });
        return;
    }

    // /api/events — SSE stream
    if(rota==="/api/events"){
        var clientId = ++sseIdCounter;
        res.writeHead(200,{
            "Content-Type":"text/event-stream",
            "Cache-Control":"no-cache, no-transform",
            "Connection":"keep-alive",
            "X-Accel-Buffering":"no",
            "X-Content-Type-Options":"nosniff"
        });
        res.flushHeaders();
        res.write(": connected\n\n");
        res.write("retry: 5000\n");
        res.write("data: "+JSON.stringify({type:"connected",id:clientId})+"\n\n");
        try{if(res.socket){res.socket.setNoDelay(true);}}catch(_){}

        var clientObj = {res:res, id:clientId, hb:null};
        sseClients.push(clientObj);

        // PRECISÃO FIX (v2.6.6): o heartbeat detectava o socket morto e limpava
        // o próprio timer, mas NÃO removia o cliente de sseClients — dependia de
        // broadcastSSE varrer a lista ou do evento "close" disparar. Numa loja
        // parada (sem vendas novas, logo sem broadcast) e com um socket que
        // morreu sem emitir "close" (queda de rede, notebook suspenso, aba
        // congelada), a entrada ficava na lista indefinidamente: contagem errada
        // em /api/sse-clients e a referência ao res segurada na memória para
        // sempre. Agora o próprio heartbeat também se desregistra.
        var _encerrarSse = function(){
            clearInterval(clientObj.hb);
            sseClients = sseClients.filter(function(c){return c.id!==clientId;});
        };

        var hb = setInterval(function(){
            try{
                if (res.destroyed || res.writable === false) { _encerrarSse(); return; }
                res.write(": ping\n\n");
            }catch(e){ _encerrarSse(); }
        }, TIMEOUT_SSE_HEARTBEAT_MS);
        // Guarda o timer no objeto para que broadcastSSE consiga limpá-lo ao
        // descartar um cliente morto (ver LEAK FIX em broadcastSSE).
        clientObj.hb = hb;

        req.on("close", _encerrarSse);
        req.on("error", _encerrarSse);
        res.on("error", _encerrarSse);
        return;
    }

    // /api/navigate/hoje
    if(rota==="/api/navigate/hoje"){
        var sent = broadcastSSE({type:"navigate", url:"/"});
        sendJson({ok:true, clients:sent});return;
    }

    // /api/navigate/config
    if(rota==="/api/navigate/config"){
        var sentCfg = broadcastSSE({type:"navigate-hash", hash:"config"});
        sendJson({ok:true, clients:sentCfg});return;
    }

    // /api/navigate/selecionar-fdb
    // Navega a aba aberta para a pagina de selecao manual do FDB.
    // Usado pelo item "Selecionar banco (FDB)..." do menu de bandeja.
    if(rota==="/api/navigate/selecionar-fdb"){
        var sentFdb = broadcastSSE({type:"navigate", url:"/selecionar-fdb"});
        sendJson({ok:true, clients:sentFdb});return;
    }

    // /api/navigate/periodo/YYYY-MM-DD/YYYY-MM-DD
    var mNav = rota.match(/^\/api\/navigate\/periodo\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
    if(mNav){
        var navUrl = "/periodo?i="+mNav[1]+"&f="+mNav[2];
        var sentNav = broadcastSSE({type:"navigate", url:navUrl});
        sendJson({ok:true, clients:sentNav});return;
    }

    // /api/upload-favicon POST
    if(rota==="/api/upload-favicon" && req.method==="POST"){
        var favChunks=[], favBytes=0, favAbortado=false;
        var FAV_MAX_BYTES = 2 * 1024 * 1024; // 2 MB — suficiente para qualquer favicon
        req.on("data",function(c){
            if(favAbortado)return;
            favBytes+=c.length;
            if(favBytes>FAV_MAX_BYTES){
                favAbortado=true;
                try{req.destroy();}catch(_){}
                if(!res.headersSent){
                    res.writeHead(413,{"Content-Type":"application/json; charset=utf-8"});
                    res.end(JSON.stringify({ok:false,erro:"Favicon muito grande (máx 2 MB)."}));
                }
                return;
            }
            favChunks.push(c);
        });
        req.on("error",function(e){
            if(favAbortado)return; favAbortado=true;
            logTs("ERRO /api/upload-favicon (req): "+e.message);
            if(!res.headersSent){
                res.writeHead(500,{"Content-Type":"application/json; charset=utf-8"});
                res.end(JSON.stringify({ok:false,erro:e.message}));
            }
        });
        req.on("end",function(){
            if(favAbortado)return;
            try{
                var buf=Buffer.concat(favChunks);
                var isPng =buf.length>4&&buf[0]===0x89&&buf[1]===0x50&&buf[2]===0x4E&&buf[3]===0x47;
                var isIco =buf.length>4&&buf[0]===0x00&&buf[1]===0x00&&buf[2]===0x01&&buf[3]===0x00;
                var isJpeg=buf.length>3&&buf[0]===0xFF&&buf[1]===0xD8&&buf[2]===0xFF;
                if(!isPng&&!isIco&&!isJpeg){
                    res.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});
                    res.end(JSON.stringify({ok:false,erro:"Formato inválido. Use PNG, ICO ou JPEG."}));
                    return;
                }
                var favDest=path.join(__dirname,"favicon.png");
                // PRECISÃO FIX (v2.6.7): gravação atômica também aqui. Não dá para
                // reusar _gravarArquivoAtomico: ele grava string em UTF-8 e isso
                // corromperia os bytes da imagem — favicon é binário (Buffer), então
                // a versão atômica precisa ser feita à parte, sem encoding.
                // Um favicon truncado não é só cosmético: iniciar-tray.ps1 carrega
                // esse arquivo com Bitmap::FromFile para montar o ícone da bandeja,
                // e um PNG pela metade faz esse carregamento falhar — a loja fica
                // sem o ícone de acesso ao sistema.
                var _favTmp = favDest + ".tmp" + process.pid;
                try {
                    fs.writeFileSync(_favTmp, buf);
                    fs.renameSync(_favTmp, favDest);
                } catch(_eFav) {
                    // Fallback: destino pode estar travado (antivírus/indexador do
                    // Windows, ou o próprio tray com o arquivo aberto). Melhor gravar
                    // de forma não-atômica que não gravar.
                    try { if (fs.existsSync(_favTmp)) fs.unlinkSync(_favTmp); } catch(_) {}
                    fs.writeFileSync(favDest, buf);
                }
                FAVICON=favDest;
                // Invalida cache em memória para que próximo request leia o novo arquivo
                _FAVICON_CACHE = null;
                _FAVICON_CACHE_MTIME = 0;
                logTs("Favicon atualizado via modal ("+buf.length+" bytes).");
                res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});
                res.end(JSON.stringify({ok:true}));
            }catch(e){
                logTs("ERRO /api/upload-favicon: "+e.message);
                if(!res.headersSent){
                    res.writeHead(500,{"Content-Type":"application/json; charset=utf-8"});
                    res.end(JSON.stringify({ok:false,erro:e.message}));
                }
            }
        });
        return;
    }

    // /
    if(rota==="/"){
        // Se FDB não encontrado automaticamente, exibe picker manual
        if(_aguardandoFdbManual){
            res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
            res.end(paginaEscolherFdb());
            return;
        }
        var dh=hoje(),ent=cache[dh];
        if(!ent){gerarEmBackground(dh,dh,dh);ent=cache[dh];}
        // ROBUSTEZ FIX (v2.4.1): gerarEmBackground é síncrono até o spawn/callback
        // ser agendado, então ent deveria sempre existir aqui — mas se algum erro
        // inesperado escapou sem popular o cache, exibir undefined.html quebrava
        // a página sem nenhuma mensagem. Trata como erro recuperável.
        if(!ent){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(paginaLoading("Gerando relatorio de hoje...",isoParaBR(dh),dh,"/"));return;}
        if(ent.gerando||ent.matando){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(paginaLoading("Gerando relatorio de hoje...",isoParaBR(dh),dh,"/"));return;}
        if(ent.erro){var em=ent.erro;delete cache[dh];res.writeHead(500,{"Content-Type":"text/html; charset=utf-8"});res.end(paginaErro("Erro ao gerar relatorio de "+isoParaBR(dh),em,"/"));return;}
        if(!ent.html){delete cache[dh];res.writeHead(500,{"Content-Type":"text/html; charset=utf-8"});res.end(paginaErro("Erro ao gerar relatorio de "+isoParaBR(dh),"Conteúdo não disponível — tente novamente.","/"));return;}
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(ent.html);return;
    }

    // /atualizar
    if(rota==="/atualizar"){
        logDebug("Atualizando "+isoParaBR(hoje())+"...");
        var _dhAtual = hoje();
        delete cache[_dhAtual];
        _gerarTentativas[_dhAtual] = 0; // reseta contador para a nova geração começar limpa
        res.writeHead(302,{"Location":"/"});res.end();return;
    }

    // /periodo
    if(rota==="/periodo"){
        // Se FDB não encontrado automaticamente, exibe picker manual
        if(_aguardandoFdbManual){
            res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
            res.end(paginaEscolherFdb());
            return;
        }
        var inicio = parsed.searchParams.get("i") || parsed.searchParams.get("inicio") || "";
        var fim    = parsed.searchParams.get("f") || parsed.searchParams.get("fim")    || "";
        inicio = String(inicio).trim();
        fim = String(fim).trim();
        if (!inicio && !fim) {res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(paginaFormPeriodo(hoje()));return;}
        if (!inicio && fim) inicio = fim;
        if (inicio && !fim) fim = inicio;
        var fixISO=function(s){
            var m2=String(s||"").match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
            return m2?m2[3]+"-"+m2[2].padStart(2,"0")+"-"+m2[1].padStart(2,"0"):s;
        };
        inicio=fixISO(inicio);fim=fixISO(fim);
        var isoRe=/^\d{4}-\d{2}-\d{2}$/;
        if(!isoRe.test(inicio)||!isoRe.test(fim)||inicio>fim){
            logTs("Periodo invalido ("+inicio+"/"+fim+"). Redirecionando para formulario.");
            res.writeHead(302,{"Location":"/periodo"});res.end();return;
        }
        var chave=inicio+"|"+fim;
        var label=(inicio===fim)?isoParaBR(inicio):(isoParaBR(inicio)+" a "+isoParaBR(fim));
        var urlDest="/periodo?i="+encodeURIComponent(inicio)+"&f="+encodeURIComponent(fim);
        var ep=cache[chave];
        if(!ep){gerarEmBackground(inicio,fim,chave);ep=cache[chave];}
        if(!ep){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(paginaLoading("Gerando relatorio...",label,chave,urlDest));return;}
        if(ep.gerando||ep.matando){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(paginaLoading("Gerando relatorio...",label,chave,urlDest));return;}
        if(ep.erro){var em2=ep.erro;delete cache[chave];res.writeHead(500,{"Content-Type":"text/html; charset=utf-8"});res.end(paginaErro("Erro ao gerar relatorio de "+label,em2,"/"));return;}
        if(!ep.html){delete cache[chave];res.writeHead(500,{"Content-Type":"text/html; charset=utf-8"});res.end(paginaErro("Erro ao gerar relatorio de "+label,"Conteúdo não disponível — tente novamente.","/"));return;}
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(ep.html);return;
    }

    res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});res.end("Rota nao encontrada.");
});

// ---------------------------------------------------------------------------
// Inicia
// ---------------------------------------------------------------------------
server.listen(PORT, BIND_ADDR, function(){
    var addr = _maquinaIP
        ? "http://" + _maquinaIP + ":" + PORT + "  (acesso externo habilitado)"
        : "http://localhost:" + PORT;
    // "=== Servidor iniciado ===" já foi logado como primeiro log protegido
    // (antes da detecção de FDB). Aqui apenas registra o endereço de acesso.
    logProtegido(APP_NAME+" | "+addr);

    aguardarFDB(function(dbOk){
        if(dbOk){
            // Ordem correta: disponível → configurado (FDB pode ter mudado após scan)
            logProtegido("Banco disponível em "+FDB_HOST+".");
            logProtegido("Banco configurado: "+FDB);
            _aguardandoFdbManual = false;
        } else {
            // FDB não encontrado após todas tentativas automáticas.
            // Ativa modo de seleção manual — qualquer acesso a / ou /periodo
            // exibirá a página paginaEscolherFdb() até o usuário configurar.
            logTs("AVISO: Banco não encontrado. Aguardando seleção manual em http://localhost:"+PORT+"/selecionar-fdb");
            _aguardandoFdbManual = true;
        }

        var dh=hoje();
        // Gera relatório mesmo sem banco — resultado mostrará mensagem de erro adequada
        gerarEmBackground(dh,dh,dh);

        if(Firebird&&dbOk){
            setTimeout(function(){
                pollStatus();
                if (_pollIntervalId) clearInterval(_pollIntervalId);
                // Fast-poll (50ms) trata detecção; pollStatus só para correções + fallback.
                _pollIntervalId = setInterval(pollStatus, Math.max(POLL_INTERVAL * POLL_RETRY_MULTIPLIER, 2000));
                _iniciarFastPoll(); // detecção em tempo real via conexão persistente
            }, 5000);
    
        }

        agendarRegen();
        // BUG FIX (v2.4.1): mensagem tinha "200ms" fixo no texto, mas a constante
        // real do fast-poll (_FP_INTERVAL_MS) já era outro valor — o log mentia
        // sobre o próprio comportamento do servidor, confundindo qualquer debug
        // futuro. Corrigido para sempre ler a constante, nunca hardcodar o número
        // (valor atual: ver declaração de _FP_INTERVAL_MS).
        logTs("Fast-poll: " + _FP_INTERVAL_MS + "ms (detecção instantânea) | pollStatus fallback: " + (POLL_INTERVAL/1000) + "s | browser poll: " + POLL_INTERVAL + "ms | spawnTimeout: " + (_SPAWN_TIMEOUT_MS/1000) + "s. Servidor pronto.");
    });
});

server.on("error",function(err){
    if(err.code==="EADDRINUSE"){
        logTs("Servidor ja rodando na porta "+PORT+". Encerrando.");
        setTimeout(function(){process.exit(0);},300);
    } else {
        console.error("Erro: "+err.message);process.exit(1);
    }
});

// INTEGRIDADE FIX (v2.4.1): garante que a última janela de correções de horário
// (até 500ms de debounce) seja gravada em disco antes do processo morrer, e que
// a conexão Firebird persistente do fast-poll não fique pendurada no SO após o
// Node encerrar (no Windows, o processo Firebird do lado servidor pode manter
// o handle da conexão TCP em CLOSE_WAIT por um tempo se não for fechada).
process.on("exit", function() {
    try { if (typeof _salvarHoraFixadaCache === "function" && _salvarHoraFixadaCache.flush) _salvarHoraFixadaCache.flush(); } catch(_) {}
    try { if (typeof _fpDb !== "undefined" && _fpDb) _matarConexao(_fpDb); } catch(_) {}
});

process.on("SIGINT",function(){console.log("\nServidor encerrado.\n");process.exit(0);});