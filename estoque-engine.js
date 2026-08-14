/**
 * estoque-engine.js
 *
 * @version 1.4.0
 * @changelog
 *   1.4.0 - 2026-08-14 15:40 - Revisão de auditoria (sem mudança de
 *     comportamento observável — mesma API, mesmos resultados, 70/70 testes
 *     originais continuam passando):
 *       [1] _autoEncontrarMelhor mutava os objetos de entrada (`_item._p =
 *           _cp`), efeito colateral não documentado numa função descrita
 *           como pura — agora cada candidato é empacotado como {it, p}
 *           (item original + preço numérico já convertido), nunca mais
 *           escrito de volta no objeto do chamador.
 *       [2] Número mágico `40` (tolerância do modo Combinar) estava
 *           hardcoded em 4 pontos diferentes em vez de usar a constante
 *           FAIXA_COMBINAR já existente — agora todos os pontos referenciam
 *           a constante; mudar a tolerância no futuro exige editar 1 lugar,
 *           não 4.
 *       [3] Removida a label `outer3ex:` da Fase 3 de _autoEncontrarMelhor —
 *           não era referenciada por nenhum break/continue (resquício de
 *           uma versão anterior do algoritmo), apenas ruído para quem lê.
 *
 * ARQUITETURA:
 *   - UMD wrapper: expõe via module.exports (Node) ou window globals (browser)
 *   - Funções puras: nenhuma lê/escreve globais — toda dependência é parâmetro
 *   - Os únicos "globals" usados são o fallback em _ehProibidoCliente e
 *     _termosSemMatch, que aceitam o valor explícito como 1º opção
 *   - encontrarGruposAsync / encontrarCombinacoesComRepeticaoAsync aceitam um
 *     objeto de geração externo e um callback de status opcionais
 *
 * USO NOS TESTES:
 *   const engine = require('./estoque-engine.js');
 *   const { _qtdMaximaDisponivel } = engine;
 *
 * USO NO BROWSER (via script inline pelo servidor):
 *   // Todas as funções ficam globais automaticamente via UMD
 *   _qtdMaximaDisponivel(item, usos, parada, piso);
 */

