/**
 * validar-client.js — ferramenta de verificação (não faz parte do runtime)
 *
 * @version 1.0.0
 * @changelog
 *   1.0.0 - 2026-08-08 - Primeira versão. Valida a sintaxe do JavaScript
 *     client-side embutido no HTML de consulta-estoque.js, que `node -c` e
 *     `node --test` não alcançam por estar dentro de um template literal.
 *
 * PROBLEMA QUE ESTA FERRAMENTA RESOLVE:
 * `node -c consulta-estoque.js` valida apenas o código do SERVIDOR. Todo o
 * JavaScript do cliente mora dentro de um template literal (a string do HTML),
 * ou seja, para o Node é apenas texto — um erro de sintaxe ali passa batido no
 * `node -c`, no `node --test`, e só aparece como página quebrada no navegador
 * do usuário final, em produção.
 *
 * Este script fecha essa lacuna: gera o HTML como o servidor geraria, extrai o
 * conteúdo de cada <script>, e roda o parser do próprio Node (new Function)
 * sobre ele. Não executa nada — só analisa sintaticamente.
 *
 * USO:  node validar-client.js
 * Saída: código 0 se tudo OK, 1 se houver erro (serve para CI / pré-commit).
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

const ARQUIVO = path.join(__dirname, "consulta-estoque.js");

function extrairBlocosScript(html) {
    const blocos = [];
    const re = /<script>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const antes = html.slice(0, m.index);
        blocos.push({
            codigo: m[1],
            linhaInicial: antes.split("\n").length
        });
    }
    return blocos;
}

function main() {
    if (!fs.existsSync(ARQUIVO)) {
        console.error("ERRO: " + ARQUIVO + " nao encontrado.");
        process.exit(1);
    }

    // Gera o HTML sem subir o servidor: carrega o módulo com uma flag que o faz
    // apenas exportar gerarHTML(). Como o arquivo é um servidor completo, a via
    // mais segura e sem efeitos colaterais é recortar o template literal
    // diretamente do fonte e resolver as interpolações com valores neutros.
    const fonte = fs.readFileSync(ARQUIVO, "utf8");

    const inicio = fonte.indexOf("_htmlCache = `<!DOCTYPE html>");
    const fim    = fonte.indexOf("</html>`;", inicio);
    if (inicio === -1 || fim === -1) {
        console.error("ERRO: nao foi possivel localizar o template do HTML.");
        process.exit(1);
    }

    let bruto = fonte.slice(fonte.indexOf("`", inicio) + 1, fim + "</html>".length);

    // ATENÇÃO — detalhe que já causou um falso positivo nesta ferramenta:
    // NÃO basta recortar o texto do fonte. O HTML do cliente vive dentro de um
    // template literal, então no fonte as sequências aparecem escapadas em
    // dobro (`\\'` no fonte vira `\'` no HTML final). Analisar o texto bruto
    // faria o parser reclamar de escapes que na prática estão corretos.
    // Por isso avaliamos o template DE VERDADE (as interpolações viram um
    // literal neutro), obtendo exatamente a string que o navegador receberia.
    const comStub = bruto.replace(/\$\{[^}]*\}/g, "${0}");

    let html;
    try {
        html = new Function("return `" + comStub + "`;")();
    } catch (e) {
        console.error("ERRO ao materializar o template do HTML: " + e.message);
        process.exit(1);
    }

    const blocos = extrairBlocosScript(html);
    if (!blocos.length) {
        console.error("ERRO: nenhum bloco <script> encontrado no HTML gerado.");
        process.exit(1);
    }

    let falhas = 0;
    blocos.forEach((bloco, i) => {
        const rotulo = "bloco <script> #" + (i + 1) +
                       " (~" + bloco.codigo.split("\n").length + " linhas)";
        try {
            // new vm.Script faz o parse completo SEM executar o código.
            new vm.Script(bloco.codigo, { filename: "client-script-" + (i + 1) + ".js" });
            console.log("  OK  " + rotulo);
        } catch (e) {
            falhas++;
            console.error("  FALHA  " + rotulo);
            console.error("         " + e.message);
        }
    });

    console.log("");
    if (falhas) {
        console.error("RESULTADO: " + falhas + " bloco(s) com erro de sintaxe no client-side.");
        process.exit(1);
    }
    console.log("RESULTADO: sintaxe do client-side OK (" + blocos.length + " bloco(s)).");
    process.exit(0);
}

main();
