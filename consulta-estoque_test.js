"use strict";

/**
 * consulta-estoque.test.js
 *
 * @version 2.3.0
 * @changelog
 *   2.3.0 - 2026-07-10 - Testes de regressão para o bug "Agrupar não
 *     funcionava": encontrarGruposAsync voltou ao algoritmo comprovadamente
 *     estável (apenas pares e triplas, sem a fase de subset-sum/DP que se
 *     mostrou não confiável). describe() de regressão atualizado para
 *     também garantir que nenhum grupo retornado tem mais de 3 itens.
 *
 * EXECUÇÃO:
 *   node --test consulta-estoque.test.js
 *   (Node.js >= 18, sem dependências externas)
 *
 * MANUTENÇÃO FUTURA:
 *   - Nova constante no engine   → não precisa mexer aqui (é re-exportada)
 *   - Novo algoritmo no engine   → adicione um describe() abaixo
 *   - Mudança de comportamento   → atualize os asserts do describe correspondente
 *   - Mudança de assinatura      → o teste vai falhar e indicar exatamente onde
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

// Importação direta — mesma fonte usada pelo servidor no HTML.
// Nenhum stub necessário: o engine é puro (sem DOM, sem globais obrigatórios).
const engine = require("./estoque-engine.js");
const {
    FLOAT_EPS, FAIXA_COMBINAR, FAIXA_EXCEDENTE_LP, PRECO_SENTINEL_ZERADO, MAX_COMBINAR_RESULTADOS,
    _qtdMaximaDisponivel, _grupoRespeitaLimites,
    _autoEncontrarMelhor, _autoEncontrarMelhorComRepeticao,
    _ehProibidoCliente, _validarResultadoPadrao, _validarResultadoLista,
    _formatarCodigosCompactado, _diffTermosFaltantes, _itemBateAlgumTermo, _termosSemMatch,
    encontrarGruposAsync, encontrarCombinacoesComRepeticaoAsync
} = engine;

// ── Helpers ───────────────────────────────────────────────────────────────────
function item(codigo, preco, estoque, descricao) {
    return {
        codigo,
        preco,
        estoque,
        descricao: descricao || "PRODUTO " + codigo,
        _codUp:    String(codigo).toUpperCase(),
        _descUp:   (descricao || "PRODUTO " + codigo).toUpperCase(),
        _barUp:    "",
        usado:     false
    };
}

// Proibidos reais do sistema (passados explicitamente — sem ler globais)
const PROIBIDOS = ["CARTAO", "CREDITO", "DEBITO", "CHEQUE", "DINHEIRO"];

// ── 1. Constantes exportadas ──────────────────────────────────────────────────
describe("constantes exportadas", () => {
    test("FLOAT_EPS é 0.005", () => { assert.equal(FLOAT_EPS, 0.005); });
    test("FAIXA_COMBINAR é 40", () => { assert.equal(FAIXA_COMBINAR, 40); });
    test("FAIXA_EXCEDENTE_LP é 99999", () => { assert.equal(FAIXA_EXCEDENTE_LP, 99999); });
    test("PRECO_SENTINEL_ZERADO é 0.01", () => { assert.equal(PRECO_SENTINEL_ZERADO, 0.01); });
    test("MAX_COMBINAR_RESULTADOS é 20", () => { assert.equal(MAX_COMBINAR_RESULTADOS, 20); });
});

// ── 2. _qtdMaximaDisponivel ───────────────────────────────────────────────────
describe("_qtdMaximaDisponivel", () => {
    test("sem usos e sem parada retorna estoque inteiro", () =>
        assert.equal(_qtdMaximaDisponivel(item("A",10,20), {}, {}), 20));

    test("desconta usos acumulados", () =>
        assert.equal(_qtdMaximaDisponivel(item("A",10,20), {A:5}, {}), 15));

    test("respeita estoque de parada", () =>
        assert.equal(_qtdMaximaDisponivel(item("A",10,20), {}, {A:8}), 12));

    test("respeita pisoPadrao quando não há parada específica", () =>
        assert.equal(_qtdMaximaDisponivel(item("A",10,20), {}, {}, 5), 15));

    test("0 absoluto: parada negativa não libera mais que o restante real", () =>
        assert.equal(_qtdMaximaDisponivel(item("A",10,20), {A:18}, {A:-50}), 2));

    test("0 absoluto: pisoPadrao negativo não libera mais que o restante real", () =>
        assert.equal(_qtdMaximaDisponivel(item("A",10,20), {A:18}, {}, -100), 2));

    test("0 absoluto: estoque bruto negativo retorna 0", () =>
        assert.equal(_qtdMaximaDisponivel(item("A",10,-3), {}, {}), 0));

    test("retorna 0 quando usos esgotam o estoque", () =>
        assert.equal(_qtdMaximaDisponivel(item("A",10,10), {A:10}, {}), 0));

    test("retorna 0 (não negativo) quando usos ultrapassam o estoque", () =>
        assert.equal(_qtdMaximaDisponivel(item("A",10,10), {A:15}, {}), 0));

    test("item null retorna 0", () =>
        assert.equal(_qtdMaximaDisponivel(null, {}, {}), 0));
});

// ── 3. _grupoRespeitaLimites ──────────────────────────────────────────────────
describe("_grupoRespeitaLimites", () => {
    test("grupo vazio passa", () =>
        assert.ok(_grupoRespeitaLimites([], {}, {})));

    test("2 usos de item com estoque 5 passa", () => {
        const it = item("A",10,5);
        assert.ok(_grupoRespeitaLimites([it,it], {}, {}));
    });

    test("6 usos de item com estoque 5 não passa", () => {
        const it = item("A",10,5);
        assert.ok(!_grupoRespeitaLimites([it,it,it,it,it,it], {}, {}));
    });

    test("respeita usos acumulados externos", () => {
        const it = item("A",10,5);
        assert.ok(!_grupoRespeitaLimites([it,it,it], {A:3}, {}));
    });
});

// ── 4. _autoEncontrarMelhor (sem repetição) ───────────────────────────────────
describe("_autoEncontrarMelhor (sem repetição)", () => {
    test("encontra item exato", () => {
        const r = _autoEncontrarMelhor([item("A",50,10), item("B",100,5)], 50, 0);
        assert.ok(r && r.itens[0].codigo === "A" && r.diff === 0);
    });

    test("retorna null quando nada cabe na faixa", () =>
        assert.equal(_autoEncontrarMelhor([item("A",200,10)], 50, 0), null));

    test("retorna null para pool vazio", () =>
        assert.equal(_autoEncontrarMelhor([], 50, 0), null));

    test("encontra par exato", () => {
        const r = _autoEncontrarMelhor([item("A",30,10), item("B",20,10)], 50, 0);
        assert.ok(r && Math.abs(r.soma - 50) < 0.01);
    });
});

// ── 5. _autoEncontrarMelhorComRepeticao ──────────────────────────────────────
describe("_autoEncontrarMelhorComRepeticao", () => {
    test("3×16,90 ≈ 50,70 (cobre valor 50 com repetição)", () => {
        const r = _autoEncontrarMelhorComRepeticao([item("A",16.90,20)], 50, 0, {}, null, 5);
        assert.ok(r && r.itens.length === 3 && r.soma > 49.99);
    });

    test("respeita pisoPadrao — sem unidade disponível retorna null", () => {
        // estoque=6, piso=5 → só 1 disponível; 1×16,90 não cobre 50
        const r = _autoEncontrarMelhorComRepeticao([item("A",16.90,6)], 50, 0, {}, null, 5);
        assert.equal(r, null);
    });

    test("menor excedente com faixa generosa (2×71=142, diff=42)", () => {
        const r = _autoEncontrarMelhorComRepeticao([item("P71",71,100)], 100, 99999, {}, {});
        assert.ok(r && r.soma === 142 && r.diff === 42);
    });

    test("pool vazio retorna null", () =>
        assert.equal(_autoEncontrarMelhorComRepeticao([], 50, 40, {}, {}), null));

    test("valor zero retorna null", () =>
        assert.equal(_autoEncontrarMelhorComRepeticao([item("A",10,5)], 0, 0, {}, {}), null));
});

// ── 6. _ehProibidoCliente ────────────────────────────────────────────────────
describe("_ehProibidoCliente", () => {
    test("detecta termo proibido embutido", () =>
        assert.ok(_ehProibidoCliente("VALE CARTAO PRESENTE", PROIBIDOS)));

    test("descrição normal não é proibida", () =>
        assert.ok(!_ehProibidoCliente("ARROZ TIPO 1 5KG", PROIBIDOS)));

    test("descricao null retorna false", () =>
        assert.ok(!_ehProibidoCliente(null, PROIBIDOS)));

    test("detecção case-insensitive (sem acento — dado real do ERP)", () =>
        assert.ok(_ehProibidoCliente("vale cartao credito", PROIBIDOS)));

    test("acento diferente NÃO bate (Firebird Win1252 não normaliza) — comportamento documentado", () =>
        assert.ok(!_ehProibidoCliente("vale cartão crédito", PROIBIDOS)));

    test("proibido extra passado explicitamente", () =>
        assert.ok(_ehProibidoCliente("PAGUE MENOS", [], ["PAGUE"])));
});

// ── 7. _validarResultadoPadrao ────────────────────────────────────────────────
describe("_validarResultadoPadrao", () => {
    test("passa resultado válido", () => {
        const r = { itens: [item("A",10,20,"PRODUTO NORMAL")] };
        assert.ok(_validarResultadoPadrao(r, 5, null, null, PROIBIDOS));
    });

    test("rejeita item abaixo do estoque mínimo", () => {
        const r = { itens: [item("A",10,3,"PRODUTO NORMAL")] };
        assert.equal(_validarResultadoPadrao(r, 5, null, null, PROIBIDOS), null);
    });

    test("rejeita item proibido", () => {
        const r = { itens: [item("A",10,20,"CARTAO DE CREDITO")] };
        assert.equal(_validarResultadoPadrao(r, 0, null, null, PROIBIDOS), null);
    });

    test("código 'constructor' não causa prototype collision", () => {
        const r = { itens: [item("constructor",10,20,"NORMAL")] };
        assert.ok(_validarResultadoPadrao(r, 0, null, null, []));
    });

    test("rejeita duplicata sem permissão de repetição", () => {
        const it = item("A",10,20,"NORMAL");
        assert.equal(_validarResultadoPadrao({ itens:[it,it] }, 0, null, null, []), null);
    });

    test("aceita duplicata quando usosAcumulados é fornecido (modo reaproveitamento)", () => {
        const it = item("A",10,20,"NORMAL");
        assert.ok(_validarResultadoPadrao({ itens:[it,it] }, 0, {}, 0, []));
    });
});

// ── 8. _validarResultadoLista ─────────────────────────────────────────────────
describe("_validarResultadoLista", () => {
    test("passa combinação que respeita os limites", () => {
        const it = item("A",10,20);
        assert.ok(_validarResultadoLista({ itens:[it,it] }, {}, {}));
    });

    test("rejeita quando usos esgotam o estoque de parada", () => {
        const it = item("A",10,5);
        assert.equal(_validarResultadoLista({ itens:[it] }, {A:5}, {}), null);
    });

    test("resultado null retorna null", () =>
        assert.equal(_validarResultadoLista(null, {}, {}), null));
});

// ── 9. _formatarCodigosCompactado ─────────────────────────────────────────────
describe("_formatarCodigosCompactado", () => {
    test("item único sem repetição retorna só o código", () =>
        assert.equal(_formatarCodigosCompactado([item("08395",10,5)]), "08395"));

    test("dois itens distintos separados por espaço", () => {
        const r = _formatarCodigosCompactado([item("A",10,5), item("B",20,5)]);
        assert.ok(r.includes("A") && r.includes("B"));
    });

    test("item repetido compactado com multiplicador", () => {
        const it = item("A",10,5);
        const r  = _formatarCodigosCompactado([it,it,it]);
        assert.ok(r.startsWith("3*"), "esperado '3*A', recebido: " + r);
    });
});

// ── 10. Busca personalizada (multi-termo) ─────────────────────────────────────
describe("busca personalizada — _itemBateAlgumTermo, _termosSemMatch, _diffTermosFaltantes", () => {
    const catalogo = [
        item("08395", 10, 5, "ARROZ TIPO 1 5KG"),
        item("00123", 20, 3, "FEIJAO PRETO 1KG"),
        item("99999", 30, 2, "ACUCAR CRISTAL")
    ];

    test("bate por código exato", () =>
        assert.ok(_itemBateAlgumTermo(catalogo[0], ["08395"])));

    test("bate por parte da descrição (case-insensitive — _descUp já em caixa alta)", () =>
        assert.ok(_itemBateAlgumTermo(catalogo[0], ["ARROZ"])));

    test("não bate com termo inexistente", () =>
        assert.ok(!_itemBateAlgumTermo(catalogo[0], ["NAOEXISTE"])));

    test("_termosSemMatch com catálogo explícito retorna só os faltantes", () => {
        const faltam = _termosSemMatch(["08395","FEIJAO","NAOEXISTE"], catalogo);
        assert.deepEqual(faltam, ["NAOEXISTE"]);
    });

    test("_termosSemMatch sem catálogo (array vazio) retorna todos os termos", () => {
        const faltam = _termosSemMatch(["08395"], []);
        assert.deepEqual(faltam, ["08395"]);
    });

    test("_diffTermosFaltantes reusa Set sem re-varrer o catálogo", () => {
        const encontrados = new Set(["08395","FEIJAO"]);
        const faltam = _diffTermosFaltantes(["08395","FEIJAO","NAOEXISTE"], encontrados);
        assert.deepEqual(faltam, ["NAOEXISTE"]);
    });

    test("_diffTermosFaltantes sem Set retorna todos os termos (fallback)", () => {
        const faltam = _diffTermosFaltantes(["A","B"], null);
        assert.deepEqual(faltam, ["A","B"]);
    });
});

// ── 11. encontrarGruposAsync ──────────────────────────────────────────────────
describe("encontrarGruposAsync", () => {
    test("encontra par que soma ao valor-alvo", (_, done) => {
        const pool = [item("A",30,10), item("B",20,10)];
        encontrarGruposAsync(pool, 50, function(grupos) {
            try {
                assert.ok(grupos.length > 0);
                const par = grupos.find(g => g.itens.length === 2);
                assert.ok(par && Math.abs(par.soma - 50) < 0.01);
                done();
            } catch(e) { done(e); }
        });
    });

    test("retorna array vazio para pool vazio", (_, done) => {
        encontrarGruposAsync([], 50, function(grupos) {
            try { assert.deepEqual(grupos, []); done(); }
            catch(e) { done(e); }
        });
    });

    test("guard de geração descarta resultado de busca obsoleta", (_, done) => {
        const gen  = { valor: 0 };
        const pool = [item("A",25,10), item("B",25,10)];
        let chamado = false;
        encontrarGruposAsync(pool, 50, function() { chamado = true; }, gen);
        // Incrementa imediatamente — simula nova busca iniciada antes da anterior terminar
        gen.valor++;
        setTimeout(function() {
            try { assert.ok(!chamado, "onDone não deveria ser chamado quando geração foi invalidada"); done(); }
            catch(e) { done(e); }
        }, 200);
    });
});

// ── 12. encontrarCombinacoesComRepeticaoAsync ─────────────────────────────────
describe("encontrarCombinacoesComRepeticaoAsync", () => {
    test("encontra combinações com repetição", (_, done) => {
        const pool = [item("A",50,10), item("B",33,10)];
        encontrarCombinacoesComRepeticaoAsync(pool, 100, function(combos) {
            try {
                assert.ok(combos.length > 0);
                combos.forEach(c => assert.ok(c.soma >= 100 - 0.01 && c.soma <= 140));
                done();
            } catch(e) { done(e); }
        }, { estoqueMinimo: 0 });
    });

    test("retorna array vazio para pool vazio", (_, done) => {
        encontrarCombinacoesComRepeticaoAsync([], 100, function(combos) {
            try { assert.deepEqual(combos, []); done(); }
            catch(e) { done(e); }
        });
    });

    test("respeita estoqueMinimo — sem unidade disponível retorna zero combinações", (_, done) => {
        const it = item("A",16.90,6); // estoque=6, piso=5 → só 1 disponível
        encontrarCombinacoesComRepeticaoAsync([it], 50, function(combos) {
            try {
                // 1×16,90 não cobre 50 → nenhuma combinação
                assert.equal(combos.length, 0);
                done();
            } catch(e) { done(e); }
        }, { estoqueMinimo: 5 });
    });

    test("callback onStatus é chamado durante o cálculo", (_, done) => {
        const pool = [item("A",50,5)];
        const mensagens = [];
        encontrarCombinacoesComRepeticaoAsync(pool, 50, function() {
            try { assert.ok(mensagens.length > 0); done(); }
            catch(e) { done(e); }
        }, { estoqueMinimo: 0, onStatus: function(msg) { mensagens.push(msg); } });
    });
});

// ── 14. Regressão — Combinar não achava valores altos (DP_MAX_CENTS) ─────────
// Bug relatado: "valores altos nunca são achados" no modo Combinar. Causa:
// DP_MAX_CENTS era 60000 (R$600) — qualquer alvo acima disso pulava o DP
// inteiro e caía num força-bruta de no máximo 4 itens, que quase nunca fecha
// somas grandes. Corrigido: teto do DP subiu pra R$1200 + fallback guloso
// para valores ainda maiores (soma vários itens até fechar a faixa).
describe("regressão — Combinar em valores altos (acima do antigo teto de R$600)", () => {
    test("valor de R$800 (acima do teto antigo, dentro do novo teto do DP) encontra combinação exata", () => {
        const pool = [item("A", 50, 20), item("B", 33.5, 20), item("C", 16.5, 20)];
        const r = _autoEncontrarMelhorComRepeticao(pool, 800, 40, {}, {}, 0);
        assert.ok(r, "deveria encontrar uma combinação para R$800");
        assert.ok(r.soma >= 800 - 0.01 && r.soma <= 840 + 0.01,
            "soma " + r.soma + " deveria estar em [800, 840]");
    });

    test("valor de R$3200 (acima do novo teto do DP) ainda encontra combinação via fallback guloso", () => {
        const pool = [];
        for (let i = 0; i < 40; i++) pool.push(item("C" + i, 5 + (i % 13) * 7.35, 20));
        const r = _autoEncontrarMelhorComRepeticao(pool, 3200, 40, {}, {}, 0);
        assert.ok(r, "deveria encontrar uma combinação para R$3200 (fallback guloso)");
        assert.ok(r.soma >= 3200 - 0.01, "soma " + r.soma + " deveria ser >= 3200");
        assert.ok(r.soma <= 3200 + 40 + 40 + 0.01, "soma " + r.soma + " deveria respeitar a faixa de tolerância");
    });

    test("encontrarCombinacoesComRepeticaoAsync entrega ao menos 1 combinação para valor alto", (_, done) => {
        const pool = [];
        for (let i = 0; i < 30; i++) pool.push(item("D" + i, 8 + (i % 11) * 6.2, 15));
        encontrarCombinacoesComRepeticaoAsync(pool, 1500, function(combos) {
            try {
                assert.ok(combos.length > 0, "deveria achar ao menos 1 combinação para R$1500");
                combos.forEach(c => assert.ok(c.soma >= 1500 - 0.01));
                done();
            } catch (e) { done(e); }
        }, { estoqueMinimo: 0 });
    });

    test("fallback guloso nunca ultrapassa o teto da faixa (valor + faixaExtra + 40)", () => {
        const pool = [item("X", 999, 50)];
        const r = _autoEncontrarMelhorComRepeticao(pool, 5000, 40, {}, {}, 0);
        if (r) {
            const alvoMax = 5000 + 40 + 40;
            assert.ok(r.soma <= alvoMax + 0.01, "soma " + r.soma + " não deveria ultrapassar " + alvoMax);
        }
    });
});
describe("regressão — reaproveitamento com piso de estoque", () => {
    test("5 linhas corretas + 6ª nula (piso=5, estoque=20)", () => {
        const it   = item("08395", 16.90, 20);
        const usos = {};
        function rodar(val) {
            const pool = [it].filter(i => _qtdMaximaDisponivel(i, usos, null, 5) > 0);
            let r = _autoEncontrarMelhorComRepeticao(pool, val, 0, usos, null, 5);
            r = _validarResultadoPadrao(r, 5, usos, 5, []);
            if (r) r.itens.forEach(i => { usos[i.codigo] = (usos[i.codigo]||0)+1; });
            return r;
        }
        const linhas = [1,2,3,4,5].map(() => rodar(50));
        assert.ok(linhas.every(Boolean), "5 combinações devem ser encontradas");
        assert.equal(usos["08395"], 15, "3 unidades×5 linhas = 15 usos acumulados");
        assert.equal(rodar(50), null, "6ª linha retorna null — estoque atingiu o piso");
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSÃO — encontrarGruposAsync (modo Agrupar) não deve duplicar combinações
// ─────────────────────────────────────────────────────────────────────────────
// Bug original: os laços de pares/triplas varriam o array de candidatos
// inteiro (0..n) em vez de índices estritamente crescentes, gerando o MESMO
// conjunto de itens várias vezes (par {A,B} contado como (A,B) e (B,A); tripla
// {A,B,C} gerada a partir de cada âncora separadamente). Isso inflava o
// resultado com cards duplicados na UI. Fix: índices crescentes (a<b / a<b<c)
// + deduplicação final por assinatura de códigos ordenados.
describe("regressão — Agrupar não duplica combinações (pares/triplas)", () => {
    test("par simples {A,B}: aparece uma única vez, não (A,B)+(B,A)", (_, done) => {
        const itens = [item("A", 10, 5), item("B", 10, 5)];
        encontrarGruposAsync(itens, 20, function(grupos) {
            try {
                assert.equal(grupos.length, 1, "deveria haver exatamente 1 grupo para {A,B}");
                assert.deepEqual(grupos[0].itens.map(i => i.codigo).sort(), ["A", "B"]);
                done();
            } catch (e) { done(e); }
        }, null, null, {});
    });

    test("catálogo pequeno (A,B,C): nenhuma assinatura de combinação se repete", (_, done) => {
        const itens = [item("A", 10, 5), item("B", 10, 5), item("C", 20, 5)];
        encontrarGruposAsync(itens, 20, function(grupos) {
            try {
                const assinaturas = grupos.map(g => g.itens.map(i => i.codigo).slice().sort().join("|"));
                const unicas = new Set(assinaturas);
                assert.equal(assinaturas.length, unicas.size,
                    "cada combinação de itens deve aparecer no máximo 1 vez — encontrado: " + JSON.stringify(assinaturas));
                done();
            } catch (e) { done(e); }
        }, null, null, {});
    });

    test("tripla {A,B,C}: soma correta e um único card (não 3, um por âncora)", (_, done) => {
        const itens = [item("A", 10, 5), item("B", 10, 5), item("C", 10, 5)];
        encontrarGruposAsync(itens, 30, function(grupos) {
            try {
                const triplas = grupos.filter(g => g.itens.length === 3);
                assert.equal(triplas.length, 1, "deveria haver exatamente 1 tripla para {A,B,C} somando 30");
                assert.deepEqual(triplas[0].itens.map(i => i.codigo).sort(), ["A", "B", "C"]);
                done();
            } catch (e) { done(e); }
        }, null, null, {});
    });

    test("catálogo maior (10 itens): nenhuma duplicata de assinatura em nenhum grupo retornado", (_, done) => {
        const itens = [];
        for (let i = 0; i < 10; i++) itens.push(item("P" + i, 5 + i * 3.7, 10));
        encontrarGruposAsync(itens, 50, function(grupos) {
            try {
                const assinaturas = grupos.map(g => g.itens.map(i => i.codigo).slice().sort().join("|"));
                const unicas = new Set(assinaturas);
                assert.equal(assinaturas.length, unicas.size, "não deve haver combinações duplicadas");
                // cada grupo deve realmente somar dentro da faixa [valor, valor+40]
                grupos.forEach(g => {
                    assert.ok(g.soma >= 50 - 0.01 && g.soma <= 90 + 0.01,
                        "soma " + g.soma + " fora da faixa [50,90]");
                });
                done();
            } catch (e) { done(e); }
        }, null, null, { maxResultados: 50 });
    });

    test("nenhum grupo tem mais de 3 itens (fase de subset-sum/DP removida — só pares e triplas)", (_, done) => {
        const itens = [];
        for (let i = 0; i < 12; i++) itens.push(item("Q" + i, 3 + i * 2.5, 10));
        encontrarGruposAsync(itens, 60, function(grupos) {
            try {
                grupos.forEach(g => {
                    assert.ok(g.itens.length === 2 || g.itens.length === 3,
                        "grupo com " + g.itens.length + " itens — esperado apenas pares ou triplas");
                });
                done();
            } catch (e) { done(e); }
        }, null, null, { maxResultados: 50 });
    });
});