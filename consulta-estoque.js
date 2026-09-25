"use strict";

/**
 * consulta-estoque.js
 *
 * @version 5.32.0
 * @changelog
 *   5.32.0 - 2026-08-29 - Dois pedidos: (1) lista personalizada nunca pode
 *     ter código duplicado; (2) código recém-adicionado + salvo aparecia
 *     como "não existe mais no banco" (falso — sumia sozinho ao reiniciar
 *     pelo .bat, sintoma de dado desatualizado, não de código ausente).
 *
 *     [1] LISTA PERSONALIZADA — DUPLICATA NUNCA MAIS ENTRA
 *         _sanitizarListaPersonalizada() (servidor) agora deduplica por
 *         código, 1ª ocorrência vence — é o ÚNICO ponto de gravação
 *         (POST /api/lista-personalizada), então a garantia vale sempre,
 *         não importa a origem. Também retorna quantos foram removidos por
 *         duplicata vs quantos por exceder o limite de 1000 — motivos
 *         diferentes, nunca misturados numa mensagem só (testado: 1200
 *         códigos únicos sem duplicata nenhuma não deve acusar
 *         "duplicata", e sim "limite excedido"). _parseListaPersonalizadaDetalhada()
 *         (cliente) também deduplica ao ler o texto colado, mesma regra —
 *         defesa em dobro, não só no servidor.
 *
 *     [2] FALSO "NÃO EXISTE MAIS NO BANCO" LOGO APÓS SALVAR — CORRIGIDO
 *         Causa: salvarListaPersonalizada() espera _sincronizarEstoqueTempoReal
 *         recalcular _lpEstoquesReais antes de checar alertas, mas o teto de
 *         espera (SYNC_ESTOQUE_TIMEOUT_MS) era 6s — curto demais no mesmo
 *         ambiente lento já identificado na v5.31.0 (carregarItens() levando
 *         15-20s+). Ao vencer o teto, o código antigo aplicava os dados
 *         (possivelmente ainda os de ANTES do save) e rodava o alerta do
 *         mesmo jeito — um código recém-salvo, ainda fora de
 *         _lpEstoquesReais, virava "não existe mais no banco" (falso).
 *         Corrigido em duas frentes: SYNC_ESTOQUE_TIMEOUT_MS 6s -> 30s
 *         (folga real sobre o ambiente observado); e _aguardarCargaFrescaConcluir
 *         agora informa onPronto(sucesso) — sucesso=true só quando o
 *         servidor confirmou !carregando de verdade. salvarListaPersonalizada()
 *         só roda o alerta quando sucesso=true; se não (banco ainda mais
 *         lento que o esperado), avisa que ainda está sincronizando e tenta
 *         de novo uma vez, 8s depois — nunca mais afirma "não existe" com
 *         base em dado sabidamente desatualizado.
 *
 *     70/70 testes originais passando sem alteração (estoque-engine.js não
 *     foi tocado nesta versão); dedup testado isoladamente em 3 cenários
 *     (só duplicata, só limite, os dois juntos).
 *
 * Servidor de relatório de estoque disponível (Firebird + Node.js).
 * NÃO depende de gerar-relatorio-html.js nem servidor-relatorio.js.
 * Lê config.json apenas para: fbHost, fdbPath, proibidos, appName.
 * Porta padrão: 7888 (configurável via config.json → portaEstoque)
 *
 * Para iniciar:
 *   node consulta-estoque.js
 *   Acesse: http://localhost:7888
 */

// ─────────────────────────────────────────────────────────────────────────────
// DEPENDÊNCIAS
// ─────────────────────────────────────────────────────────────────────────────
let Firebird = null;
try {
    Firebird = require("node-firebird");
} catch (e) {
    process.stderr.write(
        "[ERRO FATAL] Módulo 'node-firebird' não instalado.\n" +
        "Execute no terminal: npm install node-firebird\n"
    );
    process.exit(1);
}

const fs   = require("fs");
const path = require("path");
const http = require("http");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "config.json");
const USADOS_PATH = path.join(__dirname, "usados-estoque.json");
const LISTA_PERSONALIZADA_PATH = path.join(__dirname, "lista-personalizada.json");
const ANO_ATUAL   = new Date().getFullYear();
const MAX_ITENS   = 2000;
const LIMITE_SESSAO_BUSCA = 1000; // itens por "sessão" de busca estendida (Modo Automático) — evita travar o navegador
// ── Teto configurável de itens carregados do banco ───────────────────────────
// Era 5000. Elevado para 20000 na v5.23.0 porque o gargalo que justificava o
// teto baixo foi removido: até então a tabela era montada inteira num único
// innerHTML, e o custo medido por linha é ~435 bytes de HTML e ~20 nós de DOM
// — ou seja, 5000 itens = ~2 MB de HTML e ~100.000 nós DE UMA VEZ, a cada
// filtro/ordenação, o que congela um PC de loja por vários segundos.
// Com a renderização incremental (ver _renderLote no client-side), o DOM passa
// a receber apenas o lote visível (120–300 linhas), então o custo de render
// deixou de crescer com maxItens.
//
// Por que 20000 e não "ilimitado": o que ainda cresce linearmente é a MEMÓRIA
// do array _itens no navegador (~1 KB/item ≈ 20 MB em 20000) e o custo O(n) de
// cada filtro/ordenação, que roda a cada busca. 20000 mantém o filtro na casa
// de poucas dezenas de ms mesmo em máquina fraca; acima disso a digitação
// começa a engasgar de novo, agora por um motivo diferente (CPU, não DOM), que
// só uma indexação server-side resolveria de verdade.
const MAX_ITENS_TETO      = 20000;
const SQL_LIMIT_BRUTO     = 200000; // teto do SELECT FIRST — muito acima do maxItens configurável (máx MAX_ITENS_TETO)
                                     // pra garantir que o banco devolva o catálogo inteiro de uma vez
// CONEXAO_TIMEOUT_MS — ACHADO (2026-08-29, caso real de produção): apesar do
// nome, este teto NUNCA cobriu só o Firebird.attach() — o Promise.race
// engloba o attach() E TUDO que roda dentro do callback dele (detecção de
// tabela, a query principal, a consulta dedicada da lista personalizada).
// Num ambiente real (Firebird remoto por rede local, tabela ESTOQUE com 93
// colunas), attach() + detecção + a query principal levaram ~15-16s juntos —
// bem em cima do teto antigo (15000ms), fazendo o race "vencer" por uma
// fração de segundo e declarar "Timeout ao conectar" mesmo com o banco
// respondendo normalmente, só que devagar. O carregamento REAL terminava
// ~1s depois em background (best-effort, ver comentário mais abaixo), mas o
// usuário via um erro de conexão falso e um scan de rede desnecessário.
// Subido para 60s — ainda finito (nunca trava _loadLock pra sempre num host
// genuinely inacessível), com folga real para bancos/redes lentos.
const CONEXAO_TIMEOUT_MS  = 60000;
// LP_QUERY_TIMEOUT_MS — teto de CADA lote da consulta dedicada da lista
// personalizada (ver carregarItens() → bloco da lista personalizada,
// abaixo). Antes era 15000ms fixo e inline — curto demais no mesmo ambiente
// lento acima: a consulta dedicada chegou a estourar esse teto sozinha
// (mesmo sendo uma busca por código, tipicamente rápida), derrubando TODA a
// reconciliação da lista personalizada numa única tacada (rLp.e setado =
// _lpEstoquesReais fica vazio = todo código aparece como "não existe mais
// no banco", mesmo existindo). Subido para 45s, com folga generosa sobre o
// que já foi observado necessário para a query principal (bem maior) nesse
// mesmo ambiente.
const LP_QUERY_TIMEOUT_MS = 45000;

// ─────────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────────────────────────────────────
function p2(n) { return String(n).padStart(2, "0"); }

// ── COLUNA ATIVO — FONTE ÚNICA DA REGRA DE "INATIVO" ────────────────────────
// Usada em dois lugares (carregarItens(): whereAtivo da query principal E
// reconciliação da consulta dedicada da lista personalizada, rLp) — mantida
// aqui, uma única vez, para as duas nunca divergirem silenciosamente se o
// critério for ajustado no futuro (bastaria editar esta lista).
// Blacklist (não whitelist) de propósito: exclui só quem bate EXATAMENTE com
// um destes marcadores comuns de ERP para produto cancelado/descontinuado —
// nunca perde item com ATIVO = 'T', 'A', '1', 'Y' ou qualquer outro valor
// válido que o banco use para "ativo".
const ATIVO_VALORES_INATIVOS = ["N", "I", "X", "F"];

// _valorColunaIndicaInativo: true SOMENTE quando o valor (já em texto, TRIM
// aplicado aqui de novo por segurança mesmo a query já fazendo TRIM) bate
// exatamente com um marcador da blacklist. NULL/undefined/qualquer outro
// valor => false (ativo) — nunca bloqueia por engano quando o dado é
// ausente ou desconhecido.
function _valorColunaIndicaInativo(valorRaw) {
    if (valorRaw == null) return false;
    return ATIVO_VALORES_INATIVOS.indexOf(String(valorRaw).trim()) !== -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDAÇÃO DE IDENTIFICADOR SQL (defesa em profundidade)
// Nomes de tabela/coluna usados nas queries vêm de introspecção do schema
// (RDB$RELATIONS / RDB$RELATION_FIELDS, ver camposTabela()/listarTabelas()),
// nunca de entrada HTTP — não é injeção de SQL no sentido clássico. Ainda
// assim, o Firebird permite identificadores delimitados (aspas duplas) que
// podem conter praticamente qualquer caractere, incluindo aspas e operadores
// SQL. Um identificador "exótico" desses (legado, criado por outra ferramenta)
// interpolado sem filtro na string SQL poderia gerar uma query malformada ou,
// em tese, alterar sua semântica. Esta função restringe o que é aceito ao
// formato de identificador Firebird não-delimitado padrão — a imensa maioria
// dos bancos reais — e qualquer nome fora desse formato é tratado como
// "coluna/tabela não encontrada" em vez de ser interpolado cegamente.
const _IDENTIFICADOR_SQL_RE = /^[A-Z_][A-Z0-9_$]{0,62}$/;
function identificadorSqlValido(nome) {
    return typeof nome === "string" && _IDENTIFICADOR_SQL_RE.test(nome);
}

// nivel: 'info' (default, stdout) | 'erro' (stderr — convenção Unix, permite
// redirecionar/monitorar erros separadamente do log normal, ex:
// `node consulta-estoque.js 2>erros.log`). Retrocompatível: chamadas
// existentes sem o 2º argumento continuam indo para stdout como sempre.
function logTs(msg, nivel) {
    const d = new Date();
    const linha = "[" + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "] " +
        String(msg) + "\n";
    if (nivel === "erro") process.stderr.write(linha);
    else process.stdout.write(linha);
}
// Atalho semântico para logTs(msg, "erro") — usar ao logar falhas reais.
function logErro(msg) { logTs(msg, "erro"); }

// NOTA (achado #1 da revisão 2026-07-11): idêntica a esc() (linha ~2796, dentro
// do <script> client-side). Não são duplicação por descuido — escH() roda no
// processo Node (server-side) e esc() roda no browser; sem bundler/import entre
// os dois runtimes, cada lado precisa da própria cópia. Se corrigir um bug de
// escaping aqui, replicar em esc() também.
function escH(s) {
    return String(s == null ? "" : s)
        .replace(/&/g,  "&amp;")
        .replace(/</g,  "&lt;")
        .replace(/>/g,  "&gt;")
        .replace(/"/g,  "&quot;")
        .replace(/'/g,  "&#39;");
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
let cfg = {};
try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8")
        .replace(/^\uFEFF/, "")             // Remove BOM
        .replace(/:\s*0+(\d)/g, ": $1");   // Corrige zeros à esquerda em números
    cfg = JSON.parse(raw);
} catch (e) {
    logTs("AVISO: config.json inválido ou ausente — usando padrões.");
}

const APP_NAME  = (cfg.appName && String(cfg.appName).trim())
    ? String(cfg.appName).trim()
    : "Consulta Estoque";

// Lista de proibidos embutida diretamente no script (não depende do config.json).
// Se o config.json estiver presente e tiver proibidos, ele prevalece (merge).
const PROIBIDOS_EMBUTIDOS = [
    "FARO","BIOFRESH","OPTIMUM","CIBAU","ATACAMA","GOLDEN","PIPICAT","SYNTEC",
    "MITZI","PETISCAO","ND CAES","ND GATOS","GRANPLUS","PEDIGREE","CHAMP",
    "WHISKAS","PREMIER","GUABI","NATURAL CAES","NATURAL GATOS","PUTZ","GRANEL",
    "ELANCO","VET LIFE","VETLIFE","KONIG","SAN REMO","SANREMO","FN CAE","FN CAO",
    "FN GATO","FN VET","ORIGENS","FUNNY BUNNY","FUNNY BIRDY","SANOL","KELDOG",
    "KDOG","MAGNUS","MAGNO","GENIAL","CANISTER","NATURAL SACHE","FN COOKIES",
    "KITEKAT","MARS","ADIMAX","FARMINA", "PETISCO", "PETISSCOS", "TAXA DE ENTREGA", "COPO SIMPARIC",
	"BALDE C/TAMPA", "CONJ.BALDE E TAMPA", "ARRANHADOR COM BOLINHA FN CAT", "TAXA ENTREGA"
];

const PROIBIDOS = (() => {
    // Merge: embutidos + os do config.json (se houver), sem duplicatas
    const base = new Set(PROIBIDOS_EMBUTIDOS.map(p => p.toUpperCase().trim()));
    if (Array.isArray(cfg.proibidos)) {
        cfg.proibidos.forEach(p => { const s = String(p).toUpperCase().trim(); if (s) base.add(s); });
    }
    return [...base];
})();

// ─── Regex pré-compilada dos proibidos (criada UMA vez no startup) ────────────
// Substitui o loop some()+indexOf() chamado em cada uma das ~200k linhas brutas.
// Cada termo é escapado para uso seguro como literal na expressão regular.
const _PROIBIDOS_RE = (() => {
    if (!PROIBIDOS.length) return null;
    try {
        const escaped = PROIBIDOS
            .filter(p => p && p.length > 0)
            .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        return new RegExp(escaped.join("|"));
    } catch (e) {
        logTs("AVISO: falha ao compilar regex de proibidos — usando fallback indexOf. " + e.message);
        return null; // ehProibido() usará indexOf como fallback
    }
})();

const PORTA = (() => {
    const p = parseInt(cfg.portaEstoque || cfg.portaConsulta || "0", 10);
    return (p > 1024 && p < 65535) ? p : 7888;
})();

// ─────────────────────────────────────────────────────────────────────────────
// VALORES-PADRÃO (fonte única) — achado #A da revisão 2026-08-06: antes os
// mesmos valores (host, porta, caminho do FDB, usuário, senha, estoqueMinimo,
// maxItens...) estavam duplicados em 3 pontos independentes do arquivo
// (detectarFdb(), inicialização de _cfgVivo e o bloco "defaults" devolvido por
// GET /api/config) — mudar um default exigia lembrar de editar os outros dois,
// e diferenças entre eles já causaram o placeholder da UI ("masterkey") ficar
// diferente do valor realmente aplicado em runtime. Centralizado aqui: qualquer
// mudança de default futura é feita em UM único lugar.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
    fbHost:        "192.168.1.65",
    fbPort:        3050,
    fdbPath:       "C:\\Program Files (x86)\\SmallSoft\\Small Commerce\\SMALL.FDB",
    fbUser:        "SYSDBA",
    fbPassword:    "masterkey",
    portaEstoque:  7888,
    appName:       "Consulta Estoque",
    estoqueMinimo: 5,
    maxItens:      MAX_ITENS
});

// ─────────────────────────────────────────────────────────────────────────────
// DETECÇÃO DO FDB
// Prioridade: (1) FDB local no disco, (2) config.json, (3) scan de rede na
// subnet local pela porta Firebird (3050) — resultado é salvo no config.json
// para que o próximo startup não precise escanear novamente.
// ─────────────────────────────────────────────────────────────────────────────
const net = require("net");

function detectarFdb() {
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const pf   = process.env["ProgramFiles"]      || "C:\\Program Files";
    const pd   = process.env["ProgramData"]       || "C:\\ProgramData";
    const candidatos = [
        pf86 + "\\SmallSoft\\Small Commerce\\SMALL.FDB",
        pf   + "\\SmallSoft\\Small Commerce\\SMALL.FDB",
        pd   + "\\SmallSoft\\Small Commerce\\SMALL.FDB",
        "C:\\SmallSoft\\Small Commerce\\SMALL.FDB",
        "C:\\Dados\\SMALL.FDB",
        "C:\\SmallCommerce\\SMALL.FDB"
    ];
    for (const c of candidatos) {
        try {
            if (fs.existsSync(c)) {
                logTs("FDB local encontrado: " + c);
                return { host: "127.0.0.1", dbPath: c };
            }
        } catch (_) {}
    }

    // Tenta ler o caminho da .FDB do INI do SmallSoft (evita hardcode do path)
    const iniCandidatos = [
        pf86 + "\\SmallSoft\\Small Commerce\\Small.ini",
        pf86 + "\\SmallSoft\\Small Commerce\\SmallCommerce.ini",
        pf   + "\\SmallSoft\\Small Commerce\\Small.ini",
        "C:\\SmallSoft\\Small Commerce\\Small.ini"
    ];
    let fdbPathDoIni = null;
    for (const ini of iniCandidatos) {
        try {
            const iniText = fs.readFileSync(ini, "utf8");
            const m = iniText.match(/(?:Database|Banco|FDB)\s*=\s*([^\r\n]+)/i);
            if (m && m[1].trim().toUpperCase().endsWith(".FDB")) {
                fdbPathDoIni = m[1].trim();
                logTs("FDB path lido do INI: " + fdbPathDoIni);
                break;
            }
        } catch (_) {}
    }

    // config.json prevalece — é a memória da última descoberta bem-sucedida
    if (cfg.fbHost && String(cfg.fbHost).trim()) {
        const host   = String(cfg.fbHost).trim();
        const dbPath = fdbPathDoIni
            || (cfg.fdbPath && String(cfg.fdbPath).trim()
                ? String(cfg.fdbPath).trim()
                : DEFAULTS.fdbPath);
        logTs("FDB via config.json: " + host + ":" + dbPath);
        return { host, dbPath };
    }

    // Nenhuma fonte definida — usa padrão e agenda scan de rede em background.
    // O scan não bloqueia o startup: o servidor sobe imediatamente com o padrão
    // e atualizará _cfgVivo + salva no config.json quando encontrar o servidor.
    const dbPath = fdbPathDoIni || DEFAULTS.fdbPath;
    const host   = DEFAULTS.fbHost; // padrão; scan atualizará se errado
    logTs("FDB sem config.json — usando padrão: " + host + ":" + dbPath);
    return { host, dbPath };
}

// Verifica se uma porta TCP está aberta num host, com timeout curto
function _portaAberta(host, porta, timeoutMs) {
    return new Promise(function(resolve) {
        const sock = new net.Socket();
        var done = false;
        const fim = function(ok) {
            if (done) return;
            done = true;
            sock.destroy();
            resolve(ok);
        };
        sock.setTimeout(timeoutMs || 400);
        sock.once("connect", function() { fim(true); });
        sock.once("timeout", function() { fim(false); });
        sock.once("error",   function() { fim(false); });
        sock.connect(porta, host);
    });
}

// Escaneia a subnet /24 derivada de um IP local, buscando Firebird na porta dada.
// Retorna o primeiro IP que responder (ou null).
async function _escanearSubnet(portaFirebird) {
    // Descobre o IP local pra montar a base da subnet
    const { networkInterfaces } = require("os");
    const ifaces = networkInterfaces();
    let base = null;
    for (const nome of Object.keys(ifaces)) {
        for (const iface of ifaces[nome]) {
            if (!iface.internal && iface.family === "IPv4") {
                const partes = iface.address.split(".");
                base = partes.slice(0, 3).join("."); // ex: "192.168.1"
                break;
            }
        }
        if (base) break;
    }
    if (!base) return null;

    logTs("Scan de rede: procurando Firebird na subnet " + base + ".0/24 porta " + portaFirebird + "...");

    // Varre em lotes de 20 hosts em paralelo pra terminar em ~4s no pior caso
    const LOTE = 20;
    for (let inicio = 1; inicio <= 254; inicio += LOTE) {
        const hosts = [];
        for (let i = inicio; i < Math.min(inicio + LOTE, 255); i++) {
            hosts.push(base + "." + i);
        }
        const resultados = await Promise.all(hosts.map(h => _portaAberta(h, portaFirebird)));
        for (let i = 0; i < hosts.length; i++) {
            if (resultados[i]) {
                logTs("Firebird encontrado: " + hosts[i] + ":" + portaFirebird);
                return hosts[i];
            }
        }
    }
    return null;
}

// Chamado no startup (e opcionalmente ao falhar uma conexão): tenta descobrir
// o host Firebird na rede e atualiza _cfgVivo + config.json automaticamente.
async function autoDetectarHost() {
    const PORTA_FB = _cfgVivo ? _cfgVivo.fbPort : 3050;
    const hostEncontrado = await _escanearSubnet(PORTA_FB);
    if (!hostEncontrado) {
        logTs("AVISO scan: nenhum host com Firebird encontrado na rede local.");
        return;
    }
    if (_cfgVivo && _cfgVivo.fbHost === hostEncontrado) {
        logTs("Scan: host já configurado (" + hostEncontrado + ") — sem mudança.");
        return;
    }
    logTs("Scan: atualizando fbHost para " + hostEncontrado);
    if (_cfgVivo) _cfgVivo.fbHost = hostEncontrado;
    // Persiste no config.json para não precisar escanear no próximo startup
    try {
        let cfgAtual = {};
        try { cfgAtual = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")); } catch (_) {}
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(Object.assign({}, cfgAtual, { fbHost: hostEncontrado }), null, 2), "utf8");
        logTs("config.json atualizado com fbHost=" + hostEncontrado);
    } catch (e) {
        logTs("AVISO: falha ao salvar config.json após scan: " + e.message);
    }
    // Recarrega com o novo host descoberto
    if (!_loadLock && !_carregando) {
        setImmediate(function() {
            carregarItens().catch(function(e) { logErro("ERRO reload pós-scan: " + (e.message || e)); });
        });
    }
}

const { host: FDB_HOST, dbPath: FDB_PATH } = detectarFdb();

// ─────────────────────────────────────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────────────────────
let _itensBrutos    = [];               // Itens filtrados e carregados do banco
let _lpEstoquesReais = Object.create(null); // {codigo: {estoque, preco, descricao, ativo}}
                                         // — SOMENTE códigos da lista personalizada,
                                         // capturados direto da consulta dedicada rLp (ver
                                         // carregarItens()), sem o corte de maxItens/
                                         // estoqueMinimo/proibidos. ativo é true/false
                                         // quando o banco tem coluna ATIVO detectável, ou
                                         // null quando não tem (não dá pra verificar).
let _itensOrdenados = [];               // Fila de exibição: não-usados + usados
let _usados         = Object.create(null); // { "CODIGO": true }
let _usadosCount    = 0;               // Contador explícito — evita Object.keys(_usados).length
let _codigosSet     = new Set();        // Lookup O(1) de códigos válidos no banco
let _carregando     = false;
let _erroConexao    = null;
let _ultimaAtualiz  = null;
let _camposLog      = "";
let _loadLock       = false;            // Previne carregamentos simultâneos
let _htmlCache      = null;             // Cache do HTML estático — gerado apenas 1 vez
// ── ESTOQUE ENGINE (embutido) ─────────────────────────────────────────────
// Antes era lido de estoque-engine.js em runtime via fs.readFileSync — se esse
// arquivo não fosse copiado junto pro servidor, TODO o Agrupar e o Combinar
// paravam de funcionar silenciosamente (engine ausente = funções undefined).
// Essa era a causa real do bug "Agrupar não funciona mais": em qualquer
// deploy que copiasse só consulta-estoque.js, o require/readFileSync do
// engine falhava e _engineSrc virava um comentário vazio.
// Agora o código do engine vive embutido aqui como string, injetado direto
// no HTML — um único arquivo, zero dependência externa para rodar.
const _ENGINE_SRC = "/**\n * estoque-engine.js\n *\n * @version 1.4.0\n * @changelog\n *   1.4.0 - 2026-08-14 15:40 - Revisão de auditoria (sem mudança de\n *     comportamento observável — mesma API, mesmos resultados, 70/70 testes\n *     originais continuam passando):\n *       [1] _autoEncontrarMelhor mutava os objetos de entrada (`_item._p =\n *           _cp`), efeito colateral não documentado numa função descrita\n *           como pura — agora cada candidato é empacotado como {it, p}\n *           (item original + preço numérico já convertido), nunca mais\n *           escrito de volta no objeto do chamador.\n *       [2] Número mágico `40` (tolerância do modo Combinar) estava\n *           hardcoded em 4 pontos diferentes em vez de usar a constante\n *           FAIXA_COMBINAR já existente — agora todos os pontos referenciam\n *           a constante; mudar a tolerância no futuro exige editar 1 lugar,\n *           não 4.\n *       [3] Removida a label `outer3ex:` da Fase 3 de _autoEncontrarMelhor —\n *           não era referenciada por nenhum break/continue (resquício de\n *           uma versão anterior do algoritmo), apenas ruído para quem lê.\n *\n * ARQUITETURA:\n *   - UMD wrapper: expõe via module.exports (Node) ou window globals (browser)\n *   - Funções puras: nenhuma lê/escreve globais — toda dependência é parâmetro\n *   - Os únicos \"globals\" usados são o fallback em _ehProibidoCliente e\n *     _termosSemMatch, que aceitam o valor explícito como 1º opção\n *   - encontrarGruposAsync / encontrarCombinacoesComRepeticaoAsync aceitam um\n *     objeto de geração externo e um callback de status opcionais\n *\n * USO NOS TESTES:\n *   const engine = require('./estoque-engine.js');\n *   const { _qtdMaximaDisponivel } = engine;\n *\n * USO NO BROWSER (via script inline pelo servidor):\n *   // Todas as funções ficam globais automaticamente via UMD\n *   _qtdMaximaDisponivel(item, usos, parada, piso);\n */\n\n/* global window, _S, _itens */\n(function (root, factory) {\n    \"use strict\";\n    if (typeof module !== \"undefined\" && module.exports) {\n        // Node.js — require()\n        module.exports = factory();\n    } else {\n        // Browser — expõe tudo como global (igual ao comportamento anterior)\n        var api = factory();\n        for (var k in api) {\n            if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];\n        }\n    }\n}(typeof globalThis !== \"undefined\" ? globalThis : this, function () {\n    \"use strict\";\n\n    // ── Constantes exportadas ─────────────────────────────────────────────────\n    // Centralizadas aqui para que testes e servidor usem sempre os mesmos valores.\n    var FLOAT_EPS              = 0.005;  // tolerância float (~meio centavo)\n    var FAIXA_COMBINAR         = 40;     // tolerância acima do valor-alvo no modo Combinar\n    var FAIXA_EXCEDENTE_LP     = 99999;  // sentinela \"sem teto\" para busca de excedente\n    var PRECO_SENTINEL_ZERADO  = 0.01;   // preço sentinela de item \"zerado\" no ERP legado\n    var MAX_COMBINAR_RESULTADOS = 20;    // máx. combinações retornadas pelo modo Combinar\n\n    // ── _qtdMaximaDisponivel ──────────────────────────────────────────────────\n    // Quantas unidades de um item ainda podem ser usadas sem violar nenhum\n    // dos três pisos de estoque (parada, mínimo ou zero absoluto).\n    //\n    // Três conceitos de piso, como camadas independentes:\n    //   1. Estoque de parada (estoqueParadaPorCod[codigo]) — prevalece quando definido.\n    //   2. Estoque mínimo (pisoPadrao) — usado quando não há parada específica.\n    //   3. Zero absoluto — trava incondicional; nunca retorna valor que tornaria\n    //      o estoque simulado negativo, mesmo que piso ou dados venham inválidos.\n    function _qtdMaximaDisponivel(item, usosAcumulados, estoqueParadaPorCod, pisoPadrao) {\n        if (!item) return 0;\n        var estoqueAtual = Number(item.estoque || 0);\n        if (!Number.isFinite(estoqueAtual) || estoqueAtual < 0) return 0;\n        var usados = (usosAcumulados && usosAcumulados[item.codigo]) || 0;\n        if (!Number.isFinite(usados) || usados < 0) usados = 0;\n        var limite   = estoqueParadaPorCod ? estoqueParadaPorCod[item.codigo] : null;\n        var pisoBase = (typeof pisoPadrao === \"number\" && Number.isFinite(pisoPadrao)) ? pisoPadrao : 0;\n        var piso     = (limite != null && !isNaN(limite)) ? Number(limite) : pisoBase;\n        if (!Number.isFinite(piso) || piso < 0) piso = 0;\n        var restante = estoqueAtual - usados - piso;\n        return restante > 0 ? Math.floor(restante) : 0;\n    }\n\n    // ── _grupoRespeitaLimites ─────────────────────────────────────────────────\n    // Trava final: verifica se um grupo de itens (podendo repetir códigos)\n    // respeita, código a código, a quantidade máxima calculada por\n    // _qtdMaximaDisponivel. Usado antes de aceitar uma combinação no fallback\n    // de força bruta de _autoEncontrarMelhorComRepeticao.\n    function _grupoRespeitaLimites(grupo, usosAcumulados, estoqueParadaPorCod, pisoPadrao) {\n        if (!grupo || !grupo.length) return true;\n        var contagem = {};\n        var refs     = {};\n        for (var gi = 0; gi < grupo.length; gi++) {\n            var cod = grupo[gi].codigo;\n            contagem[cod] = (contagem[cod] || 0) + 1;\n            refs[cod] = grupo[gi];\n        }\n        for (var cod2 in contagem) {\n            if (!Object.prototype.hasOwnProperty.call(contagem, cod2)) continue;\n            if (contagem[cod2] > _qtdMaximaDisponivel(refs[cod2], usosAcumulados, estoqueParadaPorCod, pisoPadrao)) {\n                return false;\n            }\n        }\n        return true;\n    }\n\n    // ── _autoEncontrarMelhor (modo padrão — sem repetição de código) ──────────\n    // Busca em 4 fases: item exato → par exato → tripla exata → melhor match\n    // em [valor, valor+40]. Nunca usa o mesmo código mais de uma vez.\n    function _autoEncontrarMelhor(disponiveis, valor, faixaExtra) {\n        if (!valor || valor <= 0 || !disponiveis || !disponiveis.length) return null;\n        var _extra  = (typeof faixaExtra === \"number\" && faixaExtra >= 0) ? faixaExtra : 0;\n        var EPS     = FLOAT_EPS;\n        var alvoMax = valor + FAIXA_COMBINAR + _extra;\n        // Candidatos empacotados como {it, p}: o preço fica no wrapper, nunca\n        // escrito de volta no objeto original — a função é pura de verdade,\n        // não muta nenhum item do array recebido (achado de auditoria: a\n        // versão anterior gravava \"_item._p = _cp\" direto no item do\n        // chamador, poluindo silenciosamente objetos que também vivem em\n        // _itens/_catalogoCompleto no servidor/cliente).\n        var candsExatos = [];\n        var candsFaixa  = [];\n        for (var _ci = 0; _ci < disponiveis.length; _ci++) {\n            var _item = disponiveis[_ci];\n            var _cp   = Number(_item.preco || 0);\n            if (_cp <= 0) continue;\n            var _cand = { it: _item, p: _cp };\n            if (_cp <= alvoMax + EPS) {\n                candsFaixa.push(_cand);\n                if (_cp <= valor + EPS) candsExatos.push(_cand);\n            }\n        }\n        if (!candsFaixa.length) return null;\n\n        // Fase 1: item único exato\n        for (var _f1 = 0; _f1 < candsExatos.length; _f1++) {\n            if (Math.abs(candsExatos[_f1].p - valor) <= EPS) {\n                return { itens: [candsExatos[_f1].it], soma: +candsExatos[_f1].p.toFixed(2), diff: 0 };\n            }\n        }\n\n        // Mapa preço→candidatos (centavos) para lookup O(1) de complemento\n        var _precoMap = Object.create(null);\n        for (var _pmi = 0; _pmi < candsExatos.length; _pmi++) {\n            var _pKey = Math.round(candsExatos[_pmi].p * 100);\n            if (!_precoMap[_pKey]) _precoMap[_pKey] = [];\n            _precoMap[_pKey].push(candsExatos[_pmi]);\n        }\n\n        // Fase 2: par exato\n        for (var _f2 = 0; _f2 < candsExatos.length; _f2++) {\n            var _pa2  = candsExatos[_f2].p;\n            var _pb2  = valor - _pa2;\n            if (_pb2 <= EPS) continue;\n            var _lista2 = _precoMap[Math.round(_pb2 * 100)];\n            if (!_lista2) continue;\n            for (var _li2 = 0; _li2 < _lista2.length; _li2++) {\n                if (_lista2[_li2].it.codigo === candsExatos[_f2].it.codigo) continue;\n                var _soma2 = _pa2 + _lista2[_li2].p;\n                if (Math.abs(_soma2 - valor) <= EPS) {\n                    return { itens: [candsExatos[_f2].it, _lista2[_li2].it], soma: +_soma2.toFixed(2), diff: 0 };\n                }\n            }\n        }\n\n        // Fase 3: tripla exata (O(n²) + hash para 3º)\n        var _tripCands = candsExatos.filter(function(c) { return c.p < valor - EPS; });\n        if (_tripCands.length > 200) _tripCands = _tripCands.slice(0, 200);\n        for (var _a3 = 0; _a3 < _tripCands.length; _a3++) {\n            var _pa3 = _tripCands[_a3].p;\n            for (var _b3 = _a3 + 1; _b3 < _tripCands.length; _b3++) {\n                var _ab3 = _pa3 + _tripCands[_b3].p;\n                if (_ab3 >= valor - EPS) continue;\n                var _lista3 = _precoMap[Math.round((valor - _ab3) * 100)];\n                if (!_lista3) continue;\n                for (var _li3 = 0; _li3 < _lista3.length; _li3++) {\n                    var _c3 = _lista3[_li3];\n                    if (_c3.it.codigo === _tripCands[_a3].it.codigo || _c3.it.codigo === _tripCands[_b3].it.codigo) continue;\n                    var _soma3 = _ab3 + _c3.p;\n                    if (Math.abs(_soma3 - valor) <= EPS) {\n                        return { itens: [_tripCands[_a3].it, _tripCands[_b3].it, _c3.it], soma: +_soma3.toFixed(2), diff: 0 };\n                    }\n                }\n            }\n        }\n\n        // Fase 4: melhor match em [valor, valor+FAIXA_COMBINAR]\n        candsFaixa.sort(function(a, b) { return Math.abs(a.p - valor) - Math.abs(b.p - valor); });\n        if (candsFaixa.length > 80) candsFaixa = candsFaixa.slice(0, 80);\n        var _melhor = null;\n        function _atualizar(grupoCands, soma) {\n            var diff = +(soma - valor).toFixed(2);\n            if (diff < -EPS || diff > FAIXA_COMBINAR + _extra + EPS) return;\n            if (!_melhor || diff < _melhor.diff) {\n                var _itensGrupo = [];\n                for (var _gi = 0; _gi < grupoCands.length; _gi++) _itensGrupo.push(grupoCands[_gi].it);\n                _melhor = { itens: _itensGrupo, soma: +soma.toFixed(2), diff: diff };\n            }\n        }\n        for (var _s4 = 0; _s4 < candsFaixa.length; _s4++) {\n            _atualizar([candsFaixa[_s4]], candsFaixa[_s4].p);\n            if (_melhor && _melhor.diff < EPS) return _melhor;\n        }\n        outer2f:\n        for (var _a4 = 0; _a4 < candsFaixa.length; _a4++) {\n            for (var _b4 = _a4 + 1; _b4 < candsFaixa.length; _b4++) {\n                var _s2f = candsFaixa[_a4].p + candsFaixa[_b4].p;\n                if (_s2f > alvoMax + EPS) continue;\n                _atualizar([candsFaixa[_a4], candsFaixa[_b4]], _s2f);\n                if (_melhor && _melhor.diff < EPS) break outer2f;\n            }\n        }\n        if (_melhor && _melhor.diff < EPS) return _melhor;\n        outer3f:\n        for (var _a5 = 0; _a5 < candsFaixa.length; _a5++) {\n            var _pa5 = candsFaixa[_a5].p;\n            for (var _b5 = _a5 + 1; _b5 < candsFaixa.length; _b5++) {\n                var _ab5 = _pa5 + candsFaixa[_b5].p;\n                if (_ab5 > alvoMax + EPS) continue;\n                for (var _c5 = _b5 + 1; _c5 < candsFaixa.length; _c5++) {\n                    var _s3f = _ab5 + candsFaixa[_c5].p;\n                    if (_s3f > alvoMax + EPS) continue;\n                    _atualizar([candsFaixa[_a5], candsFaixa[_b5], candsFaixa[_c5]], _s3f);\n                    if (_melhor && _melhor.diff < EPS) break outer3f;\n                }\n            }\n        }\n        return _melhor;\n    }\n\n    // ── _autoEncontrarMelhorComRepeticao (lista personalizada / Combinar) ─────\n    // DP bounded-knapsack via binary splitting + fallback de força bruta.\n    // O mesmo item pode aparecer mais de uma vez, nunca ultrapassando\n    // _qtdMaximaDisponivel(item, usosAcumulados, estoqueParadaPorCod, pisoPadrao).\n    function _autoEncontrarMelhorComRepeticao(pool, valor, faixaExtra, usosAcumulados, estoqueParadaPorCod, pisoPadrao) {\n        usosAcumulados      = usosAcumulados      || {};\n        estoqueParadaPorCod = estoqueParadaPorCod || {};\n        if (!valor || valor <= 0 || !pool || !pool.length) return null;\n        var _extra  = (typeof faixaExtra === \"number\" && faixaExtra >= 0) ? faixaExtra : 0;\n        var EPS     = FLOAT_EPS;\n        var alvoMax = valor + FAIXA_COMBINAR + _extra;\n\n        var cands = [];\n        for (var _ci = 0; _ci < pool.length; _ci++) {\n            var _cp = Number(pool[_ci].preco || 0);\n            if (_cp > 0 && _qtdMaximaDisponivel(pool[_ci], usosAcumulados, estoqueParadaPorCod, pisoPadrao) > 0) {\n                cands.push(pool[_ci]);\n            }\n        }\n        if (!cands.length) return null;\n        if (cands.length > 30) cands = cands.slice(0, 30);\n\n        // Teto do DP exato (bounded-knapsack). Acima disso o custo O(moedas×cents)\n        // fica caro demais para rodar síncrono no meio de _buscarProxima — nesses\n        // casos (valores altos) cai no fallback guloso logo abaixo, que sempre\n        // consegue formar uma soma (ainda que não ótima) somando vários itens.\n        var DP_MAX_CENTS = 120000; // R$1200 — antes 60000 (R$600), por isso valores\n                                    // altos nunca eram encontrados: o DP nem rodava\n                                    // e o força-bruta antigo (máx. 4 itens) raramente\n                                    // alcança somas grandes.\n        var alvoCents   = Math.round(valor * 100);\n        var maxCents    = Math.round(alvoMax * 100);\n\n        if (alvoCents > 0 && maxCents > 0 && maxCents <= DP_MAX_CENTS) {\n            var moedas = [];\n            for (var _pc = 0; _pc < cands.length; _pc++) {\n                var _precoC  = Math.round(Number(cands[_pc].preco) * 100);\n                if (_precoC <= 0 || _precoC > maxCents) continue;\n                var _limQtd  = _qtdMaximaDisponivel(cands[_pc], usosAcumulados, estoqueParadaPorCod, pisoPadrao);\n                if (_limQtd <= 0) continue;\n                var _restQtd = _limQtd;\n                var _bloco   = 1;\n                while (_restQtd > 0) {\n                    var _qtdBloco = Math.min(_bloco, _restQtd);\n                    moedas.push({ item: cands[_pc], qtd: _qtdBloco, custo: _precoC * _qtdBloco });\n                    _restQtd -= _qtdBloco;\n                    _bloco   *= 2;\n                }\n            }\n            if (moedas.length > 150) moedas = moedas.slice(0, 150);\n\n            if (moedas.length) {\n                var dp = new Array(maxCents + 1);\n                for (var _zi = 0; _zi <= maxCents; _zi++) dp[_zi] = null;\n                dp[0] = { count: 0, lastMoeda: -1, prevV: -1 };\n                for (var mIdx = 0; mIdx < moedas.length; mIdx++) {\n                    var moeda = moedas[mIdx];\n                    for (var v = maxCents; v >= moeda.custo; v--) {\n                        if (dp[v - moeda.custo]) {\n                            var cnt = dp[v - moeda.custo].count + moeda.qtd;\n                            if (!dp[v] || cnt < dp[v].count) {\n                                dp[v] = { count: cnt, lastMoeda: mIdx, prevV: v - moeda.custo };\n                            }\n                        }\n                    }\n                }\n                var melhorV = dp[alvoCents] ? alvoCents : -1;\n                if (melhorV < 0) {\n                    for (var v2 = alvoCents + 1; v2 <= maxCents; v2++) {\n                        if (dp[v2]) { melhorV = v2; break; }\n                    }\n                }\n                if (melhorV >= 0) {\n                    var itensResult = [];\n                    var cur = melhorV;\n                    var _guard = 0;\n                    while (cur > 0 && dp[cur] && _guard < 5000) {\n                        var _mu = moedas[dp[cur].lastMoeda];\n                        for (var _rep = 0; _rep < _mu.qtd; _rep++) itensResult.push(_mu.item);\n                        cur = dp[cur].prevV;\n                        _guard++;\n                    }\n                    if (itensResult.length) {\n                        var sf = melhorV / 100;\n                        return { itens: itensResult, soma: +sf.toFixed(2), diff: +(sf - valor).toFixed(2) };\n                    }\n                }\n            }\n        }\n\n        // ── Fallback guloso (valores acima do teto do DP, ex: DP_MAX_CENTS) ──────\n        // Para valores altos o força-bruta abaixo (até 4 itens) quase nunca alcança\n        // a soma-alvo — por isso \"valores altos nunca eram achados\". O guloso monta\n        // a combinação item a item (maior preço que ainda cabe primeiro), respeitando\n        // _qtdMaximaDisponivel a cada passo, até cair dentro de [valor, valor+faixa]\n        // ou esgotar candidatos. Não é sempre a soma ótima, mas encontra uma\n        // combinação válida onde o DP e o força-bruta de poucos itens falhavam.\n        if (maxCents > DP_MAX_CENTS) {\n            var _usosG = {};\n            for (var _ug in usosAcumulados) if (Object.prototype.hasOwnProperty.call(usosAcumulados, _ug)) _usosG[_ug] = usosAcumulados[_ug];\n            var _gulosos = cands.slice().sort(function(x, y) { return Number(y.preco) - Number(x.preco); });\n            var _somaG = 0;\n            var _itensG = [];\n            var _guardG = 0;\n            var _restanteCents = maxCents;\n            while (_restanteCents > 0 && _guardG < 2000) {\n                _guardG++;\n                var _achouAlgum = false;\n                for (var _gi = 0; _gi < _gulosos.length; _gi++) {\n                    var _git = _gulosos[_gi];\n                    var _gpc = Math.round(Number(_git.preco) * 100);\n                    if (_gpc <= 0 || _gpc > _restanteCents) continue;\n                    if (_qtdMaximaDisponivel(_git, _usosG, estoqueParadaPorCod, pisoPadrao) <= 0) continue;\n                    _itensG.push(_git);\n                    _usosG[_git.codigo] = (_usosG[_git.codigo] || 0) + 1;\n                    _somaG += _gpc;\n                    _restanteCents = maxCents - _somaG;\n                    _achouAlgum = true;\n                    if (_somaG >= alvoCents) break;\n                    break; // reavalia do maior candidato novamente (limites de qtd mudam)\n                }\n                if (!_achouAlgum) break;\n                if (_somaG >= alvoCents) break;\n            }\n            if (_itensG.length && _somaG >= alvoCents - EPS * 100 && _somaG <= maxCents + EPS * 100) {\n                var sfG = _somaG / 100;\n                return { itens: _itensG, soma: +sfG.toFixed(2), diff: +(sfG - valor).toFixed(2) };\n            }\n            // Não fechou dentro da faixa com o guloso — cai para o força-bruta\n            // abaixo, que ainda pode achar uma combinação pequena e exata.\n        }\n\n        // Fallback força bruta (até 4 itens, com repetição)\n        var sorted = cands.slice().sort(function(x, y) { return Number(x.preco) - Number(y.preco); });\n        var n = sorted.length;\n        var precos = sorted.map(function(i) { return Number(i.preco); });\n        var _melhorR = null;\n        function _atualizarR(grupo, soma) {\n            var diff = +(soma - valor).toFixed(2);\n            if (diff < -EPS || diff > FAIXA_COMBINAR + _extra + EPS) return;\n            if (!_grupoRespeitaLimites(grupo, usosAcumulados, estoqueParadaPorCod, pisoPadrao)) return;\n            if (!_melhorR || diff < _melhorR.diff) {\n                _melhorR = { itens: grupo.slice(), soma: +soma.toFixed(2), diff: diff };\n            }\n        }\n        for (var s1 = 0; s1 < n; s1++) {\n            if (precos[s1] > alvoMax + EPS) break;\n            _atualizarR([sorted[s1]], precos[s1]);\n            if (_melhorR && _melhorR.diff < EPS) return _melhorR;\n        }\n        for (var a2 = 0; a2 < n; a2++) {\n            if (precos[a2] > alvoMax + EPS) break;\n            for (var b2 = a2; b2 < n; b2++) {\n                var s2 = precos[a2] + precos[b2];\n                if (s2 > alvoMax + EPS) break;\n                _atualizarR([sorted[a2], sorted[b2]], s2);\n                if (_melhorR && _melhorR.diff < EPS) return _melhorR;\n            }\n        }\n        for (var a3 = 0; a3 < n; a3++) {\n            if (precos[a3] > alvoMax + EPS) break;\n            for (var b3 = a3; b3 < n; b3++) {\n                var ab3 = precos[a3] + precos[b3];\n                if (ab3 > alvoMax + EPS) break;\n                for (var c3 = b3; c3 < n; c3++) {\n                    var s3 = ab3 + precos[c3];\n                    if (s3 > alvoMax + EPS) break;\n                    _atualizarR([sorted[a3], sorted[b3], sorted[c3]], s3);\n                    if (_melhorR && _melhorR.diff < EPS) return _melhorR;\n                }\n            }\n        }\n        for (var a4 = 0; a4 < n; a4++) {\n            if (precos[a4] > alvoMax + EPS) break;\n            for (var b4 = a4; b4 < n; b4++) {\n                var ab4 = precos[a4] + precos[b4];\n                if (ab4 > alvoMax + EPS) break;\n                for (var c4 = b4; c4 < n; c4++) {\n                    var abc4 = ab4 + precos[c4];\n                    if (abc4 > alvoMax + EPS) break;\n                    for (var d4 = c4; d4 < n; d4++) {\n                        var s4 = abc4 + precos[d4];\n                        if (s4 > alvoMax + EPS) break;\n                        _atualizarR([sorted[a4], sorted[b4], sorted[c4], sorted[d4]], s4);\n                        if (_melhorR && _melhorR.diff < EPS) return _melhorR;\n                    }\n                }\n            }\n        }\n        return _melhorR;\n    }\n\n    // ── _ehProibidoCliente ────────────────────────────────────────────────────\n    // Verifica se a descrição de um item contém termo da lista de proibidos.\n    // Aceita as listas explicitamente (preferido nos testes); como fallback\n    // em contexto browser lê window._S se as listas não forem fornecidas.\n    function _ehProibidoCliente(descricao, proibidosEmbutidos, proibidosExtra) {\n        if (!descricao) return false;\n        var upper = String(descricao).toUpperCase();\n        /* global window, _S */\n        var lista  = proibidosEmbutidos != null ? proibidosEmbutidos\n                   : (typeof _S !== \"undefined\" && _S.proibidosEmbutidos ? _S.proibidosEmbutidos : []);\n        var extras = proibidosExtra != null ? proibidosExtra\n                   : (typeof _S !== \"undefined\" && _S.proibidosExtra    ? _S.proibidosExtra    : []);\n        for (var i = 0; i < lista.length; i++) {\n            if (lista[i] && upper.indexOf(String(lista[i]).toUpperCase()) !== -1) return true;\n        }\n        for (var j = 0; j < extras.length; j++) {\n            if (extras[j] && upper.indexOf(String(extras[j]).toUpperCase()) !== -1) return true;\n        }\n        return false;\n    }\n\n    // ── _validarResultadoPadrao ───────────────────────────────────────────────\n    // Camada defensiva: rejeita resultado que viola código duplicado, estoque\n    // mínimo ou itens proibidos. Aceita listas de proibidos explicitamente\n    // (para testes determinísticos) com fallback para globais no browser.\n    function _validarResultadoPadrao(resultado, estoqueMinimo, usosAcumulados, pisoPadrao, proibidosEmbutidos, proibidosExtra) {\n        if (!resultado || !resultado.itens || !resultado.itens.length) return null;\n        var permiteRepeticao = !!usosAcumulados;\n        var vistos = Object.create(null);\n        for (var i = 0; i < resultado.itens.length; i++) {\n            var it = resultado.itens[i];\n            if (vistos[it.codigo] && !permiteRepeticao) return null;\n            vistos[it.codigo] = true;\n            if (Number(it.estoque || 0) < Number(estoqueMinimo || 0)) return null;\n            if (_ehProibidoCliente(it.descricao, proibidosEmbutidos, proibidosExtra)) return null;\n        }\n        if (permiteRepeticao && !_grupoRespeitaLimites(resultado.itens, usosAcumulados, null, pisoPadrao)) {\n            return null;\n        }\n        return resultado;\n    }\n\n    // ── _validarResultadoLista ────────────────────────────────────────────────\n    // Equivalente de _validarResultadoPadrao para a lista personalizada.\n    // Não verifica proibidos/estoqueMinimo (by design — lista personalizada\n    // é escolha manual do usuário). Só verifica piso de estoque/zero absoluto.\n    function _validarResultadoLista(resultado, usosAcumulados, estoqueParadaPorCod) {\n        if (!resultado || !resultado.itens || !resultado.itens.length) return null;\n        if (!_grupoRespeitaLimites(resultado.itens, usosAcumulados, estoqueParadaPorCod)) {\n            return null;\n        }\n        return resultado;\n    }\n\n    // ── _formatarCodigosCompactado ────────────────────────────────────────────\n    // Agrupa itens repetidos: [\"A\",\"A\",\"B\"] → \"2*A B\"\n    function _formatarCodigosCompactado(itens) {\n        var contagem = {};\n        var ordem    = [];\n        itens.forEach(function(it) {\n            if (!contagem[it.codigo]) { contagem[it.codigo] = 0; ordem.push(it.codigo); }\n            contagem[it.codigo]++;\n        });\n        return ordem.map(function(cod) {\n            return contagem[cod] > 1 ? (contagem[cod] + \"*\" + cod) : cod;\n        }).join(\" \");\n    }\n\n    // ── _diffTermosFaltantes ──────────────────────────────────────────────────\n    // Subtração O(termos) usando um Set já calculado — evita re-varrer _itens.\n    function _diffTermosFaltantes(termos, encontradosSet) {\n        if (!encontradosSet) return termos;\n        return termos.filter(function(t) { return !encontradosSet.has(t); });\n    }\n\n    // ── _itemBateAlgumTermo ───────────────────────────────────────────────────\n    // Verdadeiro se o item bate com qualquer termo (union search).\n    function _itemBateAlgumTermo(it, termos) {\n        for (var i = 0; i < termos.length; i++) {\n            var t = termos[i];\n            if (it._descUp.indexOf(t) !== -1 || it._codUp.indexOf(t) !== -1 || it._barUp.indexOf(t) !== -1) {\n                return true;\n            }\n        }\n        return false;\n    }\n\n    // ── _termosSemMatch ───────────────────────────────────────────────────────\n    // Quais termos não têm nenhum item correspondente em itensArr.\n    // Aceita itensArr explícito (testes) ou faz fallback para o global _itens.\n    function _termosSemMatch(termos, itensArr) {\n        /* global _itens */\n        var catalogo = itensArr != null ? itensArr\n                     : (typeof _itens !== \"undefined\" ? _itens : []);\n        return termos.filter(function(termo) {\n            for (var i = 0; i < catalogo.length; i++) {\n                var it = catalogo[i];\n                if (it._descUp.indexOf(termo) !== -1 || it._codUp.indexOf(termo) !== -1 || it._barUp.indexOf(termo) !== -1) {\n                    return false;\n                }\n            }\n            return true;\n        });\n    }\n\n    // ── encontrarGruposAsync ──────────────────────────────────────────────────\n    // Combinações de 2-3 itens DISTINTOS que somam ao valor-alvo (modo Agrupar).\n    // Algoritmo restaurado da versão anterior comprovadamente estável (ver\n    // changelog v1.3.0): pares e triplas com índices estritamente crescentes\n    // (a<b / a<b<c — nunca repete o mesmo conjunto de itens em ordem\n    // diferente), rodando em UM ÚNICO setTimeout (sem chunking multi-fase).\n    // gen: objeto { valor: number } — incrementar cancela resultado tardio.\n    // onStatus: callback opcional (msg) para atualizar UI sem referência a DOM.\n    // cfg (opcional, 6º parâmetro): { estoqueMinimo, proibidosEmbutidos, proibidosExtra, maxResultados }\n    //   - estoqueMinimo: piso de estoque que cada item candidato deve respeitar (default 0)\n    //   - proibidosEmbutidos/proibidosExtra: listas repassadas para _ehProibidoCliente\n    //   - maxResultados: quantos grupos retornar no máximo (default 20)\n    function encontrarGruposAsync(itens, valor, onDone, gen, onStatus, cfg) {\n        if (!itens || !itens.length || !valor || valor <= 0) { if (onDone) onDone([]); return; }\n        cfg = cfg || {};\n        var estoqueMinimo      = typeof cfg.estoqueMinimo   === \"number\" ? cfg.estoqueMinimo   : 0;\n        var proibidosEmbutidos = cfg.proibidosEmbutidos != null ? cfg.proibidosEmbutidos : null;\n        var proibidosExtra     = cfg.proibidosExtra     != null ? cfg.proibidosExtra     : null;\n        var maxResultados      = typeof cfg.maxResultados === \"number\" ? cfg.maxResultados : 20;\n        var minhaGen = gen ? gen.valor++ : null; // guarda geração atual antes de incrementar\n\n        var alvoMin = valor;\n        var alvoMax = valor + FAIXA_COMBINAR;\n        var EPS     = FLOAT_EPS;\n\n        setTimeout(function() {\n            // Descarta resultado obsoleto: uma busca mais nova já foi disparada\n            // enquanto esta esperava o setTimeout (gen.valor mudou nesse meio-tempo).\n            if (gen && minhaGen !== null && gen.valor - 1 !== minhaGen) { return; }\n            if (onStatus) onStatus(\"Calculando combinações...\");\n\n            // Candidatos: preço válido dentro da faixa, não usado, estoque mínimo\n            // respeitado e não proibido — tudo filtrado ANTES de montar pares/triplas.\n            var cands = itens.filter(function(it) {\n                var p = Number(it.preco || 0);\n                if (!(p > PRECO_SENTINEL_ZERADO && p <= alvoMax + EPS && !it.usado)) return false;\n                if (Number(it.estoque || 0) < estoqueMinimo) return false;\n                if (_ehProibidoCliente(it.descricao, proibidosEmbutidos, proibidosExtra)) return false;\n                return true;\n            });\n            // Limita candidatos para não explodir O(n³) nas triplas\n            if (cands.length > 250) cands = cands.slice(0, 250);\n\n            // Pré-extrai preços numéricos uma única vez (evita Number() repetido nos loops internos)\n            var precos = new Array(cands.length);\n            for (var _pi = 0; _pi < cands.length; _pi++) precos[_pi] = Number(cands[_pi].preco);\n\n            var grupos  = [];\n            var LIMITE  = Math.max(maxResultados, 30); // teto de coleta antes de ordenar/cortar\n\n            // ── Pares — índices estritamente crescentes (a<b): cada conjunto\n            //    {A,B} é gerado UMA única vez, nunca como (A,B) e depois (B,A). ──\n            for (var a = 0; a < cands.length && grupos.length < LIMITE; a++) {\n                var pa = precos[a];\n                for (var b = a + 1; b < cands.length && grupos.length < LIMITE; b++) {\n                    var soma2 = pa + precos[b];\n                    if (soma2 >= alvoMin - EPS && soma2 <= alvoMax + EPS) {\n                        grupos.push({ itens: [cands[a], cands[b]], soma: +soma2.toFixed(2), diff: +(soma2 - valor).toFixed(2) });\n                    }\n                }\n            }\n\n            // ── Triplas — apenas se ainda precisamos de mais grupos; índices\n            //    estritamente crescentes (a<b<c) pela mesma razão dos pares. ──\n            if (grupos.length < LIMITE) {\n                for (var a2 = 0; a2 < cands.length && grupos.length < LIMITE; a2++) {\n                    var pa2 = precos[a2];\n                    if (pa2 >= alvoMax + EPS) continue;\n                    for (var b2 = a2 + 1; b2 < cands.length && grupos.length < LIMITE; b2++) {\n                        var ab2 = pa2 + precos[b2];\n                        if (ab2 >= alvoMax + EPS) continue;\n                        for (var c2 = b2 + 1; c2 < cands.length && grupos.length < LIMITE; c2++) {\n                            var soma3 = ab2 + precos[c2];\n                            if (soma3 >= alvoMin - EPS && soma3 <= alvoMax + EPS) {\n                                grupos.push({ itens: [cands[a2], cands[b2], cands[c2]], soma: +soma3.toFixed(2), diff: +(soma3 - valor).toFixed(2) });\n                            }\n                        }\n                    }\n                }\n            }\n\n            // ── Deduplicação por assinatura ────────────────────────────────────\n            // Trava de segurança extra: mesmo com índices crescentes já evitando\n            // permutações do mesmo conjunto, garante 1 card por combinação\n            // distinta de itens (assinatura = códigos ordenados, não a ordem\n            // de inserção — {A,B} e {B,A} colapsam na mesma chave).\n            var vistos       = Object.create(null);\n            var gruposUnicos = [];\n            for (var gi = 0; gi < grupos.length; gi++) {\n                var cods = [];\n                for (var ci = 0; ci < grupos[gi].itens.length; ci++) cods.push(String(grupos[gi].itens[ci].codigo));\n                cods.sort();\n                var assinatura = cods.join(\"|\");\n                if (vistos[assinatura]) continue;\n                vistos[assinatura] = true;\n                gruposUnicos.push(grupos[gi]);\n            }\n\n            if (onStatus) onStatus(\"\");\n\n            // Ordena do mais próximo ao valor-alvo usando transformação de\n            // Schwartzian: pré-computa Math.abs uma única vez por elemento.\n            var resultado = gruposUnicos\n                .map(function(g) { return { g: g, d: Math.abs(g.soma - valor) }; })\n                .sort(function(x, y) { return x.d - y.d; })\n                .slice(0, maxResultados)\n                .map(function(x) { return x.g; });\n            if (onDone) onDone(resultado);\n        }, 0);\n    }\n\n    // ── encontrarCombinacoesComRepeticaoAsync ─────────────────────────────────\n    // Modo Combinar: mesmo item pode aparecer múltiplas vezes (qtd×item).\n    // gen: objeto { valor: number } — incrementar cancela resultado tardio.\n    // onStatus: callback opcional (msg) em vez de document.getElementById.\n    function encontrarCombinacoesComRepeticaoAsync(itens, valor, onDone, cfg) {\n        cfg = cfg || {};\n        var estoqueMinimo   = typeof cfg.estoqueMinimo   === \"number\" ? cfg.estoqueMinimo   : 0;\n        var maxResultados   = typeof cfg.maxResultados   === \"number\" ? cfg.maxResultados   : MAX_COMBINAR_RESULTADOS;\n        var faixaCombinar   = typeof cfg.faixaCombinar   === \"number\" ? cfg.faixaCombinar   : FAIXA_COMBINAR;\n        var precoSentinel   = typeof cfg.precoSentinel   === \"number\" ? cfg.precoSentinel   : PRECO_SENTINEL_ZERADO;\n        var onStatus        = typeof cfg.onStatus        === \"function\" ? cfg.onStatus      : null;\n        var gen             = cfg.gen || null;\n        var minhaGen        = gen ? gen.valor++ : null;\n\n        if (!itens || !itens.length || !valor || valor <= 0) { if (onDone) onDone([]); return; }\n        if (onStatus) onStatus(\"Calculando...\");\n\n        var pool = itens.filter(function(it) {\n            return Number(it.preco || 0) > precoSentinel && Number(it.estoque || 0) > 0 && !it.usado;\n        });\n\n        var usosSimulados = {};\n        var resultados    = [];\n\n        function _buscarProxima() {\n            if (gen && minhaGen !== null && gen.valor - 1 !== minhaGen) return;\n            if (resultados.length >= maxResultados) { _entregar(); return; }\n\n            var poolAtual = pool.filter(function(it) {\n                return (Number(it.estoque || 0) - (usosSimulados[it.codigo] || 0) - estoqueMinimo) > 0;\n            });\n            if (!poolAtual.length) { _entregar(); return; }\n\n            var resultado = _autoEncontrarMelhorComRepeticao(poolAtual, valor, faixaCombinar, usosSimulados, null, estoqueMinimo);\n            if (!resultado || !resultado.itens || !resultado.itens.length) { _entregar(); return; }\n\n            resultado.itens.forEach(function(it) {\n                usosSimulados[it.codigo] = (usosSimulados[it.codigo] || 0) + 1;\n            });\n            resultados.push(resultado);\n            setTimeout(_buscarProxima, 0);\n        }\n\n        function _entregar() {\n            if (gen && minhaGen !== null && gen.valor - 1 !== minhaGen) return;\n            if (onStatus) {\n                var n = resultados.length;\n                onStatus(n ? n + \" combinação\" + (n > 1 ? \"ões\" : \"\") + \" encontrada\" + (n > 1 ? \"s\" : \"\") : \"\");\n            }\n            if (onDone) onDone(resultados);\n        }\n\n        setTimeout(_buscarProxima, 0);\n    }\n\n    // ── API pública ───────────────────────────────────────────────────────────\n    return {\n        // Constantes\n        FLOAT_EPS              : FLOAT_EPS,\n        FAIXA_COMBINAR         : FAIXA_COMBINAR,\n        FAIXA_EXCEDENTE_LP     : FAIXA_EXCEDENTE_LP,\n        PRECO_SENTINEL_ZERADO  : PRECO_SENTINEL_ZERADO,\n        MAX_COMBINAR_RESULTADOS: MAX_COMBINAR_RESULTADOS,\n        // Funções puras de estoque\n        _qtdMaximaDisponivel               : _qtdMaximaDisponivel,\n        _grupoRespeitaLimites              : _grupoRespeitaLimites,\n        _autoEncontrarMelhor               : _autoEncontrarMelhor,\n        _autoEncontrarMelhorComRepeticao   : _autoEncontrarMelhorComRepeticao,\n        _ehProibidoCliente                 : _ehProibidoCliente,\n        _validarResultadoPadrao            : _validarResultadoPadrao,\n        _validarResultadoLista             : _validarResultadoLista,\n        _formatarCodigosCompactado         : _formatarCodigosCompactado,\n        _diffTermosFaltantes               : _diffTermosFaltantes,\n        _itemBateAlgumTermo                : _itemBateAlgumTermo,\n        _termosSemMatch                    : _termosSemMatch,\n        // Funções assíncronas de busca\n        encontrarGruposAsync                        : encontrarGruposAsync,\n        encontrarCombinacoesComRepeticaoAsync        : encontrarCombinacoesComRepeticaoAsync\n    };\n}));";
let _itensAbaixoMin = 0;               // Itens abaixo do estoqueMinimo incluídos p/ completar a lista
let _catalogoCompleto = [];            // TODOS os itens válidos do banco (sem o corte de maxItens) —
                                        // populado a cada carregarItens(), usado pela busca estendida.
                                        // achado #F da revisão 2026-08-06: NÃO existe mais um cursor
                                        // global aqui (_catalogoCursor foi removido) — cada cliente
                                        // informa seu próprio offset a cada chamada de
                                        // /api/buscar-mais-itens, tornando a rota stateless e segura
                                        // para múltiplos clientes concorrentes (ver handleBuscarMaisItens).

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG MUTÁVEL EM RUNTIME (/api/config aplica sem reiniciar, exceto porta e nome)
// ─────────────────────────────────────────────────────────────────────────────
let _cfgVivo = {
    fbHost:         FDB_HOST,
    fbPath:         FDB_PATH,
    fbPort:         (() => { const p = parseInt(cfg.fbPort  || String(DEFAULTS.fbPort), 10); return (p > 0 && p < 65535) ? p : DEFAULTS.fbPort; })(),
    fbUser:         (cfg.fbUser     && String(cfg.fbUser).trim())     ? String(cfg.fbUser).trim()     : DEFAULTS.fbUser,
    fbPassword:     (cfg.fbPassword && String(cfg.fbPassword).trim()) ? String(cfg.fbPassword).trim() : DEFAULTS.fbPassword,
    portaEstoque:   PORTA,
    appName:        APP_NAME,
    estoqueMinimo:  (() => { const v = parseFloat(cfg.estoqueMinimo); return (Number.isFinite(v) && v >= 0) ? v : DEFAULTS.estoqueMinimo; })(),
    maxItens:       (() => { const v = parseInt(cfg.maxItens || "0", 10); return (v >= 100 && v <= MAX_ITENS_TETO) ? v : DEFAULTS.maxItens; })(),
    proibidosExtra: Array.isArray(cfg.proibidos) ? cfg.proibidos.map(p => String(p).trim()) : []
};

// ── AVISO DE SEGURANÇA: credencial padrão em uso ──────────────────────────────
// Achado de auditoria: DEFAULTS.fbPassword é o usuário/senha padrão de
// instalação do Firebird ("SYSDBA"/"masterkey"), embutido no código-fonte
// como fallback de conveniência para o primeiro start (sem isso, quem nunca
// configurou config.json nem trocou a senha do banco não conseguiria nem
// começar a usar o sistema). O fallback em si é um trade-off aceito para uma
// ferramenta de rede interna — mas ficar SILENCIOSO sobre estar usando uma
// credencial padrão publicamente conhecida é o problema real. Este aviso não
// muda nenhum comportamento (a conexão seguiria exatamente igual sem ele);
// só garante que quem olha o log sabe que deveria trocar a senha do Firebird
// e/ou preencher config.json, em vez de descobrir isso só quando for tarde.
if (!cfg.fbPassword && _cfgVivo.fbPassword === DEFAULTS.fbPassword) {
    logTs(
        "AVISO SEGURANÇA: nenhuma senha configurada em config.json — conectando com a " +
        "credencial padrão de instalação do Firebird (" + DEFAULTS.fbUser + "/" + DEFAULTS.fbPassword + "). " +
        "Configure fbUser/fbPassword em config.json (ou pelas Configurações na interface) assim que possível.",
        "erro"
    );
}

// Cópias mutáveis da lista e regex de proibidos — atualizadas por _refazerProibidos()
let _proibidosAtivos  = [...PROIBIDOS];
let _proibidosREAtivo = _PROIBIDOS_RE;

// Reconstrói a lista e regex de proibidos a partir dos embutidos + extras do config
function _refazerProibidos(extras) {
    const base = new Set(PROIBIDOS_EMBUTIDOS.map(p => p.toUpperCase().trim()));
    if (Array.isArray(extras)) {
        extras.forEach(p => { const s = String(p).toUpperCase().trim(); if (s) base.add(s); });
    }
    _proibidosAtivos = [...base];
    try {
        const esc = _proibidosAtivos
            .filter(p => p && p.length > 0)
            .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        _proibidosREAtivo = esc.length ? new RegExp(esc.join("|")) : null;
        logTs("Proibidos atualizados: " + _proibidosAtivos.length + " termos.");
    } catch (e) {
        logTs("AVISO: falha ao recompilar regex de proibidos: " + e.message);
        _proibidosREAtivo = null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTÊNCIA DOS USADOS
// ─────────────────────────────────────────────────────────────────────────────
function carregarUsados() {
    try {
        const raw = fs.readFileSync(USADOS_PATH, "utf8").replace(/^\uFEFF/, "");
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            arr.forEach(c => { if (c != null && c !== "") _usados[String(c)] = true; });
            _usadosCount = Object.keys(_usados).length;
            logTs("Usados carregados: " + _usadosCount + " item(s).");
        }
    } catch (_) { /* arquivo não existe ainda, OK */ }
}

let _salvarTimer = null;
function salvarUsados() {
    clearTimeout(_salvarTimer);
    _salvarTimer = setTimeout(() => {
        const arr = Object.keys(_usados);
        fs.writeFile(USADOS_PATH, JSON.stringify(arr, null, 2), "utf8", function(e) {
            if (e) logTs("AVISO salvarUsados: " + e.message);
        });
    }, 600);
}

carregarUsados();

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTÊNCIA DA LISTA PERSONALIZADA (modo automático)
// Mesmo esquema usado para usados-estoque.json: lida uma vez no startup e
// gravada (com pequeno debounce) a cada alteração feita pelo cliente via
// POST /api/lista-personalizada — assim ela sobrevive a reinicializações do
// servidor e a F5 na página, em vez de viver só na memória do navegador.
// ─────────────────────────────────────────────────────────────────────────────
let _listaPersonalizada = []; // [{codigo, estoqueParada}, ...] — estoqueParada pode ser null

// Nunca confia cegamente no que vem do disco ou do POST do cliente: valida e
// normaliza item a item, descartando qualquer entrada malformada em vez de
// deixar o resto do sistema (parser/HTML) quebrar com dado inesperado.
// Retorna { itens, duplicatas, cortados, limite } em vez de só o array —
// duplicatas/cortados existem pra quem chama poder logar/avisar a causa
// EXATA de qualquer código que não entrou (nunca misturar as duas: "removido
// por ser duplicata" e "removido por exceder o limite de MAX_ITENS_LP" são
// motivos diferentes, e uma mensagem genérica atribuindo tudo a "duplicata"
// seria falsa quando o motivo real é o limite).
function _sanitizarListaPersonalizada(arr) {
    const MAX_ITENS_LP = 1000;
    const out = [];
    // A lista personalizada NUNCA pode ter código duplicado — ponto único de
    // gravação (todo POST /api/lista-personalizada passa por aqui, sem
    // exceção), então é aqui que essa garantia vale de verdade, não importa
    // se o cliente já deduplicou ou não. 1ª ocorrência vence (mesmo critério
    // já usado na reconciliação de _lpEstoquesReais, ver carregarItens()).
    const vistos = new Set();
    let duplicatas = 0;
    let cortados = 0;
    if (!Array.isArray(arr)) return { itens: out, duplicatas, cortados, limite: MAX_ITENS_LP };
    for (let i = 0; i < arr.length; i++) {
        const it = arr[i];
        if (!it || typeof it !== "object") continue;
        const codigo = String(it.codigo == null ? "" : it.codigo).trim().slice(0, 50);
        if (!codigo) continue;
        if (vistos.has(codigo)) { duplicatas++; continue; } // duplicata — não conta pro limite
        if (out.length >= MAX_ITENS_LP) { cortados++; continue; } // único, mas excedeu o limite
        vistos.add(codigo);
        let estoqueParada = null;
        if (it.estoqueParada != null && it.estoqueParada !== "") {
            const n = Number(it.estoqueParada);
            if (Number.isFinite(n) && n >= 0) estoqueParada = n;
        }
        out.push({ codigo, estoqueParada });
    }
    return { itens: out, duplicatas, cortados, limite: MAX_ITENS_LP };
}

function carregarListaPersonalizada() {
    try {
        const raw = fs.readFileSync(LISTA_PERSONALIZADA_PATH, "utf8").replace(/^\uFEFF/, "");
        const arr = JSON.parse(raw);
        const resultado = _sanitizarListaPersonalizada(arr);
        _listaPersonalizada = resultado.itens;
        logTs("Lista personalizada carregada: " + _listaPersonalizada.length + " c\u00f3digo(s)." +
              (resultado.duplicatas ? " (" + resultado.duplicatas + " duplicata(s) ignorada(s) no arquivo)" : "") +
              (resultado.cortados   ? " (" + resultado.cortados   + " ignorado(s) por exceder o limite de " + resultado.limite + ")" : ""));
    } catch (_) { /* arquivo não existe ainda, OK */ }
}

let _salvarListaTimer = null;
function salvarListaPersonalizadaDisco() {
    clearTimeout(_salvarListaTimer);
    _salvarListaTimer = setTimeout(() => {
        const dados = _listaPersonalizada;
        fs.writeFile(LISTA_PERSONALIZADA_PATH, JSON.stringify(dados, null, 2), "utf8", function(e) {
            if (e) logTs("AVISO salvarListaPersonalizadaDisco: " + e.message);
        });
    }, 600);
}

carregarListaPersonalizada();

// ─────────────────────────────────────────────────────────────────────────────
// DECODER WINDOWS-1252 (igual ao gerar-relatorio-html.js)
// ─────────────────────────────────────────────────────────────────────────────
let _decoder = null;
try { _decoder = new TextDecoder("windows-1252"); } catch (_) {}

function decodRow(row) {
    if (!row) return {};
    const out  = {};
    const keys = Object.keys(row); // mais rápido que for...in: não percorre protótipo
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        out[k] = (Buffer.isBuffer(row[k]) && _decoder)
            ? _decoder.decode(row[k])
            : row[k];
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY COM ISOLATION_READ_UNCOMMITTED (mesma estratégia do projeto)
// ─────────────────────────────────────────────────────────────────────────────
function query(db, sql, params, ms) {
    return new Promise(resolve => {
        const tms = Math.max(ms || 0, 10000);
        const _to = setTimeout(() => {
            resolve({ e: new Error("Timeout após " + Math.round(tms / 1000) + "s"), rows: [] });
        }, tms);
        db.transaction(Firebird.ISOLATION_READ_UNCOMMITTED, (errTx, tx) => {
            if (errTx) { clearTimeout(_to); return resolve({ e: errTx, rows: [] }); }
            tx.query(sql, params || [], (e, rows) => {
                clearTimeout(_to);
                tx.rollback(() => {});
                resolve({ e, rows: (rows || []).map(decodRow) });
            });
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTAR CAMPOS DE TABELA
// ─────────────────────────────────────────────────────────────────────────────
async function camposTabela(db, nome) {
    const r = await query(
        db,
        "SELECT TRIM(RF.RDB$FIELD_NAME) AS C FROM RDB$RELATION_FIELDS RF " +
        "WHERE TRIM(RF.RDB$RELATION_NAME) = ?",
        [String(nome).toUpperCase()],
        15000
    );
    const set = new Set();
    if (!r.e && r.rows) {
        r.rows.forEach(row => {
            const c = String(row.C || "").trim().toUpperCase();
            // Só aceita nomes de coluna no formato de identificador padrão —
            // ver comentário em identificadorSqlValido() no topo do arquivo.
            if (c && identificadorSqlValido(c)) set.add(c);
        });
    }
    return set;
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTAR TODAS AS TABELAS DO USUÁRIO NO BANCO
// ─────────────────────────────────────────────────────────────────────────────
async function listarTabelas(db) {
    const r = await query(
        db,
        "SELECT TRIM(RDB$RELATION_NAME) AS T FROM RDB$RELATIONS " +
        "WHERE RDB$SYSTEM_FLAG = 0 AND RDB$VIEW_BLR IS NULL " +
        "ORDER BY RDB$RELATION_NAME",
        [], 15000
    );
    const tabelas = [];
    if (!r.e && r.rows) {
        r.rows.forEach(row => {
            const t = String(row.T || "").trim().toUpperCase();
            // Mesma validação de camposTabela() — só aceita nomes de tabela
            // no formato de identificador padrão antes de virarem candidatos
            // a entrar cru numa string SQL.
            if (t && identificadorSqlValido(t)) tabelas.push(t);
        });
    }
    return tabelas;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTAR TABELA DE PRODUTOS AUTOMATICAMENTE
// Tenta candidatos por prioridade; valida pelas colunas ESTOQUE e DESCRICAO.
// ─────────────────────────────────────────────────────────────────────────────
async function detectarTabelaProduto(db) {
    const tabelasUsuario = await listarTabelas(db);
    logTs("Tabelas no banco (" + tabelasUsuario.length + "): " + tabelasUsuario.join(", "));

    // Candidatos em ordem de prioridade (nomes comuns no SmallSoft/SmallCommerce)
    // ESTOQUE é o nome padrão da tabela de produtos no SmallSoft Small Commerce
    const candidatos = [
        "ESTOQUE", "PRODUTO", "PRODUTOS", "CADPRODUTO", "CADPROD", "CADASTROPRODUTO",
        "CADESTOQUE", "CADEST",
        "ITEM", "ITENS", "CADITEM",
        "MERCADORIA", "MERCADORIAS",
        "PROD", "PRODS"
    ];

    // Filtra apenas os que realmente existem no banco
    const existentes = candidatos.filter(c => tabelasUsuario.includes(c));

    // Adiciona qualquer tabela do banco que contenha "PROD" ou "ESTOQUE" no nome
    for (const t of tabelasUsuario) {
        if ((t.includes("PROD") || t.includes("ESTOQUE") || t.includes("ITEM") || t.includes("MERC"))
            && !existentes.includes(t)) {
            existentes.push(t);
        }
    }

    logTs("Candidatas a tabela de produtos: " + (existentes.length ? existentes.join(", ") : "nenhuma"));

    // Valida cada candidata: precisa ter coluna de estoque E de descrição
    // SmallSoft Small Commerce usa QTD_ATUAL como campo principal de estoque
    const colsEstoque = [
        "QTD_ATUAL","QTDATUAL","QTD_ATU",                            // SmallSoft padrao
        "QTATU","QTATUAL","QTDATUAL2","QTDISPONIVEL","QTESTATU","SALDOATU","SALDOATUAL","ESTOQUEATU",
        "ESTOQUE","QT_ESTOQUE","QTESTOQUE","SALDO","QTDESTOQUE","QTD_ESTOQUE",
        "QT","QUANTIDADE","QUANTIDADEATU","QTATU2","QTREAL","ESTOQUEREAL","ESTOQUEEFETIVO"
    ];
    const colsDesc    = ["DESCRICAO","NOME","DESCR"];
    const colsCod     = ["CODIGO","CODPRODUTO","ID","COD"];

    for (const tabela of existentes) {
        const campos = await camposTabela(db, tabela);
        if (campos.size === 0) continue;
        const temEst  = colsEstoque.some(c => campos.has(c));
        const temDesc = colsDesc.some(c => campos.has(c));
        const temCod  = colsCod.some(c => campos.has(c));
        logTs("  " + tabela + ": " + campos.size + " campos | estoque=" + temEst + " | desc=" + temDesc + " | cod=" + temCod);
        if (!temEst && temDesc && temCod) {
            // Loga colunas para ajudar a identificar o campo de estoque
            logTs("    Colunas de " + tabela + ": " + [...campos].join(", "));
        }
        if (temEst && temDesc && temCod) {
            logTs("Tabela de produtos selecionada: " + tabela);
            return { nomTabela: tabela, campos };
        }
    }

    // Última tentativa: qualquer tabela com ESTOQUE
    for (const tabela of tabelasUsuario) {
        if (existentes.includes(tabela)) continue;
        const campos = await camposTabela(db, tabela);
        if (campos.size === 0) continue;
        if (colsEstoque.some(c => campos.has(c)) && colsDesc.some(c => campos.has(c))) {
            logTs("Tabela com ESTOQUE encontrada (fallback): " + tabela);
            return { nomTabela: tabela, campos };
        }
    }

    return null; // não encontrou
}

// ─────────────────────────────────────────────────────────────────────────────
// toISO — normaliza campo de data do Firebird para YYYY-MM-DD
// (mesma implementação do gerar-relatorio-html.js)
// ─────────────────────────────────────────────────────────────────────────────
function toISO(val) {
    if (!val) return null;
    if (val instanceof Date) {
        return val.getUTCFullYear() + "-" + p2(val.getUTCMonth() + 1) + "-" + p2(val.getUTCDate());
    }
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s))  return s;
    if (/^\d{4}-\d{2}-\d{2}T/.test(s))  return s.substring(0, 10);
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
        return d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate());
    }
    return s.length >= 10 ? s.substring(0, 10) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZAR CÓDIGO NUMÉRICO
// ─────────────────────────────────────────────────────────────────────────────
// Alguns bancos guardam o código de produto como coluna NUMÉRICA (INTEGER/
// BIGINT), não texto. Nesse caso, CAST(colCod AS VARCHAR) perde qualquer zero
// à esquerda que o usuário tenha digitado ao cadastrar na lista personalizada
// (ex.: "04567" no cadastro vira "4567" ao vir do banco) — uma comparação de
// string exata (WHERE ... IN ('04567')) nunca bate contra "4567", fazendo um
// código que existe e tem estoque parecer "excluído do banco". Esta função
// normaliza um código puramente numérico removendo os zeros à esquerda, pra
// permitir comparar as duas formas como equivalentes. Retorna null se o
// código não é só dígitos (ex.: contém letras) — nesse caso não há
// ambiguidade de zero à esquerda a resolver.
function _normalizarCodigoNumerico(codigo) {
    const s = String(codigo == null ? "" : codigo).trim();
    if (!/^\d+$/.test(s)) return null;
    const semZeros = s.replace(/^0+/, "");
    return semZeros === "" ? "0" : semZeros; // "000" -> "0", nunca string vazia
}

// ─────────────────────────────────────────────────────────────────────────────
// CÓDIGO PADRÃO DE 5 DÍGITOS
// ─────────────────────────────────────────────────────────────────────────────
// Regra de negócio confirmada: todo código deste catálogo tem exatamente 5
// dígitos (ex.: 7403 -> 07403, 703 -> 00703, 8883 -> 08883). Diferente de
// _normalizarCodigoNumerico() acima (que só REMOVE zeros à esquerda — útil
// quando o banco tem MENOS dígitos que o digitado), esta função ACRESCENTA
// zeros à esquerda até completar 5 dígitos — necessária quando o usuário
// digita o código "encurtado" (sem os zeros de preenchimento) na lista
// personalizada, mas o banco guarda a forma completa de 5 dígitos. Sem isso,
// a busca só tentava a forma exata e a mais curta, nunca a preenchida —
// "8883" nunca virava "08883" na tentativa de busca, gerando falso "código
// não existe mais no banco" para itens que existem e têm estoque normal.
// Códigos com 5+ dígitos voltam inalterados (nada a preencher). Retorna null
// se não é só dígitos (mesma regra de _normalizarCodigoNumerico).
function _codigoPadrao5Digitos(codigo) {
    const s = String(codigo == null ? "" : codigo).trim();
    if (!/^\d+$/.test(s)) return null;
    if (s.length >= 5) return s;
    return "0".repeat(5 - s.length) + s;
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFICAR PROIBIDOS
// ─────────────────────────────────────────────────────────────────────────────
function ehProibido(descricao) {
    if (!descricao) return false;
    const upper = String(descricao).toUpperCase();
    // Usa a cópia mutável — pode ser reconstruída via /api/config sem reiniciar
    if (_proibidosREAtivo) return _proibidosREAtivo.test(upper);
    if (!_proibidosAtivos.length) return false;
    return _proibidosAtivos.some(p => p && upper.indexOf(p) !== -1);
}

// ─────────────────────────────────────────────────────────────────────────────
// REORDENAR FILA: não-usados (por estoque desc) → usados (por estoque desc)
// ─────────────────────────────────────────────────────────────────────────────
function reordenarFila() {
    // Passagem única: particiona em não-usados e usados, sem percorrer o array duas vezes
    const a = [];
    const b = [];
    for (let i = 0; i < _itensBrutos.length; i++) {
        const item = _itensBrutos[i];
        (_usados[item.codigo] ? b : a).push(item);
    }
    _itensOrdenados = a.concat(b);
}

// ─────────────────────────────────────────────────────────────────────────────
// CARREGAR ITENS DO BANCO
// ─────────────────────────────────────────────────────────────────────────────
async function carregarItens() {
    if (_loadLock) {
        logTs("Carregamento já em andamento, ignorando solicitação duplicada.");
        return false;
    }
    _loadLock    = true;
    _carregando  = true;
    _erroConexao = null;

    logTs("Conectando ao banco: " + _cfgVivo.fbHost + ":" + _cfgVivo.fbPath);

    const tentativaConexao = new Promise(resolve => {
        // Por que o try/catch aqui (e não só dentro do callback): se
        // Firebird.attach() lançar uma excecao SINCRONA (antes de invocar o
        // callback — ex: config malformada rejeitada pelo driver), o callback
        // abaixo nunca executa e o lock nunca seria liberado, travando todo
        // carregamento futuro até reiniciar o servidor manualmente. Esta
        // camada garante que _loadLock/_carregando SEMPRE são liberados e a
        // Promise SEMPRE resolve (nunca rejeita) — quem chama carregarItens()
        // não precisa de .catch() pra garantir esse destravamento.
        try {
            Firebird.attach({
                host:      _cfgVivo.fbHost,
                port:      _cfgVivo.fbPort,
                database:  _cfgVivo.fbPath,
                user:      _cfgVivo.fbUser,
                password:  _cfgVivo.fbPassword,
                role:      null,
                pageSize:  4096,
                charset:   "UTF8",
                isolation: Firebird.ISOLATION_READ_COMMITTED
            }, async (err, db) => {

            if (err) {
                _erroConexao = "Falha na conexão: " + String(err.message || err);
                _carregando = _loadLock = false;
                logErro("ERRO: " + _erroConexao);
                resolve(false);
                // Agenda scan de rede em background: tenta descobrir um host
                // Firebird diferente do atual sem travar o fluxo de resolução.
                setImmediate(function() { autoDetectarHost().catch(function() {}); });
                return;
            }

            logTs("Conectado! Detectando tabela de produtos no banco...");

            try {
                // Detecta automaticamente qual tabela contém os dados de produtos
                const detectado = await detectarTabelaProduto(db);

                if (!detectado) {
                    _erroConexao = "Nenhuma tabela de produtos encontrada. " +
                        "Verifique o log acima para ver as tabelas disponíveis.";
                    db.detach();
                    _carregando = _loadLock = false;
                    resolve(false);
                    return;
                }

                let { nomTabela, campos } = detectado;

                // ── Mapear colunas com fallbacks ───────────────────────────
                const pick = (...candidates) => candidates.find(c => campos.has(c)) || null;

                const colCod   = pick("CODIGO",     "CODPRODUTO",  "ID",     "COD");
                const colDesc  = pick("DESCRICAO", "DESCR", "NOME");
                const colEst   = pick(
                    "QTD_ATUAL","QTDATUAL","QTD_ATU",                // SmallSoft padrao
                    "QTATU","QTATUAL","QTDISPONIVEL","QTESTATU","SALDOATU","SALDOATUAL","ESTOQUEATU",
                    "ESTOQUE","QT_ESTOQUE","QTESTOQUE","SALDO","QTDESTOQUE","QTD_ESTOQUE",
                    "QT","QUANTIDADE","QUANTIDADEATU","QTREAL","ESTOQUEREAL","ESTOQUEEFETIVO"
                );
                const colBar   = pick("CODBARRAS","EAN","BARRAS","CODBARRA","CODEAN","BARCODE","EAN13","REFERENCIA");
                const colPrc   = pick("PRECO","PRECO1","PVENDA","PRECOVENDA","PRECO_VENDA","VAL_VEND","PRECOUNIT","PRECOUNITARIO");
                const colUltV  = pick("ULT_VENDA","ULTVENDA","ULTIMAVENDA","ULTIMA_VENDA","DTVENDA","DT_VENDA","ULTIMOSAIDA","ULTIMA_SAIDA");
                const colAtivo = pick("ATIVO",      "ATIVADO",     "SITUACAO",  "STATUS");

                _camposLog = [
                    "tabela=" + nomTabela,
                    "COD="    + (colCod   || "?"),
                    "DESC="   + (colDesc  || "?"),
                    "EST="    + (colEst   || "?"),
                    "BAR="    + (colBar   || "-"),
                    "PRECO="  + (colPrc   || "-"),
                    "ULTV="   + (colUltV  || "N/A — filtro de ano desativado"),
                    "ATIVO="  + (colAtivo || "-")
                ].join(" | ");
                logTs("Colunas: " + _camposLog);

                if (!colCod || !colDesc || !colEst) {
                    const disponiveis = [...campos].slice(0, 30).join(", ");
                    _erroConexao = "Colunas essenciais (CODIGO, DESCRICAO, ESTOQUE) não encontradas em " +
                                   nomTabela + ". Colunas disponíveis: " + disponiveis;
                    db.detach();
                    _carregando = _loadLock = false;
                    resolve(false);
                    return;
                }

                // ── Montar SQL ─────────────────────────────────────────────
                const selBar  = colBar
                    ? "TRIM(CAST(p." + colBar + " AS VARCHAR(60)))"
                    : "CAST('' AS VARCHAR(60))";

                const selPrc  = colPrc
                    ? "CAST(p." + colPrc + " AS DOUBLE PRECISION)"
                    : "CAST(0.00 AS DOUBLE PRECISION)";

                const selUltV = colUltV
                    ? "CAST(p." + colUltV + " AS DATE)"
                    : "CAST(NULL AS DATE)";

                // // Filtro de ano REMOVIDO — exibe todos os itens independente de quando foram vendidos
                const whereAno = "";

                // Filtro ATIVO: exclui apenas valores explicitamente inativos/cancelados.
                // Usando blacklist em vez de whitelist para não perder itens com
                // ATIVO = 'T', 'A', '1', 'Y' ou outros valores válidos do banco.
                let whereAtivo = "";
                if (colAtivo) {
                    // Gerado a partir de ATIVO_VALORES_INATIVOS (topo do arquivo) — mesmo
                    // SQL de antes (N/I/X/F, ANDados), agora com uma única fonte de
                    // verdade compartilhada com a reconciliação da lista personalizada.
                    const condsAtivo = ATIVO_VALORES_INATIVOS
                        .map(v => "CAST(p." + colAtivo + " AS VARCHAR(1)) <> '" + v + "'")
                        .join(" AND ");
                    whereAtivo = "AND (p." + colAtivo + " IS NULL OR (" + condsAtivo + "))";
                    logTs("Filtro ATIVO (blacklist " + ATIVO_VALORES_INATIVOS.join("/") + ") aplicado na coluna: " + colAtivo);
                }

                // NOTA DE SEGURANÇA (achado #5 da revisão 2026-07-11): os nomes de
                // coluna/tabela abaixo (colCod, colDesc, colEst, colAtivo, nomTabela)
                // são interpolados direto na string SQL — o que pareceria SQL
                // Injection à primeira vista. Não é: eles vêm de introspecção do
                // schema do banco feita no boot (função pick(), acima), nunca de
                // request HTTP/entrada do usuário — e identificadores de coluna/
                // tabela não são parametrizáveis via "?" no Firebird de qualquer
                // forma (só valores são). Os VALORES desta query (quando existem
                // parâmetros de usuário) são corretamente parametrizados via
                // "params" em tx.query() — ver função query() (Firebird, mais acima).
                // Busca apenas itens com estoque REALMENTE disponível (> 0).
                // Antes esta query usava ">= 0" e o JS classificava o que ficasse
                // abaixo do estoqueMinimo como "complemento" para preencher a
                // lista até maxItens — o efeito colateral era que itens ZERADOS
                // entravam na lista quando sobrava espaço, violando a regra de
                // nunca sugerir item sem estoque. Itens negativos já eram
                // excluídos aqui e continuam sendo.
                // Observação importante: isto NÃO afeta a detecção de zerado/
                // negativado da lista personalizada — ela usa uma consulta
                // dedicada (rLp, logo abaixo), propositalmente SEM filtro de
                // estoque, exatamente para conseguir distinguir "chegou a zero"
                // de "negativado" de "não existe mais no banco".
                const sql = [
                    "SELECT FIRST " + SQL_LIMIT_BRUTO,
                    "  TRIM(CAST(p." + colCod  + " AS VARCHAR(30)))  AS CODIGO,",
                    "  TRIM(CAST(p." + colDesc + " AS VARCHAR(120))) AS DESCRICAO,",
                    "  "  + selBar  + " AS CODBARRAS,",
                    "  CAST(p." + colEst + " AS DOUBLE PRECISION)   AS ESTOQUE,",
                    "  "  + selPrc  + " AS PRECO,",
                    "  "  + selUltV + " AS ULTIMAVENDA",
                    "FROM " + nomTabela + " p",
                    "WHERE CAST(p." + colEst + " AS DOUBLE PRECISION) > 0",
                    whereAno,
                    whereAtivo,
                    "ORDER BY CAST(p." + colEst + " AS DOUBLE PRECISION) DESC"
                ].join("\n");

                logTs("Executando consulta de estoque disponivel...");
                const r = await query(db, sql, [], 120000);

                // Consulta DEDICADA aos códigos da lista personalizada, SEM o filtro
                // "estoque >= 0" da query principal — só assim dá pra diferenciar
                // "chegou a zero" de "está negativado" (o ERP pode permitir estoque
                // negativo em alguns fluxos, ex.: venda antes da entrada no sistema)
                // de "não existe mais no banco" (produto excluído/renomeado). A query
                // principal, como já filtra >=0, NUNCA vê uma linha com estoque
                // negativo — pra ela, "negativo" e "excluído" são indistinguíveis
                // (nenhum dos dois aparece em r.rows). Roda na mesma conexão, antes
                // do detach; falha aqui NUNCA derruba o carregamento principal —
                // best-effort, o alerta cai pro fallback "não encontrado" se essa
                // consulta falhar.
                //
                // FIX (2026-07-22): quando a coluna de código é NUMÉRICA no banco
                // (INTEGER/BIGINT), CAST(...AS VARCHAR) perde zeros à esquerda — um
                // código cadastrado como "04567" na lista personalizada vira "4567"
                // ao vir do banco, e a comparação de string exata nunca batia,
                // fazendo um item que EXISTE e tem estoque aparecer como "excluído
                // do banco". Agora a consulta busca as DUAS formas (com e sem
                // zeros à esquerda) e o resultado é reconciliado de volta pro
                // código exatamente como foi digitado na lista personalizada — ver
                // _normalizarCodigoNumerico() e o bloco de reconciliação abaixo.
                let rLp = { e: null, rows: [] };
                if (!r.e && _listaPersonalizada.length) {
                    const _lpCodsTodosUnicos = Array.from(new Set(_listaPersonalizada.map(lp => lp.codigo).filter(Boolean)));

                    // Todas as formas de busca (original + sem zeros à esquerda +
                    // preenchida a 5 dígitos) de TODOS os códigos — sem cortar nada
                    // aqui. ACHADO (2026-08-29, caso real): um teto fixo de 500
                    // códigos/1000 formas cortava código silenciosamente em listas
                    // grandes (ex.: 563 códigos únicos → 63 nunca eram buscados e
                    // apareciam como "não existe mais no banco" mesmo existindo).
                    // _sanitizarListaPersonalizada já garante um teto superior
                    // (MAX_ITENS_LP = 1000 códigos), então o que evita a consulta
                    // ficar gigante agora é rodar em VÁRIOS lotes menores (abaixo),
                    // nunca descartar código antes de tentar buscá-lo.
                    const _lpCodsBusca = new Set();
                    _lpCodsTodosUnicos.forEach(cod => {
                        _lpCodsBusca.add(cod);
                        const semZeros = _normalizarCodigoNumerico(cod);
                        if (semZeros !== null && semZeros !== cod) _lpCodsBusca.add(semZeros);
                        const padded5 = _codigoPadrao5Digitos(cod);
                        if (padded5 !== null && padded5 !== cod) _lpCodsBusca.add(padded5);
                    });
                    const _lpCodsArr = Array.from(_lpCodsBusca);

                    // LOTE_LP: tamanho de cada IN(...) — bem abaixo do limite prático
                    // de parâmetros de uma lista IN no Firebird, com folga generosa.
                    // Com o teto de 1000 códigos (_sanitizarListaPersonalizada) e até
                    // 3 formas por código, o pior caso são ~3000 formas ≈ 8 lotes.
                    const LOTE_LP = 400;
                    const _lotesLp = [];
                    for (let _li = 0; _li < _lpCodsArr.length; _li += LOTE_LP) {
                        _lotesLp.push(_lpCodsArr.slice(_li, _li + LOTE_LP));
                    }

                    if (_lotesLp.length) {
                        // Coluna ATIVO também entra nesta consulta dedicada — é a ÚNICA
                        // forma de saber se um código da lista personalizada está
                        // marcado como inativo/descontinuado no ERP. A query PRINCIPAL
                        // já exclui inativos via whereAtivo, então eles nunca aparecem
                        // em r.rows/_itensBrutos; sem captar ATIVO aqui, um código
                        // inativo mas com estoque > 0 passava batido como candidato
                        // válido no Modo Automático — mesmo defeito que o resto desta
                        // consulta já resolve para zerado/negativado/excluído do banco.
                        // Se a coluna não existir neste banco (colAtivo === null), vem
                        // sempre NULL e o cliente trata como "não dá pra verificar"
                        // (nunca bloqueia por engano — ver _valorColunaIndicaInativo).
                        const selAtivoLp = colAtivo
                            ? "TRIM(CAST(p." + colAtivo + " AS VARCHAR(1)))"
                            : "CAST(NULL AS VARCHAR(1))";

                        const _todasLinhasLp = [];
                        let _lotesComErro = 0;
                        for (let _loteIdx = 0; _loteIdx < _lotesLp.length; _loteIdx++) {
                            const _lote = _lotesLp[_loteIdx];
                            const sqlLp = [
                                "SELECT FIRST " + _lote.length,
                                "  TRIM(CAST(p." + colCod  + " AS VARCHAR(30)))  AS CODIGO,",
                                "  TRIM(CAST(p." + colDesc + " AS VARCHAR(120))) AS DESCRICAO,",
                                "  CAST(p." + colEst + " AS DOUBLE PRECISION)   AS ESTOQUE,",
                                "  "  + selPrc     + " AS PRECO,",
                                "  "  + selAtivoLp + " AS ATIVO",
                                "FROM " + nomTabela + " p",
                                "WHERE TRIM(CAST(p." + colCod + " AS VARCHAR(30))) IN (" + _lote.map(() => "?").join(",") + ")"
                            ].join("\n");
                            const _rLote = await query(db, sqlLp, _lote, LP_QUERY_TIMEOUT_MS);
                            if (_rLote.e) {
                                _lotesComErro++;
                                logErro("ERRO consulta lista personalizada, lote " + (_loteIdx + 1) + "/" + _lotesLp.length +
                                        " (n\u00e3o-fatal, segue com os demais lotes): " + String(_rLote.e.message || _rLote.e));
                            } else {
                                for (const _rowLote of _rLote.rows) _todasLinhasLp.push(_rowLote);
                            }
                        }
                        // Só trata como falha TOTAL (bloco de reconciliação abaixo
                        // inteiro pulado) se TODOS os lotes falharam — um lote com
                        // erro não pode apagar o resultado, já real e utilizável, dos
                        // demais lotes que funcionaram.
                        rLp = {
                            e: (_lotesComErro === _lotesLp.length) ? new Error(_lotesComErro + " de " + _lotesLp.length + " lote(s) falharam") : null,
                            rows: _todasLinhasLp
                        };
                        // Diagnóstico: sem isto, uma falha de reconciliação (código
                        // que deveria bater mas não bateu) só aparecia pro usuário
                        // como "não existe mais no banco" — indistinguível de uma
                        // consulta que genuinely não achou nada. Este log mostra
                        // quantas variantes foram buscadas, em quantos lotes, e
                        // quantas linhas voltaram no total.
                        logTs("Lista personalizada: " + _lpCodsArr.length + " forma(s) de c\u00f3digo buscada(s) em " +
                              _lotesLp.length + " lote(s) de at\u00e9 " + LOTE_LP + ", " + _todasLinhasLp.length + " linha(s) encontrada(s)" +
                              (_lotesComErro ? " \u2014 " + _lotesComErro + " lote(s) falharam" : "") + ".");
                    }
                }

                db.detach();

                // _lpEstoquesReais: {codigo: {estoque, descricao, preco, ativo}} — SEMPRE
                // indexado pelo código EXATAMENTE como está na lista personalizada (é
                // essa a chave que o cliente usa pra consultar). Reconcilia o
                // resultado da consulta acima (que pode ter vindo sem zeros à
                // esquerda, ver FIX 2026-07-22) casando primeiro por igualdade exata
                // e, se não achar, por forma numérica normalizada. O campo "preco"
                // (adicionado em 2026-07-22) permite ao Modo Automático montar o pool
                // de busca da lista personalizada DIRETO daqui, sem depender de
                // _itens (que é filtrado por proibidos/maxItens/estoqueMinimo) — a
                // lista personalizada é escolha manual do usuário e não pode ficar
                // invisível pro próprio Modo Automático por causa de filtros
                // pensados pra sugestões automáticas.
                _lpEstoquesReais = Object.create(null);
                if (!rLp.e) {
                    const _porCodigoExato  = new Map();
                    const _porNormalizado  = new Map(); // chave: sem zeros à esquerda
                    const _porPadrao5      = new Map(); // chave: preenchido com 5 dígitos
                    for (const row of rLp.rows) {
                        const codDB = String(row.CODIGO || "").trim();
                        if (!codDB || _porCodigoExato.has(codDB)) continue; // primeira ocorrência vence
                        const est  = Number(row.ESTOQUE != null ? row.ESTOQUE : NaN);
                        const prc  = Number(row.PRECO   != null ? row.PRECO   : NaN);
                        const desc = String(row.DESCRICAO || "").trim();
                        // ativo: null quando este banco não tem coluna ATIVO/ATIVADO/
                        // SITUACAO/STATUS detectável (colAtivo === null) — "não dá pra
                        // verificar" nunca deve virar "inativo" nem "confirmadamente
                        // ativo". Só um valor explicitamente na blacklist vira false —
                        // mesma regra do whereAtivo da query principal (ver
                        // ATIVO_VALORES_INATIVOS/_valorColunaIndicaInativo, topo do
                        // arquivo), agora também aplicada aos códigos da lista
                        // personalizada, que usam esta consulta separada sem esse filtro.
                        const registro = {
                            estoque:   Number.isFinite(est) ? Math.round(est * 1000) / 1000 : null,
                            preco:     Number.isFinite(prc) ? Math.round(prc * 100)  / 100  : null,
                            descricao: desc || null,
                            ativo:     colAtivo ? !_valorColunaIndicaInativo(row.ATIVO) : null
                        };
                        _porCodigoExato.set(codDB, registro);
                        const norm = _normalizarCodigoNumerico(codDB);
                        if (norm !== null && !_porNormalizado.has(norm)) _porNormalizado.set(norm, registro);
                        const pad5 = _codigoPadrao5Digitos(codDB);
                        if (pad5 !== null && !_porPadrao5.has(pad5)) _porPadrao5.set(pad5, registro);
                    }
                    for (const lp of _listaPersonalizada) {
                        const cod = lp.codigo;
                        let registro = _porCodigoExato.get(cod);
                        if (!registro) {
                            const pad5 = _codigoPadrao5Digitos(cod);
                            if (pad5 !== null) registro = _porPadrao5.get(pad5);
                        }
                        if (!registro) {
                            const norm = _normalizarCodigoNumerico(cod);
                            if (norm !== null) registro = _porNormalizado.get(norm);
                        }
                        // Se não achou de nenhuma forma: o código realmente não
                        // existe no banco — fica de fora de _lpEstoquesReais, e o
                        // cliente trata isso como "código não existe mais" (correto).
                        if (registro) _lpEstoquesReais[cod] = registro;
                    }
                }
                // Diagnóstico (fora do "if (!rLp.e)" de propósito — roda mesmo quando
                // a consulta falhou, pra deixar óbvio que TODOS os códigos ficaram
                // sem reconciliar por causa do erro acima, e não um por um por engano
                // de normalização): lista, pelo código exatamente como está salvo na
                // lista personalizada, quem não bateu em NENHUMA das 3 formas tentadas
                // (exata / preenchida a 5 dígitos / sem zeros à esquerda). Isso é o
                // que decide se um código aparece como "não existe mais no banco" no
                // alerta consolidado — ver _verificarAlertasListaPersonalizada no
                // cliente.
                if (_listaPersonalizada.length) {
                    const _lpNaoReconciliados = _listaPersonalizada
                        .map(lp => lp.codigo)
                        .filter(cod => !(cod in _lpEstoquesReais));
                    if (_lpNaoReconciliados.length) {
                        logTs(
                            "Lista personalizada: " + _lpNaoReconciliados.length + " de " + _listaPersonalizada.length +
                            " c\u00f3digo(s) N\u00c3O reconciliados com o banco (v\u00e3o aparecer como \"n\u00e3o existe mais\"): " +
                            _lpNaoReconciliados.slice(0, 20).join(", ") + (_lpNaoReconciliados.length > 20 ? "..." : "")
                        );
                    }
                }

                if (r.e) {
                    _erroConexao = "Erro na consulta: " + String(r.e.message || r.e);
                    _carregando = _loadLock = false;
                    logErro("ERRO query: " + _erroConexao);
                    resolve(false);
                    return;
                }

                logTs(r.rows.length + " linhas brutas. Filtrando proibidos (3 fases)...");

                // Prioridade: est >= estoqueMinimo (itensAcima).
                // Complementa com est < estoqueMinimo (itensAbaixo) quando necessário
                // para completar a lista enviada ao cliente. Note que itensAbaixo
                // contém apenas 0 < est < estoqueMinimo: itens ZERADOS não chegam
                // até aqui (barrados no SQL e na guarda de arredondamento acima),
                // então "completar a lista" nunca mais recorre a item sem estoque.
                //
                // IMPORTANTE: o loop varre TODAS as linhas retornadas pela query (sem
                // parar em maxItens) para construir o catálogo COMPLETO (_catalogoCompleto),
                // usado depois pela busca estendida do Modo Automático (ver
                // /api/buscar-mais-itens). A lista normal enviada ao cliente continua
                // limitada a maxItens, via slice() mais abaixo — isso não muda.
                const _estMin     = _cfgVivo.estoqueMinimo;
                const itensAcima  = [];   // est >= _estMin
                const itensAbaixo = [];   // est <  _estMin
                const codigosVistos = new Set();

                for (const row of r.rows) {
                    const desc = String(row.DESCRICAO || "").trim();
                    const cod  = String(row.CODIGO || "").trim();
                    const est  = Number(row.ESTOQUE != null ? row.ESTOQUE : 0);

                    if (!desc) continue;
                    if (ehProibido(desc)) continue;

                    // Guarda pelo valor JÁ ARREDONDADO, que é o que o cliente
                    // exibe e usa nos cálculos. O filtro "> 0" do SQL sozinho
                    // deixaria passar resíduo de ponto flutuante (ESTOQUE é
                    // DOUBLE PRECISION): um saldo de 0,0004, por exemplo, é
                    // "> 0" para o banco, mas vira 0 ao ser arredondado para 3
                    // casas — e apareceria na tela como um item de estoque 0,
                    // exatamente o sintoma que a regra quer impedir. Arredondar
                    // ANTES de decidir elimina a divergência entre o que foi
                    // filtrado e o que é mostrado.
                    if (!Number.isFinite(est)) continue;
                    const estArredondado = Math.round(est * 1000) / 1000;
                    if (estArredondado <= 0) continue;
                    if (!cod) continue;
                    if (codigosVistos.has(cod)) continue;
                    codigosVistos.add(cod);

                    const preco = Number(row.PRECO || 0);
                    const item = {
                        codigo:      cod,
                        descricao:   desc,
                        codbarras:   String(row.CODBARRAS || "").trim(),
                        estoque:     estArredondado,
                        preco:       Math.round(preco  * 100)  / 100,
                        ultimaVenda: row.ULTIMAVENDA ? toISO(row.ULTIMAVENDA) : null
                    };

                    if (est >= _estMin) {
                        itensAcima.push(item);
                    } else {
                        itensAbaixo.push(item);
                    }
                }

                // Combina: acima do mínimo primeiro, depois os de complemento.
                // Como a query já ordena por ESTOQUE DESC, todo item de itensAcima
                // naturalmente vem antes de qualquer item de itensAbaixo — a
                // concatenação preserva essa ordem sem precisar reordenar.
                const _nAcima  = Math.min(itensAcima.length, _cfgVivo.maxItens);
                _catalogoCompleto = itensAcima.concat(itensAbaixo);
                const itens        = _catalogoCompleto.slice(0, _cfgVivo.maxItens);
                const _nAbaixo = itens.length - _nAcima;
                _itensAbaixoMin = _nAbaixo;
                const _nF1     = itens.length;

                _itensBrutos   = itens;
                _codigosSet    = new Set(itens.map(i => i.codigo)); // lookup O(1) em marcar-usado
                _ultimaAtualiz = new Date();
                reordenarFila();
                // _lpEstoquesReais já foi calculado acima (consulta dedicada rLp,
                // antes do db.detach()) — não depende do filtro de proibidos nem do
                // filtro "estoque >= 0" da query principal, então detecta zerado,
                // negativado e excluído do ERP corretamente. Ver comentário acima.
                _carregando = _loadLock = false;

                logTs(
                    "OK: " + _itensBrutos.length + " itens carregados " +
                    "(estq\u2265" + _estMin + ": " + _nAcima +
                    (_nAbaixo > 0 ? ", abaixo do m\u00ednimo: " + _nAbaixo : "") +
                    "). Usados na fila: " + _usadosCount + ". " +
                    "Cat\u00e1logo completo: " + _catalogoCompleto.length + " itens (" +
                    Math.max(0, _catalogoCompleto.length - _itensBrutos.length) + " dispon\u00edveis para extens\u00e3o)."
                );
                if (!colUltV) {
                    logTs("AVISO: ULTIMAVENDA não encontrada — itens NÃO foram filtrados por ano de venda.");
                }
                resolve(true);
                // Notifica todos os clientes SSE que o catálogo foi atualizado
                emitirEventoSse("dados", { carregando: false, total: _itensBrutos.length });

            } catch (e) {
                _erroConexao = "Erro inesperado: " + String(e.message || e);
                try { db.detach(); } catch (_) {}
                _carregando = _loadLock = false;
                logErro("ERRO inesperado: " + _erroConexao);
                resolve(false);
            }
            });
        } catch (e) {
            // Firebird.attach() lançou antes de chamar o callback (config
            // inválida rejeitada pelo driver, etc.) — libera o lock mesmo assim.
            _erroConexao = "Erro ao iniciar conexão: " + String(e.message || e);
            _carregando = _loadLock = false;
            logErro("ERRO: " + _erroConexao);
            resolve(false);
        }
    });

    // ── Teto de segurança: carregarItens() nunca trava o servidor pra sempre ───
    // achado #B da revisão 2026-08-06: o try/catch acima só protege contra uma
    // exceção SÍNCRONA de attach() — se o host estiver inacessível de um jeito
    // que nem erro nem callback disparam (blackhole de rede, firewall que
    // descarta pacotes em silêncio), o driver pode nunca chamar o callback.
    // Nesse cenário _loadLock ficava travado em "true" para sempre, e todo
    // carregamento futuro (poll, botão "Atualizar", SSE) era silenciosamente
    // ignorado sem nenhum log de erro — o único jeito de recuperar era
    // reiniciar o processo manualmente. Promise.race garante uma resposta
    // (sucesso ou timeout) em no máximo CONEXAO_TIMEOUT_MS.
    //
    // IMPORTANTE (corrigido 2026-08-29, achado num caso real): este teto NÃO
    // cobre só o attach() — cobre TODO o callback dele, ou seja, attach() +
    // detecção de tabela + a query principal + a consulta da lista
    // personalizada, tudo junto. Por isso a mensagem abaixo fala em "carregar
    // dados", não em "conectar": um banco lento (não inacessível) pode
    // estourar este teto mesmo com o attach() tendo funcionado perfeitamente.
    // Se o carregamento "atrasado" eventualmente terminar depois do timeout já
    // ter liberado o lock, ele ainda roda até o fim (best-effort: os dados
    // chegam mais tarde em vez de se perderem) — só não é mais o resultado que
    // esta chamada específica devolve a quem esperou por ela.
    const timeoutConexao = new Promise(resolve => {
        setTimeout(() => {
            if (!_loadLock) return; // já resolveu pela via normal — nada a fazer aqui
            _erroConexao = "Timeout ao carregar dados do Firebird (" +
                Math.round(CONEXAO_TIMEOUT_MS / 1000) + "s) — conexão, detecção de tabela e consulta " +
                "principal juntas demoraram mais que isso; host/porta inacessível OU banco/rede muito lento.";
            _carregando = _loadLock = false;
            logErro("ERRO: " + _erroConexao);
            setImmediate(function() { autoDetectarHost().catch(function() {}); });
            resolve(false);
        }, CONEXAO_TIMEOUT_MS);
    });

    return Promise.race([tentativaConexao, timeoutConexao]);
}

// ─────────────────────────────────────────────────────────────────────────────
// GERAR HTML (página principal)
//
// Estratégia de template:
//   – A única interpolação server-side dentro de <script> é o objeto _S,
//     injetado como JSON literal. Isso evita conflitos entre ${} do Node.js
//     e qualquer expressão do JavaScript do cliente.
//   – O código cliente usa concatenação de strings (sem template literals)
//     para não precisar de escaping adicional dentro do template literal do Node.
// ─────────────────────────────────────────────────────────────────────────────
function gerarHTML() {
    // O HTML é gerado sob demanda e cacheado. O cache é invalidado automaticamente
    // quando configurações como appName, estoqueMinimo ou maxItens mudam em runtime.
    if (_htmlCache) return _htmlCache;

    // Objeto de configuração injetado no cliente como JSON.
    // Substitui </ por <\/ para evitar que um APP_NAME contendo
    // </script> encerre o bloco <script> prematuramente no browser.
    const serverCfg = JSON.stringify({
        appName:            APP_NAME,
        anoAtual:           ANO_ATUAL,
        maxItens:           _cfgVivo.maxItens,
        estoqueMinimo:      _cfgVivo.estoqueMinimo,
        proibidosEmbutidos: PROIBIDOS_EMBUTIDOS,
        proibidosExtra:     _cfgVivo.proibidosExtra || []
    }).replace(/<\//g, "<\\/");

    // achado #E da revisão 2026-08-06: mesma proteção de serverCfg (acima),
    // agora também aplicada ao código do engine embutido. _ENGINE_SRC é
    // inserido bruto dentro de uma tag <script> — hoje o conteúdo de
    // estoque-engine.js não contém a sequência "</script", então funciona,
    // mas é uma dependência silenciosa e frágil: bastaria alguém adicionar um
    // comentário ou mensagem de erro contendo esse texto no futuro para
    // quebrar a página inteira (a tag fecharia prematuramente) sem nenhum
    // aviso em tempo de build. Escapar aqui custa nada e remove essa classe
    // inteira de regressão silenciosa.
    const engineSrcSeguro = _ENGINE_SRC.replace(/<\//g, "<\\/");

    _htmlCache = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escH(APP_NAME)} \u2014 Estoque Disponivel</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#111827;--bg2:#1a2236;--bg3:#1e2b44;
  --sur:#1c2435;--sur2:#232f47;--brd:#2c3d5e;
  --txt:#d4e2f0;--txt2:#7090b4;--txt3:#3d5578;
  --acc:#4ea8de;--acc2:#1a6fa8;
  --grn:#4caf50;--ylw:#ffd740;--red:#ef5350;--ora:#ffa726;
  --uso-bg:rgba(40,50,65,.5);--uso-txt:#4d6680;
  --hov:rgba(78,168,222,.06);
  --shadow:0 2px 18px rgba(0,0,0,.55);
  /* alturas das barras fixas — ajustadas via JS em ajustarStickyOffsets() */
  --hdr-h:57px;--ctrl-h:67px;--stats-h:28px
}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--txt);font-size:14px;min-height:100vh}

/* ─ USER CONFING ─────────────────────────────────────────────────────────────── */
th.th-est {padding: 0 5px;}
th.th-prc {padding: 0 22px;}
th.th-bar {padding: 0 14px;}
th.th-desc {padding: 0 11px;}

/* ─ HEADER ─────────────────────────────────────────────────────────────── */
.hdr{background:var(--bg2);border-bottom:1px solid var(--brd);padding:10px 20px;
     display:flex;align-items:center;gap:14px;
     position:sticky;top:0;z-index:100;box-shadow:var(--shadow)}
.hdr-title{font-size:15px;font-weight:700;color:var(--acc)}
.hdr-sub{font-size:11px;color:var(--txt2);margin-top:2px}
.hdr-r{margin-left:auto;display:flex;align-items:center;gap:8px;flex-shrink:0}

/* ─ BADGES ──────────────────────────────────────────────────────────────── */
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap}
.b-ok{background:rgba(76,175,80,.16);color:#81c784;border:1px solid rgba(76,175,80,.28)}
.b-ld{background:rgba(78,168,222,.13);color:#64b5f6;border:1px solid rgba(78,168,222,.28)}
.b-er{background:rgba(239,83,80,.16);color:#ef9a9a;border:1px solid rgba(239,83,80,.28)}

/* ─ CONTROLES ───────────────────────────────────────────────────────────── */
.ctrl{background:var(--sur);border-bottom:1px solid var(--brd);padding:10px 20px;
      display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;
      position:sticky;top:var(--hdr-h);z-index:90}
.cg{display:flex;flex-direction:column;gap:3px}
.cl{font-size:10px;color:var(--txt2);font-weight:700;text-transform:uppercase;letter-spacing:.6px}
input{background:var(--bg2);border:1px solid var(--brd);color:var(--txt);
      padding:6px 10px;border-radius:6px;font-size:13px;outline:none;transition:border-color .18s}
input:focus{border-color:var(--acc)}
input[type=number]{width:150px}
input[type=text]{width:150px}
textarea.busca-multi-ta{background:var(--bg2);border:1px solid var(--brd);color:var(--txt);
      padding:6px 10px;border-radius:6px;font-size:12px;outline:none;transition:border-color .18s;
      width:150px;height:62px;resize:vertical;font-family:inherit;line-height:1.4}
textarea.busca-multi-ta:focus{border-color:var(--acc)}
.lnk-toggle{background:none;border:none;color:var(--acc);cursor:pointer;padding:3px;
      margin-left:6px;font-family:inherit;vertical-align:middle;display:inline-flex;
      align-items:center;justify-content:center;border-radius:4px;flex-shrink:0;
      transition:color .15s,background-color .15s}
.lnk-toggle:hover{color:var(--acc2);background:var(--bg2)}
.lnk-toggle-ativo{color:var(--acc2);background:var(--bg2)}
.cl-busca{display:flex;align-items:center;max-width:150px;gap:0}
.cl-busca-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}

/* ─ BOTÕES ───────────────────────────────────────────────────────────────── */
.btn{display:inline-flex;align-items:center;gap:5px;padding:6px 13px;border-radius:6px;
     font-size:12px;font-weight:600;cursor:pointer;border:1px solid transparent;
     transition:all .15s;white-space:nowrap;line-height:1.4;font-family:inherit}
.btn:disabled{opacity:.38;cursor:not-allowed}
.btn-p{background:var(--acc2);color:#fff;border-color:var(--acc2)}
.btn-p:hover:not(:disabled){background:#1358a0}
.btn-s{background:var(--sur2);color:var(--txt);border-color:var(--brd)}
.btn-s:hover:not(:disabled){background:var(--bg3)}
.btn-d{background:rgba(239,83,80,.11);color:#ef9a9a;border-color:rgba(239,83,80,.22)}
.btn-d:hover:not(:disabled){background:rgba(239,83,80,.2)}
.btn-usar{background:rgba(78,168,222,.1);color:var(--acc);border-color:rgba(78,168,222,.22)}
.btn-usar:hover:not(:disabled){background:rgba(78,168,222,.2)}
.btn-w{background:rgba(217,119,6,.12);color:#d97706;border-color:rgba(217,119,6,.3)}
.btn-w:hover:not(:disabled){background:rgba(217,119,6,.22)}
.btn-sm{padding:6px 10px;font-size:11px}

/* ─ FAIXA DE PREÇO ──────────────────────────────────────────────────────── */
/* IMPORTANTE (fix 2026-07-09): antes o .prc-box inteiro tinha
   white-space:nowrap+overflow:hidden+text-overflow:ellipsis, o que truncava
   o BLOCO TODO como uma unidade só — na prática cortava também o prc-range
   (o valor em R$, que precisa estar sempre 100% legível). Agora só o
   prc-hint (texto complementar, ex: "(até +R$40 de tolerância)") pode
   truncar; prc-range nunca é cortado (flex-shrink:0). O texto completo do
   hint, mesmo truncado visualmente, fica disponível no atributo title
   (tooltip ao passar o mouse) — ver atualizarPrcBox(). */
.prc-box{background:rgba(76,175,80,.08);border:1px solid rgba(76,175,80,.2);
         border-radius:6px;padding:5px 12px;font-size:11px;color:var(--txt2);
         display:none;align-items:center;gap:6px;min-width:0;
         max-width:320px}
.prc-box.vis{display:flex}
#prcBoxWrap{flex-shrink:1;min-width:0;max-width:320px}

/* ─ BOTÃO LIMPAR FILTROS — só aparece quando há filtro ativo ──────────────── */
#btnLimparFiltros{display:none}
#btnLimparFiltros.vis{display:inline-flex}
.prc-range{color:var(--grn);font-weight:700;flex-shrink:0;white-space:nowrap}
.prc-hint{font-size:10px;color:var(--txt2);font-style:italic;
          flex-shrink:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
          cursor:default}

/* ─ STATS ────────────────────────────────────────────────────────────────── */
.stats{background:var(--sur);border-bottom:1px solid var(--brd);padding:5px 20px;
       display:flex;align-items:center;flex-wrap:wrap;gap:12px;
       font-size:11px;color:var(--txt2);min-height:28px;
       position:sticky;top:calc(var(--hdr-h) + var(--ctrl-h));z-index:80}
.stats strong{color:var(--txt);font-size:12px}

/* ─ TABELA ───────────────────────────────────────────────────────────────── */
.tw{overflow-x:auto;padding-bottom:80px}
table{width:100%;border-collapse:collapse;table-layout:fixed}
thead th{
  background:var(--bg2);color:var(--txt2);font-size:10px;font-weight:700;
  text-transform:uppercase;letter-spacing:.5px;padding:8px 12px;
  border-bottom:2px solid var(--brd);text-align:left;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* thead sticky via JS (overflow-x:auto quebra position:sticky nativo) */
thead{position:relative;z-index:70;will-change:transform}
/* colunas fixas — table-layout:fixed garante uniformidade */
.th-n  {width:38px; text-align:center}
.th-cod{width:76px; text-align:center}
/* Cabecalhos que copiam a coluna inteira ("Codigo" e "Cod. Barras").
   Regras escritas UMA vez sobre a classe generica .th-copiar em vez de
   duplicadas por coluna: as duas se comportam igual, e duplicar significaria
   que qualquer ajuste futuro teria de ser lembrado nos dois lugares.
   Segue a mesma linguagem visual de .th-sort (cursor de mao, realce no hover)
   para o usuario reconhecer de imediato que a celula responde a clique.
   O icone usa flex:0 0 auto pelo mesmo motivo do indicador de ordenacao: o th
   e estreito e tem overflow:hidden, entao sem isso o icone seria a primeira
   coisa cortada pelo ellipsis, e o affordance desapareceria justamente nas
   telas menores, onde ele e mais necessario. */
th.th-copiar{cursor:pointer;user-select:none;transition:color .15s,background .15s}
th.th-copiar:hover{color:var(--acc);background:var(--sur2)}
th.th-copiar:active{background:var(--brd)}
/* O flex NAO pode impor um alinhamento proprio: justify-content substituiria o
   text-align de cada coluna. "Codigo" e centralizado (pedido explicito), mas
   "Cod. Barras" e alinhado a esquerda como sempre foi — o padrao aqui e
   flex-start e so .th-cod recebe o centro, para nenhuma coluna mudar de
   aparencia por efeito colateral de virar copiavel. */
.th-copiar-conteudo{display:flex;align-items:center;justify-content:flex-start;gap:4px;min-width:0}
.th-cod .th-copiar-conteudo{justify-content:center}
.th-copiar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.th-copiar-ico{flex:0 0 auto;display:inline-flex;align-items:center;opacity:.5;line-height:0;
            transition:opacity .15s}
th.th-copiar:hover .th-copiar-ico{opacity:1}
.th-desc{/* preenche o espaço restante automaticamente */}
.th-bar{width:138px}
.th-est{width:84px; text-align:center}
.th-prc{width:94px; text-align:center}
.th-uv {width:90px; text-align:center}
.th-ac {width:80px; text-align:center}
tbody tr{border-bottom:1px solid var(--brd);transition:background .1s}
tbody tr:hover:not(.tr-uso){background:var(--hov)}
.tr-uso{background:var(--uso-bg);opacity:.62}
/* Destaque de match de preço */
.tr-pm{background:rgba(76,175,80,.07)!important;border-left:3px solid rgba(76,175,80,.55)!important}
.tr-pm:hover{background:rgba(76,175,80,.13)!important}
td{padding:7px 12px;vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.td-n  {text-align:center;color:var(--txt3);font-size:11px}
.td-cod{font-family:Consolas,monospace;font-size:12px;color:var(--txt2);text-align:center}
.td-desc{white-space:normal;line-height:1.4;word-break:break-word}
.td-bar{font-family:Consolas,monospace;font-size:11px;color:var(--txt2)}
.td-est{text-align:center;font-weight:700;color:var(--ylw)}
.td-prc{text-align:center;font-weight:600;color:var(--acc)}
.td-uv {text-align:center;font-size:11px;color:var(--txt2)}
.td-ac {text-align:center}
.tr-uso td{color:var(--uso-txt)}
.tr-uso .td-est,.tr-uso .td-prc{color:var(--uso-txt)}
/* Tags inline */
.tag{display:inline-block;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:5px;vertical-align:middle;font-weight:600}
.tag-fila{background:rgba(77,102,128,.22);color:#5a7a96}
.tag-pm  {background:rgba(76,175,80,.2);color:#81c784}

/* ─ MENSAGENS ────────────────────────────────────────────────────────────── */
.msg{margin:44px auto;max-width:460px;background:var(--sur);border:1px solid var(--brd);border-radius:10px;padding:24px 28px;text-align:center}
.msg h3{font-size:15px;margin-bottom:8px}
.msg p{color:var(--txt2);font-size:13px;line-height:1.6}
.msg-er{border-color:rgba(239,83,80,.35)}
.msg-er h3{color:#ef9a9a}

/* ─ SPINNER SVG ──────────────────────────────────────────────────────────── */
@keyframes sp{to{transform:rotate(360deg)}}
.spin-svg{display:inline-block;animation:sp .7s linear infinite;vertical-align:middle;
          margin-right:5px;flex-shrink:0;overflow:visible}

/* ─ TOAST ────────────────────────────────────────────────────────────────── */
.toast{position:fixed;top:22px;left:22px;background:var(--sur2);border:1px solid var(--brd);
       color:var(--txt);padding:9px 10px 9px 16px;border-radius:8px;font-size:13px;
       box-shadow:var(--shadow);z-index:9999;opacity:0;transform:translateY(-8px);
       transition:opacity .22s,transform .22s;pointer-events:none;max-width:320px;
       display:flex;align-items:flex-start;gap:10px}
/* pointer-events volta a "auto" SO quando o toast esta visivel: enquanto
   invisivel ele nao pode capturar cliques destinados ao que esta embaixo
   (o elemento continua no DOM, ocupando a area do canto superior esquerdo). */
.toast.on{opacity:1;transform:translateY(0);pointer-events:auto}
.toast-msg{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.toast-x{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
         width:20px;height:20px;margin-top:-1px;padding:0;border:0;border-radius:5px;
         background:transparent;color:var(--txt3);cursor:pointer;line-height:0;
         transition:background .15s,color .15s}
.toast-x:hover{background:var(--brd);color:var(--txt)}

/* ─ MODAL CONFIRM ────────────────────────────────────────────────────────── */
/* z-index alto o suficiente para ficar SEMPRE acima de qualquer outro overlay
   da página (.auto-ov:9100, .cfg-ov:1200, .toast:9999, .btn-top:9000).
   Antes era 9000 — menor que .auto-ov (9100), por isso o modal de confirmação
   (ex.: "Itens não encontrados") aparecia ATRÁS do modal do Modo Automático. */
.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:10000;
  display:flex;align-items:center;justify-content:center;
  opacity:0;transition:opacity .18s;pointer-events:none}
.modal-ov.on{opacity:1;pointer-events:auto}
.modal-bx{background:var(--sur);border:1px solid var(--brd);border-radius:10px;
  padding:22px 26px;max-width:380px;width:92%;box-shadow:var(--shadow);
  transform:translateY(-10px);transition:transform .18s;
  max-height:85vh;display:flex;flex-direction:column;overflow-y:auto}
.modal-ov.on .modal-bx{transform:translateY(0);}
.modal-ttl{font-size:14px;font-weight:700;color:var(--txt);margin-bottom:8px;flex-shrink:0}
.modal-msg{font-size:13px;color:var(--txt2);line-height:1.6;margin-bottom:18px;white-space:pre-line;flex-shrink:0}
.modal-msg-lista{font-size:12.5px;color:var(--txt2);line-height:1.6;margin-bottom:18px;white-space:pre-line;
  flex-shrink:0;max-height:220px;overflow-y:auto;
  background:var(--bg3);border:1px solid var(--brd);border-radius:6px;padding:8px 10px}
.modal-ftr{display:flex;justify-content:flex-end;gap:8px;flex-shrink:0}

/* ─ SCROLLBAR FINA ─────────────────────────────────────────────────────── */
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--brd);border-radius:6px}
::-webkit-scrollbar-thumb:hover{background:var(--txt2)}
*{scrollbar-width:thin;scrollbar-color:var(--brd) transparent}

/* ─ MODO AUTOMÁTICO ─────────────────────────────────────────────────────── */
.auto-ov{position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9100;
  display:flex;align-items:center;justify-content:center;
  opacity:0;transition:opacity .18s;pointer-events:none}
.auto-ov.on{opacity:1;pointer-events:auto}
.auto-bx{background:var(--sur);border:1px solid var(--brd);border-radius:12px;
  padding:24px 26px;max-width:680px;width:95%;box-shadow:var(--shadow);
  transform:translateY(-12px);transition:transform .2s;display:flex;flex-direction:column;gap:14px;max-height:90vh;overflow-y:auto}
.auto-ov.on .auto-bx{transform:translateY(0)}
.auto-ttl{font-size:15px;font-weight:700;color:var(--acc);display:flex;align-items:center;justify-content:space-between}
.auto-close{background:none;border:none;color:var(--txt2);font-size:18px;cursor:pointer;padding:2px 6px;border-radius:4px;line-height:1}
.auto-close:hover{color:var(--txt);background:var(--bg3)}

/* ─ BOTÃO CONFIG (ícone no header) ──────────────────────────────────────── */
.btn-cfg{padding:5px 8px;background:transparent;border:1px solid var(--brd);color:var(--txt2);border-radius:6px}
.btn-cfg:hover{color:var(--txt);border-color:var(--acc);background:var(--bg3)}

/* ─ MODAL CONFIGURAÇÕES ──────────────────────────────────────────────────── */
.cfg-ov{position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(2px);
        z-index:1200;display:flex;align-items:center;justify-content:center;
        opacity:0;pointer-events:none;transition:opacity .2s}
.cfg-ov.on{opacity:1;pointer-events:all}
.cfg-bx{background:var(--bg2);border:1px solid var(--brd);border-radius:12px;
        width:min(560px,96vw);max-height:88vh;display:flex;flex-direction:column;
        box-shadow:0 24px 64px rgba(0,0,0,.65);
        transform:translateY(8px);transition:transform .22s}
.cfg-ov.on .cfg-bx{transform:translateY(0)}
.cfg-ttl{display:flex;align-items:center;justify-content:space-between;
         padding:14px 18px;border-bottom:1px solid var(--brd);flex-shrink:0}
.cfg-ttl-txt{font-size:13.5px;font-weight:700;color:var(--txt);display:flex;align-items:center;gap:8px}
.cfg-body{overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
.cfg-sec{background:var(--bg3);border:1px solid var(--brd);border-radius:8px;padding:14px;
         display:flex;flex-direction:column;gap:10px}
.cfg-sec-ttl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;
              color:var(--txt2);margin-bottom:2px;display:flex;align-items:center;gap:6px}
.cfg-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.cfg-grid-1{display:grid;grid-template-columns:1fr;gap:8px}
.cfg-field{display:flex;flex-direction:column;gap:4px}
.cfg-lbl{font-size:11px;color:var(--txt2);font-weight:600}
.cfg-inp{background:var(--bg);border:1px solid var(--brd);color:var(--txt);
         padding:7px 10px;border-radius:6px;font-size:12.5px;outline:none;
         transition:border-color .15s;width:100%;font-family:Consolas,monospace}
.cfg-inp:focus{border-color:var(--acc)}
.cfg-inp::placeholder{color:var(--txt3);opacity:1}
.cfg-ta{resize:vertical;min-height:88px;font-family:Consolas,monospace;line-height:1.65;font-size:12px}
.cfg-note{font-size:10.5px;color:var(--txt3);line-height:1.5;display:flex;align-items:flex-start;gap:5px}
.cfg-note-warn{color:#f6b048}
.cfg-proib-emb{font-size:10.5px;color:var(--txt3);line-height:1.9;
               columns:2;column-gap:10px;max-height:88px;overflow-y:auto;
               padding:7px 9px;background:var(--bg);border-radius:5px;
               border:1px solid var(--brd);margin-top:6px;font-family:Consolas,monospace}
.cfg-proib-emb summary::-webkit-details-marker{display:none}
.cfg-details summary{font-size:10.5px;color:var(--txt2);cursor:pointer;user-select:none;
                      list-style:none;display:flex;align-items:center;gap:5px}
.cfg-details summary::before{content:"";display:inline-block;width:8px;height:8px;
                               border:1.5px solid var(--txt3);border-radius:1px;
                               transform:rotate(45deg);transition:transform .15s;flex-shrink:0}
.cfg-details[open] summary::before{transform:rotate(225deg)}
.cfg-ftr{padding:12px 18px;border-top:1px solid var(--brd);
         display:flex;align-items:center;justify-content:space-between;
         gap:10px;flex-shrink:0;min-height:56px}
.cfg-status{font-size:12px;flex:1;line-height:1.45}
.cfg-status.ok{color:#81c784}
.cfg-status.er{color:#ef9a9a}
.cfg-status.warn{color:#f6b048}
.auto-desc{font-size:12px;color:var(--txt2);line-height:1.6}
.auto-ta{width:100%;min-height:160px;background:var(--bg2);border:1px solid var(--brd);color:var(--txt);
  padding:10px 12px;border-radius:8px;font-family:Consolas,monospace;font-size:12px;
  outline:none;resize:vertical;transition:border-color .18s;line-height:1.55}
.auto-ta:focus{border-color:var(--acc)}
.auto-ta-out{width:100%;min-height:180px;background:rgba(76,175,80,.05);border:1px solid rgba(76,175,80,.25);
  color:var(--txt);padding:10px 12px;border-radius:8px;font-family:Consolas,monospace;font-size:12px;
  outline:none;resize:vertical;line-height:1.55;cursor:text}
/* ─ LISTA PERSONALIZADA (modo automático) ─────────────────────────────────── */
.auto-ta-lp{width:100%;min-height:70px;background:rgba(78,168,222,.05);border:1px solid rgba(78,168,222,.25);
  color:var(--txt);padding:9px 11px;border-radius:8px;font-family:Consolas,monospace;font-size:12px;
  outline:none;resize:vertical;transition:border-color .18s;line-height:1.55;margin-top:8px}
.auto-ta-lp:focus{border-color:var(--acc)}
.auto-lp-hint{font-size:10.5px;color:var(--txt3);margin-top:5px;line-height:1.5}
.auto-ftr{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.auto-status{font-size:11px;color:var(--txt2);font-style:italic;flex:1}
.auto-status.ok{color:var(--grn)}
.auto-status.er{color:#ef9a9a}
.btn-auto{background:rgba(78,168,222,.13);color:var(--acc);border-color:rgba(78,168,222,.35)}
.btn-auto:hover:not(:disabled){background:rgba(78,168,222,.22)}

/* ─ TOGGLE SWITCH ──────────────────────────────────────────────────────── */
.tgl-wrap{display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none;padding:6px 10px;background:var(--bg2);border:1px solid var(--brd);border-radius:6px;transition:border-color .18s;vertical-align:middle}
.tgl-wrap:hover{border-color:var(--acc)}
.tgl-wrap input{display:none}
.tgl{width:32px;height:17px;background:var(--brd);border-radius:9px;position:relative;transition:background .2s;flex-shrink:0}
.tgl::after{content:"";width:13px;height:13px;background:#fff;border-radius:50%;position:absolute;top:2px;left:2px;transition:left .18s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.tgl-wrap input:checked+.tgl{background:var(--acc2)}
.tgl-wrap input:checked+.tgl::after{left:17px}
.tgl-lbl{font-size:11px;font-weight:600;color:var(--txt2);white-space:nowrap}
.tgl-wrap input:checked~.tgl-lbl{color:var(--acc)}

/* ─ SEÇÃO DE GRUPOS ─────────────────────────────────────────────────────── */
.grp-hdr{padding:10px 20px 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--txt2);border-top:2px solid var(--brd);margin-top:8px;display:flex;align-items:center;gap:10px}
.grp-hdr span{color:var(--grn)}
.grp-grid{display:flex;flex-wrap:wrap;gap:10px;padding:6px 20px 20px}
.grp-card{background:var(--sur);border:1px solid var(--brd);border-radius:8px;padding:10px 14px;min-width:240px;max-width:340px;flex:1;transition:border-color .15s}
.grp-card:hover{border-color:var(--grn)}
.grp-card-item{display:flex;align-items:center;padding:4px 0;font-size:11px;border-bottom:1px solid var(--brd);gap:6px}
.grp-card-item:last-of-type{border-bottom:none}
.grp-cod{font-family:Consolas,monospace;font-size:10px;color:var(--txt2);width:54px;flex-shrink:0;text-align:right}
.grp-bar{font-family:Consolas,monospace;font-size:10px;color:var(--txt3);width:110px;flex-shrink:0;text-align:right}
.grp-card-item .nm{color:var(--txt);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp-card-item .pv{color:var(--acc);font-weight:700;flex-shrink:0;width:70px;text-align:right}
.grp-total{display:flex;justify-content:space-between;align-items:center;margin-top:7px;padding-top:7px;border-top:1px solid var(--brd)}
.grp-total .lbl{font-size:11px;color:var(--txt2)}
.grp-total .val{font-size:13px;font-weight:700;color:var(--grn)}
.grp-total .diff-pos{font-size:10px;color:var(--ora);margin-left:6px}
.grp-total .diff-neg{font-size:10px;color:var(--grn);margin-left:6px}
.grp-vazio{padding:16px 20px;color:var(--txt2);font-size:12px;font-style:italic}

/* ─ MODAL: ALERTA CONSOLIDADO DA LISTA PERSONALIZADA ──────────────────────── */
.lpa-lista{display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow-y:auto;margin:2px 0}
.lpa-row{background:var(--bg3);border:1px solid var(--brd);border-radius:8px;
         padding:10px 12px;display:flex;align-items:center;justify-content:space-between;
         gap:10px;flex-wrap:wrap;transition:border-color .15s}
.lpa-row:hover{border-color:var(--ora)}
.lpa-info{flex:1;min-width:180px}
.lpa-nome{font-size:12.5px;font-weight:700;color:var(--txt);
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.lpa-item{font-size:11.5px;color:var(--txt);margin-top:2px;line-height:1.4;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.lpa-motivo{font-size:11px;color:var(--txt2);margin-top:3px;line-height:1.4}
.lpa-btns{display:flex;gap:6px;flex-shrink:0}
.lpa-rodape{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;
            border-top:1px solid var(--brd);padding-top:12px;margin-top:2px}

/* ─ BOTÃO VOLTAR AO TOPO ─────────────────────────────────────────────────── */
.btn-top{
  position:fixed;left:50%;bottom:22px;width:38px;height:38px;border-radius:50%;
  background:var(--sur2);border:1px solid var(--brd);color:var(--txt2);
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  box-shadow:var(--shadow);opacity:0;transform:translate(-50%,10px) scale(.9);
  pointer-events:none;transition:opacity .2s,transform .2s,background .15s,color .15s,border-color .15s;
  z-index:9000}
.btn-top.on{opacity:1;transform:translate(-50%,0) scale(1);pointer-events:auto}
.btn-top:hover{background:var(--acc2);color:#fff;border-color:var(--acc2)}
/* O :active PRECISA repetir o translate(-50%,0). Escrever apenas
   "transform:scale(.92)" substituia a transform inteira, descartando a
   centralizacao horizontal — no mousedown o botao pulava ~19px para a direita
   (metade da propria largura), o ponteiro deixava de estar sobre ele e o
   mouseup caia fora, entao o evento de clique nunca era disparado e a pagina
   nao subia. transform e uma propriedade unica: nao existe "alterar so a
   escala". Seletor com .on para vencer .btn-top.on por especificidade
   (0,3,0 contra 0,2,0), sem depender da ordem das regras no arquivo. */
.btn-top.on:active{transform:translate(-50%,0) scale(.92)}

/* ─ SORT NOS TH ─────────────────────────────────────────────────────────── */
.th-sort{cursor:pointer;user-select:none;transition:color .15s,background .15s}
.th-sort:hover{color:var(--acc);background:rgba(78,168,222,.07)}
.th-sort-ativo{color:var(--acc)!important}
/* ── Ícone de ordenação ───────────────────────────────────────────────────────
   "Sempre visível" aqui exige DUAS coisas, não só opacidade:

   (1) Opacidade utilizável mesmo inativo. Antes o estado inativo usava
       opacity:.22, praticamente invisível no fundo escuro — o usuário não
       tinha como saber que a coluna era clicável. Agora inativo fica em .5
       (discreto, mas legível) e o ativo em 1.

   (2) Nao ser cortado. O seletor thead th usa overflow:hidden com
       text-overflow:ellipsis, e as colunas ordenáveis são estreitas (th-prc tem 94px com 22px de
       padding de cada lado = 50px úteis). Só aumentar a opacidade não bastaria:
       em "PREÇO" o rótulo sozinho já consome quase toda a largura e o ícone
       era o primeiro a ser cortado pelo ellipsis. Por isso o conteúdo do th
       vira flex: o ÍCONE é flex:0 0 auto (nunca encolhe, nunca some) e quem
       recebe o ellipsis é o RÓTULO. O texto abrevia; o indicador permanece. */
.th-sort-conteudo{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0}
.th-sort-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sort-ico{flex:0 0 auto;display:inline-flex;align-items:center;opacity:1;line-height:0}
.sort-ico-inativo{opacity:.5}
.th-sort:hover .sort-ico-inativo{opacity:.85}

/* ─ RESPONSIVO ───────────────────────────────────────────────────────────── */
@media(max-width:720px){
  .th-bar,.td-bar,.th-uv,.td-uv{display:none}
  input[type=text]{width:160px}
  .hdr-sub{display:none}
}

/* ─ DESEMPENHO EM MÁQUINAS FRACAS ─────────────────────────────────────────
   1) contain:content nas linhas isola o layout de cada <tr>: ao inserir um
      novo bloco de linhas (render incremental), o navegador não precisa
      recalcular o layout das linhas já existentes — o custo de anexar deixa
      de crescer com o tamanho da tabela.
   2) content-visibility:auto no rodapé de carregamento evita pintar o que
      está fora da viewport.
   3) .perf-baixa (aplicada ao <html> quando detectamos hardware modesto ou o
      usuário pede menos movimento) desliga TODA transição/animação de uma vez.
      Feito por classe no elemento raiz — um único ponto de corte, sem precisar
      caçar cada regra de transition individualmente. */
tbody tr{contain:content}
.tw-sentinela{height:1px}
.tw-mais{padding:14px;text-align:center;color:var(--txt3);font-size:12px;content-visibility:auto}

html.perf-baixa *,
html.perf-baixa *::before,
html.perf-baixa *::after{
  transition:none!important;animation:none!important;scroll-behavior:auto!important}
/* O spinner é informação de estado, não enfeite: preservado mesmo no modo leve,
   só que mais lento (menos repaints por segundo). */
html.perf-baixa .spin-svg{animation:sp 1.6s linear infinite!important}

@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}
  .spin-svg{animation:sp 1.6s linear infinite!important}
}
</style>
</head>
<body>

<!-- HEADER -->
<div class="hdr">
  <div>
    <div class="hdr-title">${escH(APP_NAME)} &mdash; Estoque Disponivel</div>
    <div class="hdr-sub">
      At&eacute; <span id="hdrMaxItens">${_cfgVivo.maxItens}</span> itens &nbsp;&bull;&nbsp;
      Estoque m&iacute;nimo <span id="hdrEstMin">${_cfgVivo.estoqueMinimo}</span> unid. &nbsp;&bull;&nbsp;
      Ordenando por <span id="hdrSortLabel">Estoque \u25bc</span>
    </div>
  </div>
  <div class="hdr-r">
    <span id="badge"><span class="badge b-ld"><svg class="spin-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="rgba(78,168,222,.18)" stroke-width="2.5"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke="var(--acc)" stroke-width="2.5" stroke-linecap="round"/></svg>Carregando...</span></span>
    <button class="btn btn-auto btn-sm" onclick="abrirModoAuto()" id="btnAuto"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><path d="M9.5 1 3 9.5h5L6.5 15 13.5 6.5H8.5z"/></svg>Modo autom&aacute;tico</button>
    <button class="btn btn-s btn-sm" onclick="atualizarBanco()" id="btnAtual"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><path d="M13 8A5 5 0 1 1 9 3.1"/><polyline points="9 1 13 3.1 10.5 7"/></svg>Atualizar</button>
    <button class="btn btn-cfg btn-sm" onclick="abrirConfigs()" id="btnCfg" title="Configurações" aria-label="Configurações"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/><circle cx="5" cy="4" r="1.6" fill="var(--bg2)"/><circle cx="10" cy="8" r="1.6" fill="var(--bg2)"/><circle cx="6" cy="12" r="1.6" fill="var(--bg2)"/></svg></button>
  </div>
</div>

<!-- CONTROLES -->
<div class="ctrl">
  <div class="cg">
    <label class="cl cl-busca" for="txtBusca" title="Buscar (descri&ccedil;&atilde;o, c&oacute;digo, EAN, &gt;N, &lt;N)"><span class="cl-busca-txt">Buscar (descri&ccedil;&atilde;o, c&oacute;digo, EAN, &gt;N, &lt;N)</span><button type="button" class="lnk-toggle" id="btnBuscaMulti" onclick="toggleBuscaMulti()" title="Mudar para busca personalizada (v&aacute;rios c&oacute;digos, produtos e/ou c&oacute;digos de barra de uma vez, um por linha)" aria-label="Busca personalizada"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="4.5" x2="13" y2="4.5"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="11.5" x2="9" y2="11.5"/></svg></button></label>
    <input type="text" id="txtBusca" placeholder="Nome, c&oacute;d, EAN, &gt;200, nexgard&gt;10..." title="Buscar por descri&ccedil;&atilde;o, c&oacute;digo ou EAN. Filtro de estoque: &gt;N (estoque m&iacute;nimo) ou &lt;N (estoque m&aacute;ximo), sozinhos ou combinados com o texto. Ex: nexgard&gt;10 mostra produtos com &quot;nexgard&quot; no nome e 10 ou mais em estoque; nexgard&lt;10 mostra os com 10 ou menos." oninput="filtrarDebounced()">
    <textarea id="txtBuscaMulti" class="busca-multi-ta" style="display:none" title="Um c&oacute;digo, produto ou c&oacute;digo de barras por linha (ou separados por v&iacute;rgula)" placeholder="Um c&oacute;digo, produto ou c&oacute;digo de barras por linha (ou separados por v&iacute;rgula). Mistura os tipos livremente. Ex:&#10;08395&#10;7891234567890&#10;ARROZ" oninput="filtrarDebounced()"></textarea>
  </div>

  <div class="cg">
    <label class="cl" for="numPrc">Busca por valor (R$)</label>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:nowrap">
      <input type="number" id="numPrc" placeholder="Ex: 250,00" step="0.01" min="0" oninput="onPrecoInput()">
      <label class="tgl-wrap" style="flex-shrink:0" title="Agrupar itens distintos (sem limite de quantidade) que somem ao valor informado, respeitando estoque m&iacute;nimo e toler&acirc;ncia +R$40">
        <input type="checkbox" id="chkGrupar" onchange="filtrar()">
        <span class="tgl"></span>
        <span class="tgl-lbl">Agrupar</span>
      </label>
      <label class="tgl-wrap" style="flex-shrink:0" title="Busca combina&ccedil;&otilde;es com repeti&ccedil;&atilde;o do mesmo item (ex: 3&times;08395) — marca como usado s&oacute; ap&oacute;s confirma&ccedil;&atilde;o">
        <input type="checkbox" id="chkAcima" onchange="filtrar()">
        <span class="tgl"></span>
        <span class="tgl-lbl">Combinar</span>
      </label>
    </div>
  </div>

  <div class="cg" id="prcBoxWrap">
    <label class="cl">&nbsp;</label>
    <div class="prc-box" id="prcBox">
      Mostrando pre&ccedil;os de&nbsp;<span class="prc-range" id="prcRange">&mdash;</span>
      <span class="prc-hint" id="prcHint"></span>
    </div>
  </div>

  <div class="cg">
    <label class="cl">&nbsp;</label>
    <button class="btn btn-s btn-sm" id="btnLimparFiltros" onclick="limparFiltros()"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><path d="M3 3l10 10M13 3 3 13"/></svg>Limpar filtros</button>
  </div>

  <div class="cg">
    <label class="cl" for="selLimite">Itens exibidos</label>
    <select id="selLimite" onchange="aplicarLimite()" style="background:var(--bg2);border:1px solid var(--brd);color:var(--txt);padding:6px 10px;border-radius:6px;font-size:13px;outline:none;cursor:pointer">
    </select>
  </div>

  <div class="cg" style="margin-left:auto;flex-shrink:0">
    <label class="cl">&nbsp;</label>
    <button class="btn btn-d btn-sm" onclick="resetarUsados()" id="btnReset"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><path d="M2.5 4.5h11M6 4.5v-1a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1M5.5 4.5l.7 8h3.6l.7-8"/><path d="M7 7.5v3M9 7.5v3"/></svg>Resetar usados</button>
  </div>
</div>

<!-- STATS BAR -->
<div class="stats" id="stats">Carregando dados...</div>

<!-- COMBINAR COM QUANTIDADE (visível quando "Combinar" está ativo e há valor) — fica ANTES da tabela -->
<div id="combinarWrap" style="display:none">
  <div class="grp-hdr">Combina&ccedil;&atilde;o com repeti&ccedil;&atilde;o para <span id="combinarValorLabel">-</span><span id="combinarStatus" style="font-size:11px;color:var(--txt3);margin-left:12px"></span></div>
  <div class="grp-grid" id="combinarGrid"></div>
</div>

<!-- GRUPOS (visível quando agrupar está ativo e há valor informado) -->
<div id="gruposWrap" style="display:none">
  <div class="grp-hdr">Combina&ccedil;&otilde;es que somam a <span id="grpValorLabel">-</span></div>
  <div class="grp-grid" id="gruposGrid"></div>
</div>

<!-- TABELA -->
<div class="tw" id="tw">
  <div class="msg">
    <p><svg class="spin-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="rgba(78,168,222,.18)" stroke-width="2.5"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke="var(--acc)" stroke-width="2.5" stroke-linecap="round"/></svg>Conectando ao banco de dados...</p>
  </div>
</div>

<!-- CONFIGURAÇÕES MODAL -->
<div class="cfg-ov" id="cfgOv" onclick="fecharConfigsSe(event)" role="dialog" aria-modal="true" aria-label="Configurações">
  <div class="cfg-bx" id="cfgBx">
    <div class="cfg-ttl">
      <span class="cfg-ttl-txt">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/><circle cx="5" cy="4" r="1.6" fill="var(--bg2)"/><circle cx="10" cy="8" r="1.6" fill="var(--bg2)"/><circle cx="6" cy="12" r="1.6" fill="var(--bg2)"/></svg>
        Configura&ccedil;&otilde;es
      </span>
      <button class="auto-close" onclick="fecharConfigs()" title="Fechar" aria-label="Fechar"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </div>

    <div class="cfg-body" id="cfgBody">

      <!-- ── Banco de Dados ── -->
      <div class="cfg-sec">
        <div class="cfg-sec-ttl">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="8" cy="4" rx="5.5" ry="2"/><path d="M2.5 4v4c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V4"/><path d="M2.5 8v4c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V8"/></svg>
          Banco de Dados (Firebird)
        </div>
        <div class="cfg-grid">
          <div class="cfg-field">
            <label class="cfg-lbl" for="cfgFbHost">Host / IP</label>
            <input class="cfg-inp" id="cfgFbHost" type="text" placeholder="192.168.1.65" spellcheck="false" autocomplete="off">
          </div>
          <div class="cfg-field">
            <label class="cfg-lbl" for="cfgFbPort">Porta Firebird</label>
            <input class="cfg-inp" id="cfgFbPort" type="number" placeholder="3050" min="1" max="65534" style="font-family:inherit">
          </div>
        </div>
        <div class="cfg-grid-1">
          <div class="cfg-field">
            <label class="cfg-lbl" for="cfgFdbPath">Caminho do arquivo .FDB no servidor</label>
            <input class="cfg-inp" id="cfgFdbPath" type="text" placeholder="C:\\Program Files (x86)\\SmallSoft\\Small Commerce\\SMALL.FDB" spellcheck="false" autocomplete="off">
          </div>
        </div>
        <div class="cfg-grid">
          <div class="cfg-field">
            <label class="cfg-lbl" for="cfgFbUser">Usu&aacute;rio</label>
            <input class="cfg-inp" id="cfgFbUser" type="text" placeholder="SYSDBA" spellcheck="false" autocomplete="off">
          </div>
          <div class="cfg-field">
            <label class="cfg-lbl" for="cfgFbPass">Senha</label>
            <input class="cfg-inp" id="cfgFbPass" type="password" placeholder="masterkey" autocomplete="new-password">
          </div>
        </div>
        <span class="cfg-note">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;margin-top:1px"><circle cx="8" cy="8" r="6"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5" r=".6" fill="currentColor" stroke="none"/></svg>
          Altera&ccedil;&otilde;es no banco recarregam os dados automaticamente sem reiniciar.
        </span>
      </div>

      <!-- ── Servidor HTTP ── -->
      <div class="cfg-sec">
        <div class="cfg-sec-ttl">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="4" rx="1"/><rect x="1.5" y="9.5" width="13" height="4" rx="1"/><circle cx="4.5" cy="4.5" r=".8" fill="currentColor" stroke="none"/><circle cx="4.5" cy="11.5" r=".8" fill="currentColor" stroke="none"/></svg>
          Servidor HTTP
        </div>
        <div class="cfg-grid">
          <div class="cfg-field">
            <label class="cfg-lbl" for="cfgPorta">Porta HTTP</label>
            <input class="cfg-inp" id="cfgPorta" type="number" placeholder="7888" min="1024" max="65534" style="font-family:inherit">
          </div>
          <div class="cfg-field">
            <label class="cfg-lbl" for="cfgEstMin">Estoque m&iacute;nimo &mdash; itens com quantidade abaixo s&atilde;o exclu&iacute;dos da listagem (padr&atilde;o: 5)</label>
            <input class="cfg-inp" id="cfgEstMin" type="number" placeholder="5" min="0" max="9999" step="1" style="font-family:inherit">
          </div>
          <div class="cfg-field">
            <label class="cfg-lbl" for="cfgMaxItens">M&aacute;x. itens carregados do banco (100&ndash;20000, padr&atilde;o: 2000) &mdash; aplicado imediatamente</label>
            <input class="cfg-inp" id="cfgMaxItens" type="number" placeholder="2000" min="100" max="20000" step="100" style="font-family:inherit">
          </div>
          <div class="cfg-field">
            <label class="cfg-lbl" for="cfgAppName">Nome da aplica&ccedil;&atilde;o</label>
            <input class="cfg-inp" id="cfgAppName" type="text" placeholder="Consulta Estoque">
          </div>
        </div>
        <span class="cfg-note cfg-note-warn">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;margin-top:1px"><path d="M8 1.5 1.5 13.5h13z"/><line x1="8" y1="6" x2="8" y2="9.5"/><circle cx="8" cy="12" r=".7" fill="currentColor" stroke="none"/></svg>
          Requer reiniciar o servidor para aplicar altera&ccedil;&otilde;es de porta e nome.
        </span>
      </div>

      <!-- ── Palavras Proibidas ── -->
      <div class="cfg-sec">
        <div class="cfg-sec-ttl">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 4h12M4 8h8M6 12h4"/></svg>
          Palavras Proibidas (adicionais)
        </div>
        <div class="cfg-grid-1">
          <div class="cfg-field">
            <label class="cfg-lbl" for="cfgProib">Uma por linha &mdash; adicionadas &agrave;s j&aacute; embutidas</label>
            <textarea class="cfg-inp cfg-ta" id="cfgProib" placeholder="PRODUTO EXEMPLO&#10;OUTRA MARCA&#10;ITEM ESPECIFICO"></textarea>
          </div>
        </div>
        <span class="cfg-note">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;margin-top:1px"><circle cx="8" cy="8" r="6"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5" r=".6" fill="currentColor" stroke="none"/></svg>
          Altera&ccedil;&otilde;es na lista recarregam os dados e reconstroem o filtro automaticamente.
        </span>
        <details class="cfg-details" id="cfgProibDetails">
          <summary>Ver termos embutidos (<span id="cfgProibCount">0</span> termos)</summary>
          <div class="cfg-proib-emb" id="cfgProibEmb"></div>
        </details>
      </div>

    </div><!-- /cfg-body -->

    <div class="cfg-ftr">
      <span class="cfg-status" id="cfgStatus" role="status" aria-live="polite"></span>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn btn-s btn-sm" onclick="fecharConfigs()">Cancelar</button>
        <button class="btn btn-p btn-sm" id="cfgSalvarBtn" onclick="salvarConfigs()">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><path d="M13.5 4.5l-9 9-4-4"/></svg>
          Salvar
        </button>
      </div>
    </div>

  </div>
</div>

<!-- MODO AUTOMÁTICO MODAL -->
<div class="auto-ov" id="autoOv">
  <div class="auto-bx" id="autoBx">
    <div class="auto-ttl">
      <span><svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="vertical-align:middle;margin-right:6px"><path d="M9.5 1 3 9.5h5L6.5 15 13.5 6.5H8.5z"/></svg>Modo Autom&aacute;tico</span>
      <button class="auto-close" onclick="fecharModoAuto()" title="Fechar" aria-label="Fechar"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </div>
    <div class="auto-desc">
      Cole a lista no formato abaixo e clique em <strong>Iniciar</strong>.
      O sistema ir&aacute; buscar os c&oacute;digos automaticamente.<br>
      <span style="color:var(--acc);font-family:Consolas,monospace;font-size:11px">
        Entregas:<br>139,00&nbsp;&nbsp;CREDITO<br>Gerencia:<br>177,00&nbsp;&nbsp;CREDITO<br>Rafael:<br>197,00&nbsp;&nbsp;PIX&nbsp;&nbsp;[NAO ENCONTRADO]
      </span>
      <span style="display:block;margin-top:4px;font-size:11px">
        O "[NAO ENCONTRADO]" &eacute; opcional &mdash; &uacute;til se voc&ecirc; est&aacute; colando de volta uma sa&iacute;da anterior;
        ele &eacute; sempre substitu&iacute;do pelos c&oacute;digos encontrados neste processamento.
      </span>
    </div>
    <div>
      <div class="cl" style="margin-bottom:4px">Lista de entrada</div>
      <textarea class="auto-ta" id="autoInput" placeholder="Cole aqui a lista..."></textarea>
    </div>
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;/*overflow-x:auto*/">
      <label class="tgl-wrap" id="lpToggleWrap" title="Restringe a busca apenas aos c&oacute;digos configurados, permitindo repeti-los" style="width:fit-content;flex-shrink:0">
        <input type="checkbox" id="chkListaPersonalizada" onchange="toggleListaPersonalizada()">
        <span class="tgl"></span>
        <span class="tgl-lbl" id="lpToggleLbl">Usar lista personalizada</span>
      </label>
      <button class="btn btn-s btn-sm" type="button" onclick="abrirListaPersonalizadaModal()" style="vertical-align:middle;flex-shrink:0">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><path d="M3 4.5h10M3 8h10M3 11.5h6"/></svg>Configurar lista
      </button>
      <span id="lpResumo" style="font-size:11px;color:var(--txt3);flex-shrink:0;white-space:nowrap"></span>
      <label class="tgl-wrap" id="reaproveitarToggleWrap" title="Reaproveita o mesmo c&oacute;digo em v&aacute;rias combina&ccedil;&otilde;es/linhas, respeitando o estoque m&iacute;nimo configurado. S&oacute; marca como usado quando o c&oacute;digo esgotar essa sobra (s&oacute; vale no modo padr&atilde;o, sem lista personalizada)." style="width:fit-content;flex-shrink:0">
        <input type="checkbox" id="chkReaproveitarPadrao" onchange="_salvarPrefReaproveitar()">
        <span class="tgl"></span>
        <span class="tgl-lbl">Reaproveitar c&oacute;digo</span>
      </label>
    </div>
    <div id="autoResultWrap" style="display:none">
      <div class="cl" style="margin-bottom:4px">Resultado</div>
      <textarea class="auto-ta-out" id="autoOutput" readonly></textarea>
    </div>
    <div class="auto-ftr">
      <span class="auto-status" id="autoStatus">Aguardando lista...</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-s btn-sm" id="autoCopyBtn" style="display:none" onclick="copiarResultadoAuto()"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><rect x="5" y="4" width="8" height="10" rx="1.5"/><path d="M5 6H3.5A1.5 1.5 0 0 0 2 7.5v5A1.5 1.5 0 0 0 3.5 14H8a1.5 1.5 0 0 0 1.5-1.5V11"/><path d="M7.5 4a1.5 1.5 0 0 1 3 0"/></svg>Copiar resultado</button>
        <button class="btn btn-d btn-sm" onclick="fecharModoAuto()">Fechar</button>
        <button class="btn btn-p btn-sm" id="autoIniciarBtn" onclick="iniciarModoAuto()"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><path d="M4 2.5v11l9.5-5.5z"/></svg>Iniciar</button>
      </div>
    </div>
  </div>
</div>

<!-- MODAL: LISTA PERSONALIZADA -->
<div class="auto-ov" id="lpOv">
  <div class="auto-bx" id="lpBx">
    <div class="auto-ttl">
      <span><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:6px"><path d="M3 4.5h10M3 8h10M3 11.5h6"/></svg>Lista Personalizada</span>
      <button class="auto-close" onclick="fecharListaPersonalizadaModal()" title="Fechar" aria-label="Fechar"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </div>
    <div class="auto-desc">
      Um c&oacute;digo por linha. Formato: <strong>c&oacute;digo, estoque de parada (opcional)</strong>.
      Quando o estoque do produto atingir esse n&uacute;mero, o modo autom&aacute;tico para de us&aacute;-lo.
      Sem o segundo valor, o c&oacute;digo &eacute; usado livremente.<br>
      <span style="color:var(--acc);font-family:Consolas,monospace;font-size:11px">
        Exemplo:<br>00278, 30<br>08395
      </span>
    </div>
    <div>
      <div class="cl" style="margin-bottom:4px">C&oacute;digos</div>
      <textarea class="auto-ta-lp" id="lpTextarea" style="min-height:220px" placeholder="00278, 30&#10;08395"></textarea>
      <div class="auto-lp-hint">Os c&oacute;digos podem se repetir entre e dentro das combina&ccedil;&otilde;es para fechar o valor. Na sa&iacute;da, repeti&ccedil;&otilde;es aparecem como <strong>3*c&oacute;digo</strong>.</div>
    </div>
    <div class="auto-ftr">
      <span class="auto-status" id="lpStatus"></span>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-d btn-sm" onclick="fecharListaPersonalizadaModal()">Cancelar</button>
        <button class="btn btn-p btn-sm" id="lpSalvarBtn" onclick="salvarListaPersonalizada()">Salvar lista</button>
      </div>
    </div>
  </div>
</div>

<!-- MODAL: ALERTA CONSOLIDADO — CÓDIGOS DA LISTA PERSONALIZADA ESGOTADOS -->
<!-- Substitui o antigo fluxo de confirmação um-a-um: todos os códigos que
     precisam de decisão aparecem de uma vez, cada um com nome do produto,
     o motivo do alerta e botões individuais de "Excluir"/"Deixar para
     depois", além de botões no rodapé para resolver todos de uma só vez. -->
<div class="auto-ov" id="lpAlertaOv">
  <div class="auto-bx" id="lpAlertaBx" style="max-width:560px">
    <div class="auto-ttl">
      <span><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:6px"><path d="M8 5v4M8 11.2h.01"/><path d="M7.16 2.68 1.4 12.5A1.4 1.4 0 0 0 2.6 14.6h10.8a1.4 1.4 0 0 0 1.2-2.1L8.84 2.68a1.4 1.4 0 0 0-2.42-.01"/></svg>C&oacute;digos da lista personalizada esgotados</span>
      <button class="auto-close" onclick="_lpaResolverTodos('depois')" title="Fechar (deixa todos para depois — pergunto de novo nesta sess&atilde;o at&eacute; voc&ecirc; decidir, ou na pr&oacute;xima vez que abrir o sistema)" aria-label="Fechar"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </div>
    <div class="auto-desc" id="lpAlertaCount">Os c&oacute;digos abaixo est&atilde;o na sua lista personalizada, mas cada um deles zerou, ficou negativado, foi exclu&iacute;do do banco, ficou INATIVO no sistema ou atingiu o valor de parada configurado (o motivo espec&iacute;fico est&aacute; em cada linha). Escolha, para cada um, se deseja exclu&iacute;-lo da lista ou deixar para decidir depois (volta a perguntar sobre ele a cada nova sess&atilde;o, at&eacute; voc&ecirc; decidir) — ou resolva todos de uma vez no rodap&eacute;.</div>
    <div class="lpa-lista" id="lpAlertaLista"></div>
    <div class="lpa-rodape">
      <button class="btn btn-s btn-sm" onclick="_lpaResolverTodos('depois')">Deixar todos para depois</button>
      <button class="btn btn-d btn-sm" onclick="_lpaResolverTodos('excluir')">Excluir todos</button>
    </div>
  </div>
</div>

<!-- VOLTAR AO TOPO -->
<button class="btn-top" id="btnTopo" onclick="voltarAoTopo()" title="Voltar ao topo" aria-label="Voltar ao topo">
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.5V3.5"/><path d="M3.5 8 8 3.5 12.5 8"/></svg>
</button>

<!-- TOAST -->
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<!-- ESTOQUE ENGINE — mesmo módulo importado pelos testes unitários -->
<script>
${engineSrcSeguro}
</script>

<script>
"use strict";
// ── ATENÇÃO PARA QUEM FOR EDITAR ESTE BLOCO (achado de auditoria) ────────────
// TUDO daqui até o fechamento desta tag de script vive dentro de UMA ÚNICA
// template literal do Node.js (consulta-estoque.js, função gerarHTML()) — o
// parser do Node processa escapes de barra invertida ANTES deste texto virar
// HTML/JS de verdade no navegador. Qualquer regex client-side com \\d, \\s,
// \\w, \\n etc. PRECISA da barra DUPLICADA aqui (\\\\d vira \\d depois de o
// Node processar, e só ENTÃO o navegador entende como "dígito"). Escrever a
// barra simples (\\d) faz o Node descartá-la silenciosamente — vira só "d" no
// HTML final, o regex do browser passa a significar outra coisa TOTALMENTE
// diferente, sem nenhum erro de sintaxe em lugar nenhum (nem node -c, nem
// validar-client.js pegam isso, porque o resultado ainda é um regex
// sintaticamente válido — só semanticamente errado). Ao adicionar/editar
// qualquer regex aqui: teste manualmente com um valor que dependa do escape
// (ex.: o filtro ">10"/"<10" de busca por estoque) antes de confiar que
// "parece certo no código-fonte".
var _S = ${serverCfg};

// ── Estado do cliente ────────────────────────────────────────────────────────
var _itens   = [];   // Todos os itens recebidos do servidor
var _lpEstoquesReais = Object.create(null); // {codigo: {estoque, descricao}} — dados REAIS dos códigos
                            // da lista personalizada, vindo do servidor sem o corte de
                            // maxItens/estoqueMinimo/proibidos (ver /api/itens → lpEstoquesReais).
                            // Usado por _verificarAlertasListaPersonalizada() em vez de
                            // checar presença em _itens (que é truncado/priorizado).
var _vis     = [];   // Itens visíveis após filtros
var _ldg     = false;
var _erroCli = null;
var _pollT   = null;
var _toastT  = null;
var _limiteItens    = _S.maxItens; // Limite de itens exibidos (controlado pelo select)
var _filtrarTimer   = null;        // Debounce do campo de busca
var _renderRAF      = null;        // Controle de rAF para renderTabela
var _dadosFingerprint = '';        // Fingerprint para evitar re-render sem mudança de dados
var _gruposTimer    = null;        // Async de encontrarGrupos
var _nUsadosVis     = 0;           // Contagem de usados nos itens visíveis (evita filter() extra)
var _ultimoTermosEncontrados = null; // Set de termos (busca personalizada) que bateram na última filtrar()

// ── PERFIL DE DESEMPENHO DA MÁQUINA ───────────────────────────────────────────
// Detectado UMA vez no carregamento. Serve para calibrar tamanho de lote de
// render e debounce: um PC de loja com 2 núcleos e 4 GB não pode receber a
// mesma carga que uma workstation. Toda propriedade usada aqui é opcional no
// padrão web (Safari/Firefox não expõem deviceMemory) — por isso cada leitura
// tem fallback e o resultado só "piora" o perfil quando há evidência concreta
// de hardware modesto; na ausência de dados, assume perfil normal (nunca
// degrada a experiência de quem tem máquina boa por falta de informação).
var _perfil = (function() {
    var nucleos = 0, memoria = 0;
    try { nucleos = Number(navigator.hardwareConcurrency) || 0; } catch (_) {}
    try { memoria = Number(navigator.deviceMemory)        || 0; } catch (_) {}
    var reduzirMovimento = false;
    try {
        reduzirMovimento = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {}
    // "Fraca" = evidência explícita de poucos núcleos OU pouca RAM.
    var fraca = (nucleos > 0 && nucleos <= 4) || (memoria > 0 && memoria <= 4);
    return {
        nucleos:          nucleos,
        memoria:          memoria,
        fraca:            fraca,
        reduzirMovimento: reduzirMovimento,
        // Linhas por lote de render. Lote menor = cada inserção no DOM custa
        // menos e a página responde antes; o resto entra conforme a rolagem.
        loteRender:       fraca ? 120 : 300,
        // Debounce da busca: em máquina fraca, esperar um pouco mais evita
        // disparar filtro+render no meio da digitação.
        debounceMs:       fraca ? 260 : 160
    };
})();

// ── ESTADO DA RENDERIZAÇÃO INCREMENTAL ────────────────────────────────────────
// _vis pode ter dezenas de milhares de itens, mas o DOM só recebe o que já foi
// efetivamente rolado até. _renderCursor marca quantas linhas de _vis já estão
// no DOM na renderização atual.
var _renderCursor   = 0;
var _renderObserver = null;  // IntersectionObserver da sentinela de "carregar mais"
// Objetos de geração: o engine incrementa .valor ao iniciar, caller usa o mesmo
// objeto para cancelar uma busca em andamento incrementando externamente.
var _gruposGenObj   = { valor: 0 };
var _combinarGenObj = { valor: 0 };

// ── Sort por coluna: persistido no localStorage ───────────────────────────────
// Valores válidos para _sortKey: 'estoque' | 'preco' | 'ultimaVenda'
// Valores válidos para _sortDir: 'asc' | 'desc'
// A lista de chaves aceitas é validada na leitura do localStorage: um valor
// desconhecido (versão antiga, edição manual, storage corrompido) cai no
// padrão 'estoque' em vez de deixar _sortKey inválido e a tabela sem ordem
// definida.
var _SORT_KEYS_VALIDAS = ['estoque', 'preco', 'ultimaVenda'];
var _sortKey = (function() {
    try {
        var v = localStorage.getItem('est-sort-key');
        return (_SORT_KEYS_VALIDAS.indexOf(v) !== -1) ? v : 'estoque';
    } catch(_) { return 'estoque'; }
})();
var _sortDir = (function() {
    try { var v = localStorage.getItem('est-sort-dir'); return (v === 'asc') ? 'asc' : 'desc'; } catch(_) { return 'desc'; }
})();

// ── Faixa "acima" (+R$40) — fixa ──────────────────────────────────────────────
// Antes era ampliável (+40, +80, +120...) via confirmação manual num toast.
// Agora a faixa é sempre +R$40; quando não há resultado, a busca continua
// automaticamente no restante do banco de dados (ver _buscarRestanteSeNecessario)
// em vez de pedir para ampliar a faixa de preço.
// Constantes FAIXA_COMBINAR, FAIXA_EXCEDENTE_LP, FLOAT_EPS, PRECO_SENTINEL_ZERADO
// e MAX_COMBINAR_RESULTADOS são expostas como globals pelo estoque-engine.js (UMD).
// Declaradas apenas no engine — fonte única de verdade.

// Intervalo de polling enquanto banco está carregando (ms) — exclusivo do UI
var POLL_INTERVALO_MS = 1800;

// ── Busca exaustiva no banco (substitui o antigo "ampliar +R$40") ────────────
// Geração por tipo de busca ('item' | 'grupo'): incrementar invalida qualquer
// busca anterior em andamento, evitando que um resultado tardio de uma busca
// já obsoleta (ex: usuário trocou o valor digitado) seja aplicado por engano.
var _buscaRestanteGen   = { item: 0, grupo: 0, multi: 0 };
var _buscaRestanteTimer = { item: null, grupo: null, multi: null };

// Referências DOM cacheadas em DOMContentLoaded (evita getElementById a cada keystroke)
var _elBusca = null, _elPrc = null, _elGrupar = null, _elAcima = null, _elBuscaMulti = null;

// ── Ícones SVG (definidos uma vez, reutilizados no HTML gerado dinamicamente) ─
var _icons = {
    ok:   '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:4px"><path d="M2 8.5 6 13l8-9"/></svg>',
    warn: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:4px"><path d="M8 1.5 1.5 13.5h13z"/><line x1="8" y1="6" x2="8" y2="9.5"/><circle cx="8" cy="12" r=".7" fill="currentColor" stroke="none"/></svg>',
    spin: '<svg class="spin-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="rgba(78,168,222,.18)" stroke-width="2.5"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke="var(--acc)" stroke-width="2.5" stroke-linecap="round"/></svg>',
    // Ícones de ordenação — mesmo padrão dos demais (viewBox 16x16, fill:none,
    // stroke:currentColor, pontas arredondadas, aria-hidden). Herdam a cor do
    // <th>, então acompanham automaticamente o realce de coluna ativa.
    sortAsc:    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.75 8 5.75l4 4"/></svg>',
    sortDesc:   '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.25 8 10.25l4-4"/></svg>',
    copiar:     '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5A1.5 1.5 0 0 0 9 2H4a2 2 0 0 0-2 2v5a1.5 1.5 0 0 0 1.5 1.5"/></svg>',
    fechar:     '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    sortNeutro: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.75 6.5 8 3.25l3.25 3.25"/><path d="M11.25 9.5 8 12.75 4.75 9.5"/></svg>'
};

// ── Modal confirm customizado (substitui confirm() nativo) ────────────────────
// opts.itensScroll (opcional): array de strings — quando presente, renderiza
// num bloco DEDICADO com scroll próprio (só ele rola), entre "msg" (fixo,
// sempre visível) e opts.msgApos (fixo, sempre visível, opcional). Sem
// itensScroll, comportamento igual a antes (um único bloco de texto).
function _modalConfirm(msg, onOk, onCancel, opts) {
    opts = opts || {};
    // Defensivo: se um modal anterior ainda estiver no DOM (ex: em transição de
    // saída de 220ms, ou um encadeamento rápido de confirmações), remove-o
    // imediatamente antes de criar o novo — evita dois overlays sobrepostos.
    document.querySelectorAll('.modal-ov').forEach(function(old) {
        if (old.parentNode) old.parentNode.removeChild(old);
    });
    var ov  = document.createElement('div');  ov.className  = 'modal-ov';
    var bx  = document.createElement('div');  bx.className  = 'modal-bx';
    var ttl = document.createElement('div');  ttl.className = 'modal-ttl';
    // tituloHtml permite SVG inline no título; textContent é o fallback seguro
    if (opts.tituloHtml) {
        ttl.innerHTML = opts.tituloHtml;
    } else {
        ttl.textContent = opts.titulo || 'Confirma\u00e7\u00e3o';
    }
    var txt = document.createElement('div');  txt.className = 'modal-msg';
    txt.textContent = msg;
    var ftr = document.createElement('div');  ftr.className = 'modal-ftr';
    var bNo = document.createElement('button'); bNo.className = 'btn btn-s btn-sm';
    bNo.textContent = 'Cancelar';
    var bOk = document.createElement('button'); bOk.className = opts.okClass || 'btn btn-d btn-sm';
    bOk.textContent = opts.okLabel || 'Confirmar';
    ftr.appendChild(bNo); ftr.appendChild(bOk);
    bx.appendChild(ttl); bx.appendChild(txt);
    if (opts.itensScroll && opts.itensScroll.length) {
        var lista = document.createElement('div'); lista.className = 'modal-msg-lista';
        lista.textContent = opts.itensScroll.join('\\n');
        bx.appendChild(lista);
        if (opts.msgApos) {
            var depois = document.createElement('div'); depois.className = 'modal-msg';
            depois.textContent = opts.msgApos;
            bx.appendChild(depois);
        }
    }
    bx.appendChild(ftr);
    ov.appendChild(bx);
    document.body.appendChild(ov);
    requestAnimationFrame(function() { ov.classList.add('on'); });
    function fechar() {
        ov.classList.remove('on');
        setTimeout(function() { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 220);
    }
    bNo.addEventListener('click', function() { fechar(); if (onCancel) onCancel(); }, { once: true });
    bOk.addEventListener('click', function() { fechar(); if (onOk) onOk(); }, { once: true });
    // NOTA (achado #2 da revisão 2026-07-11, revertido): {once:true} foi
    // cogitado aqui por consistência com bNo/bOk, mas é incorreto — cliques
    // DENTRO do modal borbulham até "ov", então o listener seria removido no
    // primeiro clique (mesmo sem fechar nada), quebrando "fechar ao clicar
    // fora" nos cliques seguintes. Sem once mesmo: não é vazamento real,
    // porque "ov" é descartado do DOM (não reciclado) a cada chamada.
    ov.addEventListener('click',  function(e) { if (e.target === ov) { fechar(); if (onCancel) onCancel(); } });
}

// ── Copiar texto com fallback ─────────────────────────────────────────────────
function _copiarTexto(txt, onOk) {
    function fallback() {
        var ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        try { document.execCommand('copy'); if (onOk) onOk(); }
        catch(e) { toast('N\u00e3o foi poss\u00edvel copiar.', 2500); }
        document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function() { if (onOk) onOk(); }).catch(fallback);
    } else { fallback(); }
}

// ── Copiar uma coluna inteira do resultado atual ──────────────────────────────
// Usada pelo clique nos cabeçalhos "Código" e "Cód. Barras". Genérica de
// propósito: as duas colunas se comportam igual, e duplicar a função faria
// qualquer correção futura precisar ser lembrada nos dois lugares.
//
// PONTO CRÍTICO: lê de _vis (todos os itens que passaram no filtro), NÃO do
// DOM. Desde a renderização incremental (v5.23.0) o <tbody> contém apenas o
// lote já rolado — varrer as linhas da tabela copiaria só os primeiros 120–300
// valores e o usuário não teria como perceber que faltou o resto, já que o
// número copiado pareceria plausível. _vis é a lista completa do filtro atual,
// independente de quanto foi rolado.
//
// A ordem segue exatamente a exibida na tela (mesma ordenação aplicada em
// filtrar()), então o que é colado corresponde, linha a linha, ao que se vê.
function _valoresColunaVisiveis(campo) {
    var valores = [];
    if (!_vis || !_vis.length) return valores;
    for (var i = 0; i < _vis.length; i++) {
        var v = _vis[i][campo];
        v = String(v == null ? '' : v).trim();
        // Itens sem valor são PULADOS, não viram linha em branco: nem todo
        // produto tem código de barras cadastrado, e uma linha vazia no meio
        // da colagem quebraria importação em planilha ou no ERP.
        if (v) valores.push(v);
    }
    return valores;
}

function _copiarColunaVisivel(campo, rotuloSingular, rotuloPlural) {
    if (!_vis || !_vis.length) {
        toast('Nenhum item na busca atual para copiar.', 2500);
        return;
    }
    var valores = _valoresColunaVisiveis(campo);
    if (!valores.length) {
        toast('Nenhum ' + rotuloSingular + ' preenchido nesta busca.', 2800);
        return;
    }

    // Um valor por linha. Usa quebra simples (LF) em vez de CRLF: navegadores
    // normalizam a quebra ao colar no Windows, e o retorno de carro extra
    // sujaria colagens em campos de sistemas que o tratam como caractere
    // literal. ATENCAO ao editar este bloco: por estar dentro de um template
    // literal, escrever a sequencia de escape de nova linha aqui no COMENTARIO
    // a transformaria numa quebra de verdade, partindo o comentario ao meio e
    // jogando o resto do texto como codigo.
    _copiarTexto(valores.join('\\n'), function() {
        var plural = valores.length > 1;
        var msg = valores.length + ' ' + (plural ? rotuloPlural : rotuloSingular) +
                  ' copiado' + (plural ? 's' : '') + ' para a \u00e1rea de transfer\u00eancia.';
        // Avisa quando parte dos itens ficou de fora por não ter valor
        // cadastrado — sem isso o usuário poderia achar que copiou a lista
        // toda e só descobrir a diferença depois de colar.
        var faltando = _vis.length - valores.length;
        if (faltando > 0) {
            msg += ' (' + faltando + ' item' + (faltando > 1 ? 'ns' : '') +
                   ' sem ' + rotuloSingular + ' ficou' + (faltando > 1 ? 'ram' : '') + ' de fora.)';
        }
        toast(msg, 3500);
    });
}

function copiarCodigosVisiveis() {
    _copiarColunaVisivel('codigo', 'c\u00f3digo', 'c\u00f3digos');
}

function copiarCodBarrasVisiveis() {
    _copiarColunaVisivel('codbarras', 'c\u00f3digo de barras', 'c\u00f3digos de barras');
}

// ── Marcar item único como usado (sem precisar de elemento button) ────────────
function marcarUsadoCodigo(cod) {
    if (!cod) return Promise.resolve(false);
    return apiFetch('/api/marcar-usado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo: String(cod) })
    }).then(function(r) { return !!(r && r.ok); })
      .catch(function() { return false; });
}

// ── Marcar todos os itens de um grupo como usados ─────────────────────────────
function marcarGrupoUsado(grupoItens, onDone) {
    if (!grupoItens || !grupoItens.length) { if (onDone) onDone(0); return; }
    var pendentes = grupoItens.length;
    var ok        = 0;
    grupoItens.forEach(function(it) {
        marcarUsadoCodigo(it.codigo).then(function(res) {
            if (res) ok++;
            if (--pendentes === 0) {
                if (ok > 0) carregarItens();
                if (onDone) onDone(ok);
            }
        });
    });
}

var _autoCodsParaMarcar = []; // códigos prontos para marcar após o usuário copiar o resultado

// ── Toast simples ─────────────────────────────────────────────────────────────
function fecharToast() {
    var el = document.getElementById("toast");
    if (!el) return;
    clearTimeout(_toastT);
    el.classList.remove("on");
}

function toast(msg, ms) {
    var el = document.getElementById("toast");
    if (!el) return;

    // Conteudo montado por no, nao por innerHTML: a mensagem vem de varias
    // origens (inclusive nomes de produto vindos do banco) e textContent
    // neutraliza qualquer marcacao por construcao, sem depender de escape.
    el.textContent = "";

    var span = document.createElement("span");
    span.className = "toast-msg";
    span.textContent = msg;

    var btn = document.createElement("button");
    btn.className = "toast-x";
    btn.type      = "button";
    btn.title     = "Fechar";
    btn.setAttribute("aria-label", "Fechar aviso");
    btn.innerHTML = _icons.fechar;   // SVG estatico de _icons, sem dado dinamico
    btn.onclick   = fecharToast;

    el.appendChild(span);
    el.appendChild(btn);

    el.classList.add("on");
    clearTimeout(_toastT);
    // O X nao substitui o fechamento automatico: continua sumindo sozinho no
    // tempo de sempre, e o botao apenas antecipa isso para quem nao quer
    // esperar. Passar ms = 0 desliga o auto-fechamento (fica ate o clique) -
    // util para avisos que o usuario precisa ler com calma.
    if (ms !== 0) {
        _toastT = setTimeout(function() { el.classList.remove("on"); }, ms || 2500);
    }
}

// ── Fetch helper ──────────────────────────────────────────────────────────────
// X-Requested-With injetado em TODA requisição (inclusive GET, por
// simplicidade — o servidor só exige o cabeçalho em POST /api/*, ver
// dispatcher no server). Isso faz este mesmo header sair automaticamente em
// toda chamada do app real, sem precisar lembrar de adicioná-lo em cada
// callsite — condição para a proteção anti-CSRF do servidor funcionar sem
// quebrar nenhuma chamada legítima (ver comentário no dispatcher, server-side).
function apiFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "X-Requested-With": "XMLHttpRequest" }, opts.headers || {});
    return fetch(url, opts)
        .then(function(r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        })
        .catch(function(e) {
            console.error("apiFetch erro:", url, e);
            return null;
        });
}

// ── Carregar itens do servidor ─────────────────────────────────────────────
function carregarItens() {
    _ldg = true;
    renderTabela();
    apiFetch("/api/itens").then(function(dados) {
        _ldg = false;
        if (!dados) {
            _erroCli = "Sem resposta do servidor local.";
            renderTabela();
            return;
        }
        // Banco ainda carregando → poll
        if (dados.carregando) {
            atualizarBadge(dados);
            _ldg = true;
            renderTabela();
            clearTimeout(_pollT);
            _pollT = setTimeout(carregarItens, POLL_INTERVALO_MS);
            return;
        }
        _erroCli = dados.erro || null;

        // _aplicarDadosItensFrescos() é compartilhado com o fluxo de
        // sincronização forçada do Modo Automático (ver iniciarModoAuto) —
        // mesma lógica de mapeamento, uma única fonte de verdade.
        _aplicarDadosItensFrescos(dados);

        // Estoque real (sem o corte de maxItens/estoqueMinimo) dos códigos da
        // lista personalizada — roda ANTES do fingerprint/early-return abaixo
        // porque o estoque de um código específico pode mudar (ex.: de 3 pra
        // 2 unidades) sem alterar dados.total nem usadosCount, o que faria o
        // fingerprint bater igual e pular esse processamento indevidamente.
        _verificarAlertasListaPersonalizada();

        // Fingerprint: se total, usados e limite não mudaram, dados não mudaram — evita re-render
        var usadosCount = 0;
        if (Array.isArray(dados.itens)) {
            for (var _fi = 0; _fi < dados.itens.length; _fi++) {
                if (dados.itens[_fi].usado) usadosCount++;
            }
        }
        var fp = (dados.total || 0) + '|' + usadosCount + '|' + _limiteItens;
        if (fp === _dadosFingerprint && _itens.length > 0) {
            return; // dados idênticos — nada a re-renderizar (a checagem da lista
                     // personalizada acima já rodou com os dados mais recentes)
        }
        _dadosFingerprint = fp;

        atualizarBadge(dados);
        filtrar();

        // ── Toast de aviso sobre estoque mínimo (só quando os dados mudam) ──────
        var _estMinResp = dados.estoqueMinimo != null ? dados.estoqueMinimo : _S.estoqueMinimo;
        var _nAbaixoResp = dados.itensAbaixoMin || 0;
        var _totalResp   = dados.total || 0;
        if (_estMinResp > 0) {
            if (_totalResp < _S.maxItens) {
                // Não conseguiu completar a lista mesmo com itens abaixo do mínimo
                var _msgIncompleta = 'Banco insuficiente: apenas ' + _totalResp + ' iten' +
                    (_totalResp === 1 ? '' : 's') + ' encontrado' + (_totalResp === 1 ? '' : 's') +
                    ' (estoque mínimo: ' + _estMinResp + ')';
                if (_nAbaixoResp > 0) {
                    _msgIncompleta += ' — incluindo ' + _nAbaixoResp +
                        ' abaixo do mínimo para tentar completar';
                }
                _msgIncompleta += '. Reduza o estoque mínimo nas configurações para ver mais itens.';
                toast(_msgIncompleta, 8000);
            } else if (_nAbaixoResp > 0) {
                // Completou a lista ampliando com itens abaixo do mínimo
                toast(_nAbaixoResp + ' iten' + (_nAbaixoResp === 1 ? '' : 's') +
                    ' com estoque abaixo de ' + _estMinResp + ' unid. foram incluídos' +
                    ' para completar a lista de ' + _S.maxItens + ' itens.', 6000);
            }
        }
    });
}

// ── Busca estendida (Modo Automático) ──────────────────────────────────────
// Pede ao servidor a próxima "sessão" de itens do catálogo completo (itens que
// não couberam no carregamento normal, limitado por maxItens) e funde os
// resultados em _itens — sem duplicar código já presente e sem afetar o
// _limiteItens normal da tabela principal (os itens extras só importam pro
// processamento do Modo Automático em andamento).
// achado #F da revisão 2026-08-06: o offset é informado explicitamente por
// ESTE cliente (quantos itens ele já tem em _itens) — o servidor não guarda
// mais nenhum cursor global compartilhado entre abas/PCs. Isso elimina a
// condição de corrida em que duas pessoas usando "Modo Automático" ao mesmo
// tempo avançavam o cursor uma da outra e recebiam lotes diferentes do que
// esperavam, sem nenhum aviso.
function _buscarMaisItensBanco(callback) {
    apiFetch('/api/buscar-mais-itens?offset=' + encodeURIComponent(_itens.length)).then(function(dados) {
        if (!dados || !dados.ok) { callback(false, 0, false); return; }
        var novos = Array.isArray(dados.itens) ? dados.itens : [];
        if (novos.length) {
            var _codsJaPresentes = {};
            for (var i = 0; i < _itens.length; i++) { _codsJaPresentes[_itens[i].codigo] = true; }
            novos.forEach(function(it) {
                if (_codsJaPresentes[it.codigo]) return; // já carregado — não duplica
                it._descUp = it.descricao ? it.descricao.toUpperCase()         : '';
                it._codUp  = it.codigo    ? String(it.codigo).toUpperCase()    : '';
                it._barUp  = it.codbarras ? String(it.codbarras).toUpperCase() : '';
                _itens.push(it);
            });
        }
        callback(true, novos.length, !!dados.temMais);
    }).catch(function() { callback(false, 0, false); });
}

// ── Busca exaustiva no restante do banco (filtro manual: item único e Agrupar) ─
// Substitui o antigo fluxo "ampliar para +R$40, +R$80...": em vez de pedir
// confirmação a cada +40, busca automaticamente — sessão por sessão, nunca
// repetindo — todo o restante do catálogo no banco de dados, até achar algo
// ou esgotar o catálogo por completo. Só avisa o usuário se, depois de
// esgotar TODO o banco, ainda não encontrou nada.
//
// tipo: 'item' (busca por valor único, faixa +R$40) ou 'grupo' (Modo Agrupar)
//
// Debounce de 700ms: evita disparar a busca a cada tecla digitada no campo de
// preço. A geração por tipo (_buscaRestanteGen) garante que, se o usuário
// mudar o valor ou desativar o modo antes do debounce (ou durante uma busca
// já em andamento), o resultado tardio da busca antiga é ignorado.
function _buscarRestanteSeNecessario(tipo, contexto) {
    clearTimeout(_buscaRestanteTimer[tipo]);
    var minhaGen = ++_buscaRestanteGen[tipo];
    _buscaRestanteTimer[tipo] = setTimeout(function() {
        if (minhaGen !== _buscaRestanteGen[tipo]) return; // substituída por uma busca mais nova

        if (tipo === 'multi') {
            // Revalida: a textarea ainda tem o mesmo conteúdo de quando a busca foi pedida?
            if (!buscaMultiAtiva() || !_elBuscaMulti || _elBuscaMulti.value !== contexto) return;
        } else {
            var prcAtual = _elPrc ? parseFloat(_elPrc.value) : NaN;
            // Revalida: o valor buscado e o modo ainda são os mesmos de quando a busca foi pedida?
            if (isNaN(prcAtual) || prcAtual <= 0 || Math.abs(prcAtual - contexto) > FLOAT_EPS) return;
            if (tipo === 'item'  && (!combinarAtivo()  || _vis.length > 0))  return;
            if (tipo === 'grupo' && !gruparAtivo()) return;
        }

        toast('Buscando no restante do banco de dados...', 60000);
        _buscarRestantePasso(tipo, contexto, minhaGen);
    }, 700);
}

function _esconderToastBuscando() {
    var el = document.getElementById('toast');
    if (el) el.classList.remove('on');
}

function _buscarRestantePasso(tipo, contexto, minhaGen) {
    // Revalida a cada passo (não só no disparo inicial): se o usuário desligou
    // o modo relevante (+R$40, Agrupar ou busca personalizada) enquanto a
    // busca corria, para aqui — não há mais critério válido para continuar.
    var modoDesligado = tipo === 'multi'
        ? !buscaMultiAtiva()
        : ((tipo === 'item' && !combinarAtivo()) || (tipo === 'grupo' && !gruparAtivo()));
    if (modoDesligado) {
        _esconderToastBuscando();
        return;
    }
    _buscarMaisItensBanco(function(ok, qtd, temMais) {
        if (minhaGen !== _buscaRestanteGen[tipo]) {
            _esconderToastBuscando(); // busca obsoleta (filtros limpos, etc.) — ignora resultado
            return;
        }
        if (!ok || qtd === 0) { _finalizarBuscaRestante(tipo, contexto, false); return; }
        var aoTentar = function(achou) {
            if (minhaGen !== _buscaRestanteGen[tipo]) { _esconderToastBuscando(); return; }
            if (achou) { _finalizarBuscaRestante(tipo, contexto, true); return; }
            if (!temMais) { _finalizarBuscaRestante(tipo, contexto, false); return; }
            _buscarRestantePasso(tipo, contexto, minhaGen); // ainda há mais no banco — continua
        };
        if (tipo === 'item') {
            filtrar();
            aoTentar(_vis.length > 0);
        } else if (tipo === 'grupo') {
            encontrarGruposAsync(_itens, contexto, function(grupos) {
                renderGrupos(grupos, contexto);
                aoTentar(!!(grupos && grupos.length > 0));
            }, _gruposGenObj, null, {
                estoqueMinimo:      _S.estoqueMinimo || 0,
                proibidosEmbutidos: _S.proibidosEmbutidos,
                proibidosExtra:     _S.proibidosExtra
            });
        } else {
            // multi: só "achou" quando TODOS os termos tiverem pelo menos 1 item —
            // um lote de códigos não está completo enquanto faltar algum.
            filtrar();
            aoTentar(_termosSemMatch(_termosBuscaMulti(), _itens).length === 0);
        }
    });
}

function _finalizarBuscaRestante(tipo, contexto, achou) {
    if (achou) { _esconderToastBuscando(); return; } // achou — UI já atualizada, só limpa o toast

    if (tipo === 'multi') {
        var faltantes = _termosSemMatch(_termosBuscaMulti(), _itens);
        if (!faltantes.length) { _esconderToastBuscando(); return; } // todos cobertos nesse meio-tempo
        var lista = faltantes.slice(0, 8).join(', ') +
            (faltantes.length > 8 ? ' e mais ' + (faltantes.length - 8) : '');
        toast(
            'Procurado em todo o banco de dados (' + _itens.length + ' itens) \u2014 ' +
            faltantes.length + ' termo' + (faltantes.length === 1 ? '' : 's') +
            ' n\u00e3o encontrado' + (faltantes.length === 1 ? '' : 's') + ': ' + lista,
            9000
        );
        return;
    }

    var valorFmt = contexto.toFixed(2).replace('.', ',');
    toast(
        'Procurado em todo o banco de dados (' + _itens.length + ' itens) \u2014 ' +
        (tipo === 'item'
            ? 'nenhum item encontrado na faixa de R$' + valorFmt + '.'
            : 'nenhuma combina\u00e7\u00e3o encontrada para R$' + valorFmt + '.'),
        7000
    );
}


// ── Badge de status ───────────────────────────────────────────────────────────
function atualizarBadge(dados) {
    var el = document.getElementById("badge");
    if (!el) return;
    if (dados.carregando) {
        el.innerHTML = '<span class="badge b-ld">' + _icons.spin + 'Carregando...</span>';
    } else if (dados.erro && !_itens.length) {
        el.innerHTML = '<span class="badge b-er">' + _icons.warn + 'Erro de conex\u00e3o</span>';
    } else {
        var n = dados.total || _itens.length;
        el.innerHTML = '<span class="badge b-ok">' + _icons.ok + n + ' iten' + (n === 1 ? '' : 's') + '</span>';
    }
}

// ── Lógica de faixa de preço ──────────────────────────────────────────────────
// Sem "Acima": match EXATO no valor (tolerância de 1 centavo para float)
// Com "Acima" (+R$40): intervalo [valor, valor+40] — quando vazio, busca
// automaticamente o restante do banco (ver _buscarRestanteSeNecessario)
// calcFaixa: usado apenas quando combinarAtivo()==false para filtrar a tabela
// por preço exato. No modo Combinar a tabela NÃO filtra por preço — mostra todos
// os itens; o resultado vai para o painel "Combinar", não para a tabela.
function calcFaixa(valor) {
    return { min: valor - FLOAT_EPS, max: valor + FLOAT_EPS };
}

function gruparAtivo()   { return !!(_elGrupar && _elGrupar.checked); }
function combinarAtivo() { return !!(_elAcima  && _elAcima.checked);  }

// ── Busca personalizada (múltiplos termos: códigos, produtos, códigos de barra) ─
// Alterna entre o campo de busca simples (1 termo) e a textarea de múltiplos
// termos (1 por linha, ou separados por vírgula). Os dois nunca ficam ativos
// ao mesmo tempo — só um existe visível por vez, e filtrar() lê qual está ativo.
function buscaMultiAtiva() {
    return !!(_elBuscaMulti && _elBuscaMulti.style.display !== 'none');
}
function toggleBuscaMulti() {
    var btn = document.getElementById('btnBuscaMulti');
    if (!_elBusca || !_elBuscaMulti || !btn) return;
    var vaiAtivar = !buscaMultiAtiva();
    if (vaiAtivar) {
        // Migra o termo único já digitado (se houver) pra primeira linha da textarea
        if (_elBusca.value.trim() && !_elBuscaMulti.value.trim()) {
            _elBuscaMulti.value = _elBusca.value.trim();
        }
        _elBusca.style.display      = 'none';
        _elBuscaMulti.style.display = '';
        btn.title = 'Voltar para busca simples';
        btn.setAttribute('aria-label', 'Busca simples');
        btn.classList.add('lnk-toggle-ativo');
        _elBuscaMulti.focus();
    } else {
        _elBuscaMulti.style.display = 'none';
        _elBusca.style.display      = '';
        btn.title = 'Mudar para busca personalizada (v\u00e1rios c\u00f3digos, produtos e/ou c\u00f3digos de barra de uma vez, um por linha)';
        btn.setAttribute('aria-label', 'Busca personalizada');
        btn.classList.remove('lnk-toggle-ativo');
        _elBusca.focus();
    }
    // Cancela qualquer busca exaustiva pendente do modo que está saindo de cena
    clearTimeout(_buscaRestanteTimer.multi);
    _buscaRestanteGen.multi++;
    filtrar();
}

// Extrai os termos da textarea: um por linha OU separados por vírgula,
// misturados livremente. Vazias são ignoradas; tudo em caixa alta (mesma
// convenção de _descUp/_codUp/_barUp, usados na comparação).
function _termosBuscaMulti() {
    var raw = _elBuscaMulti ? _elBuscaMulti.value : '';
    return raw.split(/[\\n,]+/)
        .map(function(t) { return t.trim().toUpperCase(); })
        .filter(function(t) { return t.length > 0; });
}




function onPrecoInput() {
    filtrar();
}

// Define texto do hint em rng/hint. O prc-hint pode truncar visualmente com
// reticências (CSS: overflow:hidden + text-overflow:ellipsis) quando o
// container não tem espaço — o atributo title garante que o texto COMPLETO
// sempre apareça no tooltip ao passar o mouse, mesmo truncado na tela.
// prc-range (valor em R$) NUNCA trunca (flex-shrink:0 no CSS) — não precisa
// de title porque já está sempre 100% visível.
function atualizarPrcBox(val) {
    var box  = document.getElementById('prcBox');
    var rng  = document.getElementById('prcRange');
    var hint = document.getElementById('prcHint');
    if (!box) return;
    if (!val || val <= 0) { box.classList.remove('vis'); return; }
    box.classList.add('vis');
    var hintTexto;
    if (combinarAtivo()) {
        if (rng) rng.textContent = 'Combinar: R$ ' + val.toFixed(2).replace('.', ',');
        hintTexto = '(at\u00e9 +R$' + FAIXA_COMBINAR.toFixed(0) + ' de toler\u00e2ncia)';
    } else {
        if (rng) rng.textContent = 'R$ ' + val.toFixed(2).replace('.', ',');
        hintTexto = gruparAtivo() ? '(combina\u00e7\u00f5es de qualquer tamanho, at\u00e9 +R$' + FAIXA_COMBINAR.toFixed(0) + ')' : '(valor exato)';
    }
    if (hint) { hint.textContent = hintTexto; hint.title = hintTexto; }
}

// Mostra o botão "Limpar filtros" só quando há algo que limparFiltros()
// realmente vai resetar: busca preenchida, preço preenchido, ou busca
// personalizada (múltiplos termos) preenchida.
function _atualizarBtnLimparFiltros(busca, temPrc, temMulti) {
    var btn = document.getElementById('btnLimparFiltros');
    if (!btn) return;
    var temFiltro = !!busca || !!temPrc || !!temMulti;
    btn.classList.toggle('vis', temFiltro);
}

// ── Filtrar ───────────────────────────────────────────────────────────────────
function filtrar() {
    var multiAtiva  = buscaMultiAtiva();
    var termosMulti = multiAtiva ? _termosBuscaMulti() : [];
    // Em modo multi, ignora o campo de busca simples mesmo que ainda tenha
    // texto antigo (ele só está escondido, não foi limpo) — evita que um
    // valor obsoleto do campo de 1 termo influencie o resultado.
    var busca = (!multiAtiva && _elBusca) ? _elBusca.value.trim() : "";
    var prcN  = _elPrc   ? parseFloat(_elPrc.value) : NaN;
    var temPrc = !isNaN(prcN) && prcN > 0;
    var fx = temPrc ? calcFaixa(prcN) : null;

    atualizarPrcBox(temPrc ? prcN : 0);
    _atualizarBtnLimparFiltros(busca, temPrc, termosMulti.length > 0);

    // ── Filtro de estoque combinado com texto ─────────────────────────────────
    // Sintaxe aceita (busca simples):
    //     >10              -> qualquer item com estoque >= 10
    //     <10              -> qualquer item com estoque <= 10
    //     nexgard>10       -> itens cuja descrição/código/barras contenha
    //                         "nexgard" E tenham estoque >= 10
    //     nexgard<10       -> o mesmo, com estoque <= 10
    //     nexgard > 10     -> espaços ao redor do operador são tolerados
    //
    // Antes as duas expressões eram ANCORADAS sozinhas (/^>(\\d+)$/), ou seja,
    // o filtro numérico só funcionava se fosse a ÚNICA coisa digitada:
    // "nexgard>10" não casava com nada e caía na busca textual literal por
    // "nexgard>10", que naturalmente não existe em nenhum produto — o
    // resultado era sempre vazio, sem explicação visível. Agora um único
    // regex captura, em qualquer combinação: texto antes (opcional, grupo 1),
    // operador (grupo 2) e o número (grupo 3).
    //
    // O texto é capturado de forma NÃO-GULOSA e o número fica ancorado no fim,
    // então uma descrição que por acaso contenha o próprio operador continua
    // sendo tratada corretamente: a divisão acontece no último "<" ou ">"
    // seguido apenas de número até o fim da string.
    //
    // (só faz sentido na busca simples — em modo multi cada linha é um termo
    // literal de código/produto/barras, não uma expressão de comparação)
    var estoqueMin = null;
    var estoqueMax = null;
    var buscaTexto = busca;
    var mEst = busca.match(/^(.*?)\\s*([<>])\\s*(\\d+(?:[.,]\\d*)?)\\s*$/);
    if (mEst) {
        var valorEstoque = parseFloat(mEst[3].replace(',', '.'));
        // Number.isFinite protege contra entradas degeneradas que o regex
        // aceita mas parseFloat não resolve (ex.: "5," -> NaN). Sem essa
        // checagem, um NaN aqui faria TODA comparação de estoque retornar
        // false e a tabela apareceria vazia sem motivo aparente.
        if (Number.isFinite(valorEstoque)) {
            if (mEst[2] === '>') estoqueMin = valorEstoque;
            else                 estoqueMax = valorEstoque;
            buscaTexto = mEst[1];   // texto antes do operador (pode ser vazio)
        }
    }
    var buscaUpper = buscaTexto.toUpperCase();

    // Coleta quais termos bateram em pelo menos 1 item DURANTE o filtro
    // principal (não num segundo passe sobre _itens) — evita duplicar o custo
    // O(itens × termos) que existiria se filtrássemos e depois chamássemos
    // _termosSemMatch separadamente.
    var termosEncontrados = multiAtiva ? new Set() : null;

    // Conta usados em uma única passagem (evita filter() adicional em renderTabela)
    var _tmpUsados = 0;
    _vis = _itens.filter(function(it) {
        // Filtro de estoque por faixa
        if (estoqueMin !== null && Number(it.estoque) < estoqueMin) return false;
        if (estoqueMax !== null && Number(it.estoque) > estoqueMax) return false;

        // Filtro de texto: busca personalizada (união de termos) OU busca simples
        if (multiAtiva) {
            if (termosMulti.length) {
                var bateu = false;
                for (var ti = 0; ti < termosMulti.length; ti++) {
                    var t = termosMulti[ti];
                    if (it._descUp.indexOf(t) !== -1 || it._codUp.indexOf(t) !== -1 || it._barUp.indexOf(t) !== -1) {
                        termosEncontrados.add(t);
                        bateu = true;
                    }
                }
                if (!bateu) return false;
            }
        } else if (buscaUpper) {
            var matchDesc = it._descUp.indexOf(buscaUpper) !== -1;
            var matchCod  = it._codUp.indexOf(buscaUpper)  !== -1;
            var matchBar  = it._barUp.indexOf(buscaUpper)  !== -1;
            if (!matchDesc && !matchCod && !matchBar) return false;
        }

        var p = Number(it.preco || 0);
        if (p === PRECO_SENTINEL_ZERADO) return false;
        // No modo Combinar, a tabela não filtra por preço — o preço é usado
        // pelo painel Combinar. No modo exato (sem Combinar), filtra normalmente.
        if (temPrc && !combinarAtivo()) {
            if (p <= 0) return false;
            if (p < fx.min || p > fx.max) return false;
        }
        if (it.usado) _tmpUsados++;
        return true;
    });
    _nUsadosVis = _tmpUsados; // salva para renderTabela sem re-iterar _vis
    _ultimoTermosEncontrados = termosEncontrados; // reuso por quem decide estender a busca (evita re-varredura)

    // ── Ordenação ─────────────────────────────────────────────────────────────
    // No modo Combinar, a tabela mostra todos os itens (sem filtrar por preço
    // — o preço vai pro painel Combinar). Ordenação padrão por coluna.
    _vis.sort(function(a, b) {
        if (a.usado !== b.usado) return (a.usado ? 1 : 0) - (b.usado ? 1 : 0);
        var va = _chaveOrdenacao(a);
        var vb = _chaveOrdenacao(b);
        // Comparação por tipo: data vem como string ISO (comparável
        // lexicograficamente), estoque/preço vêm como número. Subtrair strings
        // daria NaN e deixaria a ordem indefinida — por isso o ramo explícito.
        var cmp = (typeof va === 'string')
            ? (va < vb ? -1 : (va > vb ? 1 : 0))
            : (va - vb);
        return _sortDir === 'desc' ? -cmp : cmp;
    });

    // Agenda renderTabela via requestAnimationFrame — nunca bloqueia o frame atual
    if (_renderRAF) cancelAnimationFrame(_renderRAF);
    _renderRAF = requestAnimationFrame(function() {
        _renderRAF = null;
        renderTabela();

        // ── Busca personalizada: algum termo ainda sem nenhum item correspondente? ──
        if (multiAtiva && termosMulti.length && _diffTermosFaltantes(termosMulti, _ultimoTermosEncontrados).length > 0) {
            _buscarRestanteSeNecessario('multi', _elBuscaMulti.value);
        }
        // ── Toast informativo: busca de texto sem resultado com agrupar ativo ──
        else if (buscaUpper && _vis.length === 0 && gruparAtivo()) {
            toast('Nenhum item encontrado para "' + buscaTexto + '" no modo Agrupar.', 3500);
        }
    });

    // ── Agrupar (itens distintos, pares e triplas) ─────────────────────────────
    // Respeita sempre: estoque mínimo configurado, tolerância +R$40 e itens
    // proibidos. Algoritmo restaurado da versão comprovadamente estável —
    // ver estoque-engine.js v1.3.0 para detalhes.
    clearTimeout(_gruposTimer);
    var gWrap = document.getElementById("gruposWrap");
    if (gruparAtivo() && temPrc) {
        _gruposTimer = setTimeout(function() {
            encontrarGruposAsync(_itens, prcN, function(grupos) {
                renderGrupos(grupos, prcN);
                if ((!grupos || grupos.length === 0) && gruparAtivo()) {
                    _buscarRestanteSeNecessario('grupo', prcN);
                }
            }, _gruposGenObj, null, {
                estoqueMinimo:      _S.estoqueMinimo || 0,
                proibidosEmbutidos: _S.proibidosEmbutidos,
                proibidosExtra:     _S.proibidosExtra
            });
        }, 0);
    } else if (gWrap) {
        gWrap.style.display = "none";
    }

    // ── Combinar (qtd×item com repetição, marcação via botão + confirmação) ───
    clearTimeout(_combinarTimer);
    var cWrap = document.getElementById("combinarWrap");
    if (combinarAtivo() && temPrc) {
        if (cWrap) cWrap.style.display = 'block';
        _combinarTimer = setTimeout(function() {
            var statusEl = document.getElementById('combinarStatus');
            encontrarCombinacoesComRepeticaoAsync(_itens, prcN, function(combos) {
                renderCombinar(combos, prcN);
            }, {
                estoqueMinimo: _S.estoqueMinimo || 0,
                gen: _combinarGenObj,
                onStatus: function(msg) { if (statusEl) statusEl.textContent = msg; }
            });
        }, 0);
    } else if (cWrap) {
        cWrap.style.display = "none";
        _combinarGenObj.valor++; // cancela qualquer cálculo em andamento ao desligar
    }
}

// ── Marcar item como usado (via data-attribute para evitar escaping de onclick) ─
// ── Verificação de estoque mínimo antes de "Usar" ────────────────────────────
// Verifica se algum dos itens está abaixo do estoqueMinimo configurado.
// • Se não houver problema → chama onOk() imediatamente.
// • Se houver → exibe modal de aviso (⚠) com lista dos itens e estoque de cada um.
//   Continuar: chama onOk()  |  Cancelar: restaura btnEl ao estado original.
// Parâmetros:
//   itens   : array de objetos item (precisa de .estoque, .descricao, .codigo)
//   onOk    : callback a chamar quando o usuário confirmar ou não houver problema
//   btnEl   : (opcional) botão que disparou a ação — desativado enquanto modal está aberto
function _usarComVerificacao(itens, onOk, btnEl) {
    var min = _S.estoqueMinimo != null ? Number(_S.estoqueMinimo) : 0;
    if (!min || min <= 0 || !itens || !itens.length) { onOk(); return; }

    var abaixo = [];
    for (var _vi = 0; _vi < itens.length; _vi++) {
        if (Number(itens[_vi].estoque || 0) < min) abaixo.push(itens[_vi]);
    }
    if (!abaixo.length) { onOk(); return; }

    // Monta mensagem listando cada item abaixo do mínimo
    var linhas = abaixo.map(function(it) {
        return '\u2022 ' + (it.descricao || it.codigo) +
               ' \u2014 ' + Number(it.estoque || 0) + ' unid. em estoque';
    });
    var msg = (abaixo.length === 1
            ? 'Este item est\u00e1 com estoque abaixo do m\u00ednimo:'
            : 'Os seguintes itens est\u00e3o com estoque abaixo do m\u00ednimo:')
        + '\\n' + linhas.join('\\n')
        + '\\n\\nM\\u00ednimo configurado: ' + min + ' unid.'
        + '\\n\\nDeseja continuar mesmo assim?';

    // Desativa o botão imediatamente (evita clique duplo durante o modal)
    var origText = btnEl ? btnEl.textContent : '';
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '...'; }

    _modalConfirm(msg,
        function() { onOk(); },
        function() {
            // Cancelar: restaura o botão ao estado original
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = origText; }
        },
        {
            tituloHtml: _icons.warn + ' Estoque abaixo do m\u00ednimo',
            okLabel: 'Continuar',
            okClass: 'btn btn-w btn-sm'
        }
    );
}

// Executa a marcação de um único item como usado (chamado após passar pela verificação)
function _executarMarcarUsado(el, cod) {
    el.disabled    = true;
    el.textContent = '...';
    _copiarTexto(cod, function() {
        toast('\u2713 C\u00f3digo ' + cod + ' copiado!', 1800);
    });
    apiFetch("/api/marcar-usado", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ codigo: cod })
    }).then(function(r) {
        if (!r || !r.ok) {
            el.disabled    = false;
            el.textContent = "Usar";
            toast("Falha ao registrar.", 2000);
            return;
        }
        toast("\u2713 " + cod + " \u2014 movido para a fila de usados.", 2400);
        for (var _i = 0; _i < _itens.length; _i++) {
            if (_itens[_i].codigo === cod) { _itens[_i].usado = true; break; }
        }
        _itens.sort(function(a, b) { return (a.usado ? 1 : 0) - (b.usado ? 1 : 0); });
        _dadosFingerprint = '';
        filtrar();
    });
}

function marcarUsadoBtn(el) {
    var cod = el ? el.getAttribute("data-cod") : null;
    if (!cod) return;
    // Localiza o item para checar o estoque antes de prosseguir
    var item = null;
    for (var _fi = 0; _fi < _itens.length; _fi++) {
        if (_itens[_fi].codigo === cod) { item = _itens[_fi]; break; }
    }
    _usarComVerificacao(item ? [item] : [], function() {
        _executarMarcarUsado(el, cod);
    }, el);
}

// ── Resetar usados ────────────────────────────────────────────────────────────
function resetarUsados() {
    _modalConfirm(
        'Limpar todos os itens marcados como usados?\\nTodos voltam para o in\u00edcio da fila.',
        function() {
            apiFetch('/api/resetar-usados', { method: 'POST' }).then(function(r) {
                if (!r || !r.ok) { toast('Falha ao resetar.', 2000); return; }
                toast('Fila de usados limpa!', 2200);
                carregarItens();
            });
        }
    );
}

// ── Atualizar banco ───────────────────────────────────────────────────────────
function atualizarBanco() {
    var btn = document.getElementById("btnAtual");
    if (btn) btn.disabled = true;
    toast("Recarregando dados do banco...", 3500);
    apiFetch("/api/atualizar", { method: "POST" }).then(function(r) {
        if (!r || !r.ok) {
            toast("Falha ao solicitar atualizacao.", 2500);
            if (btn) btn.disabled = false;
            return;
        }
        clearTimeout(_pollT);
        _pollT = setTimeout(function() {
            _itens = [];
            _vis   = [];
            carregarItens();
            if (btn) btn.disabled = false;
        }, 1500);
    });
}

// ── Limpar filtros ────────────────────────────────────────────────────────────
function limparFiltros() {
    var b  = document.getElementById("txtBusca");
    var bm = document.getElementById("txtBuscaMulti");
    var p  = document.getElementById("numPrc");
    var x  = document.getElementById("prcBox");
    if (b)  b.value  = "";
    if (bm) bm.value = "";
    if (p) p.value = "";
    if (x) x.classList.remove("vis");
    // Cancela qualquer busca exaustiva pendente/em andamento (item, grupo ou multi)
    clearTimeout(_buscaRestanteTimer.item);
    clearTimeout(_buscaRestanteTimer.grupo);
    clearTimeout(_buscaRestanteTimer.multi);
    _buscaRestanteGen.item++;
    _buscaRestanteGen.grupo++;
    _buscaRestanteGen.multi++;
    filtrar();
}

// ── Toggle de ordenação por coluna ────────────────────────────────────────────
// Chamado pelo onclick dos TH de Estoque e Preço.
// • Mesma coluna → inverte direção (asc ↔ desc)
// • Outra coluna → muda coluna, direção padrão: estoque=desc, preço=asc
// ── Chave de ordenação de um item ─────────────────────────────────────────────
// Fonte única da verdade sobre COMO cada coluna ordena. Retorna número para
// colunas numéricas e string ISO para data — quem compara decide o operador
// (ver o sort em filtrar()).
//
// Itens nunca vendidos (ultimaVenda null/vazio) viram string vazia, que é
// menor que qualquer data ISO. Efeito prático, e é intencional:
//   - "mais recente primeiro" (desc) -> nunca vendidos aparecem por último;
//   - "mais antigo primeiro"  (asc)  -> nunca vendidos aparecem primeiro.
// Faz sentido nos dois casos: um item sem venda nenhuma é o extremo do
// "parado há mais tempo", que é justamente o que se procura ao ordenar por
// data crescente.
function _chaveOrdenacao(item) {
    if (_sortKey === 'preco')       return Number(item.preco || 0);
    if (_sortKey === 'ultimaVenda') return String(item.ultimaVenda || ''); // ISO YYYY-MM-DD: ordem lexicográfica == cronológica
    return Number(item.estoque || 0);
}

function toggleSort(key) {
    if (!key) return;
    if (_sortKey === key) {
        _sortDir = (_sortDir === 'desc') ? 'asc' : 'desc';
    } else {
        _sortKey = key;
        // Direção inicial por coluna, escolhida pelo que é útil ver primeiro:
        // preço -> ascendente (mais barato primeiro); estoque e última venda
        // -> descendente (maior estoque / venda mais recente primeiro).
        _sortDir = (key === 'preco') ? 'asc' : 'desc';
    }
    try {
        localStorage.setItem('est-sort-key', _sortKey);
        localStorage.setItem('est-sort-dir', _sortDir);
    } catch(_) {}
    // Atualiza label no header
    _atualizarHdrSortLabel();
    // Força re-render (fingerprint zerado para não pular a renderização)
    _dadosFingerprint = '';
    filtrar();
}

// Atualiza o texto "Ordenando por X ▼/▲" no hdr-sub
function _atualizarHdrSortLabel() {
    var el = document.getElementById('hdrSortLabel');
    if (!el) return;
    var nome = (_sortKey === 'preco')       ? 'Pre\u00e7o'
             : (_sortKey === 'ultimaVenda') ? '\u00dalt. Venda'
             : 'Estoque';
    var ico  = (_sortDir === 'desc') ? ' \u25bc' : ' \u25b2';
    el.textContent = nome + ico;
}

// ── Debounce para o campo de busca (evita filtrar() a cada tecla) ─────────────
// Debounce adaptativo: máquina fraca espera um pouco mais entre teclas, para
// não gastar CPU filtrando resultados intermediários que o usuário nem chegou a
// ver. Em máquina normal continua nos 160 ms de antes.
function filtrarDebounced() {
    clearTimeout(_filtrarTimer);
    _filtrarTimer = setTimeout(filtrar, _perfil.debounceMs);
}

// Gera e injeta 5 opções distribuídas em [max/5 … max] no select "selLimite".
// Algoritmo:
//   step = max / 5  →  arredonda para múltiplo de potência de 10 (mín. 10)
//   opções 1-4 = step×1 … step×4 (arredondadas, sem duplicatas e < max)
//   opção 5    = max (sempre exato)
// Seleciona automaticamente a maior opção ≤ _limiteItens atual.
function _atualizarSelLimite(max) {
    var sel = document.getElementById('selLimite');
    if (!sel || !max || max < 1) return;

    var rawStep = max / 5;
    // Magnitude de arredondamento: potência de 10 um nível abaixo do step (mín. 10)
    var logStep = Math.floor(Math.log10(Math.max(rawStep, 1)) - 0.5);
    var mag     = Math.pow(10, logStep < 1 ? 1 : logStep); // mínimo 10

    var opts = [];
    for (var i = 1; i <= 4; i++) {
        var v = Math.round(Math.round(rawStep * i) / mag) * mag;
        v = Math.min(Math.max(v, 1), max - 1); // garante sempre < max (evita duplicata com último)
        if (!opts.length || opts[opts.length - 1] !== v) opts.push(v);
    }
    opts.push(max); // quinta opção: máximo exato sempre presente

    // Reconstrói as <option>
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    var curLimite   = (typeof _limiteItens !== 'undefined' && _limiteItens > 0) ? _limiteItens : max;
    var selecionado = opts[opts.length - 1]; // fallback: última (maior)
    for (var j = 0; j < opts.length; j++) {
        var opt         = document.createElement('option');
        opt.value       = String(opts[j]);
        opt.textContent = String(opts[j]);
        sel.appendChild(opt);
        // Seleciona a maior opção que não supere o limite atual
        if (opts[j] <= curLimite) selecionado = opts[j];
    }
    sel.value    = String(selecionado);
    _limiteItens = selecionado;
}

function aplicarLimite() {
    var sel = document.getElementById('selLimite');
    var val = sel ? parseInt(sel.value, 10) : _S.maxItens;
    if (!val || val < 1) val = _S.maxItens;
    if (val > _S.maxItens) val = _S.maxItens;
    _limiteItens      = val;
    _dadosFingerprint = ''; // força re-render com novo limite
    carregarItens();
}

// ── Formatadores ──────────────────────────────────────────────────────────────
// ── Texto plano sem HTML para uso em textContent ──────────────────────────────
function fmtBRLt(v) {
    var n = Number(v || 0);
    return 'R$ ' + Math.abs(n).toFixed(2).replace('.',',');
}


// ── Modo Combinar (qtd×item) ──────────────────────────────────────────────────
var _combinarTimer = null;


function renderCombinar(combos, valor, usosSimulados) {
    var wrap  = document.getElementById('combinarWrap');
    var grid  = document.getElementById('combinarGrid');
    var label = document.getElementById('combinarValorLabel');
    if (!wrap || !grid) return;
    if (label) label.textContent = 'R$ ' + valor.toFixed(2).replace('.', ',');
    wrap.style.display = 'block';
    while (grid.firstChild) grid.removeChild(grid.firstChild);

    if (!combos || !combos.length) {
        var vazio = document.createElement('div');
        vazio.className = 'grp-vazio';
        vazio.textContent = 'Nenhuma combina\u00e7\u00e3o encontrada.';
        grid.appendChild(vazio);
        return;
    }

    combos.forEach(function(combo, idx) {
        var diff = +((combo.soma || 0) - valor).toFixed(2);
        var card = document.createElement('div');
        card.className = 'grp-card';

        // Agrupa itens repetidos em linhas de "Nx descricao"
        var contagemPorCod = {};
        var ordem = [];
        combo.itens.forEach(function(it) {
            if (!contagemPorCod[it.codigo]) { contagemPorCod[it.codigo] = { it: it, qtd: 0 }; ordem.push(it.codigo); }
            contagemPorCod[it.codigo].qtd++;
        });

        ordem.forEach(function(cod) {
            var c = contagemPorCod[cod];
            var row = document.createElement('div');
            row.className = 'grp-card-item';

            var qtdEl = document.createElement('span');
            qtdEl.style.cssText = 'color:var(--acc);font-weight:700;min-width:24px;flex-shrink:0';
            qtdEl.textContent = c.qtd + '\u00d7';

            var codEl = document.createElement('span');
            codEl.className = 'grp-cod';
            codEl.textContent = cod;

            var nm = document.createElement('span');
            nm.className = 'nm';
            nm.title = c.it.descricao;
            nm.textContent = c.it.descricao;

            var barEl = document.createElement('span');
            barEl.className = 'grp-bar';
            barEl.textContent = c.it.codbarras || '-';

            var pvEl = document.createElement('span');
            pvEl.className = 'pv';
            pvEl.textContent = fmtBRLt(c.it.preco);

            row.appendChild(qtdEl);
            row.appendChild(codEl);
            row.appendChild(nm);
            row.appendChild(barEl);
            row.appendChild(pvEl);
            card.appendChild(row);
        });

        var foot = document.createElement('div');
        foot.className = 'grp-total';

        var lblEl = document.createElement('span');
        lblEl.className = 'lbl';
        lblEl.textContent = combo.itens.length + (combo.itens.length === 1 ? ' item' : ' itens');

        var rhs = document.createElement('span');
        rhs.style.cssText = 'display:flex;align-items:center;gap:8px';

        var valEl = document.createElement('span');
        valEl.className = 'val';
        valEl.textContent = fmtBRLt(combo.soma);
        rhs.appendChild(valEl);

        if (diff !== 0) {
            var diffEl = document.createElement('span');
            diffEl.className = diff > 0 ? 'diff-pos' : 'diff-neg';
            diffEl.textContent = (diff > 0 ? '+' : '-') + fmtBRLt(Math.abs(diff));
            rhs.appendChild(diffEl);
        }

        // Botão "Usar" — requer confirmação antes de marcar como usado
        var usarBtn = document.createElement('button');
        usarBtn.className = 'btn btn-usar btn-sm';
        usarBtn.textContent = 'Usar (' + (idx + 1) + ')';
        usarBtn.title = 'Confirmar e marcar itens como usados';

        (function(itensCombo, usarBtnRef) {
            usarBtnRef.addEventListener('click', function() {
                // Lista o que vai ser marcado (com quantidade)
                var linhasCod = ordem.map(function(cod) {
                    var c = contagemPorCod[cod];
                    return c.qtd + '\u00d7 ' + cod + ' (' + c.it.descricao + ')';
                });
                _modalConfirm(
                    'Confirmar uso dos seguintes itens?\\n\\n' + linhasCod.join('\\n') +
                    '\\n\\nTotal: ' + fmtBRLt(combo.soma),
                    function() {
                        _usarComVerificacao(itensCombo, function() {
                            marcarGrupoUsado(itensCombo, function(n) {
                                var codsTexto = ordem.map(function(cod) {
                                    return contagemPorCod[cod].qtd + '\u00d7' + cod;
                                }).join(' ');
                                _copiarTexto(codsTexto, function() {});
                                toast('\u2713 ' + n + ' item' + (n === 1 ? '' : 's') +
                                    ' marcado' + (n === 1 ? '' : 's') + ' como usado' + (n === 1 ? '' : 's') + '!', 3000);
                                // Re-executa a busca de combinações com o pool atualizado
                                filtrar();
                            });
                        }, usarBtnRef);
                    },
                    null,
                    { titulo: 'Usar combina\u00e7\u00e3o', okLabel: 'Confirmar uso', okClass: 'btn btn-usar btn-sm' }
                );
            });
        })(combo.itens, usarBtn);

        rhs.appendChild(usarBtn);
        foot.appendChild(lblEl);
        foot.appendChild(rhs);
        card.appendChild(foot);
        grid.appendChild(card);
    });
}

// ── Renderizar grupos — via DOM (sem innerHTML complexo) ──────────────────────
function renderGrupos(grupos, valor) {
    var wrap  = document.getElementById('gruposWrap');
    var grid  = document.getElementById('gruposGrid');
    var label = document.getElementById('grpValorLabel');
    if (!wrap || !grid) return;
    if (label) label.textContent = 'R$ ' + valor.toFixed(2).replace('.',',');
    wrap.style.display = 'block';
    while (grid.firstChild) grid.removeChild(grid.firstChild);

    if (!grupos || !grupos.length) {
        var vazio = document.createElement('div');
        vazio.className = 'grp-vazio';
        vazio.textContent = 'Nenhuma combina\u00e7\u00e3o encontrada.';
        grid.appendChild(vazio);
        return;
    }

    for (var g = 0; g < grupos.length; g++) {
        var gr   = grupos[g];
        var diff = +(gr.soma - valor).toFixed(2);
        var card = document.createElement('div');
        card.className = 'grp-card';

        for (var k = 0; k < gr.itens.length; k++) {
            var it  = gr.itens[k];
            var row = document.createElement('div');
            row.className = 'grp-card-item';

            var codEl = document.createElement('span');
            codEl.className = 'grp-cod';
            codEl.textContent = it.codigo || '-';

            var nm = document.createElement('span');
            nm.className = 'nm';
            nm.title = it.descricao;
            nm.textContent = it.descricao;

            var barEl = document.createElement('span');
            barEl.className = 'grp-bar';
            barEl.textContent = it.codbarras || '-';

            var pv = document.createElement('span');
            pv.className = 'pv';
            pv.textContent = fmtBRLt(it.preco);

            row.appendChild(codEl);
            row.appendChild(nm);
            row.appendChild(barEl);
            row.appendChild(pv);
            card.appendChild(row);
        }

        var foot = document.createElement('div');
        foot.className = 'grp-total';

        var lblEl = document.createElement('span');
        lblEl.className = 'lbl';
        lblEl.textContent = gr.itens.length + (gr.itens.length === 1 ? ' item' : ' itens');

        var rhs = document.createElement('span');
        rhs.style.cssText = 'display:flex;align-items:center;gap:8px';

        var valEl = document.createElement('span');
        valEl.className = 'val';
        valEl.textContent = fmtBRLt(gr.soma);
        rhs.appendChild(valEl);

        if (diff !== 0) {
            var diffEl = document.createElement('span');
            diffEl.className = diff > 0 ? 'diff-pos' : 'diff-neg';
            diffEl.textContent = (diff > 0 ? '+' : '-') + fmtBRLt(Math.abs(diff));
            rhs.appendChild(diffEl);
        }

        var usarBtn = document.createElement('button');
        usarBtn.className = 'btn btn-s btn-sm';
        usarBtn.textContent = 'C\u00f3d.';
        usarBtn.title = 'Copiar c\u00f3digos e marcar como usados';

        var tudoBtn = document.createElement('button');
        tudoBtn.className = 'btn btn-usar btn-sm';
        tudoBtn.textContent = 'Tudo';
        tudoBtn.title = 'Copiar informa\u00e7\u00f5es completas e marcar como usados';

        (function(itens) {
            usarBtn.addEventListener('click', function() {
                _usarComVerificacao(itens, function() {
                    var txt = itens.map(function(it) { return it.codigo || '-'; }).join(' ');
                    _copiarTexto(txt, function() {
                        marcarGrupoUsado(itens, function(n) {
                            toast('\u2713 C\u00f3digos copiados! ' + n + ' item' + (n===1?'':'s') +
                                  ' marcado' + (n===1?'':'s') + ' como usado' + (n===1?'':'s') + '.', 3200);
                        });
                    });
                }, usarBtn);
            });
            tudoBtn.addEventListener('click', function() {
                _usarComVerificacao(itens, function() {
                    var linhas = itens.map(function(it) {
                        return 'COD:' + (it.codigo||'-') +
                               ' | EAN:' + (it.codbarras||'-') +
                               ' | ' + it.descricao +
                               ' | ' + fmtBRLt(it.preco);
                    });
                    _copiarTexto(linhas.join('\\n'), function() {
                        marcarGrupoUsado(itens, function(n) {
                            toast('\u2713 Informa\u00e7\u00f5es copiadas! ' + n + ' item' + (n===1?'':'s') +
                                  ' marcado' + (n===1?'':'s') + ' como usado' + (n===1?'':'s') + '.', 3200);
                        });
                    });
                }, tudoBtn);
            });
        })(gr.itens);
        rhs.appendChild(usarBtn);
        rhs.appendChild(tudoBtn);

        foot.appendChild(lblEl);
        foot.appendChild(rhs);
        card.appendChild(foot);
        grid.appendChild(card);
    }
}


function fmtBRL(v) {
    var n = Number(v || 0);
    if (!isFinite(n) || n <= 0) return "<span style='color:var(--txt3)'>-</span>";
    return "R$\u00a0" + n.toFixed(2).replace(".", ",");
}

function fmtEst(v) {
    var n = Number(v || 0);
    if (!isFinite(n)) return "0";
    var r = Math.round(n);
    return Math.abs(n - r) < 0.001 ? String(r) : n.toFixed(2).replace(".", ",");
}

function fmtData(iso) {
    if (!iso) return "<span style='color:var(--txt3)'>-</span>";
    var m = String(iso).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
    return m ? m[3] + "/" + m[2] + "/" + m[1] : String(iso);
}

// NOTA: idêntica a _normalizarCodigoNumerico() (servidor, topo do arquivo) —
// mesmo motivo de esc()/escH() acima: dois runtimes (Node vs browser) sem
// bundler entre eles. Resolve o mesmo problema aqui do lado do cliente: o
// Modo Automático com lista personalizada precisa casar o código digitado
// (ex.: "04567") contra o código que vem de _itens (ex.: "4567", se a
// coluna do banco for numérica e tiver perdido o zero à esquerda no CAST).
function _normalizarCodigoNumericoCliente(codigo) {
    var s = String(codigo == null ? '' : codigo).trim();
    if (!/^\\d+$/.test(s)) return null;
    var semZeros = s.replace(/^0+/, '');
    return semZeros === '' ? '0' : semZeros;
}

// NOTA: idêntica a _codigoPadrao5Digitos() (servidor) — mesmo motivo de
// esc()/escH() acima. Regra de negócio confirmada: todo código deste
// catálogo tem exatamente 5 dígitos (ex.: 7403 -> 07403, 8883 -> 08883).
function _codigoPadrao5DigitosCliente(codigo) {
    var s = String(codigo == null ? '' : codigo).trim();
    if (!/^\\d+$/.test(s)) return null;
    if (s.length >= 5) return s;
    var zeros = '';
    for (var _z = 0; _z < 5 - s.length; _z++) zeros += '0';
    return zeros + s;
}

// NOTA (achado #1 da revisão 2026-07-11): idêntica a escH() (topo do arquivo,
// server-side). Ver comentário lá para o porquê de existirem duas cópias.
function esc(s) {
    return String(s == null ? "" : s)
        .replace(/&/g,  "&amp;")
        .replace(/</g,  "&lt;")
        .replace(/>/g,  "&gt;")
        .replace(/"/g,  "&quot;")
        .replace(/'/g,  "&#39;");
}

// ── Renderizar tabela ─────────────────────────────────────────────────────────
function renderTabela() {
    var tw    = document.getElementById("tw");
    var stats = document.getElementById("stats");
    if (!tw) return;

    // Desarma a sentinela do render ANTERIOR logo na entrada. renderTabela tem
    // vários caminhos de saída antecipada (carregando / erro / lista vazia /
    // sem resultados de filtro) e todos substituem o conteúdo de #tw — sem
    // este desligamento, cada um deles deixaria para trás um IntersectionObserver
    // apontando para um nó que não existe mais. Um por filtro digitado, para
    // sempre. Desarmar aqui cobre todos os caminhos de uma vez.
    _desarmarSentinela();
    _renderCursor = 0;

    // Carregando
    if (_ldg && !_itens.length) {
        tw.innerHTML = '<div class="msg"><p>' + _icons.spin + 'Conectando ao banco de dados...</p></div>';
        if (stats) stats.innerHTML = "Aguardando...";
        return;
    }

    // Erro sem dados
    if (_erroCli && !_itens.length) {
        tw.innerHTML =
            '<div class="msg msg-er">' +
            '<h3>' + _icons.warn + 'Falha de conex\u00e3o</h3>' +
            '<p>' + esc(_erroCli) + '</p>' +
            '<p style="margin-top:12px;font-size:12px">Verifique se o Firebird est\u00e1 rodando<br>e se o arquivo SMALL.FDB est\u00e1 acess\u00edvel.</p>' +
            '</div>';
        if (stats) stats.innerHTML = '<span style="color:#ef9a9a">Erro ao carregar</span>';
        return;
    }

    // Sem itens no banco
    if (!_itens.length) {
        tw.innerHTML =
            '<div class="msg">' +
            '<h3>Nenhum item encontrado</h3>' +
            '<p>N\u00e3o h\u00e1 itens com estoque positivo fora da lista de proibidos.</p></div>';
        if (stats) stats.innerHTML = "0 itens";
        return;
    }

    // Calcular faixa de preço (para stats)
    var prcEl  = document.getElementById("numPrc");
    var prcN   = prcEl ? parseFloat(prcEl.value) : NaN;
    var temPrc = !isNaN(prcN) && prcN > 0;
    var fx     = temPrc ? calcFaixa(prcN) : null;

    // Stats
    var nVis = _vis.length;
    var nUso = _nUsadosVis; // já calculado em filtrar() — sem filter() extra sobre _vis
    if (stats) {
        var s = "<strong>" + nVis + "</strong> iten" + (nVis === 1 ? "" : "s") + " vis\u00edv" + (nVis === 1 ? "el" : "eis");
        s += " &nbsp;&bull;&nbsp; <strong>" + _itens.length + "</strong> no banco";
        if (nUso > 0) {
            s += ' &nbsp;&bull;&nbsp; <span style="color:var(--uso-txt)">' + nUso + ' usados</span>';
        }
        if (temPrc) {
            if (combinarAtivo()) {
                s += ' &nbsp;&bull;&nbsp; <span style="color:var(--grn)">Combinar R$' + prcN.toFixed(2).replace(".",",") +
                     ' (\u00b1R$' + FAIXA_COMBINAR + ')</span>';
            } else {
                s += ' &nbsp;&bull;&nbsp; <span style="color:var(--grn)">=\u00a0R$' + prcN.toFixed(2).replace(".",",") + ' (exato)</span>';
            }
            if (gruparAtivo()) s += ' &nbsp;&bull;&nbsp; <span style="color:var(--acc)">agrupamento ativo</span>';
        }
        stats.innerHTML = s;
    }

    // Sem resultados após filtro
    if (!nVis) {
        tw.innerHTML =
            '<div class="msg"><h3>Sem resultados</h3>' +
            '<p>Nenhum item encontrado com os filtros atuais.<br>' +
            'Tente ajustar a busca por descri\u00e7\u00e3o ou o valor.</p></div>';
        return;
    }

    // Montar tabela via array de strings (mais performático para 500 linhas)
    // ── Helper para gerar TH de colunas sortáveis ─────────────────────────────
    // Cabeçalho de coluna copiável ("Código" e "Cód. Barras"). Um só gerador
    // para as duas: mesma marcação, mesmo comportamento.
    //
    // O title informa a QUANTIDADE exata que será copiada, para o usuário
    // conferir antes de clicar se o filtro é o que ele espera — um "copiar
    // tudo" sem número obrigaria a colar em algum lugar só para descobrir o
    // que veio. A contagem é feita sobre os valores REALMENTE preenchidos, e
    // não sobre _vis.length: nem todo produto tem código de barras cadastrado,
    // então prometer "138 códigos de barras" e entregar 96 seria pior do que
    // não informar número nenhum.
    function _thCopiarHtml(campo, label, cls, rotuloSingular, rotuloPlural, fn) {
        var qtd = _valoresColunaVisiveis(campo).length;
        var titulo = qtd
            ? 'Clique para copiar ' + (qtd > 1 ? 'os ' : 'o ') + qtd + ' ' +
              (qtd > 1 ? rotuloPlural : rotuloSingular) + ' desta busca (um por linha)'
            : 'Nenhum ' + rotuloSingular + ' preenchido nesta busca para copiar';
        return '<th class="' + cls + ' th-copiar" onclick="' + fn + '()" title="' + esc(titulo) + '">' +
               '<span class="th-copiar-conteudo">' +
                   '<span class="th-copiar-label">' + label + '</span>' +
                   '<span class="th-copiar-ico">' + _icons.copiar + '</span>' +
               '</span></th>';
    }

    function _thSortHtml(key, label, cls) {
        var ativo = (_sortKey === key);
        // Icone SVG no lugar dos glifos Unicode usados antes: a renderizacao de
        // caractere varia entre fontes e sistemas (tamanho, peso e alinhamento
        // vertical inconsistentes; o glifo de seta dupla nem existe em toda
        // fonte, virando retangulo vazio). O SVG herda currentColor, entao
        // acompanha sozinho o realce da coluna ativa, sem regra extra de cor.
        var ico   = ativo
            ? (_sortDir === 'desc' ? _icons.sortDesc : _icons.sortAsc)
            : _icons.sortNeutro;
        var clsIco = ativo ? 'sort-ico' : 'sort-ico sort-ico-inativo';
        return '<th class="' + cls + ' th-sort' + (ativo ? ' th-sort-ativo' : '') +
               '" onclick="toggleSort(\\'' + key + '\\')" title="Ordenar por ' + label +
               ' (' + (ativo ? (_sortDir === 'desc' ? 'crescente' : 'decrescente') : 'clique para ordenar') + ')">' +
               '<span class="th-sort-conteudo">' +
                   '<span class="th-sort-label">' + label + '</span>' +
                   '<span class="' + clsIco + '">' + ico + '</span>' +
               '</span></th>';
    }

    // Estrutura fixa: cabeçalho + tbody VAZIO + sentinela de carregamento.
    // As linhas entram por _renderLote() em blocos, nunca todas de uma vez —
    // ver comentário em _renderLote sobre o porquê.
    tw.innerHTML =
        "<table>" +
        "<thead><tr>" +
        '<th class="th-n">#</th>' +
        _thCopiarHtml('codigo', 'C\u00f3digo', 'th-cod',
                      'c\u00f3digo', 'c\u00f3digos', 'copiarCodigosVisiveis') +
        '<th class="th-desc">Descri\u00e7\u00e3o</th>' +
        _thCopiarHtml('codbarras', 'C\u00f3d. Barras', 'th-bar',
                      'c\u00f3digo de barras', 'c\u00f3digos de barras', 'copiarCodBarrasVisiveis') +
        _thSortHtml('estoque', 'Estoque', 'th-est') +
        _thSortHtml('preco',   'Pre\u00e7o',  'th-prc') +
        _thSortHtml('ultimaVenda', '\u00dalt. Venda', 'th-uv') +
        '<th class="th-ac">A\u00e7\u00e3o</th>' +
        '</tr></thead><tbody id="twBody"></tbody></table>' +
        '<div class="tw-mais" id="twMais" style="display:none"></div>' +
        '<div class="tw-sentinela" id="twSentinela"></div>';

    _renderCursor = 0;
    _renderLote(temPrc, fx);
    _armarSentinela(temPrc, fx);

    // Recalcula offsets e re-sincroniza thead após cada render
    ajustarStickyOffsets();
    if (window._syncThead) window._syncThead();
}

// ── Monta o HTML de UMA linha ─────────────────────────────────────────────────
// Extraída do laço de renderTabela para que a mesma marcação seja usada tanto
// no primeiro lote quanto nos lotes anexados por rolagem — uma única fonte da
// verdade para o formato da linha (antes, qualquer mudança de layout teria de
// ser replicada se houvesse mais de um ponto de montagem).
function _linhaHtml(it, indice, temPrc, fx) {
    var usado  = !!it.usado;
    var prc    = Number(it.preco || 0);
    var pmatch = temPrc && prc > 0 && fx && prc >= fx.min && prc <= fx.max;
    var trCls  = (usado ? "tr-uso" : "") + (pmatch ? " tr-pm" : "");

    var dHtml = esc(it.descricao);
    if (usado)             dHtml += ' <span class="tag tag-fila">na fila</span>';
    if (pmatch && !usado)  dHtml += ' <span class="tag tag-pm">' + _icons.ok + 'faixa</span>';

    return "<tr" + (trCls.trim() ? ' class="' + trCls.trim() + '"' : "") + ">" +
        '<td class="td-n">' + (indice + 1) + "</td>" +
        '<td class="td-cod">' + esc(it.codigo) + "</td>" +
        '<td class="td-desc">' + dHtml + "</td>" +
        '<td class="td-bar">' + (it.codbarras ? esc(it.codbarras) : '<span style="color:var(--txt3)">-</span>') + "</td>" +
        '<td class="td-est">' + fmtEst(it.estoque) + "</td>" +
        '<td class="td-prc">' + fmtBRL(it.preco) + "</td>" +
        '<td class="td-uv">'  + fmtData(it.ultimaVenda) + "</td>" +
        '<td class="td-ac">' +
            (!usado
                ? '<button class="btn btn-usar btn-sm" data-cod="' + esc(it.codigo) + '" onclick="marcarUsadoBtn(this)">Usar</button>'
                : '<span style="font-size:10px;color:var(--uso-txt)">na fila</span>') +
        "</td></tr>";
}

// ── Anexa o próximo lote de linhas ao <tbody> ─────────────────────────────────
// Por que em lotes, e não tudo de uma vez: cada linha custa ~435 bytes de HTML
// e ~20 nós de DOM. Renderizar 5.000 itens de uma vez significa ~2 MB de HTML e
// ~100.000 nós num único innerHTML — em PC de loja isso é um congelamento de
// vários segundos, e acontecia a CADA filtro/ordenação/atualização, não só na
// carga inicial. Anexando em lotes o custo por operação fica constante e o
// usuário interage com a tabela imediatamente; o resto entra conforme rola.
// insertAdjacentHTML('beforeend') preserva as linhas já existentes (não
// re-parseia a tabela inteira, ao contrário de reatribuir innerHTML).
function _renderLote(temPrc, fx) {
    var tbody = document.getElementById('twBody');
    if (!tbody) return;

    var inicio = _renderCursor;
    var fim    = Math.min(inicio + _perfil.loteRender, _vis.length);
    if (fim <= inicio) { _atualizarRodapeRender(); return; }

    var buf = [];
    for (var i = inicio; i < fim; i++) buf.push(_linhaHtml(_vis[i], i, temPrc, fx));
    tbody.insertAdjacentHTML('beforeend', buf.join(""));

    _renderCursor = fim;
    _atualizarRodapeRender();
}

// Rodapé discreto informando o quanto da lista já está na tela.
function _atualizarRodapeRender() {
    var el = document.getElementById('twMais');
    if (!el) return;
    if (_renderCursor >= _vis.length) {
        el.style.display = 'none';
        return;
    }
    el.style.display   = '';
    el.textContent     = 'Mostrando ' + _renderCursor + ' de ' + _vis.length +
                         ' \u2014 role para carregar mais';
}

// ── Sentinela de rolagem ──────────────────────────────────────────────────────
// IntersectionObserver dispara o próximo lote quando o fim da tabela se aproxima
// da viewport (margem de 600px = carrega ANTES do usuário chegar no fim, então
// a rolagem parece contínua, sem "pulo" nem tela em branco).
// Fallback: navegador sem IntersectionObserver recebe um listener de scroll com
// throttle por rAF — nunca fica sem forma de ver o resto da lista.
function _armarSentinela(temPrc, fx) {
    var sentinela = document.getElementById('twSentinela');
    if (!sentinela) return;

    // Desliga o observer anterior: sem isso, cada render deixaria um observer
    // órfão apontando para um nó removido — vazamento acumulativo a cada filtro.
    _desarmarSentinela();

    if (typeof IntersectionObserver === 'function') {
        _renderObserver = new IntersectionObserver(function(entradas) {
            for (var i = 0; i < entradas.length; i++) {
                if (entradas[i].isIntersecting) {
                    _renderLote(temPrc, fx);
                    if (_renderCursor >= _vis.length) _desarmarSentinela();
                    break;
                }
            }
        }, { rootMargin: '600px 0px' });
        _renderObserver.observe(sentinela);
        return;
    }

    // ── Fallback sem IntersectionObserver ───────────────────────────────────
    var pendente = false;
    var onScroll = function() {
        if (pendente) return;
        pendente = true;
        requestAnimationFrame(function() {
            pendente = false;
            var s = document.getElementById('twSentinela');
            if (!s) { window.removeEventListener('scroll', onScroll); return; }
            if (s.getBoundingClientRect().top - window.innerHeight < 600) {
                _renderLote(temPrc, fx);
                if (_renderCursor >= _vis.length) {
                    window.removeEventListener('scroll', onScroll);
                    _renderObserver = null;
                }
            }
        });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    // Guarda o desligamento num objeto com a mesma interface do observer, para
    // que _desarmarSentinela() trate os dois casos sem precisar saber qual é.
    _renderObserver = { disconnect: function() { window.removeEventListener('scroll', onScroll); } };
}

function _desarmarSentinela() {
    if (_renderObserver && typeof _renderObserver.disconnect === 'function') {
        try { _renderObserver.disconnect(); } catch (_) {}
    }
    _renderObserver = null;
}

// ── MODO AUTOMÁTICO ───────────────────────────────────────────────────────────

function abrirModoAuto() {
    var ov = document.getElementById('autoOv');
    if (!ov) return;
    document.getElementById('autoInput').value  = '';
    document.getElementById('autoOutput').value = '';
    document.getElementById('autoResultWrap').style.display = 'none';
    document.getElementById('autoCopyBtn').style.display    = 'none';
    document.getElementById('autoStatus').textContent = 'Aguardando lista...';
    document.getElementById('autoStatus').className   = 'auto-status';
    document.getElementById('autoIniciarBtn').disabled = false;
    // Reseta apenas o checkbox — a lista personalizada salva (_lpDados) persiste
    // entre aberturas do modal e entre recarregamentos da página, pois agora é
    // sincronizada com o servidor (lista-personalizada.json)
    var chkLp = document.getElementById('chkListaPersonalizada');
    if (chkLp) chkLp.checked = false;
    var lblLp = document.getElementById('lpToggleLbl');
    if (lblLp) lblLp.textContent = 'Usar lista personalizada';
    _atualizarResumoLp();
    _autoCodsParaMarcar = [];
    ov.classList.add('on');
}

// ── Lista personalizada: dados salvos ──────────────────────────────────────────
// Persistida no servidor (lista-personalizada.json), no mesmo esquema de
// usados-estoque.json: carregada do servidor em DOMContentLoaded (ver
// _carregarListaPersonalizadaServidor) e gravada via POST a cada "Salvar lista".
// Por isso sobrevive a F5 e a reinícios do servidor — não vive só na sessão.
var _lpDados = []; // [{codigo, estoqueParada}, ...] — estoqueParada pode ser null (sem limite)

// ── Alerta consolidado: códigos da lista personalizada esgotados ─────────────
// Dispara toda vez que _itens é atualizado (carregarItens). Para cada código
// configurado na lista que sumiu do catálogo (estoque zerado — o servidor só
// retorna itens com estoque > 0) ou atingiu o estoque de parada individual
// configurado para ele, o código entra na fila "_lpAlertasPendentes" e o
// modal consolidado (#lpAlertaOv) mostra TODOS os pendentes de uma vez —
// nome do produto, motivo, e botões "Excluir"/"Deixar para depois" por
// linha, além de "Excluir todos"/"Deixar todos para depois" no rodapé.
// Se o usuário deixar um código para depois (individual ou em massa), o
// alerta é adiado apenas para esta sessão (sessionStorage) — ao recarregar a
// página ou abrir o sistema numa nova sessão, o alerta volta a aparecer.
var _lpAlertasPendentes  = []; // [{codigo, motivo, descricao}, ...] — aguardando decisão do usuário
var _lpAlertaModalAberto = false;

// sessionStorage é esvaziado automaticamente quando a aba/janela fecha —
// diferente de localStorage, não sobrevive entre sessões, então "deixar
// para depois" só vale até a página ser recarregada/reaberta.
function _lpAlertaAdiado(codigo) {
    try { return sessionStorage.getItem('est-lp-snooze-' + codigo) === '1'; } catch (_) { return false; }
}
function _lpAlertaAdiar(codigo) {
    try { sessionStorage.setItem('est-lp-snooze-' + codigo, '1'); } catch (_) {}
}
function _lpAlertaLimparSnooze(codigo) {
    try { sessionStorage.removeItem('est-lp-snooze-' + codigo); } catch (_) {}
}

function _verificarAlertasListaPersonalizada() {
    if (!_lpDados.length) return;
    // mapaDesc é fallback SECUNDÁRIO pra exibir o nome do produto — a fonte
    // primária é o próprio _lpEstoquesReais[codigo].descricao (capturada no
    // servidor direto da linha do banco, antes do filtro de proibidos — ver
    // /api/itens). mapaDesc só entra em jogo se por algum motivo a resposta
    // do servidor não trouxer descrição pra aquele código específico.
    var mapaDesc = Object.create(null);
    for (var i = 0; i < _itens.length; i++) mapaDesc[_itens[i].codigo] = _itens[i];

    var novos = [];
    for (var j = 0; j < _lpDados.length; j++) {
        var lpItem   = _lpDados[j];
        var lpReal   = Object.prototype.hasOwnProperty.call(_lpEstoquesReais, lpItem.codigo)
                        ? _lpEstoquesReais[lpItem.codigo] : null;
        // temReal exige um número de estoque válido — lpReal existe mas
        // .estoque pode vir null se a consulta dedicada (rLp, servidor) achou
        // a linha porém não conseguiu converter ESTOQUE num número finito
        // (dado corrompido no banco) — tratado como "não deu pra confirmar",
        // mesmo caminho de "não encontrado" (nunca finge que está tudo bem).
        var temReal     = !!(lpReal && typeof lpReal.estoque === 'number' && !isNaN(lpReal.estoque));
        var estoqueReal = temReal ? lpReal.estoque : null;

        // Motivo REAL e específico — a consulta dedicada no servidor (rLp,
        // sem o filtro "estoque >= 0" da query principal) permite diferenciar
        // de verdade estes 5 casos, em vez de um "chegou a zero" genérico
        // pra qualquer situação:
        var motivo = null;
        if (!temReal) {
            motivo = 'o c\u00f3digo n\u00e3o existe mais no banco (foi exclu\u00eddo ou renomeado no ERP)';
        } else if (lpReal.ativo === false) {
            // lpReal.ativo só é boolean quando o banco tem coluna ATIVO/ATIVADO/
            // SITUACAO/STATUS detectável (ver servidor, carregarItens() →
            // _lpEstoquesReais); null (coluna inexistente nesse banco) nunca cai
            // aqui — "não dá pra verificar" não pode virar alerta de "inativo".
            // Checado ANTES do estoque de propósito: um item pode ter estoque
            // positivo e ainda assim estar descontinuado/inativo no ERP — nesse
            // caso o motivo administrativo é mais relevante que o número de
            // estoque.
            motivo = 'o item est\u00e1 INATIVO no sistema (verifique o cadastro no ERP)';
        } else if (estoqueReal < 0) {
            motivo = 'o estoque est\u00e1 NEGATIVADO (valor atual no banco: ' + estoqueReal + ' unid. \u2014 verifique o cadastro no ERP)';
        } else if (estoqueReal === 0) {
            motivo = 'o estoque chegou a zero';
        } else if (lpItem.estoqueParada != null && estoqueReal <= Number(lpItem.estoqueParada)) {
            motivo = 'o estoque atingiu o valor de parada configurado (atual: ' + estoqueReal + ' unid. \u2014 parada em ' + lpItem.estoqueParada + ' unid.)';
        }
        if (!motivo) continue;

        if (_lpAlertaAdiado(lpItem.codigo)) continue; // já adiado nesta sessão

        var jaNaFila = false;
        for (var k = 0; k < _lpAlertasPendentes.length; k++) {
            if (_lpAlertasPendentes[k].codigo === lpItem.codigo) { jaNaFila = true; break; }
        }
        if (jaNaFila) continue;
        // descricao: 1) _lpEstoquesReais (fonte primária, sobrevive a filtro de
        // proibidos); 2) mapaDesc (fallback); 3) null → UI mostra "não
        // encontrada" em vez de deixar em branco ou quebrar.
        var atual     = mapaDesc[lpItem.codigo];
        var descricao = (lpReal && lpReal.descricao) ? lpReal.descricao : (atual ? atual.descricao : null);
        novos.push({ codigo: lpItem.codigo, motivo: motivo, descricao: descricao });
    }
    if (novos.length) {
        _lpAlertasPendentes = _lpAlertasPendentes.concat(novos);
        _abrirOuAtualizarAlertaLpModal();
    }
}

// ── Modal consolidado (abrir/atualizar/fechar) ────────────────────────────────
function _abrirOuAtualizarAlertaLpModal() {
    if (!_lpAlertasPendentes.length) { _fecharAlertaLpModal(); return; }
    _renderAlertaLpModal();
    if (!_lpAlertaModalAberto) {
        var ov = document.getElementById('lpAlertaOv');
        if (ov) { ov.classList.add('on'); _lpAlertaModalAberto = true; }
    }
}

function _fecharAlertaLpModal() {
    var ov = document.getElementById('lpAlertaOv');
    if (ov) ov.classList.remove('on');
    _lpAlertaModalAberto = false;
}

// Monta a lista de linhas do modal a partir de _lpAlertasPendentes. Usa
// textContent (nunca innerHTML) para nome/motivo — evita XSS caso a
// descrição do produto contenha caracteres especiais vindos do banco.
function _renderAlertaLpModal() {
    var lista = document.getElementById('lpAlertaLista');
    var count = document.getElementById('lpAlertaCount');
    if (!lista) return;
    while (lista.firstChild) lista.removeChild(lista.firstChild);

    if (count) {
        var n = _lpAlertasPendentes.length;
        count.textContent = n + (n === 1 ? ' c\u00f3digo precisa' : ' c\u00f3digos precisam') +
            ' da sua decis\u00e3o: exclu\u00edr da lista ou deixar para decidir depois.';
    }

    _lpAlertasPendentes.forEach(function(alerta) {
        var row = document.createElement('div');
        row.className = 'lpa-row';

        var info = document.createElement('div');
        info.className = 'lpa-info';

        var linhaCod = document.createElement('div');
        linhaCod.className = 'lpa-nome';
        linhaCod.textContent = 'C\u00f3digo ' + alerta.codigo;

        var linhaItem = document.createElement('div');
        linhaItem.className = 'lpa-item';
        var textoItem = 'Item: ' + (alerta.descricao || '(descri\u00e7\u00e3o n\u00e3o encontrada no banco)');
        linhaItem.textContent = textoItem;
        linhaItem.title = textoItem; // tooltip com nome completo se truncar por ellipsis

        var motivo = document.createElement('div');
        motivo.className = 'lpa-motivo';
        motivo.textContent = 'Motivo: ' + alerta.motivo + '.';

        info.appendChild(linhaCod);
        info.appendChild(linhaItem);
        info.appendChild(motivo);

        var btns = document.createElement('div');
        btns.className = 'lpa-btns';

        var bDepois = document.createElement('button');
        bDepois.className = 'btn btn-s btn-sm';
        bDepois.textContent = 'Deixar para depois';
        bDepois.title = 'Manter na lista \u2014 pergunto de novo na pr\u00f3xima sess\u00e3o (ou se o item continuar pendente nesta mesma sess\u00e3o)';

        var bExcluir = document.createElement('button');
        bExcluir.className = 'btn btn-d btn-sm';
        bExcluir.textContent = 'Excluir';
        bExcluir.title = 'Remover este c\u00f3digo da lista personalizada';

        // { once: true } evita duplo-clique disparar a ação duas vezes
        // (a linha é removida do DOM logo após o clique, mas o listener
        // ainda poderia disparar de novo num clique muito rápido).
        (function(codigo) {
            bDepois.addEventListener('click', function() { _lpaResolverItem(codigo, 'depois'); }, { once: true });
            bExcluir.addEventListener('click', function() { _lpaResolverItem(codigo, 'excluir'); }, { once: true });
        })(alerta.codigo);

        btns.appendChild(bDepois);
        btns.appendChild(bExcluir);

        row.appendChild(info);
        row.appendChild(btns);
        lista.appendChild(row);
    });
}

// Resolve UM único código (botões da linha): remove da fila local, aplica a
// decisão (excluir da lista OU adiar 1 dia) e re-renderiza. Fecha o modal
// automaticamente quando não sobrar nenhum pendente.
function _lpaResolverItem(codigo, acao) {
    var idx = -1;
    for (var i = 0; i < _lpAlertasPendentes.length; i++) {
        if (_lpAlertasPendentes[i].codigo === codigo) { idx = i; break; }
    }
    if (idx === -1) return; // defensivo: já resolvido (ex.: clique duplo/rápido)
    _lpAlertasPendentes.splice(idx, 1);

    if (acao === 'excluir') {
        _lpAlertaLimparSnooze(codigo);
        _removerCodigosListaPersonalizada([codigo]);
    } else {
        _lpAlertaAdiar(codigo);
    }

    if (_lpAlertasPendentes.length) {
        _renderAlertaLpModal();
    } else {
        _fecharAlertaLpModal();
    }
}

// Resolve TODOS os pendentes de uma só vez (botões do rodapé e o X de fechar
// — fechar o modal sem escolher por item é tratado como "deixar para
// depois" para tudo que ainda estava pendente, nunca perde a lista nem
// deixa estado inconsistente entre _lpAlertasPendentes e o localStorage).
function _lpaResolverTodos(acao) {
    if (!_lpAlertasPendentes.length) { _fecharAlertaLpModal(); return; }
    var codigos = _lpAlertasPendentes.map(function(a) { return a.codigo; });
    _lpAlertasPendentes = [];

    if (acao === 'excluir') {
        codigos.forEach(_lpAlertaLimparSnooze);
        _removerCodigosListaPersonalizada(codigos);
    } else {
        codigos.forEach(_lpAlertaAdiar);
        toast('Vou lembrar voc\u00ea de novo na pr\u00f3xima sess\u00e3o sobre ' + codigos.length +
              (codigos.length === 1 ? ' c\u00f3digo.' : ' c\u00f3digos.'), 3500);
    }

    _fecharAlertaLpModal();
}

// Remove um ou mais códigos de _lpDados numa ÚNICA gravação no servidor
// (mesma rota usada por salvarListaPersonalizada) — usado tanto pela
// exclusão individual (array de 1) quanto por "Excluir todos" (array com
// N códigos), evitando N requisições POST sequenciais e a condição de
// corrida de reler/escrever _lpDados entre elas.
function _removerCodigosListaPersonalizada(codigos) {
    if (!codigos || !codigos.length) return;
    var remover = Object.create(null);
    codigos.forEach(function(c) { remover[c] = true; });
    var novaLista = _lpDados.filter(function(it) { return !remover[it.codigo]; });
    apiFetch('/api/lista-personalizada', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ itens: novaLista })
    }).then(function(r) {
        if (r && r.ok) {
            _lpDados = novaLista;
            _atualizarResumoLp();
            toast('\u2713 ' + codigos.length + (codigos.length === 1 ? ' c\u00f3digo removido' : ' c\u00f3digos removidos') +
                  ' da lista personalizada.', 3500);
        } else {
            toast('N\u00e3o foi poss\u00edvel remover ' + codigos.length + ' c\u00f3digo(s) da lista (erro ao salvar no servidor). ' +
                  'Abra a lista personalizada para conferir o estado atual.', 4500);
        }
    }).catch(function() {
        toast('Erro de conex\u00e3o ao tentar remover c\u00f3digo(s) da lista. Abra a lista personalizada para conferir o estado atual.', 4500);
    });
}

// ── Toggle único (ativar/desativar) ────────────────────────────────────────────
// Quando marcado: restringe a busca apenas aos códigos configurados, permitindo
// repeti-los. Se ainda não houver lista salva, abre o modal de configuração.
function toggleListaPersonalizada() {
    var chk = document.getElementById('chkListaPersonalizada');
    var lbl = document.getElementById('lpToggleLbl');
    if (!chk || !lbl) return;
    var ativo = chk.checked;
    lbl.textContent = ativo ? 'Lista personalizada ativa' : 'Usar lista personalizada';
    if (ativo && _lpDados.length === 0) {
        abrirListaPersonalizadaModal();
    }
    // Ao ATIVAR a lista personalizada, verifica se algum código já configurado
    // esgotou (estoque zero) ou atingiu o estoque de parada individual — não
    // espera o próximo ciclo de poll.
    // FIX (2026-08-01): antes checava na hora com o que já estivesse em
    // _lpEstoquesReais, sem forçar nada — se o usuário tivesse acabado de
    // salvar a lista (ou qualquer outra mudança recente ainda não refletida
    // no último poll), o checkbox reproduzia o mesmo falso "não existe mais
    // no banco" que já foi corrigido em salvarListaPersonalizada() (v5.18/
    // v5.19), só que por este caminho diferente. Agora usa a mesma
    // sincronização forçada antes de checar.
    if (ativo && _lpDados.length > 0) {
        var _lblSincronizando = lbl.textContent;
        lbl.textContent = 'Lista personalizada ativa (sincronizando...)';
        // Desabilita "Iniciar" durante a sincronização — evita começar o Modo
        // Automático com _itens/_lpEstoquesReais potencialmente em transição
        // (o risco que estamos evitando aqui é justamente sobre estoque).
        var _btnIniciarSync = document.getElementById('autoIniciarBtn');
        if (_btnIniciarSync) _btnIniciarSync.disabled = true;
        _sincronizarEstoqueTempoReal(function() {
            lbl.textContent = _lblSincronizando;
            if (_btnIniciarSync) _btnIniciarSync.disabled = false;
            _verificarAlertasListaPersonalizada();
        });
    }
    // "Reaproveitar código" só faz sentido no modo padrão — a lista
    // personalizada já tem reaproveitamento nativo (com estoque de parada
    // por código), então o toggle fica desabilitado e visualmente apagado
    // enquanto ela estiver ativa.
    var chkReap = document.getElementById('chkReaproveitarPadrao');
    var wrapReap = document.getElementById('reaproveitarToggleWrap');
    if (chkReap) chkReap.disabled = ativo;
    if (wrapReap) wrapReap.style.opacity = ativo ? '0.45' : '';
}

// ── Preferência "Reaproveitar código" (modo padrão) — persistida no localStorage,
// igual ao padrão já usado para ordenação de coluna (est-sort-key/est-sort-dir).
// É só uma preferência de UI, não dado de negócio, por isso não vai pro servidor.
function _salvarPrefReaproveitar() {
    var chk = document.getElementById('chkReaproveitarPadrao');
    if (!chk) return;
    try { localStorage.setItem('est-reaproveitar-padrao', chk.checked ? '1' : '0'); } catch (_) {}
}
function _restaurarPrefReaproveitar() {
    var chk = document.getElementById('chkReaproveitarPadrao');
    if (!chk) return;
    try { chk.checked = localStorage.getItem('est-reaproveitar-padrao') === '1'; } catch (_) {}
}

// ── Modal de Lista Personalizada: abrir / fechar / salvar ─────────────────────
function abrirListaPersonalizadaModal() {
    var ov = document.getElementById('lpOv');
    var ta = document.getElementById('lpTextarea');
    var st = document.getElementById('lpStatus');
    if (!ov || !ta) return;
    // Repopula o textarea a partir dos dados já salvos (permite reabrir e editar)
    ta.value = _lpDados.map(function(it) {
        return it.estoqueParada != null ? (it.codigo + ', ' + it.estoqueParada) : it.codigo;
    }).join(String.fromCharCode(10));
    if (st) { st.textContent = ''; st.className = 'auto-status'; }
    ov.classList.add('on');
}

function fecharListaPersonalizadaModal() {
    var ov = document.getElementById('lpOv');
    if (ov) ov.classList.remove('on');
    // Se o usuário cancelou (X, "Cancelar" ou clique fora) sem nunca ter salvo
    // uma lista, desmarca o checkbox — não faz sentido ficar "ativo" sem
    // nenhum código configurado.
    if (!_lpDados.length) {
        var chk = document.getElementById('chkListaPersonalizada');
        if (chk && chk.checked) {
            chk.checked = false;
            var lbl = document.getElementById('lpToggleLbl');
            if (lbl) lbl.textContent = 'Usar lista personalizada';
            _atualizarResumoLp();
            // FIX (2026-07-22): toggleListaPersonalizada() desabilita "Reaproveitar
            // código" quando a lista personalizada é ativada (ela tem seu próprio
            // reaproveitamento nativo) — mas esse desmarque aqui é feito direto no
            // DOM, sem passar por toggleListaPersonalizada(), então o "Reaproveitar
            // código" ficava travado desabilitado mesmo depois da lista
            // personalizada voltar a ficar inativa (o usuário cancelando o modal
            // sem salvar nunca re-habilitava o checkbox). Re-sincroniza aqui.
            var chkReap  = document.getElementById('chkReaproveitarPadrao');
            var wrapReap = document.getElementById('reaproveitarToggleWrap');
            if (chkReap)  chkReap.disabled = false;
            if (wrapReap) wrapReap.style.opacity = '';
        }
    }
}

function salvarListaPersonalizada() {
    var ta  = document.getElementById('lpTextarea');
    var st  = document.getElementById('lpStatus');
    var btn = document.getElementById('lpSalvarBtn');
    if (!ta) return;
    var parsed = _parseListaPersonalizadaDetalhada(ta.value);
    // Só bloqueia quando o usuário digitou algo que não virou nenhum código
    // válido (entrada malformada) — zerar a lista de propósito (apagar tudo
    // do textarea e salvar) é uma ação legítima e precisa ser permitida.
    if (!parsed.length && ta.value.trim()) {
        if (st) { st.textContent = 'Nenhum c\u00f3digo v\u00e1lido reconhecido no texto digitado.'; st.className = 'auto-status er'; }
        return;
    }

    if (btn) btn.disabled = true;
    if (st)  { st.textContent = 'Salvando...'; st.className = 'auto-status'; }

    // Persiste no servidor (lista-personalizada.json) antes de confirmar — evita
    // a UI achar que salvou quando, na real, a gravação em disco falhou.
    apiFetch('/api/lista-personalizada', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ itens: parsed })
    }).then(function(r) {
        if (btn) btn.disabled = false;
        if (!r || !r.ok) {
            var msg = r ? (r.erro || 'Erro ao salvar no servidor.') : 'Sem resposta do servidor.';
            if (st) { st.textContent = msg; st.className = 'auto-status er'; }
            return;
        }
        // Usa a lista JÁ deduplicada/sanitizada que o SERVIDOR devolveu (ver
        // handlePostListaPersonalizada) em vez do "parsed" local — garante
        // que _lpDados (e a contagem mostrada na tela) reflita exatamente o
        // que foi gravado em disco, mesmo que o texto colado pelo usuário
        // tivesse código repetido (o parser já deduplica antes de enviar,
        // ver _parseListaPersonalizadaDetalhada, mas o servidor é quem tem a
        // palavra final). Fallback pro "parsed" local só por segurança,
        // caso a resposta não traga "itens" por algum motivo.
        var itensSalvos = Array.isArray(r.itens) ? r.itens : parsed;
        // duplicatasRemovidas e cortadosPorLimite vêm SEPARADOS do servidor
        // (ver handlePostListaPersonalizada) de propósito — inferir só pela
        // diferença de tamanho (parsed.length - itensSalvos.length) misturaria
        // dois motivos bem diferentes (código repetido vs lista maior que o
        // limite de 1000) numa mensagem que poderia atribuir o motivo errado.
        var duplicatasRemovidas = Number(r.duplicatasRemovidas) || 0;
        var cortadosPorLimite   = Number(r.cortadosPorLimite)   || 0;
        _lpDados = itensSalvos;
        _atualizarResumoLp();
        fecharListaPersonalizadaModal();
        var _sufixoSalvarLp = '';
        if (duplicatasRemovidas > 0) {
            _sufixoSalvarLp += ' (' + duplicatasRemovidas + ' duplicata' + (duplicatasRemovidas === 1 ? '' : 's') + ' removida' + (duplicatasRemovidas === 1 ? '' : 's') + ')';
        }
        if (cortadosPorLimite > 0) {
            _sufixoSalvarLp += ' \u2014 ' + cortadosPorLimite + ' c\u00f3digo(s) ignorado(s) por exceder o limite de 1000';
        }
        toast(
            itensSalvos.length
                ? '\u2713 Lista personalizada salva: ' + itensSalvos.length + ' c\u00f3digo' + (itensSalvos.length === 1 ? '' : 's') + _sufixoSalvarLp
                : '\u2713 Lista personalizada esvaziada.',
            2500
        );

        // FIX (2026-07-27): _lpEstoquesReais (estoque/descrição REAIS dos
        // códigos da lista personalizada) só é recalculado dentro de
        // carregarItens() no servidor — sem forçar isso aqui, um código
        // RECÉM-salvo ficava fora dele até o próximo ciclo natural de
        // poll/SSE, e a checagem de alerta (mais abaixo) achava que o
        // código "não existe mais no banco" só por estar temporariamente
        // desatualizado. Sincroniza de verdade antes de checar — mesma
        // infraestrutura já usada pelo Modo Automático (ver iniciarModoAuto).
        // Desabilita "Iniciar" durante a sincronização — mesmo motivo do
        // toggleListaPersonalizada(): evita começar o Modo Automático com
        // dados de estoque potencialmente em transição.
        //
        // FIX (2026-08-29, caso real: banco/rede lento o bastante pra
        // carregarItens() levar bem mais que os 6s que este teto costumava
        // dar): _sincronizarEstoqueTempoReal agora informa via "sucesso" se
        // os dados aplicados são realmente confirmados frescos ou se o teto
        // de espera venceu ANTES do carregamento em background terminar. Sem
        // essa distinção, um código recém-salvo era acusado de "não existe
        // mais no banco" com base em _lpEstoquesReais ainda desatualizado —
        // falso, e só se corrigia sozinho no próximo poll/reinício. Agora,
        // se não deu tempo de confirmar, NÃO roda o alerta com dado
        // possivelmente velho — avisa e tenta de novo uma vez, mais adiante.
        if (itensSalvos.length) {
            var _btnIniciarSalvar    = document.getElementById('autoIniciarBtn');
            var _statusIniciarSalvar = document.getElementById('autoStatus');
            if (_btnIniciarSalvar) _btnIniciarSalvar.disabled = true;
            if (_statusIniciarSalvar) {
                _statusIniciarSalvar.textContent = 'Sincronizando estoque com o banco ap\u00f3s salvar a lista...';
                _statusIniciarSalvar.className   = 'auto-status';
            }
            _sincronizarEstoqueTempoReal(function(sucesso) {
                if (_btnIniciarSalvar) _btnIniciarSalvar.disabled = false;
                if (_statusIniciarSalvar && _statusIniciarSalvar.textContent.indexOf('Sincronizando estoque com o banco ap\u00f3s salvar') === 0) {
                    _statusIniciarSalvar.textContent = '';
                }
                if (sucesso) {
                    _verificarAlertasListaPersonalizada();
                } else {
                    toast(
                        'Banco/rede lento \u2014 ainda sincronizando o estoque dos c\u00f3digos rec\u00e9m-salvos. ' +
                        'Os alertas da lista personalizada v\u00e3o ser checados de novo em instantes.',
                        6000
                    );
                    // Uma única nova tentativa, mais adiante — cobre o caso comum
                    // (carregamento em background estava a poucos segundos de
                    // terminar); não fica repetindo indefinidamente.
                    setTimeout(_verificarAlertasListaPersonalizada, 8000);
                }
            });
        }
    });
}

// ── Lista personalizada: carrega do servidor ───────────────────────────────────
// Chamada em DOMContentLoaded para popular _lpDados com o que já está gravado
// em lista-personalizada.json — mesmo papel que /api/itens cumpre para o
// estado "usado" de cada item. Falha de rede aqui não deve travar a página:
// se não der, _lpDados simplesmente fica vazio até o usuário configurar.
function _carregarListaPersonalizadaServidor() {
    return apiFetch('/api/lista-personalizada').then(function(dados) {
        if (dados && dados.ok && Array.isArray(dados.itens)) {
            _lpDados = dados.itens;
            _atualizarResumoLp();
        }
        return _lpDados;
    });
}

// Atualiza o texto de resumo ao lado do botão "Configurar lista"
function _atualizarResumoLp() {
    var resumo = document.getElementById('lpResumo');
    if (!resumo) return;
    resumo.textContent = _lpDados.length > 0
        ? _lpDados.length + ' c\u00f3digo' + (_lpDados.length === 1 ? '' : 's') + ' configurado' + (_lpDados.length === 1 ? '' : 's')
        : '';
}

// ── Parser da lista personalizada detalhada ────────────────────────────────────
// Formato por linha: "codigo" ou "codigo, estoque_de_parada"
// Quando o estoque do produto atingir (ou ficar abaixo de) estoque_de_parada,
// o modo automático para de usá-lo. Sem o segundo valor, uso ilimitado.
// Implementado via charCodeAt (sem regex) para evitar a armadilha de escape
// \\n vs \\\\n dentro do template literal Node.js.
function _parseListaPersonalizadaDetalhada(raw) {
    var itens = [];
    if (!raw) return itens;

    function _trim(s) {
        var a = 0, b = s.length;
        while (a < b && s.charCodeAt(a) <= 32) a++;
        while (b > a && s.charCodeAt(b - 1) <= 32) b--;
        return s.slice(a, b);
    }

    var NL = String.fromCharCode(10);
    var CR = String.fromCharCode(13);
    var normalizado = raw.split(CR + NL).join(NL).split(CR).join(NL);
    var linhas = normalizado.split(NL);

    // A lista personalizada nunca deve ter código duplicado — checado aqui
    // (1ª ocorrência da linha vence, as repetidas seguintes são ignoradas) E
    // de novo no servidor em _sanitizarListaPersonalizada (ver
    // handlePostListaPersonalizada), que é quem tem a palavra final sobre o
    // que fica gravado em lista-personalizada.json.
    var _vistosCod = {};

    for (var i = 0; i < linhas.length; i++) {
        var linha = _trim(linhas[i]);
        if (!linha) continue;

        var idxVirgula = linha.indexOf(',');
        var codigoRaw, estoqueRaw;
        if (idxVirgula >= 0) {
            codigoRaw  = linha.slice(0, idxVirgula);
            estoqueRaw = linha.slice(idxVirgula + 1);
        } else {
            codigoRaw  = linha;
            estoqueRaw = '';
        }

        var codigo     = _trim(codigoRaw);
        var estoqueTxt = _trim(estoqueRaw);
        if (!codigo) continue;
        if (Object.prototype.hasOwnProperty.call(_vistosCod, codigo)) continue;
        _vistosCod[codigo] = true;

        var estoqueParada = null;
        if (estoqueTxt) {
            var n = parseFloat(estoqueTxt.split(',').join('.'));
            if (!isNaN(n) && n >= 0) estoqueParada = n;
        }

        itens.push({ codigo: codigo, estoqueParada: estoqueParada });
    }
    return itens;
}

function fecharModoAuto() {
    var ov = document.getElementById('autoOv');
    if (ov) ov.classList.remove('on');
}

function copiarResultadoAuto() {
    var out = document.getElementById('autoOutput');
    if (!out || !out.value) return;
    _copiarTexto(out.value, function() {
        toast('\u2713 Resultado copiado!', 2200);
        // Agora que o usuário copiou, marca todos os itens como usados.
        // Deduplica por segurança — mesmo que a origem (_jaMarcado, no
        // processamento do Modo Automático) já evite repetir o mesmo código.
        var cods = [];
        var _vistosCod = {};
        _autoCodsParaMarcar.forEach(function(c) {
            if (!_vistosCod[c]) { _vistosCod[c] = true; cods.push(c); }
        });
        _autoCodsParaMarcar = [];
        if (!cods.length) return;
        var pendentes = cods.length;
        var okCount   = 0;
        cods.forEach(function(cod) {
            apiFetch('/api/marcar-usado', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ codigo: cod })
            }).then(function(r) {
                if (r && r.ok) okCount++;
                if (--pendentes === 0) {
                    toast('\u2713 ' + okCount + ' item' + (okCount===1?'':'s') + ' movido' + (okCount===1?'':'s') + ' para usados.', 3000);
                    carregarItens();
                }
            });
        });
    });
}

// Fecha o modal ao clicar fora da caixa
document.addEventListener('click', function(e) {
    var ov = document.getElementById('autoOv');
    if (ov && e.target === ov) fecharModoAuto();
    var lpOv = document.getElementById('lpOv');
    if (lpOv && e.target === lpOv) fecharListaPersonalizadaModal();
    // Clique fora do modal de alerta consolidado = "deixar todos para depois"
    // (nunca perde a lista nem deixa _lpAlertasPendentes dessincronizado do
    // localStorage — resolve explicitamente em vez de só esconder o modal).
    var lpAlertaOv = document.getElementById('lpAlertaOv');
    if (lpAlertaOv && e.target === lpAlertaOv) _lpaResolverTodos('depois');
});









// ── Sincronização forçada com o banco antes do Modo Automático ─────────────────
// FIX (2026-07-17): iniciarModoAuto() usava _itens como estava em memória no
// momento do clique — um snapshot alimentado por poll passivo (a cada
// POLL_INTERVALO_MS) ou por evento SSE, ou seja, podia estar desatualizado em
// relação ao estoque real no Firebird se outra venda tivesse acontecido entre
// o último poll e o clique em "Iniciar". Como o Modo Automático decide QUANTAS
// unidades de cada item ainda podem ser sugeridas (nunca abaixo de zero — ver
// _qtdMaximaDisponivel em estoque-engine.js), a base precisa ser o estoque
// real no instante em que o processamento começa, não um cache. Esta função
// força um SELECT fresco (/api/atualizar) e só libera o processamento depois
// que os dados voltarem — nunca deixa o algoritmo decidir sobre números
// potencialmente velhos.
// FIX (2026-08-29, achado num caso real: Firebird remoto/lento, ciclo
// completo de carregarItens() perto de 16-20s): 6s era curto demais — o
// caso de uso mais sensível a isso não é nem o Modo Automático (que
// tolera number ligeiramente atrasado), e sim salvarListaPersonalizada():
// um código RECÉM-salvo podia ser acusado de "não existe mais no banco"
// só porque o teto de 6s venceu antes de carregarItens() terminar de
// recalcular _lpEstoquesReais — informação falsa, que se corrigia sozinha
// no próximo poll ou reinício (daí o relato "funciona ao reabrir pelo
// .bat"). Subido para 30s, com folga real sobre o tempo observado; ver
// também o parâmetro "sucesso" de onPronto() logo abaixo, que cobre o caso
// de o banco ser mais lento ainda que isso.
var SYNC_ESTOQUE_TIMEOUT_MS   = 30000; // teto de espera — rede lenta/Firebird ocupado nunca trava a UI pra sempre
var SYNC_ESTOQUE_POLL_MS      = 400;
var SYNC_ESTOQUE_MAX_TENTATIVAS = Math.ceil(SYNC_ESTOQUE_TIMEOUT_MS / SYNC_ESTOQUE_POLL_MS);

function _aplicarDadosItensFrescos(dados) {
    _lpEstoquesReais = dados.lpEstoquesReais || _lpEstoquesReais;
    _itens = (Array.isArray(dados.itens) ? dados.itens : []).slice(0, _limiteItens).map(function(it) {
        it._descUp = it.descricao ? it.descricao.toUpperCase()         : '';
        it._codUp  = it.codigo    ? String(it.codigo).toUpperCase()    : '';
        it._barUp  = it.codbarras ? String(it.codbarras).toUpperCase() : '';
        return it;
    });
}

// onPronto(sucesso): sucesso=true SÓ quando o servidor confirmou que não há
// carregamento em andamento (dados.carregando === false) — ou seja, os dados
// aplicados são de verdade os mais recentes. sucesso=false quando o teto de
// tentativas venceu com o servidor AINDA carregando (ou a rede falhou): os
// dados aplicados podem ser de ANTES do carregamento em curso terminar —
// quem chama precisa saber disso pra não tratar como definitivo (ver
// salvarListaPersonalizada(), que evita rodar o alerta de "código não
// existe" com base num sucesso=false).
function _aguardarCargaFrescaConcluir(onPronto, tentativa) {
    apiFetch('/api/itens').then(function(dados) {
        if (!dados) { onPronto(false); return; } // falha de rede — não deu pra confirmar nada fresco
        if (dados.carregando && tentativa < SYNC_ESTOQUE_MAX_TENTATIVAS) {
            setTimeout(function() { _aguardarCargaFrescaConcluir(onPronto, tentativa + 1); }, SYNC_ESTOQUE_POLL_MS);
            return;
        }
        // Aplica o resultado mais recente que conseguiu obter de qualquer
        // forma (nunca trava a UI indefinidamente esperando uma rede ou
        // banco muito lento) — mas só é "sucesso" de verdade quando o
        // servidor confirmou !carregando; se o teto venceu primeiro,
        // dados.carregando ainda pode ser true (ver comentário acima).
        _aplicarDadosItensFrescos(dados);
        onPronto(!dados.carregando);
    }).catch(function() { onPronto(false); });
}

function _sincronizarEstoqueTempoReal(onPronto) {
    apiFetch('/api/atualizar', { method: 'POST' }).then(function(r) {
        // FIX (2026-08-01): "!r.ok" aqui geralmente significa "já tem um
        // carregamento em andamento" (ex.: o próprio servidor disparou um
        // refresh em background ao salvar a lista personalizada, ver
        // handlePostListaPersonalizada) — NÃO significa que não há nada
        // acontecendo. Antes, esse caso desistia na hora e seguia com
        // _lpEstoquesReais/_itens desatualizados, current fresh. Agora
        // espera esse carregamento (nosso ou de outra origem) terminar do
        // mesmo jeito — só assim garante dados realmente frescos antes de
        // liberar onPronto().
        _aguardarCargaFrescaConcluir(onPronto, 0);
    }).catch(function() { onPronto(false); }); // falha de rede de verdade — segue com o que já tinha, mas avisa que não é garantidamente fresco
}

function iniciarModoAuto(faixaExtraOverride, tentativaExtensaoOverride) {
    var inputEl  = document.getElementById('autoInput');
    var statusEl = document.getElementById('autoStatus');
    var btn      = document.getElementById('autoIniciarBtn');
    if (!inputEl) return;
    if (!inputEl.value.trim()) {
        if (statusEl) { statusEl.textContent = 'Cole a lista antes de iniciar.'; statusEl.className = 'auto-status er'; }
        return;
    }
    if (btn) btn.disabled = true;
    if (statusEl) {
        statusEl.textContent = 'Sincronizando estoque em tempo real com o banco...';
        statusEl.className   = 'auto-status';
    }
    _sincronizarEstoqueTempoReal(function() {
        _iniciarModoAutoAposSync(faixaExtraOverride, tentativaExtensaoOverride);
    });
}

// Contém toda a lógica original do Modo Automático — só roda depois que
// iniciarModoAuto() (acima) confirma que _itens reflete o estoque real mais
// recente possível do Firebird.
function _iniciarModoAutoAposSync(faixaExtraOverride, tentativaExtensaoOverride) {
    var inputEl  = document.getElementById('autoInput');
    var outputEl = document.getElementById('autoOutput');
    var statusEl = document.getElementById('autoStatus');
    var resWrap  = document.getElementById('autoResultWrap');
    var copyBtn  = document.getElementById('autoCopyBtn');
    var btn      = document.getElementById('autoIniciarBtn');
    if (!inputEl || !outputEl) return;

    // faixaExtraOverride: quando o usuário decide ampliar a busca (ex: +80, +120...)
    var _faixaAutoAtual = (typeof faixaExtraOverride === 'number' && faixaExtraOverride >= 0)
        ? faixaExtraOverride
        : 0;

    // tentativaExtensaoOverride: quantas "sessões" de busca estendida no banco já
    // foram usadas neste processamento (máx. 5 — ver _perguntarExtensaoBusca abaixo)
    var _tentativaExtensaoAtual = (typeof tentativaExtensaoOverride === 'number' && tentativaExtensaoOverride >= 0)
        ? tentativaExtensaoOverride
        : 0;
    var MAX_TENTATIVAS_EXTENSAO = 5;

    var raw = inputEl.value.trim();
    if (!raw) {
        statusEl.textContent = 'Cole a lista antes de iniciar.';
        statusEl.className   = 'auto-status er';
        return;
    }
    if (!_itens || !_itens.length) {
        statusEl.textContent = 'Banco ainda n\u00e3o carregado. Aguarde e tente novamente.';
        statusEl.className   = 'auto-status er';
        return;
    }

    btn.disabled = true;
    var _limLabel = _faixaAutoAtual > 0 ? ' (faixa +R$' + (40 + _faixaAutoAtual) + ')' : '';
    statusEl.textContent = 'Processando' + _limLabel + '...';
    statusEl.className   = 'auto-status';

    // ── Lista personalizada: restringe o pool de busca e habilita repetição ────
    var chkLp = document.getElementById('chkListaPersonalizada');
    var lpAtiva = !!(chkLp && chkLp.checked);
    var poolPersonalizado    = [];
    var _estoqueParadaPorCod = {}; // codigo -> limite de estoque para parar de usar (ou undefined = sem limite)

    // ── Reaproveitar código (modo padrão) ──────────────────────────────────────
    // Só vale quando a lista personalizada NÃO está ativa (ela já tem seu
    // próprio reaproveitamento nativo, com piso por código configurável).
    var chkReap = document.getElementById('chkReaproveitarPadrao');
    var reaproveitarAtivo = !lpAtiva && !!(chkReap && chkReap.checked);

    if (lpAtiva) {
        if (!_lpDados.length) {
            statusEl.textContent = 'Lista personalizada ativa, mas nenhum c\u00f3digo foi configurado. Clique em "Configurar lista".';
            statusEl.className   = 'auto-status er';
            btn.disabled = false;
            return;
        }
        // Fonte PRIMÁRIA: _lpEstoquesReais (preenchido pelo servidor via consulta
        // dedicada — ver /api/itens → lpEstoquesReais, FIX 2026-07-22). Ao
        // contrário de _itens, essa fonte NÃO é filtrada por proibidos, NÃO é
        // truncada por maxItens/estoqueMinimo, e já resolve o mismatch de zero
        // à esquerda quando a coluna de código é numérica no banco — a lista
        // personalizada é escolha manual do usuário e não pode ficar invisível
        // pro próprio Modo Automático por causa de filtros pensados pra
        // sugestões automáticas. _itens só entra como fallback secundário, pro
        // caso raro da consulta dedicada ter falhado nesse ciclo de carga
        // (ver comentário "best-effort" no servidor).
        var _mapaCods     = Object.create(null);
        var _mapaCodsNorm = Object.create(null);
        var _mapaCodsPad5 = Object.create(null);
        for (var _mi = 0; _mi < _itens.length; _mi++) {
            var _itCod = String(_itens[_mi].codigo);
            _mapaCods[_itCod] = _itens[_mi];
            var _itNorm = _normalizarCodigoNumericoCliente(_itCod);
            if (_itNorm !== null && !(_itNorm in _mapaCodsNorm)) _mapaCodsNorm[_itNorm] = _itens[_mi];
            var _itPad5 = _codigoPadrao5DigitosCliente(_itCod);
            if (_itPad5 !== null && !(_itPad5 in _mapaCodsPad5)) _mapaCodsPad5[_itPad5] = _itens[_mi];
        }
        var _naoAchados = [];
        // Códigos que EXISTEM no banco mas estão marcados INATIVO no ERP: nunca
        // viram candidato do Modo Automático, mesmo com preço/estoque válidos —
        // mesma regra do catálogo geral (whereAtivo na query principal), agora
        // também aplicada aqui à lista personalizada, que usa uma consulta
        // própria sem esse filtro (rLp) só para poder diferenciar os motivos no
        // alerta consolidado (ver _valorColunaIndicaInativo no servidor e
        // _verificarAlertasListaPersonalizada no cliente — é lá que o usuário
        // decide "excluir da lista" ou "deixar para depois"; aqui a única
        // responsabilidade é jamais sugerir o código numa combinação).
        var _inativos = [];
        for (var _li = 0; _li < _lpDados.length; _li++) {
            var _lpItem = _lpDados[_li];
            var _itemLp = null;

            var _lpReal = Object.prototype.hasOwnProperty.call(_lpEstoquesReais, _lpItem.codigo)
                ? _lpEstoquesReais[_lpItem.codigo] : null;

            // ativo === false é sinal definitivo (nunca null/undefined — coluna
            // ausente no banco não bloqueia nada, ver comentário acima) — sai
            // ANTES de considerar preço/estoque, e antes do fallback via _itens.
            if (_lpReal && _lpReal.ativo === false) {
                if (_inativos.indexOf(_lpItem.codigo) === -1) _inativos.push(_lpItem.codigo);
                continue;
            }

            if (_lpReal && typeof _lpReal.preco === 'number' && !isNaN(_lpReal.preco) && _lpReal.preco > 0 &&
                typeof _lpReal.estoque === 'number' && !isNaN(_lpReal.estoque)) {
                _itemLp = {
                    codigo:    _lpItem.codigo,
                    descricao: _lpReal.descricao || _lpItem.codigo,
                    estoque:   _lpReal.estoque,
                    preco:     _lpReal.preco
                };
            }

            // Fallback: _lpEstoquesReais não veio (consulta dedicada falhou nesse
            // ciclo) ou não tinha preço válido — tenta _itens como antes (código
            // sempre 5 dígitos: tenta a forma preenchida antes da sem-zeros).
            // _itens nunca contém item inativo (filtro ATIVO já aplicado na query
            // principal do servidor), então este fallback é seguro sem checar
            // .ativo de novo.
            if (!_itemLp) {
                _itemLp = _mapaCods[_lpItem.codigo];
                if (!_itemLp) {
                    var _lpPad5 = _codigoPadrao5DigitosCliente(_lpItem.codigo);
                    if (_lpPad5 !== null) _itemLp = _mapaCodsPad5[_lpPad5];
                }
                if (!_itemLp) {
                    var _lpNorm = _normalizarCodigoNumericoCliente(_lpItem.codigo);
                    if (_lpNorm !== null) _itemLp = _mapaCodsNorm[_lpNorm];
                }
            }

            if (_itemLp && Number(_itemLp.preco || 0) > 0) {
                poolPersonalizado.push(_itemLp);
                if (_lpItem.estoqueParada != null) {
                    _estoqueParadaPorCod[_lpItem.codigo] = _lpItem.estoqueParada;
                }
            } else if (_naoAchados.indexOf(_lpItem.codigo) === -1) {
                _naoAchados.push(_lpItem.codigo);
            }
        }
        if (!poolPersonalizado.length) {
            statusEl.textContent = (_inativos.length && !_naoAchados.length)
                ? 'Todos os c\u00f3digos da lista personalizada est\u00e3o INATIVOS no sistema.'
                : 'Nenhum c\u00f3digo da lista personalizada foi encontrado no banco (ou sem pre\u00e7o v\u00e1lido).';
            statusEl.className   = 'auto-status er';
            btn.disabled = false;
            return;
        }
        // Um único toast() para os dois avisos — a função reutiliza o mesmo
        // elemento e zera o conteúdo a cada chamada (ver toast(), acima), então
        // duas chamadas seguidas fariam a segunda apagar a primeira antes do
        // usuário conseguir ler.
        var _avisosPool = [];
        if (_naoAchados.length > 0) {
            _avisosPool.push(_naoAchados.length + ' c\u00f3digo(s) n\u00e3o encontrado(s): ' +
                _naoAchados.slice(0, 5).join(', ') + (_naoAchados.length > 5 ? '...' : ''));
        }
        if (_inativos.length > 0) {
            _avisosPool.push(_inativos.length + ' c\u00f3digo(s) INATIVO(S) no sistema (ignorado(s) na busca): ' +
                _inativos.slice(0, 5).join(', ') + (_inativos.length > 5 ? '...' : ''));
        }
        if (_avisosPool.length) {
            toast(_avisosPool.join(' \u2014 '), _avisosPool.length > 1 ? 7000 : 5000);
        }
    }

    // Usa charCodes para evitar qualquer barra invertida no template literal do Node.js
    var NL  = String.fromCharCode(10);
    var CR  = String.fromCharCode(13);
    var TAB = String.fromCharCode(9);

    // Normaliza todas as quebras de linha
    var normalizado = raw.split(CR + NL).join(NL).split(CR).join(NL);
    var linhas = normalizado.split(NL);

    var _pendentes = {};
    _autoCodsParaMarcar.forEach(function(c) { _pendentes[c] = true; });

    var disponiveis;
    if (lpAtiva) {
        // Lista personalizada: pool restrito aos códigos informados, sem
        // filtro de estoque mínimo nem de "usado" — é uma escolha manual do usuário.
        disponiveis = poolPersonalizado;
    } else {
        disponiveis = _itens.filter(function(it) {
            // Candidato válido: não usado, não pendente, tem preço, atinge o
            // estoque mínimo configurado e não está na lista de proibidos
            return !it.usado
                && !_pendentes[it.codigo]
                && Number(it.preco   || 0) > PRECO_SENTINEL_ZERADO
                && Number(it.estoque || 0) >= _S.estoqueMinimo
                && !_ehProibidoCliente(it.descricao, _S.proibidosEmbutidos, _S.proibidosExtra);
        });
    }

    var usadosSession  = {};
    var saida          = [];
    var codsMarcados   = [];
    var encontrados    = 0;
    var naoEncontrados = 0;
    var idxLinha       = 0;
    var totalLinhas    = linhas.length;

    // ── Linhas sem combinação exata, candidatas a "exceder o valor" ────────────
    // (só relevante na lista personalizada — ver _processarProximoExcedente)
    var _linhasPendentesExcedente = [];
    // FAIXA_EXCEDENTE_LP é a constante de módulo definida fora desta função

    // ── Consumo simulado de estoque (lista personalizada) ──────────────────────
    // Contador acumulado de quantas vezes cada código já foi usado durante TODO
    // o processamento (não reseta por linha — simula o consumo real do estoque
    // ao longo de toda a lista de entregas).
    var _usosLPPorCod = {};

    // Retorna o pool atual, removendo códigos cujo estoque simulado já atingiu
    // o piso permitido:
    //   • COM "estoque de parada" informado → para nesse valor.
    //   • SEM "estoque de parada" informado → para em 0 ("uso livre até
    //     atingir zero" — nunca deixa nenhum código ficar negativo).
    function _poolLpDisponivelAgora() {
        return disponiveis.filter(function(it) {
            return _qtdMaximaDisponivel(it, _usosLPPorCod, _estoqueParadaPorCod) > 0;
        });
    }

    // ── Consumo simulado de estoque (modo padrão com "Reaproveitar código") ────
    // Mesmo princípio do _usosLPPorCod acima, mas para o modo padrão: o piso é
    // sempre o estoqueMinimo configurado (sem limite por código). Um código só
    // é de fato marcado como "usado" no servidor quando esse consumo simulado
    // atingir o piso — ver _jaMarcado abaixo.
    var _usosPadraoPorCod = {};
    var _jaMarcado        = {}; // evita pedir /api/marcar-usado mais de uma vez pro mesmo código

    function _poolPadraoDisponivelAgora() {
        return disponiveis.filter(function(it) {
            return !usadosSession[it.codigo]
                && _qtdMaximaDisponivel(it, _usosPadraoPorCod, null, _S.estoqueMinimo) > 0;
        });
    }

    // Processa uma linha por vez via setTimeout para não travar o browser
    function _processarProxima() {
        // Processa 1 linha por frame — garante que o browser nunca fica bloqueado
        var lote = 0;
        while (idxLinha < totalLinhas && lote < 1) {
            lote++;
            var linha = linhas[idxLinha++];
            // Remove trailing whitespace sem usar \\s no template
            while (linha.length > 0 && linha.charCodeAt(linha.length - 1) <= 32) {
                linha = linha.slice(0, -1);
            }

            // Aceita "[NAO ENCONTRADO]" já presente no final da linha colada — o
            // usuário pode reaproveitar uma saída anterior como entrada nova (ex.:
            // colar de volta uma lista que tinha ficado com alguns itens sem
            // solução). É só um placeholder visual: sempre sai substituído pelo
            // resultado deste processamento (achado ou não), nunca mantido ou
            // duplicado. Comparação manual (sem regex \\s), mesmo motivo do
            // trecho de remoção de espaço em branco logo acima.
            var _marcador = '[NAO ENCONTRADO]';
            if (linha.length >= _marcador.length &&
                linha.slice(-_marcador.length).toUpperCase() === _marcador) {
                linha = linha.slice(0, -_marcador.length);
                while (linha.length > 0 && linha.charCodeAt(linha.length - 1) <= 32) {
                    linha = linha.slice(0, -1);
                }
            }

            if (!linha.trim()) { saida.push(''); continue; }

            var trimmed      = linha.trim();
            var primeiroCode = trimmed.charCodeAt(0);
            var ehDigito     = primeiroCode >= 48 && primeiroCode <= 57;

            // Linha de secao: nao comeca com digito e termina com ":"
            if (!ehDigito && trimmed.charAt(trimmed.length - 1) === ':') {
                saida.push(linha);
                continue;
            }
            if (!ehDigito) { saida.push(linha); continue; }

            // Divide no primeiro espaco ou tab (charCode 32 ou 9)
            var idx1 = -1;
            for (var ci = 0; ci < trimmed.length; ci++) {
                var cc = trimmed.charCodeAt(ci);
                if (cc === 32 || cc === 9) { idx1 = ci; break; }
            }
            if (idx1 < 0) { saida.push(linha); continue; }

            var valorStr = trimmed.slice(0, idx1).replace(',', '.');
            var valor    = parseFloat(valorStr);
            if (isNaN(valor) || valor <= 0) { saida.push(linha); continue; }

            var resultado;
            if (lpAtiva) {
                // Lista personalizada: recalcula o pool a cada linha, removendo
                // códigos cujo estoque simulado já atingiu o piso permitido
                // (limite de parada informado, ou 0 quando não informado).
                var poolAgora = _poolLpDisponivelAgora();
                resultado = _autoEncontrarMelhorComRepeticao(
                    poolAgora, valor, _faixaAutoAtual, _usosLPPorCod, _estoqueParadaPorCod
                );
                // Camada defensiva extra: protege contra anomalia de dados (ex:
                // estoque alterado durante o processamento assíncrono da lista) —
                // nunca deixa passar um resultado que ultrapasse o piso de
                // estoque de parada (ou zero absoluto) de algum código.
                resultado = _validarResultadoLista(resultado, _usosLPPorCod, _estoqueParadaPorCod);
            } else if (reaproveitarAtivo) {
                // Modo padrão com "Reaproveitar código": mesmo algoritmo com
                // repetição da lista personalizada, mas com piso fixo =
                // estoqueMinimo configurado (sem limite por código) e
                // recalculando o pool a cada linha.
                var poolPadraoAgora = _poolPadraoDisponivelAgora();
                resultado = _autoEncontrarMelhorComRepeticao(
                    poolPadraoAgora, valor, _faixaAutoAtual, _usosPadraoPorCod, null, _S.estoqueMinimo
                );
                resultado = _validarResultadoPadrao(resultado, _S.estoqueMinimo, _usosPadraoPorCod, _S.estoqueMinimo, _S.proibidosEmbutidos, _S.proibidosExtra);
            } else {
                var livres = disponiveis.filter(function(it) { return !usadosSession[it.codigo]; });
                resultado  = _autoEncontrarMelhor(livres, valor, _faixaAutoAtual);
                // Camada defensiva extra (modo padrão, sem lista personalizada):
                // o algoritmo já não repete código na mesma combinação, mas essa
                // revalidação protege contra qualquer anomalia (ex: estoque
                // alterado durante o processamento assíncrono/chunked da lista,
                // ou código duplicado no catálogo) — nunca deixa passar um
                // resultado que fira o estoque mínimo configurado.
                resultado = _validarResultadoPadrao(resultado, _S.estoqueMinimo, null, null, _S.proibidosEmbutidos, _S.proibidosExtra);
            }

            if (resultado && resultado.itens && resultado.itens.length > 0) {
                if (lpAtiva) {
                    // Lista personalizada: NÃO marca como usado no servidor — os
                    // códigos seguem disponíveis. Apenas acumula o consumo simulado
                    // de estoque, para respeitar o limite de parada configurado.
                    resultado.itens.forEach(function(it) {
                        _usosLPPorCod[it.codigo] = (_usosLPPorCod[it.codigo] || 0) + 1;
                    });
                } else if (reaproveitarAtivo) {
                    // Modo padrão com reaproveitamento: acumula o consumo simulado e
                    // SÓ marca como usado de fato (fila pro servidor) quando o
                    // código atingir o piso (estoqueMinimo) — ou seja, quando não
                    // houver mais sobra pra reaproveitar em linhas seguintes.
                    // Enquanto houver sobra acima do mínimo, o código continua
                    // disponível para reaparecer em outras linhas/combinações.
                    resultado.itens.forEach(function(it) {
                        _usosPadraoPorCod[it.codigo] = (_usosPadraoPorCod[it.codigo] || 0) + 1;
                        var esgotou = _qtdMaximaDisponivel(it, _usosPadraoPorCod, null, _S.estoqueMinimo) <= 0;
                        if (esgotou) {
                            usadosSession[it.codigo] = true; // some do pool mesmo dentro desta sessão
                            if (!_jaMarcado[it.codigo]) {
                                _jaMarcado[it.codigo] = true;
                                codsMarcados.push(it.codigo); // 1 marcação só, mesmo que reaproveitado várias vezes
                            }
                        }
                    });
                } else {
                    // Modo padrão original: cada item só pode entrar em uma
                    // combinação — marca nesta sessão e na fila de "usados" do servidor.
                    resultado.itens.forEach(function(it) {
                        usadosSession[it.codigo] = true;
                        codsMarcados.push(it.codigo);
                    });
                }
                // Agrupa repetições do mesmo código no formato "3*codigo" em vez
                // de listá-lo várias vezes seguidas
                var codigos = _formatarCodigosCompactado(resultado.itens);
                saida.push(linha + TAB + codigos);
                encontrados++;
            } else {
                saida.push(linha + TAB + '[NAO ENCONTRADO]');
                naoEncontrados++;
                if (lpAtiva) {
                    _linhasPendentesExcedente.push({ idx: saida.length - 1, linha: linha, valor: valor });
                }
            }
        }

        // Atualiza status de progresso enquanto processa
        if (idxLinha < totalLinhas) {
            statusEl.textContent = 'Processando... ' + idxLinha + '/' + totalLinhas;
            setTimeout(_processarProxima, 0);
            return;
        }

        // ── Reordena para EXIBIÇÃO: dentro de cada seção (delimitada por linhas
        // "Nome:"), as linhas [NAO ENCONTRADO] vêm primeiro, seguidas pelas
        // demais — o usuário vê de cara o que ainda precisa resolver, sem
        // precisar rolar a lista toda. IMPORTANTE: opera sobre uma CÓPIA,
        // nunca muta o array "saida" original — ele é referenciado por índice
        // em _linhasPendentesExcedente (revisão de excedente da lista
        // personalizada, mais abaixo); reordenar o array de verdade quebraria
        // essas referências e faria a revisão sobrescrever a linha errada.
        function _pareceCabecalhoSecao(linhaTxt) {
            var t = linhaTxt;
            while (t.length > 0 && t.charCodeAt(0) <= 32) t = t.slice(1);
            while (t.length > 0 && t.charCodeAt(t.length - 1) <= 32) t = t.slice(0, -1);
            if (!t.length) return false;
            var primeiroCode = t.charCodeAt(0);
            var ehDigito = primeiroCode >= 48 && primeiroCode <= 57;
            return !ehDigito && t.charAt(t.length - 1) === ':';
        }
        function _saidaReordenadaParaExibicao() {
            var resultado    = [];
            var secaoAtual   = null; // { naoEncontrados: [...], outros: [...] }
            function fecharSecao() {
                if (!secaoAtual) return;
                resultado = resultado.concat(secaoAtual.naoEncontrados, secaoAtual.outros);
                secaoAtual = null;
            }
            for (var _si = 0; _si < saida.length; _si++) {
                var l = saida[_si];
                if (_pareceCabecalhoSecao(l)) {
                    fecharSecao();
                    resultado.push(l); // cabeçalho sempre no topo da própria seção
                    secaoAtual = { naoEncontrados: [], outros: [] };
                    continue;
                }
                if (!secaoAtual) secaoAtual = { naoEncontrados: [], outros: [] }; // linhas antes do 1º cabeçalho
                if (l.indexOf('[NAO ENCONTRADO]') !== -1) {
                    secaoAtual.naoEncontrados.push(l);
                } else {
                    secaoAtual.outros.push(l);
                }
            }
            fecharSecao();
            return resultado;
        }

        // Finalização — todas as linhas processadas
        outputEl.value        = _saidaReordenadaParaExibicao().join(NL);
        resWrap.style.display = 'block';
        copyBtn.style.display = '';

        function _atualizarMsgFinal() {
            var msg = '\u2713 Processado: ' + encontrados + ' linha' + (encontrados === 1 ? '' : 's') + ' com c\u00f3digos';
            if (naoEncontrados > 0) msg += ', ' + naoEncontrados + ' n\u00e3o encontrado' + (naoEncontrados === 1 ? '' : 's');
            if (lpAtiva) {
                msg += ' \u2014 lista personalizada (c\u00f3digos n\u00e3o marcados como usados)';
            } else if (reaproveitarAtivo) {
                msg += ' \u2014 reaproveitando c\u00f3digos (s\u00f3 marca como usado quando esgotar)';
                if (codsMarcados.length > 0) msg += ' \u2014 clique em "Copiar resultado" para confirmar';
            } else if (codsMarcados.length > 0) {
                msg += ' \u2014 clique em "Copiar resultado" para confirmar';
            }
            if (!lpAtiva && naoEncontrados > 0 && _tentativaExtensaoAtual >= MAX_TENTATIVAS_EXTENSAO) {
                msg += ' \u2014 limite de ' + MAX_TENTATIVAS_EXTENSAO + ' tentativa(s) de busca estendida atingido';
            }
            statusEl.textContent = msg;
            statusEl.className   = naoEncontrados > 0 ? 'auto-status er' : 'auto-status ok';
        }
        _atualizarMsgFinal();

        // Armazena os códigos — só marca como usado quando o usuário copiar o resultado
        _autoCodsParaMarcar = codsMarcados;

        // Botão só é reabilitado aqui se NENHUM modal pendente vai aparecer a seguir
        // (revisão de excedente da lista personalizada, ou extensão de busca no
        // banco). Enquanto um desses modais estiver pendente, o botão permanece
        // desabilitado — evita que o usuário clique "Iniciar" de novo e crie um
        // segundo processamento concorrente que sobrescreveria a saída do primeiro.
        var _teraExcedentePendente = lpAtiva && _linhasPendentesExcedente.length > 0;
        var _teraExtensaoPendente  = !lpAtiva && naoEncontrados > 0 && _tentativaExtensaoAtual < MAX_TENTATIVAS_EXTENSAO;
        if (!_teraExcedentePendente && !_teraExtensaoPendente) {
            btn.disabled = false;
        }

        // ── Formata os itens de uma combinação de forma legível para o modal ──────
        // Ex.: "3x 08395 (R$16,90 cada)" + " + 1x 00123 (R$5,00 cada)"
        function _formatarItensHumano(itens) {
            var contagem = {};
            var ordem    = [];
            itens.forEach(function(it) {
                if (!contagem[it.codigo]) { contagem[it.codigo] = { qtd: 0, preco: Number(it.preco || 0) }; ordem.push(it.codigo); }
                contagem[it.codigo].qtd++;
            });
            return ordem.map(function(cod) {
                var c = contagem[cod];
                return c.qtd + 'x ' + cod + ' (R$' + c.preco.toFixed(2).replace('.', ',') + ' cada)';
            }).join(' + ');
        }

        // ── Lista personalizada: revisão das linhas sem combinação exata ──────────
        // Para cada linha marcada como [NAO ENCONTRADO], busca (sem o teto de
        // +R$40) a combinação que EXCEDE o valor pedido com a menor diferença
        // possível, usando só itens da própria lista personalizada (a busca já
        // testa item sozinho E combinações de itens diferentes — "item + item" —
        // via _autoEncontrarMelhorComRepeticao, que resolve por DP/guloso sobre
        // TODO o pool disponível, não só o item isolado). Pergunta ao usuário,
        // uma linha por vez, se aceita usar essa combinação excedente.
        //
        // FIX (2026-07-19): se NEM combinação excedente for encontrada — ou
        // seja, o pool da lista personalizada está genuinamente esgotado pra
        // aquele valor, mesmo tentando toda combinação possível — a linha não
        // é mais pulada silenciosamente. Agora avisa explicitamente que todas
        // as possibilidades foram tentadas e pergunta se o usuário quer
        // remover da lista o(s) item(ns) que já bateram no estoque de parada
        // (ou zero), ou prefere lidar com essa linha manualmente (fica
        // [NAO ENCONTRADO] no resultado, sem remover nada da lista).
        //
        // Recalcula o pool a cada passo, pra refletir confirmações anteriores
        // desta mesma revisão (remoções feitas aqui somem do pool imediatamente).
        function _processarProximoExcedente(idxPendente) {
            if (idxPendente >= _linhasPendentesExcedente.length) {
                btn.disabled = false; // revisão concluída — libera o botão
                // Só agora "saida" está definitivamente estável (a revisão de
                // excedente já não vai mutar mais nenhum índice) — reordena pra
                // exibição final. "outputEl.value" já tinha sido atualizado várias
                // vezes durante a revisão (sem reordenar, ver callback de aceite
                // abaixo), então este é o ÚNICO ponto que precisa reordenar de fato.
                outputEl.value = _saidaReordenadaParaExibicao().join(NL);
                _atualizarMsgFinal(); // tallies finais após a revisão
                return;
            }

            var pend = _linhasPendentesExcedente[idxPendente];
            var poolExcedenteAgora = _poolLpDisponivelAgora();
            var resExc = _autoEncontrarMelhorComRepeticao(
                poolExcedenteAgora, pend.valor, FAIXA_EXCEDENTE_LP, _usosLPPorCod, _estoqueParadaPorCod
            );
            // Mesma camada defensiva da busca normal — ver comentário acima.
            resExc = _validarResultadoLista(resExc, _usosLPPorCod, _estoqueParadaPorCod);

            if (resExc && resExc.itens && resExc.itens.length) {
                _modalConfirm(
                    'Linha: "' + pend.linha.trim() + '" \u2014 valor R$' + pend.valor.toFixed(2).replace('.', ',') +
                    '\\n\\nNenhuma combina\u00e7\u00e3o dentro da faixa normal (+R$40) foi encontrada.' +
                    '\\n\\nDeseja usar esta combina\u00e7\u00e3o da lista personalizada, que excede o valor pedido em R$' +
                    resExc.diff.toFixed(2).replace('.', ',') + ' (soma R$' + resExc.soma.toFixed(2).replace('.', ',') + ')?' +
                    '\\n\\n' + _formatarItensHumano(resExc.itens),
                    function() {
                        resExc.itens.forEach(function(it) {
                            _usosLPPorCod[it.codigo] = (_usosLPPorCod[it.codigo] || 0) + 1;
                        });
                        saida[pend.idx] = pend.linha + TAB + _formatarCodigosCompactado(resExc.itens);
                        encontrados++;
                        naoEncontrados--;
                        outputEl.value = saida.join(NL);
                        _processarProximoExcedente(idxPendente + 1);
                    },
                    function() {
                        _processarProximoExcedente(idxPendente + 1);
                    },
                    {
                        titulo:  'Combina\u00e7\u00e3o excede o valor (' + (idxPendente + 1) + '/' + _linhasPendentesExcedente.length + ')',
                        okLabel: 'Usar esta combina\u00e7\u00e3o',
                        okClass: 'btn btn-p btn-sm'
                    }
                );
                return;
            }

            // Nada encontrado — nem item sozinho, nem combinação, nem excedente.
            // Identifica quais itens da lista personalizada já bateram no piso
            // (estoque de parada configurado, ou zero quando não configurado):
            // são os candidatos naturais a remover, já que são eles que estão
            // impedindo qualquer combinação de fechar essa linha.
            var _esgotados = poolPersonalizado.filter(function(it) {
                return _qtdMaximaDisponivel(it, _usosLPPorCod, _estoqueParadaPorCod) <= 0;
            });

            if (!_esgotados.length) {
                // Pool não está esgotado — o problema é outro (ex: nenhum preço
                // chega nem perto do valor pedido). Não há o que remover; avisa
                // via toast (não trava a revisão com um modal sem ação útil) e segue.
                toast(
                    'Linha "' + pend.linha.trim() + '" (R$' + pend.valor.toFixed(2).replace('.', ',') +
                    '): nenhuma combina\u00e7\u00e3o poss\u00edvel foi encontrada na lista personalizada.',
                    5000
                );
                _processarProximoExcedente(idxPendente + 1);
                return;
            }

            // Distingue, por item, o MOTIVO real do esgotamento — essencial pra
            // não confundir o usuário: o estoque real no banco (Firebird) NUNCA
            // muda por causa deste processamento (esta ferramenta é somente-
            // leitura). O que esgota é um contador SIMULADO de consumo
            // (_usosLPPorCod), que só existe durante este clique em "Iniciar" —
            // ele soma quantas vezes o código já foi usado em linhas ANTERIORES
            // desta mesma lista, pra nunca sugerir mais unidades do que o
            // estoque realmente suporta.
            var _linhasItensScroll = [];
            var _temConsumoNestaExecucao = false;
            var _temLimiteJaAtingido     = false;
            _esgotados.forEach(function(it) {
                var usos = _usosLPPorCod[it.codigo] || 0;
                if (usos > 0) {
                    _temConsumoNestaExecucao = true;
                    _linhasItensScroll.push(
                        '\u2022 ' + it.codigo + ' \u2014 ' + it.descricao +
                        ' (usado ' + usos + 'x em linha(s) anterior(es) desta mesma lista)'
                    );
                } else {
                    _temLimiteJaAtingido = true;
                    _linhasItensScroll.push(
                        '\u2022 ' + it.codigo + ' \u2014 ' + it.descricao +
                        ' (j\u00e1 estava no limite antes de come\u00e7ar este processamento)'
                    );
                }
            });

            var _explicacaoMotivos = 'Motivo de cada item:';
            if (_temConsumoNestaExecucao) {
                _explicacaoMotivos +=
                    '\\n\\u2014 "usado Nx" = j\u00e1 foi consumido em linha(s) anterior(es) desta mesma execu\u00e7\u00e3o ' +
                    '(o estoque real no banco N\u00c3O mudou \u2014 esta ferramenta nunca escreve no Firebird; ' +
                    '\u00e9 s\u00f3 um contador interno pra n\u00e3o sugerir mais unidades do que sobra de verdade).';
            }
            if (_temLimiteJaAtingido) {
                _explicacaoMotivos +=
                    '\\n\\u2014 "j\u00e1 estava no limite" = estoque de parada (ou zero) atingido desde ANTES deste processamento come\u00e7ar.';
            }

            _modalConfirm(
                'Linha: "' + pend.linha.trim() + '" \u2014 valor R$' + pend.valor.toFixed(2).replace('.', ',') +
                '\\n\\nTentei todas as possibilidades (item sozinho, combina\u00e7\u00e3o com outros itens da lista, ' +
                'e at\u00e9 combina\u00e7\u00f5es que excedem o valor pedido), mas nenhum resultado foi encontrado.' +
                '\\n\\n' + _explicacaoMotivos,
                function() { // Sim — remove da lista personalizada
                    var _codsEsgotados = _esgotados.map(function(it) { return it.codigo; });
                    _removerCodigosListaPersonalizada(_codsEsgotados);
                    // Some do pool desta sessão também, pra não continuar sendo
                    // considerado (e tentado de novo) nas linhas restantes.
                    var _codsEsgotadosSet = {};
                    _codsEsgotados.forEach(function(c) { _codsEsgotadosSet[c] = true; });
                    disponiveis = disponiveis.filter(function(it) { return !_codsEsgotadosSet[it.codigo]; });
                    poolPersonalizado = poolPersonalizado.filter(function(it) { return !_codsEsgotadosSet[it.codigo]; });
                    _processarProximoExcedente(idxPendente + 1);
                },
                function() { // Não — usar manualmente (deixa como [NAO ENCONTRADO])
                    _processarProximoExcedente(idxPendente + 1);
                },
                {
                    titulo:      'Nenhuma combina\u00e7\u00e3o encontrada (' + (idxPendente + 1) + '/' + _linhasPendentesExcedente.length + ')',
                    okLabel:     'Remover da lista',
                    okClass:     'btn btn-d btn-sm',
                    itensScroll: _linhasItensScroll,
                    msgApos:     'Deseja remover esse(s) item(ns) da lista personalizada agora? ' +
                                 'Se preferir, cancele e resolva essa linha manualmente \u2014 ela fica marcada como [NAO ENCONTRADO].'
                }
            );
        }

        if (lpAtiva && _linhasPendentesExcedente.length > 0) {
            // Limite de segurança: com uma textarea muito grande e a lista
            // personalizada esgotada, poderiam sobrar centenas/milhares de linhas
            // pendentes — abrir um modal sequencial pra cada uma seria impraticável
            // (o usuário teria que clicar centenas de vezes). Revisa só as
            // primeiras MAX_REVISAO_EXCEDENTE; o restante continua [NAO ENCONTRADO].
            var MAX_REVISAO_EXCEDENTE = 50;
            if (_linhasPendentesExcedente.length > MAX_REVISAO_EXCEDENTE) {
                toast(
                    _linhasPendentesExcedente.length + ' linhas sem combina\u00e7\u00e3o \u2014 revisando ' +
                    'as primeiras ' + MAX_REVISAO_EXCEDENTE + ' (as demais continuam [NAO ENCONTRADO]).',
                    6000
                );
                _linhasPendentesExcedente = _linhasPendentesExcedente.slice(0, MAX_REVISAO_EXCEDENTE);
            }
            _processarProximoExcedente(0);
        }

        // ── Pergunta se quer estender a busca no banco quando há itens não encontrados ────
        // (substitui a antiga pergunta de "ampliar a faixa de preço", que não ajudava
        // quando o item simplesmente não estava entre os carregados — o problema
        // normalmente é cobertura do catálogo, não faixa de preço).
        // Só vale no modo padrão (sem lista personalizada): a lista personalizada já
        // restringe a busca de propósito a um conjunto fixo de códigos configurados —
        // ampliar o catálogo geral não faz sentido nesse contexto.
        if (!lpAtiva && naoEncontrados > 0 && _tentativaExtensaoAtual < MAX_TENTATIVAS_EXTENSAO) {
            var _proximaTentativa = _tentativaExtensaoAtual + 1;
            _modalConfirm(
                naoEncontrados + ' item' + (naoEncontrados === 1 ? '' : 's') +
                ' n\u00e3o encontrado' + (naoEncontrados === 1 ? '' : 's') +
                ' no cat\u00e1logo carregado.' +
                '\\n\\nDeseja estender a busca no banco por mais itens correspondentes?' +
                '\\n\\n(tentativa ' + _proximaTentativa + ' de ' + MAX_TENTATIVAS_EXTENSAO + ')',
                function() {
                    statusEl.textContent = 'Buscando mais itens no banco (tentativa ' +
                        _proximaTentativa + '/' + MAX_TENTATIVAS_EXTENSAO + ')...';
                    statusEl.className = 'auto-status';
                    btn.disabled = true;
                    _buscarMaisItensBanco(function(ok, qtd, temMais) {
                        if (!ok) {
                            toast('N\u00e3o foi poss\u00edvel buscar mais itens no banco.', 4000);
                            btn.disabled = false;
                            return;
                        }
                        if (qtd === 0) {
                            toast('O cat\u00e1logo do banco j\u00e1 est\u00e1 totalmente carregado \u2014 nada mais para buscar.', 5000);
                            btn.disabled = false;
                            return;
                        }
                        toast(qtd + ' item(ns) adicional(is) carregado(s) do banco.' +
                              (temMais ? '' : ' (cat\u00e1logo esgotado)'), 4000);
                        // Limpa resultado anterior e reprocessa a lista original com o catálogo ampliado
                        resWrap.style.display = 'none';
                        copyBtn.style.display = 'none';
                        _autoCodsParaMarcar   = [];
                        // FIX (achado #G da revisão 2026-08-06): esta linha chamava
                        // iniciarModoAuto(...) — a função PÚBLICA, que sempre começa
                        // forçando uma sincronização completa com o banco
                        // (_sincronizarEstoqueTempoReal → POST /api/atualizar →
                        // carregarItens() completo no servidor). Duas consequências
                        // destrutivas, nenhuma delas intencional:
                        //   1) carregarItens() SUBSTITUI _itens inteiro pela primeira
                        //      "página" (maxItens) fresca do servidor — descartando
                        //      exatamente o lote que _buscarMaisItensBanco acabou de
                        //      mesclar duas linhas acima. A extensão nunca "pegava".
                        //   2) o servidor não guarda mais cursor global (ver achado
                        //      #F), mas mesmo antes dessa mudança o efeito já era o
                        //      mesmo: qualquer nova tentativa de "buscar mais no
                        //      banco" pedia de novo o offset baseado em _itens.length,
                        //      que tinha acabado de encolher de volta a maxItens —
                        //      ou seja, a 2ª tentativa buscava o MESMO lote da 1ª,
                        //      nunca avançava para o próximo, até esgotar as 5
                        //      tentativas permitidas (MAX_TENTATIVAS_EXTENSAO) sem
                        //      nunca alcançar itens além da segunda "página".
                        // Chamando _iniciarModoAutoAposSync(...) diretamente (pulando
                        // o resync), o merge feito por _buscarMaisItensBanco é
                        // preservado e cada tentativa avança para um lote novo.
                        // Resync completo aqui é desnecessário de qualquer forma: os
                        // itens que já estavam em _itens acabaram de ser confirmados
                        // frescos pelo próprio iniciarModoAuto() que iniciou este
                        // processamento, poucos segundos atrás.
                        _iniciarModoAutoAposSync(_faixaAutoAtual, _proximaTentativa);
                    });
                },
                function() {
                    btn.disabled = false; // usuário cancelou — libera o botão
                },
                {
                    titulo:  'Itens n\u00e3o encontrados',
                    okLabel: 'Buscar mais no banco',
                    okClass: 'btn btn-p btn-sm'
                }
            );
        }
    }

    // Inicia o processamento assíncrono (yield imediato para o browser renderizar)
    setTimeout(_processarProxima, 0);
}

// ── Sticky thead via JS (contorna overflow-x:auto que quebra position:sticky) ─
(function() {
    var _rafId = null;
    var _btnTopoVisivel = false; // cache para evitar tocar no DOM toda vez sem necessidade
    function _doSyncThead() {
        _rafId = null;
        var tw    = document.getElementById('tw');
        var thead = tw ? tw.querySelector('thead') : null;
        if (!tw || !thead) return;
        var hEl = document.querySelector('.hdr');
        var cEl = document.querySelector('.ctrl');
        var sEl = document.querySelector('.stats');
        var stickyTop = (hEl ? hEl.offsetHeight : 57) +
                        (cEl ? cEl.offsetHeight : 67) +
                        (sEl ? sEl.offsetHeight : 28);
        var scrollY    = window.scrollY || window.pageYOffset || 0;
        var twAbsTop   = tw.getBoundingClientRect().top + scrollY;
        var translateY = Math.max(0, scrollY + stickyTop - twAbsTop);
        // Não passa do final da tbody
        var tbody = tw.querySelector('tbody');
        if (tbody) {
            var maxY = tbody.offsetHeight;
            if (translateY > maxY) translateY = maxY;
        }
        thead.style.transform = translateY > 0 ? 'translateY(' + translateY + 'px)' : '';
        thead.style.boxShadow = translateY > 0 ? '0 3px 10px rgba(0,0,0,.45)' : '';

        // Botão "voltar ao topo": aparece após rolar 1 viewport
        var deveAparecer = scrollY > (window.innerHeight || 600) * 0.6;
        if (deveAparecer !== _btnTopoVisivel) {
            _btnTopoVisivel = deveAparecer;
            var btnTopo = document.getElementById('btnTopo');
            if (btnTopo) btnTopo.classList.toggle('on', deveAparecer);
        }
    }
    function _syncThead() {
        if (_rafId) return;
        _rafId = requestAnimationFrame(_doSyncThead);
    }
    window.addEventListener('scroll', _syncThead, { passive: true });
    window.addEventListener('resize', _syncThead);
    // Expõe para renderTabela chamar após re-render
    window._syncThead = _syncThead;
})();

// ── Voltar ao topo (scroll suave) ─────────────────────────────────────────────
function voltarAoTopo() {
    // scrollTo com behavior:'smooth' é suportado em todos os browsers modernos;
    // fallback defensivo para ambientes muito antigos que ignoram o objeto de opções
    try {
        window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
    } catch (_e) {
        window.scrollTo(0, 0);
    }
}

// ── Inicialização ─────────────────────────────────────────────────────────────
function ajustarStickyOffsets() {
    var r = document.documentElement.style;
    var hEl = document.querySelector('.hdr');
    var cEl = document.querySelector('.ctrl');
    var sEl = document.querySelector('.stats');
    if (hEl) r.setProperty('--hdr-h',   hEl.offsetHeight   + 'px');
    if (cEl) r.setProperty('--ctrl-h',  cEl.offsetHeight  + 'px');
    if (sEl) r.setProperty('--stats-h', sEl.offsetHeight + 'px');
}
// achado #H da revisão 2026-08-06: o listener de "resize" chamava
// ajustarStickyOffsets() direto, sem throttle — "resize" pode disparar
// dezenas de vezes por segundo durante um redimensionamento contínuo de
// janela (ou rotação de tela em tablet), e cada disparo aqui faz 3 leituras
// de offsetHeight (força reflow síncrono) + 3 escritas de custom property.
// Mesmo throttle por requestAnimationFrame já usado em _syncThead (scroll),
// aplicado aqui: no máximo 1 execução por frame, não 1 por evento.
var _stickyOffsetsRaf = null;
function _ajustarStickyOffsetsThrottled() {
    if (_stickyOffsetsRaf) return;
    _stickyOffsetsRaf = requestAnimationFrame(function() {
        _stickyOffsetsRaf = null;
        ajustarStickyOffsets();
    });
}
// ── Modal de Configurações ────────────────────────────────────────────────────
function abrirConfigs() {
    var ov = document.getElementById('cfgOv');
    if (!ov) return;
    ov.classList.add('on');
    document.getElementById('cfgStatus').textContent = '';
    document.getElementById('cfgStatus').className = 'cfg-status';
    _carregarConfigs();
}

function fecharConfigs() {
    var ov = document.getElementById('cfgOv');
    if (ov) ov.classList.remove('on');
}

function fecharConfigsSe(e) {
    if (e && e.target === document.getElementById('cfgOv')) fecharConfigs();
}

function _cfgSetVal(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = (val != null) ? String(val) : '';
}

function _cfgGetVal(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
}

function _carregarConfigs(tentativa) {
    var MAX_TENT = 3;
    tentativa = (typeof tentativa === 'number' && tentativa > 0) ? tentativa : 1;

    var st  = document.getElementById('cfgStatus');
    var btn = document.getElementById('cfgSalvarBtn');
    if (st)  { st.textContent = tentativa > 1 ? ('Tentativa ' + tentativa + ' de ' + MAX_TENT + '...') : 'Carregando...'; st.className = 'cfg-status'; }
    if (btn) btn.disabled = true;

    apiFetch('/api/config').then(function(r) {
        // Falha de rede (servidor nao respondeu) — tenta novamente com backoff linear
        if (!r) {
            if (tentativa < MAX_TENT) {
                if (st) st.textContent = 'Sem resposta, aguardando... (' + tentativa + '/' + MAX_TENT + ')';
                setTimeout(function() { _carregarConfigs(tentativa + 1); }, 600 * tentativa);
                return;
            }
            // Esgotou tentativas — exibe botao de retry manual
            if (btn) btn.disabled = false;
            if (st) {
                st.className = 'cfg-status er';
                st.innerHTML = 'Servidor n\u00e3o respondeu. ' +
                    '<button class="btn btn-s btn-sm" style="margin-left:8px;padding:2px 10px;font-size:11px" ' +
                    'onclick="_carregarConfigs(1)">Tentar novamente</button>';
            }
            return;
        }
        // Resposta com erro HTTP
        if (!r.ok) {
            if (btn) btn.disabled = false;
            if (st) { st.textContent = 'Erro ao carregar configura\u00e7\u00f5es.'; st.className = 'cfg-status er'; }
            return;
        }

        if (btn) btn.disabled = false;

        // Preenche os campos com os valores atuais
        _cfgSetVal('cfgFbHost',  r.fbHost       || '');
        _cfgSetVal('cfgFbPort',  r.fbPort       != null ? r.fbPort  : '');
        _cfgSetVal('cfgFdbPath', r.fdbPath      || '');
        _cfgSetVal('cfgFbUser',  r.fbUser       || '');
        // SEGURANÇA: a senha nunca é devolvida pela API — o campo fica em
        // branco (deixar em branco ao salvar mantém a senha atual). O
        // placeholder indica se já existe uma senha configurada.
        var _campoSenha = document.getElementById('cfgFbPass');
        if (_campoSenha) {
            _campoSenha.value = '';
            _campoSenha.placeholder = r.senhaConfigurada
                ? '(senha já configurada \u2014 deixe em branco para manter)'
                : 'masterkey';
        }
        _cfgSetVal('cfgPorta',   r.portaEstoque != null ? r.portaEstoque : '');
        _cfgSetVal('cfgAppName', r.appName      || '');
        _cfgSetVal('cfgEstMin',  r.estoqueMinimo != null ? r.estoqueMinimo : '');
        _cfgSetVal('cfgMaxItens',r.maxItens      != null ? r.maxItens      : '');
        _cfgSetVal('cfgProib',   Array.isArray(r.proibidosExtra) ? r.proibidosExtra.join('\\n') : '');

        // Popula lista de proibidos embutidos (usa API ou fallback de _S)
        var lista = (r.proibidosEmbutidos && r.proibidosEmbutidos.length)
            ? r.proibidosEmbutidos
            : (_S.proibidosEmbutidos || []);
        var countEl = document.getElementById('cfgProibCount');
        var embEl   = document.getElementById('cfgProibEmb');
        if (countEl) countEl.textContent = lista.length;
        if (embEl)   embEl.textContent   = lista.join(', ');

        if (st) { st.textContent = ''; st.className = 'cfg-status'; }
    }).catch(function(e) {
        if (btn) btn.disabled = false;
        if (st) { st.textContent = 'Erro: ' + (e && e.message ? e.message : String(e)); st.className = 'cfg-status er'; }
    });
}

function salvarConfigs() {
    var btn = document.getElementById('cfgSalvarBtn');
    var st  = document.getElementById('cfgStatus');
    if (btn) btn.disabled = true;
    if (st)  { st.textContent = 'Salvando...'; st.className = 'cfg-status'; }

    // Normaliza o campo de proibidos (aceita v\u00edrgula ou linha)
    var rawProib = (_cfgGetVal('cfgProib') || '').trim();
    var proibLista = [];
    if (rawProib) {
        var sep = rawProib.indexOf('\\n') !== -1 ? '\\n' : ',';
        proibLista = rawProib.split(sep)
            .map(function(p) { return p.trim().toUpperCase(); })
            .filter(function(p) { return p.length > 0; });
    }

    var fbPortVal  = parseInt(_cfgGetVal('cfgFbPort')  || '3050', 10);
    var httpPortVal = parseInt(_cfgGetVal('cfgPorta')  || '7888', 10);
    var estMinRaw   = _cfgGetVal('cfgEstMin');
    var estMinVal   = estMinRaw !== '' && estMinRaw != null ? parseFloat(estMinRaw) : 5;
    var maxItensRaw = _cfgGetVal('cfgMaxItens');
    var maxItensVal = maxItensRaw !== '' && maxItensRaw != null ? parseInt(maxItensRaw, 10) : 2000;

    // Valida portas no cliente antes de enviar
    if (isNaN(fbPortVal)  || fbPortVal  < 1024 || fbPortVal  > 65534) {
        if (st) { st.textContent = 'Porta Firebird inv\u00e1lida (1024\u201365534).'; st.className = 'cfg-status er'; }
        if (btn) btn.disabled = false;
        return;
    }
    if (isNaN(httpPortVal) || httpPortVal < 1024 || httpPortVal > 65534) {
        if (st) { st.textContent = 'Porta HTTP inv\u00e1lida (1024\u201365534).'; st.className = 'cfg-status er'; }
        if (btn) btn.disabled = false;
        return;
    }
    if (isNaN(estMinVal) || estMinVal < 0 || estMinVal > 9999) {
        if (st) { st.textContent = 'Estoque m\u00ednimo inv\u00e1lido (0\u20139999).'; st.className = 'cfg-status er'; }
        if (btn) btn.disabled = false;
        return;
    }
    if (isNaN(maxItensVal) || maxItensVal < 100 || maxItensVal > 20000) {
        if (st) { st.textContent = 'M\u00e1x. itens inv\u00e1lido (100\u201320000).'; st.className = 'cfg-status er'; }
        if (btn) btn.disabled = false;
        return;
    }

    var payload = {
        fbHost:         (_cfgGetVal('cfgFbHost')  || '').trim(),
        fbPort:         fbPortVal,
        fdbPath:        (_cfgGetVal('cfgFdbPath') || '').trim(),
        fbUser:         (_cfgGetVal('cfgFbUser')  || '').trim(),
        fbPassword:     (_cfgGetVal('cfgFbPass')  || '').trim(),
        portaEstoque:   httpPortVal,
        appName:        (_cfgGetVal('cfgAppName') || '').trim(),
        estoqueMinimo:  estMinVal,
        maxItens:       maxItensVal,
        proibidosExtra: proibLista.join('\\n')
    };

    apiFetch('/api/config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
    }).then(function(r) {
        if (btn) btn.disabled = false;
        if (!r || !r.ok) {
            var msg = r ? (r.erro || 'Erro ao salvar.') : 'Sem resposta do servidor.';
            if (st) { st.textContent = msg; st.className = 'cfg-status er'; }
            return;
        }
        var cls = r.reiniciarNecessario ? 'warn' : 'ok';
        if (st) { st.textContent = r.mensagem || 'Salvo com sucesso.'; st.className = 'cfg-status ' + cls; }
        // Propaga o novo estoque mínimo para o estado do cliente e para o cabeçalho
        _S.estoqueMinimo = estMinVal;
        var hdrEstMin = document.getElementById('hdrEstMin');
        if (hdrEstMin) hdrEstMin.textContent = estMinVal;
        // Propaga o novo maxItens imediatamente
        _S.maxItens = maxItensVal;
        var hdrMaxItens = document.getElementById('hdrMaxItens');
        if (hdrMaxItens) hdrMaxItens.textContent = maxItensVal;
        // Regenera as 5 opções do select e reposiciona a seleção
        _atualizarSelLimite(maxItensVal);
        // Se dados foram recarregados no servidor, atualiza a tabela ap\u00f3s breve delay
        if (r.mensagem && r.mensagem.indexOf('recarregado') !== -1) {
            setTimeout(function() { _dadosFingerprint = ''; carregarItens(); }, 1400);
        }
    }).catch(function(e) {
        if (btn) btn.disabled = false;
        if (st) { st.textContent = 'Erro: ' + (e && e.message ? e.message : String(e)); st.className = 'cfg-status er'; }
    });
}

// Fecha modal de configurações com Escape
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        var ov = document.getElementById('cfgOv');
        if (ov && ov.classList.contains('on')) { fecharConfigs(); e.stopPropagation(); }
    }
});

document.addEventListener("DOMContentLoaded", function() {
    // Modo leve: desliga transições/animações via uma única classe no <html>
    // (as regras estão no CSS, ver bloco "DESEMPENHO EM MÁQUINAS FRACAS").
    // Aplicado quando o hardware é modesto OU quando o sistema operacional
    // pede menos movimento — respeitar essa preferência é acessibilidade,
    // não só desempenho.
    if (_perfil.fraca || _perfil.reduzirMovimento) {
        document.documentElement.classList.add('perf-baixa');
    }

    // Cacheia referências DOM para evitar getElementById a cada keystroke
    _elBusca  = document.getElementById("txtBusca");
    _elPrc    = document.getElementById("numPrc");
    _elGrupar = document.getElementById("chkGrupar");
    _elAcima  = document.getElementById("chkAcima");
    _elBuscaMulti = document.getElementById("txtBuscaMulti");
    // Popula o select de limite com 5 opções calculadas a partir de _S.maxItens
    _atualizarSelLimite(_S.maxItens);
    // Inicializa o label de sort no header com o valor persistido
    _atualizarHdrSortLabel();
    _restaurarPrefReaproveitar();
    carregarItens();
    // Carrega a lista personalizada salva no servidor (lista-personalizada.json)
    _carregarListaPersonalizadaServidor();

    // ── SSE: recebe notificações do servidor em vez de poluir com polling ───
    // O servidor emite "dados" após: carregarItens, marcar-usado, resetar.
    // Quando o banco ainda está carregando (dados.carregando), fazemos um
    // único poll de /api/itens para obter o estado completo; depois o SSE
    // assume e não há mais polling periódico.
    if (typeof EventSource !== 'undefined') {
        var _sse = new EventSource('/api/sse');
        _sse.addEventListener('dados', function(e) {
            try {
                var info = JSON.parse(e.data);
                if (info.carregando) {
                    // Banco em carregamento: continua polling simples até terminar
                    clearTimeout(_pollT);
                    _pollT = setTimeout(carregarItens, POLL_INTERVALO_MS);
                } else {
                    // Dados mudaram — recarrega imediatamente sem poll periódico
                    clearTimeout(_pollT);
                    carregarItens();
                }
            } catch (_) {}
        });
        _sse.onerror = function() {
            // SSE caiu (rede temporária, servidor reiniciando) — fallback para
            // um único poll após 3s; quando reconectar, o EventSource se
            // reconnecta automaticamente (comportamento padrão do browser)
            clearTimeout(_pollT);
            _pollT = setTimeout(carregarItens, 3000);
        };
    } else {
        // Navegador não suporta EventSource (raro) — fallback para polling
        _pollT = setTimeout(carregarItens, POLL_INTERVALO_MS);
    }

    setTimeout(function() {
        ajustarStickyOffsets();
        if (window._syncThead) window._syncThead();
    }, 80);
    window.addEventListener("resize", _ajustarStickyOffsetsThrottled);
});
</script>
</body>
</html>`;
    return _htmlCache;
}

// Aquece o cache do HTML logo após o startup (antes da 1ª requisição)
setImmediate(function() { try { gerarHTML(); } catch (_) {} });

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: ler body da requisição HTTP com limite de tamanho
// ─────────────────────────────────────────────────────────────────────────────
// achado #C da revisão 2026-08-06: a versão anterior fazia `body += chunk`,
// concatenando um Buffer numa string a cada evento "data". Isso força uma
// decodificação UTF-8 PARCIAL a cada chunk — se um caractere multibyte
// (qualquer acentuação, "é", "ç", etc.) for cortado exatamente na fronteira
// entre dois chunks TCP, cada metade é decodificada isoladamente e vira
// U+FFFD ("�"), corrompendo o texto de forma silenciosa (sem erro, sem log).
// Como a maioria dos bodies desta API é pequena (cabe em 1 chunk) o bug quase
// nunca se manifestava em teste manual — mas span de rede/proxy pode
// fragmentar em chunks menores a qualquer momento, especialmente em bodies
// maiores (ex.: POST /api/lista-personalizada, até 64 KB). Corrigido
// acumulando Buffers brutos e decodificando UTF-8 uma ÚNICA vez no final,
// sobre o payload completo — nunca corta um caractere ao meio. O limite de
// tamanho também passa a contar bytes reais (chunk.length) em vez do
// `.length` de uma string (que conta unidades UTF-16, não bytes — impreciso
// para texto acentuado).
function lerBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const limite   = maxBytes || 1024 * 16; // 16 KB máx padrão
        const pedacos   = [];
        let totalBytes  = 0;
        let abortado    = false;

        req.on("data", chunk => {
            if (abortado) return;
            totalBytes += chunk.length;
            if (totalBytes > limite) {
                abortado = true;
                try { req.destroy(); } catch (_) {}
                reject(new Error("Body excede " + limite + " bytes."));
                return;
            }
            pedacos.push(chunk);
        });
        req.on("end",   () => { if (!abortado) resolve(Buffer.concat(pedacos).toString("utf8")); });
        req.on("error", e  => { if (!abortado) reject(e); });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLERS DE ROTA
// ─────────────────────────────────────────────────────────────────────────────
// Por que cada rota é uma função nomeada em vez de um bloco if/else dentro do
// listener do servidor: o listener único acumulava TODAS as rotas (10+) numa
// única função, chegando a complexidade ciclomática >100 — qualquer alteração
// em uma rota exigia entender o fluxo de controle de todas as outras ao redor.
// Como função independente, cada rota fica testável e legível isoladamente,
// e adicionar uma rota nova não aumenta a complexidade das existentes.
//
// Assinatura comum: async function handleXxx(req, res, json, erro)
//   json(dados, status?) — responde com JSON (status default 200)
//   erro(msg, status?)   — responde com {ok:false, erro:msg} (status default 500)
// Ambos já fechados sobre o `res` da requisição atual (ver dispatchRequest).

async function handleGetRoot(req, res, json, erro) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(gerarHTML());
}

// "Sessão" de busca estendida para o Modo Automático: retorna o próximo lote
// de itens do catálogo completo (_catalogoCompleto), a partir do offset que
// o PRÓPRIO CLIENTE informa (?offset=N — tipicamente quantos itens ele já
// tem carregados). Lote limitado a LIMITE_SESSAO_BUSCA para não travar o
// navegador com um payload grande de uma vez. Rota totalmente sem estado no
// servidor — ver achado #F no comentário de _catalogoCompleto, acima.
// ─────────────────────────────────────────────────────────────────────────────
// SSE — Server-Sent Events (substitui o polling de 1800ms no cliente)
// O cliente abre EventSource('/api/sse') e recebe "dados" quando o catálogo
// muda (após carregarItens, marcar-usado, resetar-usados) — em vez de
// consultar /api/itens a cada 1,8s independente de haver mudança.
// ─────────────────────────────────────────────────────────────────────────────
const _sseClients = new Set();  // Set<{res, intervalo}> — um por aba aberta

// Cleanup único e centralizado de um cliente SSE: remove do Set e cancela o
// timer de ping. Usado nos 3 pontos onde um cliente pode "sair" (escrita
// falhou em emitirEventoSse, ping falhou, ou a conexão fechou) — antes cada
// um repetia a mesma dupla remoção/clearInterval; achado de auditoria: o
// catch de emitirEventoSse fazia a remoção do Set mas NÃO cancelava
// cliente.intervalo, deixando um setInterval órfão vivo por até 25s (até o
// próprio ping falhar e se autolimpar) — inofensivo na prática (autocura),
// mas inconsistente. Centralizar remove a duplicação E a inconsistência.
function _removerClienteSse(cliente) {
    _sseClients.delete(cliente);
    clearInterval(cliente.intervalo);
}

function emitirEventoSse(evento, dados) {
    const msg = "event: " + evento + "\ndata: " + JSON.stringify(dados || {}) + "\n\n";
    for (const cliente of _sseClients) {
        try { cliente.res.write(msg); } catch (_) { _removerClienteSse(cliente); }
    }
}

async function handleSse(req, res) {
    res.writeHead(200, {
        "Content-Type":  "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
        "X-Accel-Buffering": "no"  // evita buffer em proxies nginx
    });
    res.flushHeaders();

    // `cliente` é declarado ANTES do setInterval que o referencia (achado #3
    // da revisão 2026-07-11: antes a ordem era invertida — funcionava porque
    // o callback só roda 25s depois, quando `cliente` já existe, mas forçava
    // o leitor a pular pra frente pra entender a referência).
    const cliente = { res, intervalo: null };
    _sseClients.add(cliente);

    // Ping a cada 25s — mantém o TCP vivo e avisa o cliente se cair
    cliente.intervalo = setInterval(function() {
        try { res.write(": ping\n\n"); } catch (_) { _removerClienteSse(cliente); }
    }, 25000);

    // Notifica o estado atual imediatamente ao conectar
    res.write("event: dados\ndata: " + JSON.stringify({ carregando: _carregando, total: _itensBrutos.length }) + "\n\n");

    req.once("close", function() { _removerClienteSse(cliente); });
}

async function handleBuscarMaisItens(req, res, json, erro) {
    if (!_catalogoCompleto.length) {
        json({ ok: true, itens: [], temMais: false, totalCatalogo: 0, proximoOffset: 0 });
        return;
    }

    // offset vem do cliente (quantos itens ele já tem) — nunca de um contador
    // global no servidor. Entrada inválida/ausente cai em 0 (reinicia do
    // início do catálogo estendido) em vez de quebrar a requisição.
    let offsetPedido = 0;
    try {
        const urlReq = new URL(req.url || "/", "http://localhost:" + PORTA);
        const raw    = parseInt(urlReq.searchParams.get("offset") || "0", 10);
        if (Number.isFinite(raw) && raw >= 0) offsetPedido = raw;
    } catch (_) { /* URL malformada — segue com offsetPedido = 0 */ }

    const inicio = Math.min(offsetPedido, _catalogoCompleto.length);
    const fim    = Math.min(inicio + LIMITE_SESSAO_BUSCA, _catalogoCompleto.length);
    const lote   = _catalogoCompleto.slice(inicio, fim).map(item => ({
        codigo:      item.codigo,
        descricao:   item.descricao,
        codbarras:   item.codbarras,
        estoque:     item.estoque,
        preco:       item.preco,
        ultimaVenda: item.ultimaVenda,
        usado:       !!_usados[item.codigo]
    }));
    logTs("Busca estendida: sess\u00e3o serviu " + lote.length + " item(ns) (\u00edndices " +
          inicio + "\u2013" + (fim - 1) + " de " + _catalogoCompleto.length + ", offset pedido=" + offsetPedido + ").");
    json({
        ok:            true,
        itens:         lote,
        proximoOffset: fim, // cliente usa este valor na próxima chamada
        temMais:       fim < _catalogoCompleto.length,
        totalCatalogo: _catalogoCompleto.length
    });
}

async function handleGetItens(req, res, json, erro) {
    const itens = _itensOrdenados.map(item => ({
        codigo:      item.codigo,
        descricao:   item.descricao,
        codbarras:   item.codbarras,
        estoque:     item.estoque,
        preco:       item.preco,
        ultimaVenda: item.ultimaVenda,
        usado:       !!_usados[item.codigo]
    }));
    json({
        ok:             true,
        carregando:     _carregando,
        erro:           _erroConexao,
        total:          _itensBrutos.length,
        totalUsados:    _usadosCount,
        itensAbaixoMin: _itensAbaixoMin,
        estoqueMinimo:  _cfgVivo.estoqueMinimo,
        ultimaAtualiz:  _ultimaAtualiz ? _ultimaAtualiz.toISOString() : null,
        camposLog:      _camposLog,
        anoAtual:       ANO_ATUAL,
        lpEstoquesReais: _lpEstoquesReais,
        itens
    });
}

async function handleMarcarUsado(req, res, json, erro) {
    let body;
    try { body = await lerBody(req); } catch (e) { erro("Body inválido: " + e.message, 400); return; }
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { erro("JSON inválido.", 400); return; }

    // Cap de tamanho consistente com _sanitizarListaPersonalizada (50 chars):
    // sem isso, um POST malformado/malicioso com um "codigo" arbitrariamente
    // longo entraria como chave em _usados e seria persistido em
    // usados-estoque.json sem limite — mesmo em rede interna, nada exige
    // aceitar uma chave de tamanho ilimitado num Object que vira JSON em disco.
    const codigo = String(parsed && parsed.codigo != null ? parsed.codigo : "").trim().slice(0, 50);
    if (!codigo) { erro("Campo 'codigo' obrigatório.", 400); return; }

    // Lookup O(1) via Set (substitui _itensBrutos.some(i => i.codigo === codigo))
    const existeNosBrutos = _codigosSet.has(codigo);
    if (!existeNosBrutos) {
        // Marca mesmo assim para robustez (item pode ter sumido após refresh)
        logTs("AVISO: marcar-usado para código não encontrado nos itens: " + codigo);
    }

    // Mantém _usadosCount em sincronia (incrementa apenas se era novo)
    if (!_usados[codigo]) _usadosCount++;
    _usados[codigo] = true;
    reordenarFila();
    salvarUsados();
    logTs("Marcado como usado: " + codigo);
    json({ ok: true });
    emitirEventoSse("dados", { totalUsados: _usadosCount });
}

async function handleResetarUsados(req, res, json, erro) {
    const n = _usadosCount;
    _usados      = Object.create(null);
    _usadosCount = 0;
    reordenarFila();
    salvarUsados();
    logTs("Usados resetados — " + n + " item(s) voltaram à fila.");
    json({ ok: true, liberados: n });
    emitirEventoSse("dados", { totalUsados: 0 });
}

// Lida pelo cliente ao carregar a página (DOMContentLoaded), igual ao que
// handleGetItens já faz para o estado "usado" de cada item.
async function handleGetListaPersonalizada(req, res, json, erro) {
    json({ ok: true, itens: _listaPersonalizada });
}

// Grava a lista inteira (substitui a anterior) e persiste em disco
// imediatamente — mesma filosofia de marcar-usado/resetar-usados.
async function handlePostListaPersonalizada(req, res, json, erro) {
    let body;
    try { body = await lerBody(req, 1024 * 64); } catch (e) { erro("Body inválido: " + e.message, 400); return; }
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { erro("JSON inválido.", 400); return; }
    if (!parsed || !Array.isArray(parsed.itens)) { erro("Campo 'itens' (array) obrigatório.", 400); return; }

    const resultadoSanitizado = _sanitizarListaPersonalizada(parsed.itens);
    _listaPersonalizada = resultadoSanitizado.itens;
    salvarListaPersonalizadaDisco();
    logTs("Lista personalizada salva: " + _listaPersonalizada.length + " c\u00f3digo(s)." +
          (resultadoSanitizado.duplicatas ? " (" + resultadoSanitizado.duplicatas + " duplicata(s) removida(s))" : "") +
          (resultadoSanitizado.cortados   ? " (" + resultadoSanitizado.cortados   + " ignorado(s) por exceder o limite de " + resultadoSanitizado.limite + ")" : ""));
    // Devolve a lista JÁ sanitizada (sem duplicatas, capada em MAX_ITENS_LP)
    // para o cliente atualizar _lpDados com o que REALMENTE foi persistido —
    // sem isto, se o texto colado pelo usuário tivesse duplicatas, a UI
    // continuava mostrando a contagem/lista de ANTES da deduplicação até o
    // próximo F5, uma divergência silenciosa entre tela e disco. duplicatasRemovidas
    // e cortadosPorLimite vão separados (motivos diferentes) pra UI nunca
    // atribuir ao motivo errado — ver salvarListaPersonalizada() no cliente.
    json({
        ok: true,
        total: _listaPersonalizada.length,
        itens: _listaPersonalizada,
        duplicatasRemovidas: resultadoSanitizado.duplicatas,
        cortadosPorLimite:   resultadoSanitizado.cortados
    });

    // FIX (2026-07-27): _lpEstoquesReais só é (re)calculado dentro de
    // carregarItens() — sem isto, um código RECÉM-adicionado ficava fora
    // dele até o próximo ciclo natural de poll/SSE, e o cliente (que já
    // tinha o código novo em _lpDados, mas não em _lpEstoquesReais) achava
    // que ele "não existe mais no banco" só por estar temporariamente
    // desatualizado — o alerta sumia sozinho assim que o próximo poll
    // acontecia, o que confundia (parecia ser passageiro sem motivo claro).
    // Dispara em background (não atrasa a resposta desta requisição, que já
    // foi enviada acima) — mesmo padrão do /api/atualizar.
    if (!_loadLock && !_carregando) {
        setImmediate(() => {
            carregarItens().catch(e => logErro("ERRO refresh p\u00f3s-lista-personalizada: " + (e.message || e)));
        });
    }
}

async function handlePostAtualizar(req, res, json, erro) {
    if (_loadLock || _carregando) {
        json({ ok: false, erro: "Já em carregamento. Aguarde." });
        return;
    }
    json({ ok: true, mensagem: "Iniciando atualização..." });
    // Executa em background (não bloqueia a resposta)
    setImmediate(() => {
        carregarItens().catch(e => logErro("ERRO /api/atualizar: " + (e.message || e)));
    });
}

async function handleGetStatus(req, res, json, erro) {
    json({
        ok:           true,
        carregando:   _carregando,
        erro:         _erroConexao,
        total:        _itensBrutos.length,
        totalUsados:  _usadosCount,
        ultimaAtualiz: _ultimaAtualiz ? _ultimaAtualiz.toISOString() : null,
        anoAtual:     ANO_ATUAL,
        porta:        PORTA,
        banco:        FDB_HOST + ":" + FDB_PATH,
        camposLog:    _camposLog
    });
}

async function handleGetConfig(req, res, json, erro) {
    json({
        ok:                 true,
        fbHost:             _cfgVivo.fbHost,
        fbPort:             _cfgVivo.fbPort,
        fdbPath:            _cfgVivo.fbPath,
        fbUser:             _cfgVivo.fbUser,
        // SEGURANÇA: a senha NUNCA é devolvida em texto puro pela API — só um
        // booleano indicando se já existe uma senha salva. O cliente usa isso
        // pra exibir o placeholder certo; deixar o campo em branco ao salvar
        // mantém a senha atual (ver handlePostConfig), mesmo padrão usado por
        // qualquer formulário de troca de senha.
        senhaConfigurada:   !!_cfgVivo.fbPassword,
        portaEstoque:       _cfgVivo.portaEstoque,
        appName:            _cfgVivo.appName,
        proibidosExtra:     _cfgVivo.proibidosExtra,
        estoqueMinimo:      _cfgVivo.estoqueMinimo,
        maxItens:           _cfgVivo.maxItens,
        proibidosEmbutidos: PROIBIDOS_EMBUTIDOS,
        defaults: DEFAULTS
    });
}

// ── Helpers de handlePostConfig (extraídos para reduzir a complexidade da
// função principal — cada um trata um aspecto isolado da requisição) ─────────

// Lê e valida o body, retornando os valores já normalizados ou null (e já
// responde com o erro 400 apropriado) se algo for inválido.
async function _lerEValidarPayloadConfig(req, erro) {
    let body;
    try { body = await lerBody(req, 1024 * 64); } catch (e) { erro("Body inválido: " + e.message, 400); return null; }
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { erro("JSON inválido.", 400); return null; }
    if (!parsed || typeof parsed !== "object") { erro("Payload inválido.", 400); return null; }

    const novaPortaFb   = parseInt(parsed.fbPort       || "3050", 10);
    const novaPortaHttp = parseInt(parsed.portaEstoque || String(PORTA), 10);
    const novoEstMin    = parsed.estoqueMinimo != null ? parseFloat(parsed.estoqueMinimo) : _cfgVivo.estoqueMinimo;
    const novoMaxItens  = parsed.maxItens      != null ? parseInt(parsed.maxItens, 10)    : _cfgVivo.maxItens;
    if (isNaN(novaPortaFb)   || novaPortaFb   < 1024 || novaPortaFb   > 65534) { erro("fbPort inválida (1024–65534).", 400); return null; }
    if (isNaN(novaPortaHttp) || novaPortaHttp < 1024 || novaPortaHttp > 65534) { erro("portaEstoque inválida (1024–65534).", 400); return null; }
    if (isNaN(novoEstMin)    || novoEstMin    < 0     || novoEstMin    > 9999)  { erro("estoqueMinimo inválido (0–9999).", 400); return null; }
    if (isNaN(novoMaxItens)  || novoMaxItens  < 100   || novoMaxItens  > MAX_ITENS_TETO)  { erro("maxItens inválido (100–" + MAX_ITENS_TETO + ").", 400); return null; }

    let novosProibExtra = [];
    const rawProb = String(parsed.proibidosExtra || "").trim();
    if (rawProb) {
        const sep = rawProb.includes("\n") ? "\n" : ",";
        novosProibExtra = rawProb.split(sep)
            .map(p => p.trim().toUpperCase())
            .filter(p => p.length > 0);
    }

    return {
        fbHost:        String(parsed.fbHost     || "").trim() || _cfgVivo.fbHost,
        fbPath:        String(parsed.fdbPath    || "").trim() || _cfgVivo.fbPath,
        fbUser:        String(parsed.fbUser     || "").trim() || _cfgVivo.fbUser,
        fbPassword:    String(parsed.fbPassword || "").trim() || _cfgVivo.fbPassword,
        appName:       String(parsed.appName    || "").trim() || _cfgVivo.appName,
        fbPort:        novaPortaFb,
        portaEstoque:  novaPortaHttp,
        estoqueMinimo: novoEstMin,
        maxItens:      novoMaxItens,
        proibidosExtra: novosProibExtra
    };
}

// Compara o payload normalizado contra _cfgVivo e retorna quais grupos de
// configuração mudaram — usado para decidir o que persistir/recarregar.
function _detectarMudancasConfig(novo) {
    return {
        dbMudou:       novo.fbHost !== _cfgVivo.fbHost   || novo.fbPath !== _cfgVivo.fbPath ||
                       novo.fbPort !== _cfgVivo.fbPort   || novo.fbUser !== _cfgVivo.fbUser ||
                       novo.fbPassword !== _cfgVivo.fbPassword,
        probMudou:     JSON.stringify(novo.proibidosExtra) !== JSON.stringify(_cfgVivo.proibidosExtra),
        estMinMudou:   novo.estoqueMinimo !== _cfgVivo.estoqueMinimo,
        maxItensMudou: novo.maxItens      !== _cfgVivo.maxItens,
        portaHMudou:   novo.portaEstoque  !== _cfgVivo.portaEstoque,
        nameMudou:     novo.appName       !== _cfgVivo.appName
    };
}

// Persiste em config.json, preservando campos de outros módulos que não
// passam por esta tela (merge sobre o arquivo existente, não substituição).
function _persistirConfig(novo) {
    let cfgAtual = {};
    try {
        const rawCfg = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
        cfgAtual = JSON.parse(rawCfg);
    } catch (_) { /* não existe ainda — começa do zero */ }

    const cfgNovo = Object.assign({}, cfgAtual, {
        appName:        novo.appName,
        fbHost:         novo.fbHost,
        fbPort:         novo.fbPort,
        fdbPath:        novo.fbPath,
        fbUser:         novo.fbUser,
        fbPassword:     novo.fbPassword,
        portaEstoque:   novo.portaEstoque,
        estoqueMinimo:  novo.estoqueMinimo,
        maxItens:       novo.maxItens,
        proibidos:      novo.proibidosExtra
    });

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgNovo, null, 2), "utf8"); // pode lançar — chamador trata
}

async function handlePostConfig(req, res, json, erro) {
    const novo = await _lerEValidarPayloadConfig(req, erro);
    if (!novo) return; // erro já respondido por _lerEValidarPayloadConfig

    const mud = _detectarMudancasConfig(novo);
    const reiniciarNecessario = mud.portaHMudou || mud.nameMudou;

    try {
        _persistirConfig(novo);
        logTs("Config salvo: " + CONFIG_PATH);
    } catch (e) {
        erro("Falha ao salvar config.json: " + e.message, 500);
        return;
    }

    // Aplica imediatamente as configurações que não precisam de restart
    Object.assign(_cfgVivo, {
        fbHost: novo.fbHost, fbPath: novo.fbPath, fbPort: novo.fbPort, fbUser: novo.fbUser,
        fbPassword: novo.fbPassword, portaEstoque: novo.portaEstoque, appName: novo.appName,
        estoqueMinimo: novo.estoqueMinimo, maxItens: novo.maxItens, proibidosExtra: novo.proibidosExtra
    });

    // Invalida cache do HTML se o nome da app, estoque mínimo, maxItens ou a
    // lista de proibidos mudou (o cliente usa _S.proibidosExtra na
    // verificação defensiva do modo automático — precisa ficar atual)
    if (mud.nameMudou || mud.estMinMudou || mud.maxItensMudou || mud.probMudou) _htmlCache = null;

    // Reconstrói regex de proibidos se a lista mudou
    if (mud.probMudou) _refazerProibidos(novo.proibidosExtra);

    // Recarrega dados do banco se conexão, proibidos, estoque mínimo ou maxItens mudaram.
    // achado de auditoria: a mensagem de resposta ("Dados recarregados do
    // banco.") era adicionada sempre que precisaRecarregar era true, mesmo
    // nos casos em que o recarregamento era pulado por já haver um em
    // andamento (!_loadLock) — o usuário via "recarregado" quando, na
    // prática, nada novo tinha sido dado ao carregarItens() em andamento (que
    // já havia lido a config ANTERIOR ao conectar). recarregouAgora reflete
    // com precisão qual dos dois casos realmente aconteceu.
    const precisaRecarregar = mud.dbMudou || mud.probMudou || mud.estMinMudou || mud.maxItensMudou;
    let recarregouAgora = false;
    if (precisaRecarregar) {
        if (!_loadLock) {
            recarregouAgora = true;
            logTs("Config alterado — recarregando itens em background...");
            setImmediate(() => carregarItens().catch(e => logErro("ERRO reload pós-config: " + (e.message || e))));
        } else {
            logTs("Config alterado, mas já há um carregamento em andamento — as novas configurações " +
                  "só valem a partir do PRÓXIMO carregamento (clique em 'Atualizar' se precisar agora).");
        }
    }

    const msgs = [];
    if (recarregouAgora) {
        msgs.push("Dados recarregados do banco.");
    } else if (precisaRecarregar) {
        msgs.push("Configurações salvas — um carregamento já estava em andamento; " +
                   "clique em 'Atualizar' se quiser aplicar agora.");
    }
    if (reiniciarNecessario) {
        msgs.push("Reinicie o servidor para aplicar: " +
            [mud.nameMudou ? "nome da aplicação" : null, mud.portaHMudou ? "porta HTTP" : null]
                .filter(Boolean).join(" e ") + ".");
    }

    json({ ok: true, reiniciarNecessario, mensagem: msgs.join(" ") || "Configurações salvas com sucesso." });
}

// ── Tabela de despacho ────────────────────────────────────────────────────────
// Chave: "MÉTODO caminho". Adicionar uma rota nova = adicionar uma linha aqui
// + a função handler correspondente acima — não toca em nenhuma rota existente.
const ROTAS = {
    "GET /":                              handleGetRoot,
    "GET /index.html":                    handleGetRoot,
    "GET /api/buscar-mais-itens":         handleBuscarMaisItens,
    "GET /api/sse":                        handleSse,
    "GET /api/itens":                     handleGetItens,
    "POST /api/marcar-usado":             handleMarcarUsado,
    "POST /api/resetar-usados":           handleResetarUsados,
    "GET /api/lista-personalizada":       handleGetListaPersonalizada,
    "POST /api/lista-personalizada":      handlePostListaPersonalizada,
    "POST /api/atualizar":                handlePostAtualizar,
    "GET /api/status":                    handleGetStatus,
    "GET /api/config":                    handleGetConfig,
    "POST /api/config":                   handlePostConfig
};

// ─────────────────────────────────────────────────────────────────────────────
// SERVIDOR HTTP
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    // URL parsing fora do try/catch principal causa unhandled async rejection se req.url
    // for malformado — Node.js aborta a conexao TCP e o browser recebe "Failed to fetch".
    // Tratado em bloco proprio para garantir resposta em qualquer cenario.
    let urlParsed, rota;
    try {
        urlParsed = new URL(req.url || "/", "http://localhost:" + PORTA);
        rota = urlParsed.pathname;
    } catch (_) {
        if (!res.headersSent) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Bad Request");
        }
        return;
    }

    // Segurança: evita headers duplicados + protege JSON.stringify contra campos nao-serializaveis
    const json = (data, status) => {
        if (res.headersSent) return;
        let body;
        try {
            body = typeof data === "string" ? data : JSON.stringify(data);
        } catch (e) {
            body = JSON.stringify({ ok: false, erro: "Serializacao falhou: " + String(e.message || e) });
            status = 500;
        }
        res.writeHead(status || 200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(body);
    };
    const erro = (msg, status) => json({ ok: false, erro: msg }, status || 500);

    res.on("error", e => logTs("AVISO res[" + rota + "]: " + e.message));

    // ── Proteção contra CSRF cross-origin em rotas de mutação ──────────────────
    // achado #D da revisão 2026-08-06: nenhuma rota POST validava de onde a
    // requisição vinha. Como o servidor nunca envia cabeçalhos CORS permissivos
    // (Access-Control-Allow-Origin), um `fetch()` cross-origin com JSON normal
    // já é bloqueado pelo navegador — MAS só porque `Content-Type:
    // application/json` força um preflight. Um site malicioso aberto na mesma
    // rede local (ex.: outra aba do mesmo funcionário) pode contornar isso
    // enviando o MESMO corpo JSON com `Content-Type: text/plain`, que é um
    // "simple request" e NÃO dispara preflight — o navegador envia a
    // requisição mesmo assim, e como este servidor nunca checava o cabeçalho,
    // ela era aceita e executada (ex.: reescrever fbHost/fbPassword via
    // POST /api/config, marcar itens como usados, apagar a lista
    // personalizada). Exigir um cabeçalho CUSTOMIZADO (X-Requested-With) força
    // TODO POST — mesmo com Content-Type simples — a passar por preflight;
    // como não há Access-Control-Allow-Origin, o preflight falha e o
    // navegador nunca chega a enviar a requisição de verdade. O cliente deste
    // próprio app já envia esse cabeçalho em toda chamada (ver apiFetch()) —
    // nenhuma funcionalidade legítima é afetada, inclusive entre máquinas
    // diferentes da mesma rede local (isto não é uma restrição de
    // firewall/CORS, é validação de origem da requisição).
    if (req.method === "POST" && rota.indexOf("/api/") === 0) {
        const origemConfiavel = req.headers["x-requested-with"] === "XMLHttpRequest";
        if (!origemConfiavel) {
            logErro("AVISO: POST " + rota + " bloqueado — cabeçalho X-Requested-With ausente/inválido (possível origem externa).");
            erro("Requisição rejeitada: cabeçalho obrigatório ausente.", 403);
            return;
        }
    }

    const handler = ROTAS[req.method + " " + rota];
    try {
        if (handler) {
            await handler(req, res, json, erro);
            return;
        }
        if (!res.headersSent) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Rota não encontrada: " + rota);
        }
    } catch (e) {
        logErro("ERRO na requisição [" + rota + "]: " + String(e.message || e));
        erro("Erro interno do servidor.", 500);
    }
});

server.on("error", err => {
    if (err.code === "EADDRINUSE") {
        logErro("ERRO: Porta " + PORTA + " já está em uso.");
        logTs("Adicione 'portaEstoque': XXXX no config.json para usar outra porta.");
    } else {
        logErro("ERRO no servidor: " + (err.message || err));
    }
    process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// TRATAMENTO DE ERROS GLOBAIS
// ─────────────────────────────────────────────────────────────────────────────
process.on("uncaughtException",  e => logTs("[UNCAUGHT] " + String(e && (e.stack || e))));
process.on("unhandledRejection", r => logTs("[REJECTION] " + String(r  && (r.stack  || r))));
process.on("SIGINT",  () => { logTs("Encerrando servidor."); process.exit(0); });
process.on("SIGTERM", () => { logTs("Encerrando servidor."); process.exit(0); });

// ─────────────────────────────────────────────────────────────────────────────
// INICIAR
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORTA, "0.0.0.0", () => {
    logTs("══════════════════════════════════════════════════");
    logTs(APP_NAME + " — Consulta de Estoque Disponivel");
    logTs("Acesse: http://localhost:" + PORTA);
    logTs("Banco:  " + FDB_HOST + ":" + FDB_PATH);
    logTs("Ano:    sem filtro de ano (todos os itens com estoque > 0)");
    logTs("Limite: " + _cfgVivo.maxItens + " itens | Proibidos: " + PROIBIDOS.length + " termos");
    logTs("══════════════════════════════════════════════════");

    // Carregamento inicial
    carregarItens().then(ok => {
        if (ok) {
            logTs("Pronto! " + _itensBrutos.length + " item(s) disponíveis na interface.");
        } else {
            logTs("AVISO: Dados não carregados. Causa: " + (_erroConexao || "desconhecida"));
            logTs("A interface está disponível — use o botão 'Atualizar' após corrigir a conexão.");
            // Se não há config.json com fbHost, escaneia a rede em background
            // pra tentar descobrir automaticamente (scan é disparado também no
            // callback de falha da conexão, mas apenas se err != null — aqui
            // cobrimos o caso de config ausente mas FDB local não encontrado)
            if (!cfg.fbHost) {
                setImmediate(function() { autoDetectarHost().catch(function() {}); });
            }
        }
    }).catch(e => {
        logErro("ERRO no carregamento inicial: " + String(e.message || e));
    });
});