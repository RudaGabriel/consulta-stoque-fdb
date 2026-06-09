"use strict";

/**
 * consulta-estoque.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Servidor HTTP standalone para consulta de itens PARADOS em estoque:
 *   • Estoque mínimo 5 unidades
 *   • Sem filtro de ano de venda
 *   • Descrição NÃO contém palavras de config.json → proibidos
 *   • Ordenado: maior estoque primeiro
 *   • Limite: até 2000 itens únicos
 *
 * Recursos da interface:
 *   • Busca por descrição (filtro instantâneo)
 *   • Busca por faixa de preço: [valor-5, valor+40] → indica itens com
 *     desconto potencial para o valor que o cliente tem disponível
 *   • Botão "Usar" por item → move para o final da fila (persiste em
 *     usados-estoque.json entre reinicializações)
 *   • Botão "Resetar usados" → limpa toda a fila de usados
 *   • Botão "Atualizar" → recarrega dados frescos do banco
 *
 * NÃO depende de gerar-relatorio-html.js nem servidor-relatorio.js.
 * Lê config.json apenas para: fbHost, fdbPath, proibidos, appName.
 * Porta padrão: 7735 (configurável via config.json → portaEstoque)
 *
 * Para iniciar:
 *   node consulta-estoque.js
 *   Acesse: http://localhost:7888
 * ─────────────────────────────────────────────────────────────────────────────
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
const ANO_ATUAL   = new Date().getFullYear();
const MAX_ITENS   = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────────────────────────────────────
function p2(n) { return String(n).padStart(2, "0"); }

function logTs(msg) {
    const d = new Date();
    process.stdout.write(
        "[" + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "] " +
        String(msg) + "\n"
    );
}

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
// DETECÇÃO DO FDB (mesma lógica do servidor-relatorio.js)
// ─────────────────────────────────────────────────────────────────────────────
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
    // Fallback via config.json (se existir na mesma pasta)
    if (cfg.fbHost && String(cfg.fbHost).trim()) {
        const host   = String(cfg.fbHost).trim();
        const dbPath = (cfg.fdbPath && String(cfg.fdbPath).trim())
            ? String(cfg.fdbPath).trim()
            : "C:\\Program Files (x86)\\SmallSoft\\Small Commerce\\SMALL.FDB";
        logTs("FDB via config.json: " + host + ":" + dbPath);
        return { host, dbPath };
    }
    // Fallback hardcoded (padrao da instalacao — sem config.json)
    const host   = "192.168.1.65";
    const dbPath = "C:\\Program Files (x86)\\SmallSoft\\Small Commerce\\SMALL.FDB";
    logTs("FDB padrao hardcoded: " + host + ":" + dbPath);
    return { host, dbPath };
}

const { host: FDB_HOST, dbPath: FDB_PATH } = detectarFdb();

// ─────────────────────────────────────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────────────────────
let _itensBrutos    = [];               // Itens filtrados e carregados do banco
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
let _itensAbaixoMin = 0;               // Itens abaixo do estoqueMinimo incluídos p/ completar a lista

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG MUTÁVEL EM RUNTIME (/api/config aplica sem reiniciar, exceto porta e nome)
// ─────────────────────────────────────────────────────────────────────────────
let _cfgVivo = {
    fbHost:         FDB_HOST,
    fbPath:         FDB_PATH,
    fbPort:         (() => { const p = parseInt(cfg.fbPort  || "3050", 10); return (p > 0 && p < 65535) ? p : 3050; })(),
    fbUser:         (cfg.fbUser     && String(cfg.fbUser).trim())     ? String(cfg.fbUser).trim()     : "SYSDBA",
    fbPassword:     (cfg.fbPassword && String(cfg.fbPassword).trim()) ? String(cfg.fbPassword).trim() : "masterkey",
    portaEstoque:   PORTA,
    appName:        APP_NAME,
    estoqueMinimo:  (() => { const v = parseFloat(cfg.estoqueMinimo); return (Number.isFinite(v) && v >= 0) ? v : 5; })(),
    proibidosExtra: Array.isArray(cfg.proibidos) ? cfg.proibidos.map(p => String(p).trim()) : []
};

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
        try {
            const arr = Object.keys(_usados);
            fs.writeFileSync(USADOS_PATH, JSON.stringify(arr, null, 2), "utf8");
        } catch (e) {
            logTs("AVISO salvarUsados: " + e.message);
        }
    }, 600);
}

carregarUsados();

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
            if (c) set.add(c);
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
            if (t) tabelas.push(t);
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

    logTs("Conectando ao banco: " + FDB_HOST + ":" + FDB_PATH);

    return new Promise(resolve => {
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
                logTs("ERRO: " + _erroConexao);
                resolve(false);
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
                    whereAtivo = "AND (p." + colAtivo + " IS NULL OR (" +
                        "CAST(p." + colAtivo + " AS VARCHAR(1)) <> 'N' AND " +
                        "CAST(p." + colAtivo + " AS VARCHAR(1)) <> 'I' AND " +
                        "CAST(p." + colAtivo + " AS VARCHAR(1)) <> 'X' AND " +
                        "CAST(p." + colAtivo + " AS VARCHAR(1)) <> 'F'" +
                        "))";
                    logTs("Filtro ATIVO (blacklist N/I/X/F) aplicado na coluna: " + colAtivo);
                }

                // Busca TODOS os itens do catálogo (estoque >= 0, inclusive zerado).
                // 3 fases no JS garantem prioridade: est>=5 → est 1-4 → est=0.
                const limiteBruto = 200000;
                const sql = [
                    "SELECT FIRST " + limiteBruto,
                    "  TRIM(CAST(p." + colCod  + " AS VARCHAR(30)))  AS CODIGO,",
                    "  TRIM(CAST(p." + colDesc + " AS VARCHAR(120))) AS DESCRICAO,",
                    "  "  + selBar  + " AS CODBARRAS,",
                    "  CAST(p." + colEst + " AS DOUBLE PRECISION)   AS ESTOQUE,",
                    "  "  + selPrc  + " AS PRECO,",
                    "  "  + selUltV + " AS ULTIMAVENDA",
                    "FROM " + nomTabela + " p",
                    "WHERE CAST(p." + colEst + " AS DOUBLE PRECISION) >= 0",
                    whereAno,
                    whereAtivo,
                    "ORDER BY CAST(p." + colEst + " AS DOUBLE PRECISION) DESC"
                ].join("\n");

                logTs("Executando consulta de estoque disponivel...");
                const r = await query(db, sql, [], 120000);
                db.detach();

                if (r.e) {
                    _erroConexao = "Erro na consulta: " + String(r.e.message || r.e);
                    _carregando = _loadLock = false;
                    logTs("ERRO query: " + _erroConexao);
                    resolve(false);
                    return;
                }

                logTs(r.rows.length + " linhas brutas. Filtrando proibidos (3 fases)...");

                // Prioridade: est >= estoqueMinimo (itensAcima).
                // Se insuficiente para MAX_ITENS, complementa com est < estoqueMinimo (itensAbaixo).
                const _estMin     = _cfgVivo.estoqueMinimo;
                const itensAcima  = [];   // est >= _estMin
                const itensAbaixo = [];   // est <  _estMin (complemento para atingir MAX_ITENS)
                const codigosVistos = new Set();

                for (const row of r.rows) {
                    // Para quando temos MAX_ITENS acima do mínimo, ou MAX_ITENS no total
                    if (itensAcima.length >= MAX_ITENS) break;
                    if (itensAcima.length + itensAbaixo.length >= MAX_ITENS) break;

                    const desc = String(row.DESCRICAO || "").trim();
                    if (!desc) continue;
                    if (ehProibido(desc)) continue;

                    const est = Number(row.ESTOQUE != null ? row.ESTOQUE : 0);
                    if (!Number.isFinite(est) || est < 0) continue;

                    const cod = String(row.CODIGO || "").trim();
                    if (!cod) continue;
                    if (codigosVistos.has(cod)) continue;
                    codigosVistos.add(cod);

                    const preco = Number(row.PRECO || 0);
                    const item = {
                        codigo:      cod,
                        descricao:   desc,
                        codbarras:   String(row.CODBARRAS || "").trim(),
                        estoque:     Math.round(est    * 1000) / 1000,
                        preco:       Math.round(preco  * 100)  / 100,
                        ultimaVenda: row.ULTIMAVENDA ? toISO(row.ULTIMAVENDA) : null
                    };

                    if (est >= _estMin) {
                        itensAcima.push(item);
                    } else {
                        // Só coleta abaixo do mínimo se ainda precisamos completar a lista
                        const faltam = MAX_ITENS - itensAcima.length;
                        if (faltam > 0) itensAbaixo.push(item);
                    }
                }

                // Combina: acima do mínimo primeiro, depois os de complemento
                const _nAcima  = itensAcima.length;
                const itens    = itensAcima.concat(itensAbaixo).slice(0, MAX_ITENS);
                const _nAbaixo = itens.length - _nAcima;
                _itensAbaixoMin = _nAbaixo;
                const _nF1     = itens.length;

                _itensBrutos   = itens;
                _codigosSet    = new Set(itens.map(i => i.codigo)); // lookup O(1) em marcar-usado
                _ultimaAtualiz = new Date();
                reordenarFila();
                _carregando = _loadLock = false;

                logTs(
                    "OK: " + _itensBrutos.length + " itens carregados " +
                    "(estq\u2265" + _estMin + ": " + _nAcima +
                    (_nAbaixo > 0 ? ", abaixo do m\u00ednimo: " + _nAbaixo : "") +
                    "). Usados na fila: " + _usadosCount + "."
                );
                if (!colUltV) {
                    logTs("AVISO: ULTIMAVENDA não encontrada — itens NÃO foram filtrados por ano de venda.");
                }
                resolve(true);

            } catch (e) {
                _erroConexao = "Erro inesperado: " + String(e.message || e);
                try { db.detach(); } catch (_) {}
                _carregando = _loadLock = false;
                logTs("ERRO inesperado: " + _erroConexao);
                resolve(false);
            }
        });
    });
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
    // O HTML é estático (APP_NAME, ANO_ATUAL, MAX_ITENS são constantes de startup).
    // Gera apenas uma vez e retorna o cache nas chamadas subsequentes.
    if (_htmlCache) return _htmlCache;

    // Objeto de configuração injetado no cliente como JSON.
    // Substitui </ por <\/ para evitar que um APP_NAME contendo
    // </script> encerre o bloco <script> prematuramente no browser.
    const serverCfg = JSON.stringify({
        appName:            APP_NAME,
        anoAtual:           ANO_ATUAL,
        maxItens:           MAX_ITENS,
        estoqueMinimo:      _cfgVivo.estoqueMinimo,
        proibidosEmbutidos: PROIBIDOS_EMBUTIDOS
    }).replace(/<\//g, "<\\/");

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
input[type=text]{width:230px}

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
.btn-sm{padding:5px 10px;font-size:11px}

/* ─ FAIXA DE PREÇO ──────────────────────────────────────────────────────── */
.prc-box{background:rgba(76,175,80,.08);border:1px solid rgba(76,175,80,.2);
         border-radius:6px;padding:5px 12px;font-size:11px;color:var(--txt2);
         display:none;align-items:center;gap:6px}
