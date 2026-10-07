# Changelog

> Desenvolvido por **Ruda Gabriel**

Histórico completo de versões de cada arquivo do projeto, da mais recente para a mais antiga.
Dentro dos arquivos, o cabeçalho traz **apenas o changelog da versão atual**; o histórico fica só aqui.

Versões anteriores às listadas não estão no histórico deste repositório.

## Arquivos

- [`consulta-estoque.js`](#consulta-estoquejs): Servidor e interface web. Versão atual **5.39.0**.
- [`estoque-engine.js`](#estoque-enginejs): Motor de cálculo (Agrupar, Combinar, Modo Automático). Versão atual **1.6.0**.
- [`consulta-estoque.bat`](#consulta-estoquebat): Inicializador para Windows. Versão atual **5.30.0**.
- [`consulta-estoque_test.js`](#consulta-estoque_testjs): Suíte de testes. Versão atual **2.8.0**.
- [`validar-client.js`](#validar-clientjs): Validador do JavaScript da interface. Versão atual **1.0.0**.
- [`node-firebird.bat`](#node-firebirdbat): Instalador avulso do Node.js e do node-firebird. Versão atual **1.1.1**.

---

## consulta-estoque.js

_Servidor e interface web_

### 5.39.0 (2026-10-06 16:00)

```text
Dois ajustes pedidos:
  [1] Palavras Proibidas: contador no título ("N palavras"), atualizado
      ao digitar, colar, sair do campo e abrir as Configurações. Conta
      os termos válidos (sem repetidos nem linhas vazias) — o mesmo
      número que será salvo.
  [2] Cards Agrupar/Combinar: .grp-card-item .nm conforme definido pelo
      usuário — flex:1 0 100% com max-width:25% (nome na mesma linha do
      código, limitado a 1/4 da largura; descrição completa no title).
```

### 5.38.0 (2026-10-06 15:00)

```text
Configurações > Palavras Proibidas:
  [1] Removido "Ver termos embutidos" (HTML, CSS e preenchimento): a
      lista embutida é vazia no padrão de fábrica e não é mais usada.
  [2] Título renomeado para "Palavras Proibidas".
  [3] Detecção e ajuste automático do formato: o campo aceita um termo
      por linha (maiúsculas, sem repetidos); texto colado com vírgula,
      ponto e vírgula, "|", tab ou JSON é convertido ao sair do campo,
      ao colar e antes de salvar, com aviso do que foi ajustado. O
      servidor aplica a MESMA regra (engine._normalizarListaProibidos)
      no POST /api/config e ao ler "proibidos" do config.json (aceita
      texto ou array).
```

### 5.37.0 (2026-10-06 00:30)

```text
Cards do Agrupar/Combinar: código de barras
  sempre colado no preço. .grp-bar passou de largura fixa (110px) para
  "flex:1 1 0" alinhado à direita — ocupa o espaço livre da 1ª linha sem
  nunca forçar quebra; código/quantidade/preço com largura do conteúdo;
  EAN que não couber termina em "…" com title completo. Medido no
  Chromium em 9 larguras de tela (360 a 2560px, cards de 240 a 340px),
  Agrupar e Combinar: vão EAN-preço de 6px em todas, sempre 2 linhas,
  nome com >= 210px, nada transbordando. (Alternativa testada e
  descartada: nome em linha com max-width:34% + justify-content:
  space-between — vão EAN-preço variava de 30 a 130px e o preço caía
  de linha no Agrupar em cards largos.)
```

### 5.36.0 (2026-10-05 22:30)

```text
Dois defeitos relatados no uso:
  [1] Agrupar e Combinar não mostravam a soma exata (sempre "+R$ 1,00"
      ou mais) e o Combinar repetia o mesmo card: corrigido no
      estoque-engine.js 1.5.0, embutido aqui (_ENGINE_SRC).
  [2] Cards do Combinar/Agrupar: o nome do item ficava com ~30-60px (a
      linha tinha qtd, código, EAN e preço), invisível e sem onde passar
      o mouse. Agora o nome ocupa uma linha própria, com a largura toda
      do card, e o title mostra a descrição completa.
```

### 5.35.0 (2026-10-05 21:45)

```text
Padrão de fábrica: removidos do código todos
  os valores específicos de uma loja. Nada muda para quem já tem
  config.json, exceto o item [2]:
  [1] fbHost padrão: IP fixo de uma rede específica -> "127.0.0.1". Sem
      config.json e sem FDB local, o scan de rede continua descobrindo
      o servidor Firebird automaticamente.
  [2] PROIBIDOS_EMBUTIDOS agora vem VAZIO. A lista de marcas/termos
      proibidos é configuração de cada loja: cadastre-a em
      Configurações > Palavras Proibidas (ou "proibidos" no config.json).
  [3] Exemplos da interface sem nomes de pessoas nem marcas (Modo
      Automático, busca, placeholders de IP).
```

### 5.34.0 (2026-10-05 19:00)

```text
Encerramento sem perda de dados, integrado ao
  consulta-estoque.bat 5.30.0:
  [1] POST /api/encerrar: encerra o servidor de forma limpa (grava
      usados/lista pendentes antes de sair). Aceito SOMENTE de 127.0.0.1/::1
      e com o cabeçalho X-Requested-With (mesma proteção dos demais POST).
      O .bat usa esta rota na tecla 0 e ao substituir uma instância antiga;
      antes ele usava "taskkill /f", que mata o processo sem rodar nenhum
      handler e perdia a última marcação ainda no debounce de 600 ms.
  [2] SIGHUP (Windows: janela do console fechada no X) também grava os
      dados pendentes antes de sair.
  Mantém todas as correções da 5.33.0 (ver histórico do git).
```

### 5.33.0 (2026-10-05 17:30)

```text
Revisão de auditoria (correções de corretude,
  resiliência e testabilidade — sem mudança de layout/fluxo da interface):
  [1] carregarItens(): token de geração por carga. Uma carga que estoura
      CONEXAO_TIMEOUT_MS e termina depois NÃO libera mais o lock nem
      sobrescreve o estado de uma carga mais nova (antes: duas cargas em
      paralelo e lock liberado no meio da segunda). Carga atrasada só
      aplica dados se nenhuma mais nova estiver rodando/já aplicada.
  [2] Pedidos de recarga feitos durante uma carga (salvar lista
      personalizada, salvar config, scan de rede) eram descartados — agora
      ficam pendentes e rodam assim que a carga atual termina.
  [3] Falso "código não existe mais no banco": falha (total ou parcial)
      da consulta da lista personalizada, da query principal ou da
      conexão zerava _lpEstoquesReais e o cliente oferecia "Excluir
      todos". Agora o mapa anterior é preservado e /api/itens informa
      lpConfiavel=false; o cliente não acusa "não existe" sem confirmação.
  [4] Filtro ATIVO usava CAST(... AS VARCHAR(1)) — coluna SITUACAO/STATUS
      com texto ("ATIVO"/"INATIVO") gerava "string right truncation" e
      derrubava a carga inteira. DESCRICAO usa SUBSTRING (mesmo motivo).
  [5] Persistência atômica (arquivo temporário + rename) e serializada de
      usados/lista/config; JSON corrompido é preservado em
      *.corrompido-<timestamp> em vez de ser silenciosamente sobrescrito;
      gravações pendentes são descarregadas no SIGINT/SIGTERM.
  [6] config.json: a correção de "zero à esquerda" só é aplicada se o JSON
      original for inválido (antes corrompia strings como senhas).
  [7] Scan de rede: no máximo um por vez e com intervalo mínimo.
  [8] /api/status usa a config viva; /api/config não devolve mais a senha
      padrão em "defaults"; faixas de porta unificadas.
  [9] /api/itens serializa a lista uma única vez por mudança de estado.
  [10] Cliente: fingerprint inclui ultimaAtualiz (estoque mudava sem
       re-render), respostas fora de ordem descartadas, rajadas de SSE
       agrupadas, mensagem correta quando já há carga em andamento.
  [11] Testabilidade: o servidor só sobe quando executado diretamente
       (require.main === module); helpers puros exportados e cobertos
       por testes (consulta-estoque_test.js).
```

### 5.32.0 (2026-08-29)

```text
Dois pedidos: (1) lista personalizada nunca pode
  ter código duplicado; (2) código recém-adicionado + salvo aparecia
  como "não existe mais no banco" (falso — sumia sozinho ao reiniciar
  pelo .bat, sintoma de dado desatualizado, não de código ausente).

  [1] LISTA PERSONALIZADA — DUPLICATA NUNCA MAIS ENTRA
      _sanitizarListaPersonalizada() (servidor) agora deduplica por
      código, 1ª ocorrência vence — é o ÚNICO ponto de gravação
      (POST /api/lista-personalizada), então a garantia vale sempre,
      não importa a origem. Também retorna quantos foram removidos por
      duplicata vs quantos por exceder o limite de 1000 — motivos
      diferentes, nunca misturados numa mensagem só (testado: 1200
      códigos únicos sem duplicata nenhuma não deve acusar
      "duplicata", e sim "limite excedido"). _parseListaPersonalizadaDetalhada()
      (cliente) também deduplica ao ler o texto colado, mesma regra —
      defesa em dobro, não só no servidor.

  [2] FALSO "NÃO EXISTE MAIS NO BANCO" LOGO APÓS SALVAR — CORRIGIDO
      Causa: salvarListaPersonalizada() espera _sincronizarEstoqueTempoReal
      recalcular _lpEstoquesReais antes de checar alertas, mas o teto de
      espera (SYNC_ESTOQUE_TIMEOUT_MS) era 6s — curto demais no mesmo
      ambiente lento já identificado na v5.31.0 (carregarItens() levando
      15-20s+). Ao vencer o teto, o código antigo aplicava os dados
      (possivelmente ainda os de ANTES do save) e rodava o alerta do
      mesmo jeito — um código recém-salvo, ainda fora de
      _lpEstoquesReais, virava "não existe mais no banco" (falso).
      Corrigido em duas frentes: SYNC_ESTOQUE_TIMEOUT_MS 6s -> 30s
      (folga real sobre o ambiente observado); e _aguardarCargaFrescaConcluir
      agora informa onPronto(sucesso) — sucesso=true só quando o
      servidor confirmou !carregando de verdade. salvarListaPersonalizada()
      só roda o alerta quando sucesso=true; se não (banco ainda mais
      lento que o esperado), avisa que ainda está sincronizando e tenta
      de novo uma vez, 8s depois — nunca mais afirma "não existe" com
      base em dado sabidamente desatualizado.

  70/70 testes originais passando sem alteração (estoque-engine.js não
  foi tocado nesta versão); dedup testado isoladamente em 3 cenários
  (só duplicata, só limite, os dois juntos).
```

### 5.29.0 (2026-08-14 17:05)

```text
Revisão de auditoria de segurança/robustez
  (sem mudança de comportamento visível para o usuário final; 70/70
  testes originais continuam passando sem alteração):

  [1] SQL — VALIDAÇÃO DE IDENTIFICADOR (defesa em profundidade)
      Nomes de tabela/coluna descobertos por introspecção do schema
      (RDB$RELATIONS/RDB$RELATION_FIELDS) agora só são aceitos como
      candidatos se baterem no formato padrão de identificador Firebird
      (identificadorSqlValido()) antes de serem interpolados numa
      string SQL. Não muda a detecção em nenhum banco com nomes normais
      — só fecha a hipótese teórica de um identificador delimitado
      "exótico" (aspas, espaços) alterar a query.

  [2] LISTA DE USADOS — CAP DE TAMANHO NO CÓDIGO
      POST /api/marcar-usado agora limita "codigo" a 50 caracteres
      (mesmo limite já aplicado em _sanitizarListaPersonalizada),
      evitando gravar em usados-estoque.json uma chave de tamanho
      arbitrário vinda de um payload malformado.

  [3] CONFIG — AVISO QUANDO A SENHA PADRÃO DO FIREBIRD ESTÁ EM USO
      Se config.json não define fbPassword, o servidor já caía (como
      sempre) na credencial padrão de instalação do Firebird — agora
      isso fica visível no log de startup em vez de silencioso, para
      quem nunca trocou a senha do banco saber que deveria.

  [4] POST /api/config — MENSAGEM CORRIGIDA
      A resposta dizia "Dados recarregados do banco." mesmo quando o
      recarregamento era pulado por já haver um em andamento
      (_loadLock) — agora só afirma isso quando o recarregamento foi
      de fato dado início; caso contrário avisa que as novas
      configurações valem a partir do PRÓXIMO carregamento.

  [5] ENDURECIMENTO CONTRA POLUIÇÃO DE PROTÓTIPO
      _lpEstoquesReais (servidor e cliente) e os mapas de reconciliação
      de código (_mapaCods/_mapaCodsNorm/_mapaCodsPad5) passam a usar
      Object.create(null) em vez de {} — mesmo padrão já usado em
      _usados e em _precoMap (estoque-engine.js). Nenhum acesso a esses
      objetos dependia do protótipo de Object (já usavam colchetes ou
      Object.prototype.hasOwnProperty.call), então o comportamento é
      idêntico; só fecha a hipótese teórica de uma chave "__proto__".

  [6] SSE — LIMPEZA DE CLIENTE CENTRALIZADA
      emitirEventoSse(), o ping periódico e o evento "close" cada um
      repetia a mesma dupla remoção do Set + clearInterval — e o
      primeiro esquecia o clearInterval, deixando um timer órfão vivo
      por até 25s (autocorrigido no ping seguinte, mas inconsistente).
      Extraído para _removerClienteSse(), usado nos 3 pontos.

  [7] ENGINE EMBUTIDA RESSINCRONIZADA
      _ENGINE_SRC (cópia embutida usada no <script> do cliente) foi
      regenerada a partir de estoque-engine.js v1.4.0 — ver changelog
      desse arquivo para o que mudou (mutação de item corrigida em
      _autoEncontrarMelhor, número mágico 40 → FAIXA_COMBINAR, label
      morta removida). As duas cópias continuam byte-a-byte idênticas.

  [8] COMENTÁRIO DE MANUTENIBILIDADE
      Adicionado aviso explícito no topo do 2º <script> sobre a regra
      de barra invertida duplicada (regex client-side dentro da
      template literal do servidor) — closes a classe de bug em que um
      "\d" digitado sem dobrar vira "d" silenciosamente, sem erro de
      sintaxe em lugar nenhum. (Nota: a primeira tentativa de redigir
      este próprio aviso introduziu, por engano, a sequência literal
      "</script>" dentro do comentário — o que fecharia a tag
      prematuramente no navegador. Detectado por validar-client.js
      antes da entrega e corrigido; ver seção de achados.)
```

### 5.28.0 (2026-08-08)

```text
Coluna "Cód. Barras" também copia, e a lógica de
    cópia por coluna foi generalizada:

    [1] CÓD. BARRAS COPIÁVEL
        Clicar no cabeçalho copia todos os códigos de barras da busca atual,
        um por linha, com tooltip e ícone iguais aos da coluna "Código".

    [2] GENERALIZAÇÃO EM VEZ DE DUPLICAÇÃO
        Em vez de clonar a implementação da v5.27.0, ela virou genérica:
        _copiarColunaVisivel(campo, ...) e _thCopiarHtml(...) atendem as duas
        colunas, e o CSS passou da classe específica .th-cod-* para a
        genérica .th-copiar-*. Duplicar significaria que toda correção futura
        precisaria ser lembrada em dois lugares.

    [3] TRATAMENTO DE CÓDIGO DE BARRAS AUSENTE (diferença real entre as
        colunas, e o motivo de a generalização não ser trivial)
        Todo item tem código, mas nem todo item tem barras cadastrado.
        Portanto:
          - Itens sem valor são PULADOS, não viram linha em branco: uma
            linha vazia no meio da colagem quebraria importação em planilha
            ou no ERP.
          - O tooltip conta os valores REALMENTE preenchidos, não _vis.length
            — prometer "138 códigos de barras" e entregar 96 seria pior do
            que não informar número nenhum.
          - Após copiar, se algum item ficou de fora por não ter barras, o
            toast informa quantos foram. Sem isso o usuário poderia achar que
            levou a lista toda e só perceber a diferença depois de colar.
          - Se nenhum item da busca tiver barras, avisa e não mexe na área de
            transferência (não apaga o que já estava lá).

    [4] ALINHAMENTO PRESERVADO POR COLUNA
        O contêiner flex do cabeçalho poderia impor um alinhamento próprio e
        substituir o text-align de cada coluna. "Código" segue centralizado
        (pedido explícito da v5.24.0) e "Cód. Barras" segue à esquerda como
        sempre foi: o padrão é flex-start e só .th-cod recebe o centro, para
        nenhuma coluna mudar de aparência como efeito colateral de virar
        copiável.

    Continua lendo de _vis (lista completa do filtro) e não do DOM — ver
    comentário na função: com a renderização incremental, varrer as linhas
    copiaria apenas o lote já rolado.

  * Servidor de relatório de estoque disponível (Firebird + Node.js).
NÃO depende de gerar-relatorio-html.js nem servidor-relatorio.js.
Lê config.json apenas para: fbHost, fdbPath, proibidos, appName.
Porta padrão: 7888 (configurável via config.json → portaEstoque)
```

### 5.17.0 (2026-07-25)

```text
BUG REAL corrigido: alerta "código não existe
  mais no banco" disparava para códigos que EXISTEM e têm estoque
  real, quando o código digitado na lista personalizada tinha MENOS
  de 5 dígitos (ex.: "8883" em vez de "08883"). Causa: as correções
  anteriores (v5.11.0/v5.12.0) só sabiam REMOVER zeros à esquerda pra
  comparar formas — nunca ACRESCENTAR. Como a regra de negócio deste
  catálogo é códigos sempre com exatamente 5 dígitos (7403 -> 07403,
  703 -> 00703, 8883 -> 08883), um código digitado mais curto nunca
  gerava a variante de busca preenchida, então a consulta dedicada
  nunca tentava "08883" — só "8883", que não existe no banco assim.
  Nova função _codigoPadrao5Digitos() (servidor) /
  _codigoPadrao5DigitosCliente() (cliente) preenche com zeros à
  esquerda até completar 5 dígitos; usada tanto na consulta dedicada
  quanto na reconciliação de resultado (servidor) e no fallback de
  matching do pool do Modo Automático (cliente). Mantidas as duas
  formas de normalização anteriores (sem-zeros) como buscas
  adicionais, para não regredir casos já cobertos antes.
```

---

## estoque-engine.js

_Motor de cálculo (Agrupar, Combinar, Modo Automático)_

### 1.6.0 (2026-10-06 15:00)

```text
Nova _normalizarListaProibidos(): detecta e
  converte para o formato aceito (um termo por linha, maiúsculas, sem
  vazios nem repetidos) qualquer lista colada — separada por vírgula,
  ponto e vírgula, "|", tab ou quebra de linha, ou como JSON. Vírgula
  entre dígitos é decimal e não separa. Mesma função usada no navegador
  e no servidor. Sem mudança nas demais funções.
```

### 1.5.0 (2026-10-05 22:30)

```text
Agrupar nunca mostrava a soma EXATA:
  encontrarGruposAsync parava de procurar ao juntar 30 grupos, guardando
  os primeiros pares na ordem da lista (por estoque) e não os mais
  próximos do valor. Um par exato fora desses primeiros nunca aparecia
  ("R$ 101,00 +R$ 1,00" com R$ 100,00 disponível). Agora todas as bases
  são examinadas com busca binária pelos parceiros mais próximos
  (PARCEIROS_POR_BASE), a coleção é podada pelos melhores e o resultado
  sai ordenado por menor diferença e, no empate, por menos itens.
  Teto de candidatos: 250 -> 600 (MAX_CANDIDATOS_GRUPOS). Validado contra
  força bruta em 300 cenários aleatórios.
  Combinar / Modo Automático (_autoEncontrarMelhorComRepeticao): mesmo
  defeito por outro caminho — só os 30 primeiros itens da lista entravam
  na busca. Nova busca ampla de 1 a 3 itens (com repetição, respeitando
  o estoque disponível de cada código) sobre até 600 candidatos; soma
  exata é devolvida na hora, senão vence o mais próximo entre ela e a
  busca original. Combinar não repete mais o mesmo card: combinação
  repetida tira seus itens das buscas seguintes.
```

### 1.4.0 (2026-08-14 15:40)

```text
Revisão de auditoria (sem mudança de
  comportamento observável — mesma API, mesmos resultados, 70/70 testes
  originais continuam passando):
    [1] _autoEncontrarMelhor mutava os objetos de entrada (`_item._p =
        _cp`), efeito colateral não documentado numa função descrita
        como pura — agora cada candidato é empacotado como {it, p}
        (item original + preço numérico já convertido), nunca mais
        escrito de volta no objeto do chamador.
    [2] Número mágico `40` (tolerância do modo Combinar) estava
        hardcoded em 4 pontos diferentes em vez de usar a constante
        FAIXA_COMBINAR já existente — agora todos os pontos referenciam
        a constante; mudar a tolerância no futuro exige editar 1 lugar,
        não 4.
    [3] Removida a label `outer3ex:` da Fase 3 de _autoEncontrarMelhor —
        não era referenciada por nenhum break/continue (resquício de
        uma versão anterior do algoritmo), apenas ruído para quem lê.
```

### 1.3.0 (2026-07-10)

```text
Modo Agrupar (encontrarGruposAsync) não funcionava
  corretamente com a fase extra de subset-sum (DP) introduzida na v1.1.0.
  Revertido para o algoritmo da versão anterior comprovadamente estável
  (mesma lógica testada e usada em produção antes da extração para este
  módulo): apenas pares e triplas, com índices estritamente crescentes
  (a<b / a<b<c — sem duplicar o mesmo conjunto de itens em ordens
  diferentes) e limite de candidatos/resultados para nunca travar o
  browser. Roda em um único setTimeout (sem chunking multi-fase, sem
  necessidade de guard de geração entre fases internas — só no início/
  fim, mais simples e com muito menos superfície para bugs). Continua
  filtrando por estoqueMinimo/proibidos ANTES de montar os candidatos
  (correção que a v1.1.0 trouxe e que continua válida) e mantém a
  deduplicação final por assinatura de códigos como trava de segurança.
  Efeito colateral aceito: combinações de 4+ itens deixam de ser
  buscadas (eram uma tentativa de melhoria que se mostrou não confiável)
  — o modo Agrupar volta a cobrir pares e triplas, como na versão que
  funcionava.
```

---

## consulta-estoque.bat

_Inicializador para Windows_

### 5.30.0 (2026-10-05 19:00)

```text
Revisao comparando a v5.29.3 com o
  consulta-estoque.js 5.34.0 e o node-firebird.bat:
  [1] Porta lida do config.json (portaEstoque/portaConsulta, mesma regra
      do servidor). Antes 7888 era fixo: com outra porta configurada, a
      checagem de porta ocupada, o link e o navegador apontavam errado.
  [2] Porta ocupada detectada tambem em Windows em portugues: o netstat
      mostra "OUVINDO" e nao "LISTENING" - a checagem nunca disparava.
  [3] Encerramento limpo: tecla 0 e "substituir servidor antigo" pedem
      POST /api/encerrar (so aceito de 127.0.0.1) e esperam ate ~8s; so
      entao usam taskkill /f. Antes o /f matava o Node sem gravar a
      ultima marcacao de "usado" ainda pendente.
  [4] Node.js minimo verificado (18+, exigido pelos testes). Instalador
      atualizado para o Node 22.22.0 LTS (o 20.x saiu de suporte em
      abril/2026).
  [5] Do node-firebird.bat: PATH do sistema relido do registro apos
      instalar o Node; npm tenta primeiro o cache local (--prefer-offline)
      e so depois baixa da internet, com verificacao pos-instalacao.
  [6] Arquivo de PID por porta (duas pastas/portas nao se atrapalham).
  Mantido da v5.29.3: QuickEdit desativado, auto-elevacao para instalar
  o Node, SHA256 do MSI, verificacoes de integridade com confirmacao,
  monitoramento do servidor e tecla 0 para encerrar.
```

### 5.29.3 (2026-09-21)

```text
Desativa o "Modo de Edicao Rapida" (QuickEdit) do
  console ao iniciar o servidor. Nesse modo, um simples clique na janela
  do cmd inicia uma selecao de texto que CONGELA a saida do Node (e o
  servidor trava, ex.: requisicoes da interface ficam "sincronizando")
  ate uma tecla ser pressionada. Sem o QuickEdit, clicar na janela nao
  trava mais nada. O efeito vale so para esta janela.
```

### 5.26.0 (2026-08-08)

```text
Passa a rodar as verificacoes de integridade
  (node -c, validar-client.js e node --test) automaticamente antes de
  iniciar o servidor; se alguma falhar, avisa e pede confirmacao em vez
  de abortar. estoque-engine.js deixou de ser tratado como obrigatorio
  (o motor vai embutido no consulta-estoque.js; o arquivo solto so e
  usado pela suite de testes). Corrigido o uso de errorlevel dentro de
  blocos ( ), onde a variavel era expandida antes do comando rodar e
  falhas de verificacao passavam despercebidas.
```

---

## consulta-estoque_test.js

_Suíte de testes_

### 2.8.0 (2026-10-06 15:00)

```text
Testes de _normalizarListaProibidos
  (estoque-engine.js 1.6.0): formato aceito preservado; vírgula, ponto e
  vírgula, "|", tab e JSON convertidos; decimal "1,5" preservado; aspas,
  espaços, vazios e repetidos tratados. Suíte cobre engine + servidor
  sem banco, sem porta e sem gravar arquivos.
```

### 2.7.0 (2026-10-05 22:30)

```text
Regressões do Agrupar e do Combinar
  (estoque-engine.js 1.5.0): a soma exata (par ou tripla) precisa vir
  primeiro mesmo quando dezenas de combinações "+R$1,00" aparecem antes
  na lista; resultados em ordem crescente de diferença; o Combinar não
  pode repetir o mesmo card. Suíte cobre engine + servidor sem
  banco, sem porta e sem gravar arquivos.
```

### 2.6.0 (2026-10-05 21:45)

```text
Ajuste ao padrão de fábrica do servidor
  (consulta-estoque.js 5.35.0): o teste de proibidos não depende mais de
  uma marca embutida — usa um termo configurado via _refazerProibidos(),
  como viria do config.json; novo teste garante a lista embutida vazia.
  Suíte cobre engine + servidor sem banco, sem porta e sem gravar
  arquivos (seguro para o .bat rodar a cada inicialização).
```

### 2.5.0 (2026-10-05 19:00)

```text
Cobertura do servidor (consulta-estoque.js
  5.34.0): helpers puros (config tolerante, sanitização/reconciliação da
  lista personalizada, SQL gerado, processamento de linhas, porta e
  origem local do encerramento), cópia embutida do engine idêntica ao
  arquivo e a orquestração de carregarItens() com um driver Firebird
  falso (lpConfiavel, mapa preservado em falha, recarga pendente).
  Roda sem banco, sem abrir porta e sem gravar arquivos — seguro para o
  .bat executar a cada inicialização.
```

### 2.4.0 (2026-10-05 17:30)

```text
Cobertura do servidor (consulta-estoque.js
  v5.33.0): helpers puros (config tolerante, sanitização/reconciliação da
  lista personalizada, SQL gerado, processamento de linhas), cópia
  embutida do engine idêntica ao arquivo, e a orquestração de
  carregarItens() com um driver Firebird falso (lpConfiavel, mapa
  preservado em falha, recarga pendente).
```

### 2.3.0 (2026-07-10)

```text
Testes de regressão para o bug "Agrupar não
  funcionava": encontrarGruposAsync voltou ao algoritmo comprovadamente
  estável (apenas pares e triplas, sem a fase de subset-sum/DP que se
  mostrou não confiável). describe() de regressão atualizado para
  também garantir que nenhum grupo retornado tem mais de 3 itens.
```

---

## validar-client.js

_Validador do JavaScript da interface_

### 1.0.0 (2026-08-08)

```text
Primeira versão. Valida a sintaxe do JavaScript
  client-side embutido no HTML de consulta-estoque.js, que `node -c` e
  `node --test` não alcançam por estar dentro de um template literal.
```

---

## node-firebird.bat

_Instalador avulso do Node.js e do node-firebird_

### 1.1.1 (2026-08-08 05:10)

```text
Quebras de linha convertidas para
 CRLF, a convencao correta do Windows. Estes arquivos estavam com LF
 puro; funcionavam porque so' usam "goto", mas "call :label" quebra
 nesse formato (ver instalar-na-inicializacao.bat v1.8.1). Padronizado
 em todo o projeto para evitar a armadilha em edicoes futuras.
 Se for editar, use um editor que preserve CRLF.
```