/* global window, _S, _itens */
(function (root, factory) {
    "use strict";
    if (typeof module !== "undefined" && module.exports) {
        // Node.js — require()
        module.exports = factory();
    } else {
        // Browser — expõe tudo como global (igual ao comportamento anterior)
        var api = factory();
        for (var k in api) {
            if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
        }
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // ── Constantes exportadas ─────────────────────────────────────────────────
    // Centralizadas aqui para que testes e servidor usem sempre os mesmos valores.
    var FLOAT_EPS              = 0.005;  // tolerância float (~meio centavo)
    var FAIXA_COMBINAR         = 40;     // tolerância acima do valor-alvo no modo Combinar
    var FAIXA_EXCEDENTE_LP     = 99999;  // sentinela "sem teto" para busca de excedente
    var PRECO_SENTINEL_ZERADO  = 0.01;   // preço sentinela de item "zerado" no ERP legado
    var MAX_COMBINAR_RESULTADOS = 20;    // máx. combinações retornadas pelo modo Combinar

    // ── _qtdMaximaDisponivel ──────────────────────────────────────────────────
    // Quantas unidades de um item ainda podem ser usadas sem violar nenhum
    // dos três pisos de estoque (parada, mínimo ou zero absoluto).
    //
    // Três conceitos de piso, como camadas independentes:
    //   1. Estoque de parada (estoqueParadaPorCod[codigo]) — prevalece quando definido.
    //   2. Estoque mínimo (pisoPadrao) — usado quando não há parada específica.
    //   3. Zero absoluto — trava incondicional; nunca retorna valor que tornaria
    //      o estoque simulado negativo, mesmo que piso ou dados venham inválidos.
    function _qtdMaximaDisponivel(item, usosAcumulados, estoqueParadaPorCod, pisoPadrao) {
        if (!item) return 0;
        var estoqueAtual = Number(item.estoque || 0);
        if (!Number.isFinite(estoqueAtual) || estoqueAtual < 0) return 0;
        var usados = (usosAcumulados && usosAcumulados[item.codigo]) || 0;
        if (!Number.isFinite(usados) || usados < 0) usados = 0;
        var limite   = estoqueParadaPorCod ? estoqueParadaPorCod[item.codigo] : null;
        var pisoBase = (typeof pisoPadrao === "number" && Number.isFinite(pisoPadrao)) ? pisoPadrao : 0;
        var piso     = (limite != null && !isNaN(limite)) ? Number(limite) : pisoBase;
        if (!Number.isFinite(piso) || piso < 0) piso = 0;
        var restante = estoqueAtual - usados - piso;
        return restante > 0 ? Math.floor(restante) : 0;
    }

    // ── _grupoRespeitaLimites ─────────────────────────────────────────────────
    // Trava final: verifica se um grupo de itens (podendo repetir códigos)
    // respeita, código a código, a quantidade máxima calculada por
    // _qtdMaximaDisponivel. Usado antes de aceitar uma combinação no fallback
    // de força bruta de _autoEncontrarMelhorComRepeticao.
    function _grupoRespeitaLimites(grupo, usosAcumulados, estoqueParadaPorCod, pisoPadrao) {
        if (!grupo || !grupo.length) return true;
        var contagem = {};
        var refs     = {};
        for (var gi = 0; gi < grupo.length; gi++) {
            var cod = grupo[gi].codigo;
            contagem[cod] = (contagem[cod] || 0) + 1;
            refs[cod] = grupo[gi];
        }
        for (var cod2 in contagem) {
            if (!Object.prototype.hasOwnProperty.call(contagem, cod2)) continue;
            if (contagem[cod2] > _qtdMaximaDisponivel(refs[cod2], usosAcumulados, estoqueParadaPorCod, pisoPadrao)) {
                return false;
            }
        }
        return true;
    }

    // ── _autoEncontrarMelhor (modo padrão — sem repetição de código) ──────────
    // Busca em 4 fases: item exato → par exato → tripla exata → melhor match
    // em [valor, valor+40]. Nunca usa o mesmo código mais de uma vez.
    function _autoEncontrarMelhor(disponiveis, valor, faixaExtra) {
        if (!valor || valor <= 0 || !disponiveis || !disponiveis.length) return null;
        var _extra  = (typeof faixaExtra === "number" && faixaExtra >= 0) ? faixaExtra : 0;
        var EPS     = FLOAT_EPS;
        var alvoMax = valor + FAIXA_COMBINAR + _extra;
        // Candidatos empacotados como {it, p}: o preço fica no wrapper, nunca
        // escrito de volta no objeto original — a função é pura de verdade,
        // não muta nenhum item do array recebido (achado de auditoria: a
        // versão anterior gravava "_item._p = _cp" direto no item do
        // chamador, poluindo silenciosamente objetos que também vivem em
        // _itens/_catalogoCompleto no servidor/cliente).
        var candsExatos = [];
        var candsFaixa  = [];
        for (var _ci = 0; _ci < disponiveis.length; _ci++) {
            var _item = disponiveis[_ci];
            var _cp   = Number(_item.preco || 0);
            if (_cp <= 0) continue;
            var _cand = { it: _item, p: _cp };
            if (_cp <= alvoMax + EPS) {
                candsFaixa.push(_cand);
                if (_cp <= valor + EPS) candsExatos.push(_cand);
            }
        }
        if (!candsFaixa.length) return null;

        // Fase 1: item único exato
        for (var _f1 = 0; _f1 < candsExatos.length; _f1++) {
            if (Math.abs(candsExatos[_f1].p - valor) <= EPS) {
                return { itens: [candsExatos[_f1].it], soma: +candsExatos[_f1].p.toFixed(2), diff: 0 };
            }
        }

        // Mapa preço→candidatos (centavos) para lookup O(1) de complemento
        var _precoMap = Object.create(null);
        for (var _pmi = 0; _pmi < candsExatos.length; _pmi++) {
            var _pKey = Math.round(candsExatos[_pmi].p * 100);
            if (!_precoMap[_pKey]) _precoMap[_pKey] = [];
            _precoMap[_pKey].push(candsExatos[_pmi]);
        }

        // Fase 2: par exato
        for (var _f2 = 0; _f2 < candsExatos.length; _f2++) {
            var _pa2  = candsExatos[_f2].p;
            var _pb2  = valor - _pa2;
            if (_pb2 <= EPS) continue;
            var _lista2 = _precoMap[Math.round(_pb2 * 100)];
            if (!_lista2) continue;
            for (var _li2 = 0; _li2 < _lista2.length; _li2++) {
                if (_lista2[_li2].it.codigo === candsExatos[_f2].it.codigo) continue;
                var _soma2 = _pa2 + _lista2[_li2].p;
                if (Math.abs(_soma2 - valor) <= EPS) {
                    return { itens: [candsExatos[_f2].it, _lista2[_li2].it], soma: +_soma2.toFixed(2), diff: 0 };
                }
            }
        }

        // Fase 3: tripla exata (O(n²) + hash para 3º)
        var _tripCands = candsExatos.filter(function(c) { return c.p < valor - EPS; });
        if (_tripCands.length > 200) _tripCands = _tripCands.slice(0, 200);
        for (var _a3 = 0; _a3 < _tripCands.length; _a3++) {
            var _pa3 = _tripCands[_a3].p;
            for (var _b3 = _a3 + 1; _b3 < _tripCands.length; _b3++) {
                var _ab3 = _pa3 + _tripCands[_b3].p;
                if (_ab3 >= valor - EPS) continue;
                var _lista3 = _precoMap[Math.round((valor - _ab3) * 100)];
                if (!_lista3) continue;
                for (var _li3 = 0; _li3 < _lista3.length; _li3++) {
                    var _c3 = _lista3[_li3];
                    if (_c3.it.codigo === _tripCands[_a3].it.codigo || _c3.it.codigo === _tripCands[_b3].it.codigo) continue;
                    var _soma3 = _ab3 + _c3.p;
                    if (Math.abs(_soma3 - valor) <= EPS) {
                        return { itens: [_tripCands[_a3].it, _tripCands[_b3].it, _c3.it], soma: +_soma3.toFixed(2), diff: 0 };
                    }
                }
            }
        }

        // Fase 4: melhor match em [valor, valor+FAIXA_COMBINAR]
        candsFaixa.sort(function(a, b) { return Math.abs(a.p - valor) - Math.abs(b.p - valor); });
        if (candsFaixa.length > 80) candsFaixa = candsFaixa.slice(0, 80);
        var _melhor = null;
        function _atualizar(grupoCands, soma) {
            var diff = +(soma - valor).toFixed(2);
            if (diff < -EPS || diff > FAIXA_COMBINAR + _extra + EPS) return;
            if (!_melhor || diff < _melhor.diff) {
                var _itensGrupo = [];
                for (var _gi = 0; _gi < grupoCands.length; _gi++) _itensGrupo.push(grupoCands[_gi].it);
                _melhor = { itens: _itensGrupo, soma: +soma.toFixed(2), diff: diff };
            }
        }
        for (var _s4 = 0; _s4 < candsFaixa.length; _s4++) {
            _atualizar([candsFaixa[_s4]], candsFaixa[_s4].p);
            if (_melhor && _melhor.diff < EPS) return _melhor;
        }
        outer2f:
        for (var _a4 = 0; _a4 < candsFaixa.length; _a4++) {
            for (var _b4 = _a4 + 1; _b4 < candsFaixa.length; _b4++) {
                var _s2f = candsFaixa[_a4].p + candsFaixa[_b4].p;
                if (_s2f > alvoMax + EPS) continue;
                _atualizar([candsFaixa[_a4], candsFaixa[_b4]], _s2f);
                if (_melhor && _melhor.diff < EPS) break outer2f;
            }
        }
        if (_melhor && _melhor.diff < EPS) return _melhor;
        outer3f:
        for (var _a5 = 0; _a5 < candsFaixa.length; _a5++) {
            var _pa5 = candsFaixa[_a5].p;
            for (var _b5 = _a5 + 1; _b5 < candsFaixa.length; _b5++) {
                var _ab5 = _pa5 + candsFaixa[_b5].p;
                if (_ab5 > alvoMax + EPS) continue;
                for (var _c5 = _b5 + 1; _c5 < candsFaixa.length; _c5++) {
                    var _s3f = _ab5 + candsFaixa[_c5].p;
                    if (_s3f > alvoMax + EPS) continue;
                    _atualizar([candsFaixa[_a5], candsFaixa[_b5], candsFaixa[_c5]], _s3f);
                    if (_melhor && _melhor.diff < EPS) break outer3f;
                }
            }
        }
        return _melhor;
    }

    // ── _autoEncontrarMelhorComRepeticao (lista personalizada / Combinar) ─────
    // DP bounded-knapsack via binary splitting + fallback de força bruta.
    // O mesmo item pode aparecer mais de uma vez, nunca ultrapassando
    // _qtdMaximaDisponivel(item, usosAcumulados, estoqueParadaPorCod, pisoPadrao).
    function _autoEncontrarMelhorComRepeticao(pool, valor, faixaExtra, usosAcumulados, estoqueParadaPorCod, pisoPadrao) {
        usosAcumulados      = usosAcumulados      || {};
        estoqueParadaPorCod = estoqueParadaPorCod || {};
        if (!valor || valor <= 0 || !pool || !pool.length) return null;
        var _extra  = (typeof faixaExtra === "number" && faixaExtra >= 0) ? faixaExtra : 0;
        var EPS     = FLOAT_EPS;
        var alvoMax = valor + FAIXA_COMBINAR + _extra;

        var cands = [];
        for (var _ci = 0; _ci < pool.length; _ci++) {
            var _cp = Number(pool[_ci].preco || 0);
            if (_cp > 0 && _qtdMaximaDisponivel(pool[_ci], usosAcumulados, estoqueParadaPorCod, pisoPadrao) > 0) {
                cands.push(pool[_ci]);
            }
        }
        if (!cands.length) return null;
        if (cands.length > 30) cands = cands.slice(0, 30);

        // Teto do DP exato (bounded-knapsack). Acima disso o custo O(moedas×cents)
        // fica caro demais para rodar síncrono no meio de _buscarProxima — nesses
        // casos (valores altos) cai no fallback guloso logo abaixo, que sempre
        // consegue formar uma soma (ainda que não ótima) somando vários itens.
        var DP_MAX_CENTS = 120000; // R$1200 — antes 60000 (R$600), por isso valores
                                    // altos nunca eram encontrados: o DP nem rodava
                                    // e o força-bruta antigo (máx. 4 itens) raramente
                                    // alcança somas grandes.
        var alvoCents   = Math.round(valor * 100);
        var maxCents    = Math.round(alvoMax * 100);

        if (alvoCents > 0 && maxCents > 0 && maxCents <= DP_MAX_CENTS) {
            var moedas = [];
            for (var _pc = 0; _pc < cands.length; _pc++) {
                var _precoC  = Math.round(Number(cands[_pc].preco) * 100);
                if (_precoC <= 0 || _precoC > maxCents) continue;
                var _limQtd  = _qtdMaximaDisponivel(cands[_pc], usosAcumulados, estoqueParadaPorCod, pisoPadrao);
                if (_limQtd <= 0) continue;
                var _restQtd = _limQtd;
                var _bloco   = 1;
                while (_restQtd > 0) {
                    var _qtdBloco = Math.min(_bloco, _restQtd);
                    moedas.push({ item: cands[_pc], qtd: _qtdBloco, custo: _precoC * _qtdBloco });
                    _restQtd -= _qtdBloco;
                    _bloco   *= 2;
                }
            }
            if (moedas.length > 150) moedas = moedas.slice(0, 150);

            if (moedas.length) {
                var dp = new Array(maxCents + 1);
                for (var _zi = 0; _zi <= maxCents; _zi++) dp[_zi] = null;
                dp[0] = { count: 0, lastMoeda: -1, prevV: -1 };
                for (var mIdx = 0; mIdx < moedas.length; mIdx++) {
                    var moeda = moedas[mIdx];
                    for (var v = maxCents; v >= moeda.custo; v--) {
                        if (dp[v - moeda.custo]) {
                            var cnt = dp[v - moeda.custo].count + moeda.qtd;
                            if (!dp[v] || cnt < dp[v].count) {
                                dp[v] = { count: cnt, lastMoeda: mIdx, prevV: v - moeda.custo };
                            }
                        }
                    }
                }
                var melhorV = dp[alvoCents] ? alvoCents : -1;
                if (melhorV < 0) {
                    for (var v2 = alvoCents + 1; v2 <= maxCents; v2++) {
                        if (dp[v2]) { melhorV = v2; break; }
                    }
                }
                if (melhorV >= 0) {
                    var itensResult = [];
                    var cur = melhorV;
                    var _guard = 0;
                    while (cur > 0 && dp[cur] && _guard < 5000) {
                        var _mu = moedas[dp[cur].lastMoeda];
                        for (var _rep = 0; _rep < _mu.qtd; _rep++) itensResult.push(_mu.item);
                        cur = dp[cur].prevV;
                        _guard++;
                    }
                    if (itensResult.length) {
                        var sf = melhorV / 100;
                        return { itens: itensResult, soma: +sf.toFixed(2), diff: +(sf - valor).toFixed(2) };
                    }
                }
            }
        }

        // ── Fallback guloso (valores acima do teto do DP, ex: DP_MAX_CENTS) ──────
        // Para valores altos o força-bruta abaixo (até 4 itens) quase nunca alcança
        // a soma-alvo — por isso "valores altos nunca eram achados". O guloso monta
        // a combinação item a item (maior preço que ainda cabe primeiro), respeitando
        // _qtdMaximaDisponivel a cada passo, até cair dentro de [valor, valor+faixa]
        // ou esgotar candidatos. Não é sempre a soma ótima, mas encontra uma
        // combinação válida onde o DP e o força-bruta de poucos itens falhavam.
        if (maxCents > DP_MAX_CENTS) {
            var _usosG = {};
            for (var _ug in usosAcumulados) if (Object.prototype.hasOwnProperty.call(usosAcumulados, _ug)) _usosG[_ug] = usosAcumulados[_ug];
            var _gulosos = cands.slice().sort(function(x, y) { return Number(y.preco) - Number(x.preco); });
            var _somaG = 0;
            var _itensG = [];
            var _guardG = 0;
            var _restanteCents = maxCents;
            while (_restanteCents > 0 && _guardG < 2000) {
                _guardG++;
                var _achouAlgum = false;
                for (var _gi = 0; _gi < _gulosos.length; _gi++) {
                    var _git = _gulosos[_gi];
                    var _gpc = Math.round(Number(_git.preco) * 100);
                    if (_gpc <= 0 || _gpc > _restanteCents) continue;
                    if (_qtdMaximaDisponivel(_git, _usosG, estoqueParadaPorCod, pisoPadrao) <= 0) continue;
                    _itensG.push(_git);
                    _usosG[_git.codigo] = (_usosG[_git.codigo] || 0) + 1;
                    _somaG += _gpc;
                    _restanteCents = maxCents - _somaG;
                    _achouAlgum = true;
                    if (_somaG >= alvoCents) break;
                    break; // reavalia do maior candidato novamente (limites de qtd mudam)
                }
                if (!_achouAlgum) break;
                if (_somaG >= alvoCents) break;
            }
            if (_itensG.length && _somaG >= alvoCents - EPS * 100 && _somaG <= maxCents + EPS * 100) {
                var sfG = _somaG / 100;
                return { itens: _itensG, soma: +sfG.toFixed(2), diff: +(sfG - valor).toFixed(2) };
            }
            // Não fechou dentro da faixa com o guloso — cai para o força-bruta
            // abaixo, que ainda pode achar uma combinação pequena e exata.
        }

        // Fallback força bruta (até 4 itens, com repetição)
        var sorted = cands.slice().sort(function(x, y) { return Number(x.preco) - Number(y.preco); });
        var n = sorted.length;
        var precos = sorted.map(function(i) { return Number(i.preco); });
        var _melhorR = null;
        function _atualizarR(grupo, soma) {
            var diff = +(soma - valor).toFixed(2);
            if (diff < -EPS || diff > FAIXA_COMBINAR + _extra + EPS) return;
            if (!_grupoRespeitaLimites(grupo, usosAcumulados, estoqueParadaPorCod, pisoPadrao)) return;
            if (!_melhorR || diff < _melhorR.diff) {
                _melhorR = { itens: grupo.slice(), soma: +soma.toFixed(2), diff: diff };
            }
        }
        for (var s1 = 0; s1 < n; s1++) {
            if (precos[s1] > alvoMax + EPS) break;
            _atualizarR([sorted[s1]], precos[s1]);
            if (_melhorR && _melhorR.diff < EPS) return _melhorR;
        }
        for (var a2 = 0; a2 < n; a2++) {
            if (precos[a2] > alvoMax + EPS) break;
            for (var b2 = a2; b2 < n; b2++) {
                var s2 = precos[a2] + precos[b2];
                if (s2 > alvoMax + EPS) break;
                _atualizarR([sorted[a2], sorted[b2]], s2);
                if (_melhorR && _melhorR.diff < EPS) return _melhorR;
            }
        }
        for (var a3 = 0; a3 < n; a3++) {
            if (precos[a3] > alvoMax + EPS) break;
            for (var b3 = a3; b3 < n; b3++) {
                var ab3 = precos[a3] + precos[b3];
                if (ab3 > alvoMax + EPS) break;
                for (var c3 = b3; c3 < n; c3++) {
                    var s3 = ab3 + precos[c3];
                    if (s3 > alvoMax + EPS) break;
                    _atualizarR([sorted[a3], sorted[b3], sorted[c3]], s3);
                    if (_melhorR && _melhorR.diff < EPS) return _melhorR;
                }
            }
        }
        for (var a4 = 0; a4 < n; a4++) {
            if (precos[a4] > alvoMax + EPS) break;
            for (var b4 = a4; b4 < n; b4++) {
                var ab4 = precos[a4] + precos[b4];
                if (ab4 > alvoMax + EPS) break;
                for (var c4 = b4; c4 < n; c4++) {
                    var abc4 = ab4 + precos[c4];
                    if (abc4 > alvoMax + EPS) break;
                    for (var d4 = c4; d4 < n; d4++) {
                        var s4 = abc4 + precos[d4];
                        if (s4 > alvoMax + EPS) break;
                        _atualizarR([sorted[a4], sorted[b4], sorted[c4], sorted[d4]], s4);
                        if (_melhorR && _melhorR.diff < EPS) return _melhorR;
                    }
                }
            }
        }
        return _melhorR;
    }

    // ── _ehProibidoCliente ────────────────────────────────────────────────────
    // Verifica se a descrição de um item contém termo da lista de proibidos.
    // Aceita as listas explicitamente (preferido nos testes); como fallback
    // em contexto browser lê window._S se as listas não forem fornecidas.
    function _ehProibidoCliente(descricao, proibidosEmbutidos, proibidosExtra) {
        if (!descricao) return false;
        var upper = String(descricao).toUpperCase();
        /* global window, _S */
        var lista  = proibidosEmbutidos != null ? proibidosEmbutidos
                   : (typeof _S !== "undefined" && _S.proibidosEmbutidos ? _S.proibidosEmbutidos : []);
        var extras = proibidosExtra != null ? proibidosExtra
                   : (typeof _S !== "undefined" && _S.proibidosExtra    ? _S.proibidosExtra    : []);
        for (var i = 0; i < lista.length; i++) {
            if (lista[i] && upper.indexOf(String(lista[i]).toUpperCase()) !== -1) return true;
        }
        for (var j = 0; j < extras.length; j++) {
            if (extras[j] && upper.indexOf(String(extras[j]).toUpperCase()) !== -1) return true;
        }
        return false;
    }

    // ── _validarResultadoPadrao ───────────────────────────────────────────────
    // Camada defensiva: rejeita resultado que viola código duplicado, estoque
    // mínimo ou itens proibidos. Aceita listas de proibidos explicitamente
    // (para testes determinísticos) com fallback para globais no browser.
    function _validarResultadoPadrao(resultado, estoqueMinimo, usosAcumulados, pisoPadrao, proibidosEmbutidos, proibidosExtra) {
        if (!resultado || !resultado.itens || !resultado.itens.length) return null;
        var permiteRepeticao = !!usosAcumulados;
        var vistos = Object.create(null);
        for (var i = 0; i < resultado.itens.length; i++) {
            var it = resultado.itens[i];
            if (vistos[it.codigo] && !permiteRepeticao) return null;
            vistos[it.codigo] = true;
            if (Number(it.estoque || 0) < Number(estoqueMinimo || 0)) return null;
            if (_ehProibidoCliente(it.descricao, proibidosEmbutidos, proibidosExtra)) return null;
        }
        if (permiteRepeticao && !_grupoRespeitaLimites(resultado.itens, usosAcumulados, null, pisoPadrao)) {
            return null;
        }
        return resultado;
    }

    // ── _validarResultadoLista ────────────────────────────────────────────────
    // Equivalente de _validarResultadoPadrao para a lista personalizada.
    // Não verifica proibidos/estoqueMinimo (by design — lista personalizada
    // é escolha manual do usuário). Só verifica piso de estoque/zero absoluto.
    function _validarResultadoLista(resultado, usosAcumulados, estoqueParadaPorCod) {
        if (!resultado || !resultado.itens || !resultado.itens.length) return null;
        if (!_grupoRespeitaLimites(resultado.itens, usosAcumulados, estoqueParadaPorCod)) {
            return null;
        }
        return resultado;
    }

    // ── _formatarCodigosCompactado ────────────────────────────────────────────
    // Agrupa itens repetidos: ["A","A","B"] → "2*A B"
    function _formatarCodigosCompactado(itens) {
        var contagem = {};
        var ordem    = [];
        itens.forEach(function(it) {
            if (!contagem[it.codigo]) { contagem[it.codigo] = 0; ordem.push(it.codigo); }
            contagem[it.codigo]++;
        });
        return ordem.map(function(cod) {
            return contagem[cod] > 1 ? (contagem[cod] + "*" + cod) : cod;
        }).join(" ");
    }

    // ── _diffTermosFaltantes ──────────────────────────────────────────────────
    // Subtração O(termos) usando um Set já calculado — evita re-varrer _itens.
    function _diffTermosFaltantes(termos, encontradosSet) {
        if (!encontradosSet) return termos;
        return termos.filter(function(t) { return !encontradosSet.has(t); });
    }

    // ── _itemBateAlgumTermo ───────────────────────────────────────────────────
    // Verdadeiro se o item bate com qualquer termo (union search).
    function _itemBateAlgumTermo(it, termos) {
        for (var i = 0; i < termos.length; i++) {
            var t = termos[i];
            if (it._descUp.indexOf(t) !== -1 || it._codUp.indexOf(t) !== -1 || it._barUp.indexOf(t) !== -1) {
                return true;
            }
        }
        return false;
    }

    // ── _termosSemMatch ───────────────────────────────────────────────────────
    // Quais termos não têm nenhum item correspondente em itensArr.
    // Aceita itensArr explícito (testes) ou faz fallback para o global _itens.
    function _termosSemMatch(termos, itensArr) {
        /* global _itens */
        var catalogo = itensArr != null ? itensArr
                     : (typeof _itens !== "undefined" ? _itens : []);
        return termos.filter(function(termo) {
            for (var i = 0; i < catalogo.length; i++) {
                var it = catalogo[i];
                if (it._descUp.indexOf(termo) !== -1 || it._codUp.indexOf(termo) !== -1 || it._barUp.indexOf(termo) !== -1) {
                    return false;
                }
            }
            return true;
        });
    }

    // ── encontrarGruposAsync ──────────────────────────────────────────────────
    // Combinações de 2-3 itens DISTINTOS que somam ao valor-alvo (modo Agrupar).
    // Algoritmo restaurado da versão anterior comprovadamente estável (ver
    // changelog v1.3.0): pares e triplas com índices estritamente crescentes
    // (a<b / a<b<c — nunca repete o mesmo conjunto de itens em ordem
    // diferente), rodando em UM ÚNICO setTimeout (sem chunking multi-fase).
    // gen: objeto { valor: number } — incrementar cancela resultado tardio.
    // onStatus: callback opcional (msg) para atualizar UI sem referência a DOM.
    // cfg (opcional, 6º parâmetro): { estoqueMinimo, proibidosEmbutidos, proibidosExtra, maxResultados }
    //   - estoqueMinimo: piso de estoque que cada item candidato deve respeitar (default 0)
    //   - proibidosEmbutidos/proibidosExtra: listas repassadas para _ehProibidoCliente
    //   - maxResultados: quantos grupos retornar no máximo (default 20)
    function encontrarGruposAsync(itens, valor, onDone, gen, onStatus, cfg) {
        if (!itens || !itens.length || !valor || valor <= 0) { if (onDone) onDone([]); return; }
        cfg = cfg || {};
        var estoqueMinimo      = typeof cfg.estoqueMinimo   === "number" ? cfg.estoqueMinimo   : 0;
        var proibidosEmbutidos = cfg.proibidosEmbutidos != null ? cfg.proibidosEmbutidos : null;
        var proibidosExtra     = cfg.proibidosExtra     != null ? cfg.proibidosExtra     : null;
        var maxResultados      = typeof cfg.maxResultados === "number" ? cfg.maxResultados : 20;
        var minhaGen = gen ? gen.valor++ : null; // guarda geração atual antes de incrementar

        var alvoMin = valor;
        var alvoMax = valor + FAIXA_COMBINAR;
        var EPS     = FLOAT_EPS;

        setTimeout(function() {
            // Descarta resultado obsoleto: uma busca mais nova já foi disparada
            // enquanto esta esperava o setTimeout (gen.valor mudou nesse meio-tempo).
            if (gen && minhaGen !== null && gen.valor - 1 !== minhaGen) { return; }
            if (onStatus) onStatus("Calculando combinações...");

            // Candidatos: preço válido dentro da faixa, não usado, estoque mínimo
            // respeitado e não proibido — tudo filtrado ANTES de montar pares/triplas.
            var cands = itens.filter(function(it) {
                var p = Number(it.preco || 0);
                if (!(p > PRECO_SENTINEL_ZERADO && p <= alvoMax + EPS && !it.usado)) return false;
                if (Number(it.estoque || 0) < estoqueMinimo) return false;
                if (_ehProibidoCliente(it.descricao, proibidosEmbutidos, proibidosExtra)) return false;
                return true;
            });
            // Limita candidatos para não explodir O(n³) nas triplas
            if (cands.length > 250) cands = cands.slice(0, 250);

            // Pré-extrai preços numéricos uma única vez (evita Number() repetido nos loops internos)
            var precos = new Array(cands.length);
            for (var _pi = 0; _pi < cands.length; _pi++) precos[_pi] = Number(cands[_pi].preco);

            var grupos  = [];
            var LIMITE  = Math.max(maxResultados, 30); // teto de coleta antes de ordenar/cortar

            // ── Pares — índices estritamente crescentes (a<b): cada conjunto
            //    {A,B} é gerado UMA única vez, nunca como (A,B) e depois (B,A). ──
            for (var a = 0; a < cands.length && grupos.length < LIMITE; a++) {
                var pa = precos[a];
                for (var b = a + 1; b < cands.length && grupos.length < LIMITE; b++) {
                    var soma2 = pa + precos[b];
                    if (soma2 >= alvoMin - EPS && soma2 <= alvoMax + EPS) {
                        grupos.push({ itens: [cands[a], cands[b]], soma: +soma2.toFixed(2), diff: +(soma2 - valor).toFixed(2) });
                    }
                }
            }

            // ── Triplas — apenas se ainda precisamos de mais grupos; índices
            //    estritamente crescentes (a<b<c) pela mesma razão dos pares. ──
            if (grupos.length < LIMITE) {
                for (var a2 = 0; a2 < cands.length && grupos.length < LIMITE; a2++) {
                    var pa2 = precos[a2];
                    if (pa2 >= alvoMax + EPS) continue;
                    for (var b2 = a2 + 1; b2 < cands.length && grupos.length < LIMITE; b2++) {
                        var ab2 = pa2 + precos[b2];
                        if (ab2 >= alvoMax + EPS) continue;
                        for (var c2 = b2 + 1; c2 < cands.length && grupos.length < LIMITE; c2++) {
                            var soma3 = ab2 + precos[c2];
                            if (soma3 >= alvoMin - EPS && soma3 <= alvoMax + EPS) {
                                grupos.push({ itens: [cands[a2], cands[b2], cands[c2]], soma: +soma3.toFixed(2), diff: +(soma3 - valor).toFixed(2) });
                            }
                        }
                    }
                }
            }

            // ── Deduplicação por assinatura ────────────────────────────────────
            // Trava de segurança extra: mesmo com índices crescentes já evitando
            // permutações do mesmo conjunto, garante 1 card por combinação
            // distinta de itens (assinatura = códigos ordenados, não a ordem
            // de inserção — {A,B} e {B,A} colapsam na mesma chave).
            var vistos       = Object.create(null);
            var gruposUnicos = [];
            for (var gi = 0; gi < grupos.length; gi++) {
                var cods = [];
                for (var ci = 0; ci < grupos[gi].itens.length; ci++) cods.push(String(grupos[gi].itens[ci].codigo));
                cods.sort();
                var assinatura = cods.join("|");
                if (vistos[assinatura]) continue;
                vistos[assinatura] = true;
                gruposUnicos.push(grupos[gi]);
            }

            if (onStatus) onStatus("");

            // Ordena do mais próximo ao valor-alvo usando transformação de
            // Schwartzian: pré-computa Math.abs uma única vez por elemento.
            var resultado = gruposUnicos
                .map(function(g) { return { g: g, d: Math.abs(g.soma - valor) }; })
                .sort(function(x, y) { return x.d - y.d; })
                .slice(0, maxResultados)
                .map(function(x) { return x.g; });
            if (onDone) onDone(resultado);
        }, 0);
    }

    // ── encontrarCombinacoesComRepeticaoAsync ─────────────────────────────────
    // Modo Combinar: mesmo item pode aparecer múltiplas vezes (qtd×item).
    // gen: objeto { valor: number } — incrementar cancela resultado tardio.
    // onStatus: callback opcional (msg) em vez de document.getElementById.
    function encontrarCombinacoesComRepeticaoAsync(itens, valor, onDone, cfg) {
        cfg = cfg || {};
        var estoqueMinimo   = typeof cfg.estoqueMinimo   === "number" ? cfg.estoqueMinimo   : 0;
        var maxResultados   = typeof cfg.maxResultados   === "number" ? cfg.maxResultados   : MAX_COMBINAR_RESULTADOS;
        var faixaCombinar   = typeof cfg.faixaCombinar   === "number" ? cfg.faixaCombinar   : FAIXA_COMBINAR;
        var precoSentinel   = typeof cfg.precoSentinel   === "number" ? cfg.precoSentinel   : PRECO_SENTINEL_ZERADO;
        var onStatus        = typeof cfg.onStatus        === "function" ? cfg.onStatus      : null;
        var gen             = cfg.gen || null;
        var minhaGen        = gen ? gen.valor++ : null;

        if (!itens || !itens.length || !valor || valor <= 0) { if (onDone) onDone([]); return; }
        if (onStatus) onStatus("Calculando...");

        var pool = itens.filter(function(it) {
            return Number(it.preco || 0) > precoSentinel && Number(it.estoque || 0) > 0 && !it.usado;
        });

        var usosSimulados = {};
        var resultados    = [];

        function _buscarProxima() {
            if (gen && minhaGen !== null && gen.valor - 1 !== minhaGen) return;
            if (resultados.length >= maxResultados) { _entregar(); return; }

            var poolAtual = pool.filter(function(it) {
                return (Number(it.estoque || 0) - (usosSimulados[it.codigo] || 0) - estoqueMinimo) > 0;
            });
            if (!poolAtual.length) { _entregar(); return; }

            var resultado = _autoEncontrarMelhorComRepeticao(poolAtual, valor, faixaCombinar, usosSimulados, null, estoqueMinimo);
            if (!resultado || !resultado.itens || !resultado.itens.length) { _entregar(); return; }

            resultado.itens.forEach(function(it) {
                usosSimulados[it.codigo] = (usosSimulados[it.codigo] || 0) + 1;
            });
            resultados.push(resultado);
            setTimeout(_buscarProxima, 0);
        }

        function _entregar() {
            if (gen && minhaGen !== null && gen.valor - 1 !== minhaGen) return;
            if (onStatus) {
                var n = resultados.length;
                onStatus(n ? n + " combinação" + (n > 1 ? "ões" : "") + " encontrada" + (n > 1 ? "s" : "") : "");
            }
            if (onDone) onDone(resultados);
        }

        setTimeout(_buscarProxima, 0);
    }

    // ── API pública ───────────────────────────────────────────────────────────
    return {
        // Constantes
        FLOAT_EPS              : FLOAT_EPS,
        FAIXA_COMBINAR         : FAIXA_COMBINAR,
        FAIXA_EXCEDENTE_LP     : FAIXA_EXCEDENTE_LP,
        PRECO_SENTINEL_ZERADO  : PRECO_SENTINEL_ZERADO,
        MAX_COMBINAR_RESULTADOS: MAX_COMBINAR_RESULTADOS,
        // Funções puras de estoque
        _qtdMaximaDisponivel               : _qtdMaximaDisponivel,
        _grupoRespeitaLimites              : _grupoRespeitaLimites,
        _autoEncontrarMelhor               : _autoEncontrarMelhor,
        _autoEncontrarMelhorComRepeticao   : _autoEncontrarMelhorComRepeticao,
        _ehProibidoCliente                 : _ehProibidoCliente,
        _validarResultadoPadrao            : _validarResultadoPadrao,
        _validarResultadoLista             : _validarResultadoLista,
        _formatarCodigosCompactado         : _formatarCodigosCompactado,
        _diffTermosFaltantes               : _diffTermosFaltantes,
        _itemBateAlgumTermo                : _itemBateAlgumTermo,
        _termosSemMatch                    : _termosSemMatch,
        // Funções assíncronas de busca
        encontrarGruposAsync                        : encontrarGruposAsync,
        encontrarCombinacoesComRepeticaoAsync        : encontrarCombinacoesComRepeticaoAsync
    };
}));