.prc-box.vis{display:flex}
.prc-range{color:var(--grn);font-weight:700}
.prc-hint{font-size:10px;color:var(--txt2);font-style:italic}

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
.th-cod{width:76px}
.th-desc{/* preenche o espaço restante automaticamente */}
.th-bar{width:138px}
.th-est{width:84px; text-align:right}
.th-prc{width:94px; text-align:right}
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
.td-cod{font-family:Consolas,monospace;font-size:12px;color:var(--txt2)}
.td-desc{white-space:normal;line-height:1.4;word-break:break-word}
.td-bar{font-family:Consolas,monospace;font-size:11px;color:var(--txt2)}
.td-est{text-align:right;font-weight:700;color:var(--ylw)}
.td-prc{text-align:right;font-weight:600;color:var(--acc)}
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
.toast{position:fixed;bottom:22px;right:22px;background:var(--sur2);border:1px solid var(--brd);
       color:var(--txt);padding:9px 16px;border-radius:8px;font-size:13px;
       box-shadow:var(--shadow);z-index:9999;opacity:0;transform:translateY(8px);
       transition:all .22s;pointer-events:none;max-width:320px}
.toast.on{opacity:1;transform:translateY(0)}

/* ─ MODAL CONFIRM ────────────────────────────────────────────────────────── */
.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9000;
  display:flex;align-items:center;justify-content:center;
  opacity:0;transition:opacity .18s;pointer-events:none}
.modal-ov.on{opacity:1;pointer-events:auto}
.modal-bx{background:var(--sur);border:1px solid var(--brd);border-radius:10px;
  padding:22px 26px;max-width:380px;width:92%;box-shadow:var(--shadow);
  transform:translateY(-10px);transition:transform .18s}
.modal-ov.on .modal-bx{transform:translateY(0)}
.modal-ttl{font-size:14px;font-weight:700;color:var(--txt);margin-bottom:8px}
.modal-msg{font-size:13px;color:var(--txt2);line-height:1.6;margin-bottom:18px;white-space:pre-line}
.modal-ftr{display:flex;justify-content:flex-end;gap:8px}

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
.auto-ftr{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.auto-status{font-size:11px;color:var(--txt2);font-style:italic;flex:1}
.auto-status.ok{color:var(--grn)}
.auto-status.er{color:#ef9a9a}
.btn-auto{background:rgba(78,168,222,.13);color:var(--acc);border-color:rgba(78,168,222,.35)}
.btn-auto:hover:not(:disabled){background:rgba(78,168,222,.22)}

/* ─ TOGGLE SWITCH ──────────────────────────────────────────────────────── */
.tgl-wrap{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none;padding:6px 10px;background:var(--bg2);border:1px solid var(--brd);border-radius:6px;transition:border-color .18s}
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
/* ─ RESPONSIVO ───────────────────────────────────────────────────────────── */
@media(max-width:720px){
  .th-bar,.td-bar,.th-uv,.td-uv{display:none}
  input[type=text]{width:160px}
  .hdr-sub{display:none}
}
</style>
</head>
<body>

<!-- HEADER -->
<div class="hdr">
  <div>
    <div class="hdr-title">${escH(APP_NAME)} &mdash; Estoque Disponivel</div>
    <div class="hdr-sub">
      At&eacute; ${MAX_ITENS} itens &nbsp;&bull;&nbsp;
      Estoque m&iacute;nimo <span id="hdrEstMin">${_cfgVivo.estoqueMinimo}</span> unid. &nbsp;&bull;&nbsp;
      Maior estoque primeiro
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
    <label class="cl" for="txtBusca">Buscar (descri&ccedil;&atilde;o, c&oacute;digo, EAN, &gt;N, &lt;N)</label>
    <input type="text" id="txtBusca" placeholder="Nome, c&oacute;d, EAN, &gt;200, &lt;50..." oninput="filtrarDebounced()">
  </div>

  <div class="cg">
    <label class="cl" for="numPrc">Busca por valor (R$)</label>
    <div style="display:flex;gap:8px;align-items:center">
      <input type="number" id="numPrc" placeholder="Ex: 250,00" step="0.01" min="0" oninput="onPrecoInput()">
      <label class="tgl-wrap" title="Agrupar itens que somem ao valor informado">
        <input type="checkbox" id="chkGrupar" onchange="filtrar()">
        <span class="tgl"></span>
        <span class="tgl-lbl">Agrupar</span>
      </label>
      <label class="tgl-wrap" title="Mostrar itens com preco acima do valor (ate +R$40)">
        <input type="checkbox" id="chkAcima" onchange="filtrar()">
        <span class="tgl"></span>
        <span class="tgl-lbl">+R$40</span>
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
    <button class="btn btn-s btn-sm" onclick="limparFiltros()"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><path d="M3 3l10 10M13 3 3 13"/></svg>Limpar filtros</button>
  </div>

  <div class="cg">
    <label class="cl" for="selLimite">Itens exibidos</label>
    <select id="selLimite" onchange="aplicarLimite()" style="background:var(--bg2);border:1px solid var(--brd);color:var(--txt);padding:6px 10px;border-radius:6px;font-size:13px;outline:none;cursor:pointer">
      <option value="100">100</option>
      <option value="250">250</option>
      <option value="500">500</option>
      <option value="1000">1000</option>
      <option value="2000" selected>2000</option>
    </select>
  </div>

  <div class="cg" style="margin-left:auto">
    <label class="cl">&nbsp;</label>
    <button class="btn btn-d btn-sm" onclick="resetarUsados()" id="btnReset"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:5px"><path d="M2.5 4.5h11M6 4.5v-1a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1M5.5 4.5l.7 8h3.6l.7-8"/><path d="M7 7.5v3M9 7.5v3"/></svg>Resetar usados</button>
  </div>
</div>

<!-- STATS BAR -->
<div class="stats" id="stats">Carregando dados...</div>

<!-- TABELA -->
<div class="tw" id="tw">
  <div class="msg">
    <p><svg class="spin-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="rgba(78,168,222,.18)" stroke-width="2.5"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke="var(--acc)" stroke-width="2.5" stroke-linecap="round"/></svg>Conectando ao banco de dados...</p>
  </div>
</div>

<!-- GRUPOS (visível quando agrupar está ativo e há valor informado) -->
<div id="gruposWrap" style="display:none">
  <div class="grp-hdr">Combina&ccedil;&otilde;es que somam a <span id="grpValorLabel">-</span></div>
  <div class="grp-grid" id="gruposGrid"></div>
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
            <input class="cfg-inp" id="cfgFdbPath" type="text" placeholder="C:\Program Files (x86)\SmallSoft\Small Commerce\SMALL.FDB" spellcheck="false" autocomplete="off">
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
      Cole a lista de entregas no formato abaixo e clique em <strong>Iniciar</strong>.
      O sistema ir&aacute; buscar os c&oacute;digos automaticamente e marcar como usados.<br>
      <span style="color:var(--acc);font-family:Consolas,monospace;font-size:11px">
        Entregas:<br>139,00&nbsp;&nbsp;CREDITO<br>Gerencia:<br>177,00&nbsp;&nbsp;CREDITO
      </span>
    </div>
    <div>
      <div class="cl" style="margin-bottom:4px">Lista de entrada</div>
      <textarea class="auto-ta" id="autoInput" placeholder="Cole aqui a lista..."></textarea>
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

<!-- TOAST -->
<div class="toast" id="toast"></div>

<script>
"use strict";
// ── Configuração injetada pelo servidor ──────────────────────────────────────
var _S = ${serverCfg};

// ── Estado do cliente ────────────────────────────────────────────────────────
var _itens   = [];   // Todos os itens recebidos do servidor
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
// Referências DOM cacheadas em DOMContentLoaded (evita getElementById a cada keystroke)
var _elBusca = null, _elPrc = null, _elGrupar = null, _elAcima = null;

// ── Ícones SVG (definidos uma vez, reutilizados no HTML gerado dinamicamente) ─
var _icons = {
    ok:   '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:4px"><path d="M2 8.5 6 13l8-9"/></svg>',
    warn: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:4px"><path d="M8 1.5 1.5 13.5h13z"/><line x1="8" y1="6" x2="8" y2="9.5"/><circle cx="8" cy="12" r=".7" fill="currentColor" stroke="none"/></svg>',
    spin: '<svg class="spin-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="rgba(78,168,222,.18)" stroke-width="2.5"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke="var(--acc)" stroke-width="2.5" stroke-linecap="round"/></svg>'
};

// ── Modal confirm customizado (substitui confirm() nativo) ────────────────────
function _modalConfirm(msg, onOk, onCancel) {
    var ov  = document.createElement('div');  ov.className  = 'modal-ov';
    var bx  = document.createElement('div');  bx.className  = 'modal-bx';
    var ttl = document.createElement('div');  ttl.className = 'modal-ttl';
    ttl.textContent = 'Confirma\u00e7\u00e3o';
    var txt = document.createElement('div');  txt.className = 'modal-msg';
    txt.textContent = msg;
    var ftr = document.createElement('div');  ftr.className = 'modal-ftr';
    var bNo = document.createElement('button'); bNo.className = 'btn btn-s btn-sm';
    bNo.textContent = 'Cancelar';
    var bOk = document.createElement('button'); bOk.className = 'btn btn-d btn-sm';
    bOk.textContent = 'Confirmar';
    ftr.appendChild(bNo); ftr.appendChild(bOk);
    bx.appendChild(ttl); bx.appendChild(txt); bx.appendChild(ftr);
    ov.appendChild(bx);
    document.body.appendChild(ov);
    requestAnimationFrame(function() { ov.classList.add('on'); });
    function fechar() {
        ov.classList.remove('on');
        setTimeout(function() { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 220);
    }
    bNo.addEventListener('click', function() { fechar(); if (onCancel) onCancel(); });
    bOk.addEventListener('click', function() { fechar(); if (onOk) onOk(); });
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

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, ms) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(_toastT);
    _toastT = setTimeout(function() { el.classList.remove("on"); }, ms || 2500);
}

// ── Fetch helper ──────────────────────────────────────────────────────────────
function apiFetch(url, opts) {
    return fetch(url, opts || {})
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
            _pollT = setTimeout(carregarItens, 1800);
            return;
        }
        _erroCli = dados.erro || null;

        // Fingerprint: se total, usados e limite não mudaram, dados não mudaram — evita re-render
        var usadosCount = 0;
        if (Array.isArray(dados.itens)) {
            for (var _fi = 0; _fi < dados.itens.length; _fi++) {
                if (dados.itens[_fi].usado) usadosCount++;
            }
        }
        var fp = (dados.total || 0) + '|' + usadosCount + '|' + _limiteItens;
        if (fp === _dadosFingerprint && _itens.length > 0) {
            return; // dados idênticos — nada a re-renderizar
        }
        _dadosFingerprint = fp;

        // Pre-computa campos uppercase uma única vez (evita toUpperCase() a cada filtrar())
        _itens = (Array.isArray(dados.itens) ? dados.itens : []).slice(0, _limiteItens).map(function(it) {
            it._descUp = it.descricao              ? it.descricao.toUpperCase()        : '';
            it._codUp  = it.codigo                 ? String(it.codigo).toUpperCase()   : '';
            it._barUp  = it.codbarras              ? String(it.codbarras).toUpperCase(): '';
            return it;
        });

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
// Com "Acima" (+R$40): intervalo [valor, valor+40]
function calcFaixa(valor) {
    var acima = acimaAtivo();
    if (acima) {
        return { min: valor, max: valor + 40 };
    }
    // Exato: tolerância mínima de floating-point (0,01)
    return { min: valor - 0.005, max: valor + 0.005 };
}

function gruparAtivo() { return !!(_elGrupar && _elGrupar.checked); }
function acimaAtivo()  { return !!(_elAcima  && _elAcima.checked);  }

function onPrecoInput() { filtrar(); }

function atualizarPrcBox(val) {
    var box  = document.getElementById('prcBox');
    var rng  = document.getElementById('prcRange');
    var hint = document.getElementById('prcHint');
    if (!box) return;
    if (!val || val <= 0) { box.classList.remove('vis'); return; }
    box.classList.add('vis');
    var acima = acimaAtivo();
    if (acima) {
        if (rng)  rng.textContent  = 'R$ ' + val.toFixed(2).replace('.',',') + ' a R$ ' + (val+40).toFixed(2).replace('.',',');
        if (hint) hint.textContent = '(acima: ate +R$40,00)';
    } else {
        if (rng)  rng.textContent  = 'R$ ' + val.toFixed(2).replace('.',',');
        if (hint) hint.textContent = '(valor exato)';
    }
}

// ── Filtrar ───────────────────────────────────────────────────────────────────
function filtrar() {
    var busca = _elBusca ? _elBusca.value.trim() : "";
    var prcN  = _elPrc   ? parseFloat(_elPrc.value) : NaN;
    var temPrc = !isNaN(prcN) && prcN > 0;
    var fx = temPrc ? calcFaixa(prcN) : null;

    atualizarPrcBox(temPrc ? prcN : 0);

    // ── Filtro de estoque: >N (estoque >= N) ou <N (estoque <= N) ──────────────
    var estoqueMin = null;
    var estoqueMax = null;
    var buscaTexto = busca;
    var mEstMin = busca.match(/^>(\\d+(?:[.,]\\d*)?)$/);
    var mEstMax = busca.match(/^<(\\d+(?:[.,]\\d*)?)$/);
    if (mEstMin) {
        estoqueMin = parseFloat(mEstMin[1].replace(',', '.'));
        buscaTexto = '';
    } else if (mEstMax) {
        estoqueMax = parseFloat(mEstMax[1].replace(',', '.'));
        buscaTexto = '';
    }
    var buscaUpper = buscaTexto.toUpperCase();

    // Conta usados em uma única passagem (evita filter() adicional em renderTabela)
    var _tmpUsados = 0;
    _vis = _itens.filter(function(it) {
        // Filtro de estoque por faixa
        if (estoqueMin !== null && Number(it.estoque) < estoqueMin) return false;
        if (estoqueMax !== null && Number(it.estoque) > estoqueMax) return false;

        // Filtro de texto: descrição, código do produto e código de barras (contains)
        if (buscaUpper) {
            var matchDesc = it._descUp.indexOf(buscaUpper) !== -1;
            var matchCod  = it._codUp.indexOf(buscaUpper)  !== -1;
            var matchBar  = it._barUp.indexOf(buscaUpper)  !== -1;
            if (!matchDesc && !matchCod && !matchBar) return false;
        }

        var p = Number(it.preco || 0);
        if (p === 0.01) return false; // ocultar itens com valor R$0,01
        if (temPrc) {
            if (p <= 0) return false;
            if (p < fx.min || p > fx.max) return false;
        }
        if (it.usado) _tmpUsados++;
        return true;
    });
    _nUsadosVis = _tmpUsados; // salva para renderTabela sem re-iterar _vis

    // Quando +40 ativo: ordenar pela menor diferença possível (0 → 40)
    if (temPrc && acimaAtivo()) {
        _vis.sort(function(a, b) {
            var da = Math.abs(Number(a.preco || 0) - prcN);
            var db = Math.abs(Number(b.preco || 0) - prcN);
            return da - db;
        });
    }

    // Agenda renderTabela via requestAnimationFrame — nunca bloqueia o frame atual
    if (_renderRAF) cancelAnimationFrame(_renderRAF);
    _renderRAF = requestAnimationFrame(function() {
        _renderRAF = null;
        renderTabela();
    });

    // Grupos: cálculo pesado (O(n³)) adiado para depois do render principal
    clearTimeout(_gruposTimer);
    var gWrap = document.getElementById("gruposWrap");
    if (gruparAtivo() && temPrc) {
        _gruposTimer = setTimeout(function() {
            var grupos = encontrarGrupos(_itens, prcN);
            renderGrupos(grupos, prcN);
        }, 0);
    } else {
        if (gWrap) gWrap.style.display = "none";
    }
}

// ── Marcar item como usado (via data-attribute para evitar escaping de onclick) ─
function marcarUsadoBtn(el) {
    var cod = el ? el.getAttribute("data-cod") : null;
    if (!cod) return;
    el.disabled  = true;
    el.textContent = "...";
    // Copia o código para o clipboard e exibe feedback visual imediato
    _copiarTexto(cod, function() {
        toast('\u2713 C\u00f3digo ' + cod + ' copiado!', 1800);
    });
    apiFetch("/api/marcar-usado", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ codigo: cod })
    }).then(function(r) {
        if (!r || !r.ok) {
            el.disabled  = false;
            el.textContent = "Usar";
            toast("Falha ao registrar.", 2000);
            return;
        }
        toast("\u2713 " + cod + " \u2014 movido para a fila de usados.", 2400);
        // Atualização LOCAL: marca o item e reordena sem round-trip completo ao servidor.
        // Espelha exatamente o que o servidor faz em reordenarFila():
        //   não-usados primeiro → usados no final.
        for (var _i = 0; _i < _itens.length; _i++) {
            if (_itens[_i].codigo === cod) { _itens[_i].usado = true; break; }
        }
        _itens.sort(function(a, b) { return (a.usado ? 1 : 0) - (b.usado ? 1 : 0); });
        _dadosFingerprint = ''; // invalida fingerprint para eventual re-sync posterior
        filtrar();              // re-filtra e re-renderiza sem buscar dados do servidor
    });
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
    var b = document.getElementById("txtBusca");
    var p = document.getElementById("numPrc");
    var x = document.getElementById("prcBox");
    if (b) b.value = "";
    if (p) p.value = "";
    if (x) x.classList.remove("vis");
    filtrar();
}

// ── Debounce para o campo de busca (evita filtrar() a cada tecla) ─────────────
function filtrarDebounced() {
    clearTimeout(_filtrarTimer);
    _filtrarTimer = setTimeout(filtrar, 160);
}

// ── Limite de itens exibidos ──────────────────────────────────────────────────
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

// ── Copiar com fallback ───────────────────────────────────────────────────────
function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); toast('Codigos copiados!', 2000); }
    catch(e) { toast('Nao foi possivel copiar.', 2000); }
    document.body.removeChild(ta);
}

// ── encontrarGrupos: combinações de 2 ou 3 itens cujos preços somam ao valor ──
// Retorna até 20 grupos, priorizando os mais próximos do valor-alvo.
function encontrarGrupos(itens, valor) {
    if (!itens || !itens.length || !valor || valor <= 0) return [];

    var acima   = acimaAtivo();
    var alvoMin = valor;
    var alvoMax = acima ? valor + 40 : valor;
    var EPS     = 0.005; // tolerância de float (~1 centavo)

    // Só candidatos com preço > 0 e <= alvoMax
    var cands = [];
    for (var _ci = 0; _ci < itens.length; _ci++) {
        var _cp = Number(itens[_ci].preco);
        if (_cp > 0 && _cp <= alvoMax + EPS) cands.push(itens[_ci]);
    }
    // Limita candidatos para não explodir O(n³)
    if (cands.length > 250) cands = cands.slice(0, 250);

    // Pré-extrai preços numéricos uma única vez (evita Number() repetido nos loops internos)
    var _precos = new Array(cands.length);
    for (var _pi = 0; _pi < cands.length; _pi++) {
        _precos[_pi] = Number(cands[_pi].preco);
    }

    var grupos = [];
    var LIMITE = 30;

    // ── Pares ──
    for (var a = 0; a < cands.length && grupos.length < LIMITE; a++) {
        var pa = _precos[a];
        for (var b = a + 1; b < cands.length && grupos.length < LIMITE; b++) {
            var soma2 = pa + _precos[b];
            if (soma2 >= alvoMin - EPS && soma2 <= alvoMax + EPS) {
                grupos.push({ itens: [cands[a], cands[b]], soma: +soma2.toFixed(2) });
            }
        }
    }

    // ── Triplas (apenas se ainda precisamos de mais grupos) ──
    if (grupos.length < 20) {
        for (var a2 = 0; a2 < cands.length && grupos.length < LIMITE; a2++) {
            var pa2 = _precos[a2];
            if (pa2 >= alvoMax + EPS) continue;
            for (var b2 = a2 + 1; b2 < cands.length && grupos.length < LIMITE; b2++) {
                var pb2 = _precos[b2];
                var ab2 = pa2 + pb2;
                if (ab2 >= alvoMax + EPS) continue;
                for (var c2 = b2 + 1; c2 < cands.length && grupos.length < LIMITE; c2++) {
                    var soma3 = ab2 + _precos[c2];
                    if (soma3 >= alvoMin - EPS && soma3 <= alvoMax + EPS) {
                        grupos.push({ itens: [cands[a2], cands[b2], cands[c2]], soma: +soma3.toFixed(2) });
                    }
                }
            }
        }
    }

    // Ordena do mais próximo ao valor-alvo usando transformação de Schwartzian:
    // pré-computa Math.abs uma única vez por elemento antes de ordenar.
    return grupos
        .map(function(g) { return { g: g, d: Math.abs(g.soma - valor) }; })
        .sort(function(x, y) { return x.d - y.d; })
        .slice(0, 20)
        .map(function(x) { return x.g; });
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
        vazio.textContent = 'Nenhuma combinacao encontrada. Tente ativar +R$40.';
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
                var txt = itens.map(function(it) { return it.codigo || '-'; }).join(' ');
                _copiarTexto(txt, function() {
                    marcarGrupoUsado(itens, function(n) {
                        toast('\u2713 C\u00f3digos copiados! ' + n + ' item' + (n===1?'':'s') +
                              ' marcado' + (n===1?'':'s') + ' como usado' + (n===1?'':'s') + '.', 3200);
                    });
                });
            });
            tudoBtn.addEventListener('click', function() {
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
            '<p>N\u00e3o h\u00e1 itens com estoque positivo, sem venda em ' + _S.anoAtual +
            ' e fora da lista de proibidos.</p></div>';
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
        if (acimaAtivo()) {
            s += ' &nbsp;&bull;&nbsp; <span style="color:var(--grn)">R$' + prcN.toFixed(2).replace(".",",") + ' a R$' + (prcN+40).toFixed(2).replace(".",",") + '</span>';
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
    var buf = [
        "<table>",
        "<thead><tr>",
        '<th class="th-n">#</th>',
        '<th class="th-cod">C\u00f3digo</th>',
        '<th class="th-desc">Descri\u00e7\u00e3o</th>',
        '<th class="th-bar">C\u00f3d. Barras</th>',
        '<th class="th-est">Estoque</th>',
        '<th class="th-prc">Pre\u00e7o</th>',
        '<th class="th-uv">\u00dalt. Venda</th>',
        '<th class="th-ac">A\u00e7\u00e3o</th>',
        "</tr></thead><tbody>"
    ];

    for (var i = 0; i < _vis.length; i++) {
        var it    = _vis[i];
        var usado = !!it.usado;
        var prc   = Number(it.preco || 0);

        // Match de preço: item dentro da faixa informada
        var pmatch = temPrc && prc > 0 && fx && prc >= fx.min && prc <= fx.max;

        var trCls = (usado ? "tr-uso" : "") + (pmatch ? " tr-pm" : "");
        buf.push("<tr" + (trCls.trim() ? ' class="' + trCls.trim() + '"' : "") + ">");
        buf.push('<td class="td-n">' + (i + 1) + "</td>");
        buf.push('<td class="td-cod">' + esc(it.codigo) + "</td>");

        // Descrição + tags
        var dHtml = esc(it.descricao);
        if (usado)  dHtml += ' <span class="tag tag-fila">na fila</span>';
        if (pmatch && !usado) dHtml += ' <span class="tag tag-pm">' + _icons.ok + 'faixa</span>';
        buf.push('<td class="td-desc">' + dHtml + "</td>");

        buf.push('<td class="td-bar">' + (it.codbarras ? esc(it.codbarras) : '<span style="color:var(--txt3)">-</span>') + "</td>");
        buf.push('<td class="td-est">' + fmtEst(it.estoque) + "</td>");
        buf.push('<td class="td-prc">' + fmtBRL(it.preco) + "</td>");
        buf.push('<td class="td-uv">'  + fmtData(it.ultimaVenda) + "</td>");

        // Botão de ação (usa data-cod para evitar problemas de escaping no onclick)
        buf.push('<td class="td-ac">');
        if (!usado) {
            buf.push(
                '<button class="btn btn-usar btn-sm" ' +
                'data-cod="' + esc(it.codigo) + '" ' +
                'onclick="marcarUsadoBtn(this)">' +
                'Usar</button>'
            );
        } else {
            buf.push('<span style="font-size:10px;color:var(--uso-txt)">na fila</span>');
        }
        buf.push("</td></tr>");
    }

    buf.push("</tbody></table>");
    tw.innerHTML = buf.join("");

    // Recalcula offsets e re-sincroniza thead após cada render
    ajustarStickyOffsets();
    if (window._syncThead) window._syncThead();
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
    _autoCodsParaMarcar = [];
    ov.classList.add('on');
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
        // Agora que o usuário copiou, marca todos os itens como usados
        var cods = _autoCodsParaMarcar.slice();
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
});

// Encontra a melhor combinação de itens (não usados nesta sessão) para um valor alvo.
// Retorna { itens: [...], soma, diff } ou null se nada encontrado.
// Estratégia: single item mais próximo, depois pares, depois triplas — sempre menor diff >= 0.
// PERF: candidatos ordenados por proximidade ao alvo e limitados a 80 para evitar O(n³) lento.
function _autoEncontrarMelhor(disponiveis, valor) {
    var EPS     = 0.005;
    var alvoMax = valor + 40;
    var melhor  = null;

    // Candidatos: preço > 0 e <= alvoMax
    var cands = [];
    for (var i = 0; i < disponiveis.length; i++) {
        var p = Number(disponiveis[i].preco || 0);
        if (p > 0 && p <= alvoMax + EPS) cands.push(disponiveis[i]);
    }

    // Pré-extrai preços numéricos UMA VEZ (evita Number() repetido nos loops internos)
    for (var _pi = 0; _pi < cands.length; _pi++) {
        cands[_pi]._p = Number(cands[_pi].preco || 0);
    }

    // Ordena do mais próximo ao mais distante — usa _p já extraído
    cands.sort(function(a, b) { return Math.abs(a._p - valor) - Math.abs(b._p - valor); });
    // Cap em 80: com os mais próximos primeiro, a qualidade do match não piora sensivelmente
    // mas o pior caso do loop triplo cai de ~2,6M para ~85k iterações por linha
    if (cands.length > 80) cands = cands.slice(0, 80);

    function atualizar(itensGrupo, soma) {
        var diff = +(soma - valor).toFixed(2);
        if (diff < -EPS) return; // abaixo do valor: não serve
        if (!melhor || diff < melhor.diff) {
            melhor = { itens: itensGrupo.slice(), soma: soma, diff: diff };
        }
    }

    // Single items
    for (var a = 0; a < cands.length; a++) {
        atualizar([cands[a]], cands[a]._p);
        if (melhor && melhor.diff < EPS) return melhor; // match perfeito: para já
    }

    // Pares
    outer2:
    for (var a2 = 0; a2 < cands.length; a2++) {
        var pa = cands[a2]._p;
        for (var b = a2 + 1; b < cands.length; b++) {
            var soma2 = pa + cands[b]._p;
            if (soma2 > alvoMax + EPS) continue;
            atualizar([cands[a2], cands[b]], soma2);
            if (melhor && melhor.diff < EPS) break outer2; // match perfeito
        }
    }
    if (melhor && melhor.diff < EPS) return melhor;

    // Triplas (apenas se ainda não tem match perfeito)
    outer3:
    for (var a3 = 0; a3 < cands.length; a3++) {
        var pa3 = cands[a3]._p;
        for (var b3 = a3 + 1; b3 < cands.length; b3++) {
            var pb3 = cands[b3]._p;
            var ab3 = pa3 + pb3;
            if (ab3 > alvoMax + EPS) continue;
            for (var c3 = b3 + 1; c3 < cands.length; c3++) {
                var soma3 = ab3 + cands[c3]._p;
                if (soma3 > alvoMax + EPS) continue;
                atualizar([cands[a3], cands[b3], cands[c3]], soma3);
                if (melhor && melhor.diff < EPS) break outer3; // match perfeito
            }
        }
    }

    return melhor;
}

function iniciarModoAuto() {
    var inputEl  = document.getElementById('autoInput');
    var outputEl = document.getElementById('autoOutput');
    var statusEl = document.getElementById('autoStatus');
    var resWrap  = document.getElementById('autoResultWrap');
    var copyBtn  = document.getElementById('autoCopyBtn');
    var btn      = document.getElementById('autoIniciarBtn');
    if (!inputEl || !outputEl) return;

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
    statusEl.textContent = 'Processando...';
    statusEl.className   = 'auto-status';

    // Usa charCodes para evitar qualquer barra invertida no template literal do Node.js
    var NL  = String.fromCharCode(10);
    var CR  = String.fromCharCode(13);
    var TAB = String.fromCharCode(9);

    // Normaliza linha para saída: tabs → espaço simples (saída uniforme)
    function normalizarLinha(s) {
        return s.split(TAB).join(' ');
    }

    // Normaliza todas as quebras de linha
    var normalizado = raw.split(CR + NL).join(NL).split(CR).join(NL);
    var linhas = normalizado.split(NL);

    var _pendentes = {};
    _autoCodsParaMarcar.forEach(function(c) { _pendentes[c] = true; });

    var disponiveis = _itens.filter(function(it) {
        return !it.usado && !_pendentes[it.codigo] && Number(it.preco || 0) > 0.01;
    });

    var usadosSession  = {};
    var saida          = [];
    var codsMarcados   = [];
    var encontrados    = 0;
    var naoEncontrados = 0;
    var idxLinha       = 0;
    var totalLinhas    = linhas.length;

    // Processa uma linha por vez via setTimeout para não travar o browser
    function _processarProxima() {
        // Processa 1 linha por frame — garante que o browser nunca fica bloqueado
        var lote = 0;
        while (idxLinha < totalLinhas && lote < 1) {
            lote++;
            var linha = linhas[idxLinha++];
            // Remove trailing whitespace sem usar \s no template
            while (linha.length > 0 && linha.charCodeAt(linha.length - 1) <= 32) {
                linha = linha.slice(0, -1);
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

            var livres    = disponiveis.filter(function(it) { return !usadosSession[it.codigo]; });
            var resultado = _autoEncontrarMelhor(livres, valor);

            if (resultado && resultado.itens && resultado.itens.length > 0) {
                resultado.itens.forEach(function(it) {
                    usadosSession[it.codigo] = true;
                    codsMarcados.push(it.codigo);
                });
                var codigos = resultado.itens.map(function(it) { return it.codigo; }).join(' ');
                saida.push(linha + TAB + codigos);
                encontrados++;
            } else {
                saida.push(linha + TAB + '[NAO ENCONTRADO]');
                naoEncontrados++;
            }
        }

        // Atualiza status de progresso enquanto processa
        if (idxLinha < totalLinhas) {
            statusEl.textContent = 'Processando... ' + idxLinha + '/' + totalLinhas;
            setTimeout(_processarProxima, 0);
            return;
        }

        // Finalização — todas as linhas processadas
        outputEl.value        = saida.join(NL);
        resWrap.style.display = 'block';
        copyBtn.style.display = '';

        var msg = '\u2713 Processado: ' + encontrados + ' linha' + (encontrados === 1 ? '' : 's') + ' com c\u00f3digos';
        if (naoEncontrados > 0) msg += ', ' + naoEncontrados + ' n\u00e3o encontrado' + (naoEncontrados === 1 ? '' : 's');
        if (codsMarcados.length > 0) msg += ' \u2014 clique em \ud83d\udccb Copiar para confirmar';
        statusEl.textContent = msg;
        statusEl.className   = naoEncontrados > 0 ? 'auto-status er' : 'auto-status ok';

        // Armazena os códigos — só marca como usado quando o usuário copiar o resultado
        _autoCodsParaMarcar = codsMarcados;

        btn.disabled = false;
    }

    // Inicia o processamento assíncrono (yield imediato para o browser renderizar)
    setTimeout(_processarProxima, 0);
}

// ── Sticky thead via JS (contorna overflow-x:auto que quebra position:sticky) ─
(function() {
    var _rafId = null;
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

function _carregarConfigs() {
    var st = document.getElementById('cfgStatus');
    var btn = document.getElementById('cfgSalvarBtn');
    if (st)  { st.textContent = 'Carregando...'; st.className = 'cfg-status'; }
    if (btn) btn.disabled = true;

    apiFetch('/api/config').then(function(r) {
        if (btn) btn.disabled = false;
        if (!r || !r.ok) {
            if (st) { st.textContent = 'Erro ao carregar configura\u00e7\u00f5es.'; st.className = 'cfg-status er'; }
            return;
        }
        // Preenche os campos com os valores atuais
        _cfgSetVal('cfgFbHost',  r.fbHost       || '');
        _cfgSetVal('cfgFbPort',  r.fbPort       != null ? r.fbPort  : '');
        _cfgSetVal('cfgFdbPath', r.fdbPath      || '');
        _cfgSetVal('cfgFbUser',  r.fbUser       || '');
        _cfgSetVal('cfgFbPass',  r.fbPassword   || '');
        _cfgSetVal('cfgPorta',   r.portaEstoque != null ? r.portaEstoque : '');
        _cfgSetVal('cfgAppName', r.appName      || '');
        _cfgSetVal('cfgEstMin',  r.estoqueMinimo != null ? r.estoqueMinimo : '');
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

    var payload = {
        fbHost:         (_cfgGetVal('cfgFbHost')  || '').trim(),
        fbPort:         fbPortVal,
        fdbPath:        (_cfgGetVal('cfgFdbPath') || '').trim(),
        fbUser:         (_cfgGetVal('cfgFbUser')  || '').trim(),
        fbPassword:     (_cfgGetVal('cfgFbPass')  || '').trim(),
        portaEstoque:   httpPortVal,
        appName:        (_cfgGetVal('cfgAppName') || '').trim(),
        estoqueMinimo:  estMinVal,
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
    // Cacheia referências DOM para evitar getElementById a cada keystroke
    _elBusca  = document.getElementById("txtBusca");
    _elPrc    = document.getElementById("numPrc");
    _elGrupar = document.getElementById("chkGrupar");
    _elAcima  = document.getElementById("chkAcima");
    carregarItens();
    setTimeout(function() {
        ajustarStickyOffsets();
        if (window._syncThead) window._syncThead();
    }, 80);
    window.addEventListener("resize", ajustarStickyOffsets);
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
function lerBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const limite = maxBytes || 1024 * 16; // 16 KB máx padrão
        let body    = "";
        let abortado = false;

        req.on("data", chunk => {
            if (abortado) return;
            body += chunk;
            if (body.length > limite) {
                abortado = true;
                try { req.destroy(); } catch (_) {}
                reject(new Error("Body excede " + limite + " bytes."));
            }
        });
        req.on("end",   () => { if (!abortado) resolve(body); });
        req.on("error", e  => { if (!abortado) reject(e); });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVIDOR HTTP
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const urlParsed = new URL(req.url || "/", "http://localhost:" + PORTA);
    const rota      = urlParsed.pathname;

    // Segurança: evita headers duplicados
    const json = (data, status) => {
        if (res.headersSent) return;
        res.writeHead(status || 200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(typeof data === "string" ? data : JSON.stringify(data));
    };
    const erro = (msg, status) => json({ ok: false, erro: msg }, status || 500);

    res.on("error", e => logTs("AVISO res[" + rota + "]: " + e.message));

    try {
        // ── GET / ─────────────────────────────────────────────────────────────
        if ((rota === "/" || rota === "/index.html") && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(gerarHTML());
            return;
        }

        // ── GET /api/itens ────────────────────────────────────────────────────
        if (rota === "/api/itens" && req.method === "GET") {
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
                itens
            });
            return;
        }

        // ── POST /api/marcar-usado ────────────────────────────────────────────
        if (rota === "/api/marcar-usado" && req.method === "POST") {
            let body;
            try { body = await lerBody(req); } catch (e) { erro("Body inválido: " + e.message, 400); return; }
            let parsed;
            try { parsed = JSON.parse(body); } catch (_) { erro("JSON inválido.", 400); return; }

            const codigo = String(parsed && parsed.codigo != null ? parsed.codigo : "").trim();
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
            return;
        }

        // ── POST /api/resetar-usados ──────────────────────────────────────────
        if (rota === "/api/resetar-usados" && req.method === "POST") {
            const n = _usadosCount;
            _usados      = Object.create(null);
            _usadosCount = 0;
            reordenarFila();
            salvarUsados();
            logTs("Usados resetados — " + n + " item(s) voltaram à fila.");
            json({ ok: true, liberados: n });
            return;
        }

        // ── POST /api/atualizar ───────────────────────────────────────────────
        if (rota === "/api/atualizar" && req.method === "POST") {
            if (_loadLock || _carregando) {
                json({ ok: false, erro: "Já em carregamento. Aguarde." });
                return;
            }
            json({ ok: true, mensagem: "Iniciando atualização..." });
            // Executa em background (não bloqueia a resposta)
            setImmediate(() => {
                carregarItens().catch(e => logTs("ERRO /api/atualizar: " + (e.message || e)));
            });
            return;
        }

        // ── GET /api/status ───────────────────────────────────────────────────
        if (rota === "/api/status" && req.method === "GET") {
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
            return;
        }

        // ── GET /api/config ───────────────────────────────────────────────────
        if (rota === "/api/config" && req.method === "GET") {
            json({
                ok:                 true,
                fbHost:             _cfgVivo.fbHost,
                fbPort:             _cfgVivo.fbPort,
                fdbPath:            _cfgVivo.fbPath,
                fbUser:             _cfgVivo.fbUser,
                fbPassword:         _cfgVivo.fbPassword,
                portaEstoque:       _cfgVivo.portaEstoque,
                appName:            _cfgVivo.appName,
                proibidosExtra:     _cfgVivo.proibidosExtra,
                estoqueMinimo:      _cfgVivo.estoqueMinimo,
                proibidosEmbutidos: PROIBIDOS_EMBUTIDOS,
                defaults: {
                    fbHost:        "192.168.1.65",
                    fbPort:        3050,
                    fdbPath:       "C:\\Program Files (x86)\\SmallSoft\\Small Commerce\\SMALL.FDB",
                    fbUser:        "SYSDBA",
                    fbPassword:    "masterkey",
                    portaEstoque:  7888,
                    appName:       "Consulta Estoque",
                    estoqueMinimo: 5
                }
            });
            return;
        }

        // ── POST /api/config ──────────────────────────────────────────────────
        if (rota === "/api/config" && req.method === "POST") {
            let body;
            try { body = await lerBody(req, 1024 * 64); } catch (e) { erro("Body inválido: " + e.message, 400); return; }
            let parsed;
            try { parsed = JSON.parse(body); } catch (_) { erro("JSON inválido.", 400); return; }
            if (!parsed || typeof parsed !== "object") { erro("Payload inválido.", 400); return; }

            // Valida e normaliza portas e limites numéricos
            const novaPortaFb    = parseInt(parsed.fbPort        || "3050", 10);
            const novaPortaHttp  = parseInt(parsed.portaEstoque  || String(PORTA), 10);
            const novoEstMin     = parsed.estoqueMinimo != null ? parseFloat(parsed.estoqueMinimo) : _cfgVivo.estoqueMinimo;
            if (isNaN(novaPortaFb)   || novaPortaFb   < 1024 || novaPortaFb   > 65534) { erro("fbPort inválida (1024–65534).", 400); return; }
            if (isNaN(novaPortaHttp) || novaPortaHttp < 1024 || novaPortaHttp > 65534) { erro("portaEstoque inválida (1024–65534).", 400); return; }
            if (isNaN(novoEstMin)    || novoEstMin    < 0     || novoEstMin    > 9999)  { erro("estoqueMinimo inválido (0–9999).", 400); return; }

            // Sanitiza strings
            const novoFbHost  = String(parsed.fbHost       || "").trim() || _cfgVivo.fbHost;
            const novoFbPath  = String(parsed.fdbPath      || "").trim() || _cfgVivo.fbPath;
            const novoFbUser  = String(parsed.fbUser       || "").trim() || _cfgVivo.fbUser;
            const novoFbPass  = String(parsed.fbPassword   || "").trim() || _cfgVivo.fbPassword;
            const novoAppName = String(parsed.appName      || "").trim() || _cfgVivo.appName;

            // Sanitiza proibidos extras (aceita lista separada por \n ou ,)
            let novosProibExtra = [];
            const rawProb = String(parsed.proibidosExtra || "").trim();
            if (rawProb) {
                const sep = rawProb.includes("\n") ? "\n" : ",";
                novosProibExtra = rawProb.split(sep)
                    .map(p => p.trim().toUpperCase())
                    .filter(p => p.length > 0);
            }

            // Detecta o que realmente mudou
            const dbMudou     = novoFbHost !== _cfgVivo.fbHost   || novoFbPath !== _cfgVivo.fbPath    ||
                                novaPortaFb !== _cfgVivo.fbPort  || novoFbUser !== _cfgVivo.fbUser    ||
                                novoFbPass  !== _cfgVivo.fbPassword;
            const probMudou    = JSON.stringify(novosProibExtra) !== JSON.stringify(_cfgVivo.proibidosExtra);
            const estMinMudou  = novoEstMin !== _cfgVivo.estoqueMinimo;
            const portaHMudou  = novaPortaHttp !== _cfgVivo.portaEstoque;
            const nameMudou   = novoAppName   !== _cfgVivo.appName;
            const reiniciarNecessario = portaHMudou || nameMudou;

            // Lê config.json existente para preservar campos de outros módulos
            let cfgAtual = {};
            try {
                const rawCfg = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
                cfgAtual = JSON.parse(rawCfg);
            } catch (_) { /* não existe ainda — começa do zero */ }

            // Merge: preserva campos existentes, atualiza apenas os do formulário
            const cfgNovo = Object.assign({}, cfgAtual, {
                appName:      novoAppName,
                fbHost:       novoFbHost,
                fbPort:       novaPortaFb,
                fdbPath:      novoFbPath,
                fbUser:       novoFbUser,
                fbPassword:   novoFbPass,
                portaEstoque:   novaPortaHttp,
                estoqueMinimo:  novoEstMin,
                proibidos:      novosProibExtra
            });

            try {
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgNovo, null, 2), "utf8");
                logTs("Config salvo: " + CONFIG_PATH);
            } catch (e) {
                erro("Falha ao salvar config.json: " + e.message, 500);
                return;
            }

            // Aplica imediatamente as configurações que não precisam de restart
            _cfgVivo.fbHost         = novoFbHost;
            _cfgVivo.fbPath         = novoFbPath;
            _cfgVivo.fbPort         = novaPortaFb;
            _cfgVivo.fbUser         = novoFbUser;
            _cfgVivo.fbPassword     = novoFbPass;
            _cfgVivo.portaEstoque   = novaPortaHttp;
            _cfgVivo.appName        = novoAppName;
            _cfgVivo.estoqueMinimo  = novoEstMin;
            _cfgVivo.proibidosExtra = novosProibExtra;

            // Invalida cache do HTML se o nome da app ou o estoque mínimo mudou
            if (nameMudou || estMinMudou) _htmlCache = null;

            // Reconstrói regex de proibidos se a lista mudou
            if (probMudou) _refazerProibidos(novosProibExtra);

            // Recarrega dados do banco se conexão ou proibidos mudaram
            if ((dbMudou || probMudou || estMinMudou) && !_loadLock) {
                logTs("Config alterado — recarregando itens em background...");
                setImmediate(() => carregarItens().catch(e => logTs("ERRO reload pós-config: " + (e.message || e))));
            }

            const msgs = [];
            if (dbMudou || probMudou || estMinMudou) msgs.push("Dados recarregados do banco.");
            if (reiniciarNecessario)   msgs.push("Reinicie o servidor para aplicar: " +
                [nameMudou ? "nome da aplicação" : null, portaHMudou ? "porta HTTP" : null]
                    .filter(Boolean).join(" e ") + ".");

            json({ ok: true, reiniciarNecessario, mensagem: msgs.join(" ") || "Configurações salvas com sucesso." });
            return;
        }

        // ── 404 ───────────────────────────────────────────────────────────────
        if (!res.headersSent) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Rota não encontrada: " + rota);
        }

    } catch (e) {
        logTs("ERRO na requisição [" + rota + "]: " + String(e.message || e));
        erro("Erro interno do servidor.", 500);
    }
});

server.on("error", err => {
    if (err.code === "EADDRINUSE") {
        logTs("ERRO: Porta " + PORTA + " já está em uso.");
        logTs("Adicione 'portaEstoque': XXXX no config.json para usar outra porta.");
    } else {
        logTs("ERRO no servidor: " + (err.message || err));
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
    logTs("Limite: " + MAX_ITENS + " itens | Proibidos: " + PROIBIDOS.length + " termos");
    logTs("══════════════════════════════════════════════════");

    // Carregamento inicial
    carregarItens().then(ok => {
        if (ok) {
            logTs("Pronto! " + _itensBrutos.length + " item(s) disponíveis na interface.");
        } else {
            logTs("AVISO: Dados não carregados. Causa: " + (_erroConexao || "desconhecida"));
            logTs("A interface está disponível — use o botão 'Atualizar' após corrigir a conexão.");
        }
    }).catch(e => {
        logTs("ERRO no carregamento inicial: " + String(e.message || e));
    });
});