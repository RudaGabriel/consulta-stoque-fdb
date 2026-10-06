# Consulta Estoque FDB

> Desenvolvido por **Ruda Gabriel**

Sistema web local para **consultar o estoque disponível** de um ERP **SmallSoft / Small Commerce** (banco **Firebird `.FDB`**) e **montar combinações de produtos que somam um valor em reais**, com controle de itens já usados.

Ele roda num PC da loja e é acessado pelo navegador, nessa máquina ou em qualquer outra da mesma rede. **Nunca escreve no banco do ERP:** só lê.

---

## Sumário

- [O que o sistema faz](#o-que-o-sistema-faz)
- [Funcionalidades da interface](#funcionalidades-da-interface)
- [Modo Automático](#modo-automático)
- [Lista personalizada](#lista-personalizada)
- [Como o estoque é lido do banco](#como-o-estoque-é-lido-do-banco)
- [Requisitos](#requisitos)
- [Instalação e uso](#instalação-e-uso)
- [Configuração (`config.json`)](#configuração-configjson)
- [Arquivos do projeto](#arquivos-do-projeto)
- [Arquivos gerados em uso](#arquivos-gerados-em-uso)
- [API HTTP](#api-http)
- [Testes e verificações](#testes-e-verificações)
- [Segurança](#segurança)
- [Solução de problemas](#solução-de-problemas)
- [Créditos](#créditos)

---

## O que o sistema faz

1. **Conecta no Firebird** do ERP. Ele encontra o banco sozinho: procura o `SMALL.FDB` local, lê o `.ini` do SmallSoft, usa o `config.json` ou, em último caso, varre a rede local pela porta 3050.
2. **Detecta a tabela de produtos** e as colunas de código, descrição, estoque, código de barras, preço, última venda e situação (ativo/inativo), sem precisar configurar nomes de colunas.
3. **Lista só os itens com estoque real (> 0)**, sem os inativos e sem os termos **proibidos** que você configurar (marcas, categorias ou itens que não devem ser sugeridos).
4. **Monta combinações de produtos** que somam um valor-alvo. Isso serve para fechar valores de cartão, crédito, PIX ou entregas com itens que realmente existem em estoque.
5. **Controla os "usados":** um item marcado como usado vai para o fim da fila e não é sugerido de novo até a fila ser limpa. Esse estado fica gravado em disco e é compartilhado entre todos os PCs que acessam o sistema.
6. **Atualiza todas as abas abertas em tempo real**, por Server-Sent Events (SSE), quando os dados mudam.

---

## Funcionalidades da interface

| Recurso | Descrição |
|---|---|
| **Busca** | Por descrição, código ou código de barras (EAN). Aceita filtros de estoque: `>200`, `<10`, e combinados com texto, como `produto>10`. |
| **Busca personalizada** | Vários termos de uma vez (um por linha ou separados por vírgula). Mostra quais termos não encontraram nenhum item. |
| **Busca por valor (R$)** | Informe um valor para ativar o **Agrupar** ou o **Combinar**. |
| **Agrupar** | Encontra **pares e trios de itens diferentes** cuja soma fica entre o valor e o valor + R$ 40, respeitando o estoque mínimo. |
| **Combinar** | Encontra combinações **com repetição do mesmo item** (ex.: `3×08395`), respeitando o estoque disponível. Os itens só são marcados como usados depois que você confirma. |
| **Usar** | Copia o código para a área de transferência e marca o item como usado. Antes disso, avisa se o estoque está abaixo do mínimo. |
| **Ordenação** | Por estoque, preço ou data da última venda, crescente ou decrescente (a escolha fica salva no navegador). |
| **Copiar coluna** | Um clique no cabeçalho **Código** ou **Cód. Barras** copia todos os valores do filtro atual, não só as linhas visíveis. |
| **Itens exibidos** | Limite de linhas na tabela. A tabela é desenhada aos poucos, conforme a rolagem, para não travar com milhares de itens. |
| **Atualizar** | Recarrega o estoque do banco na hora. |
| **Limpar usados** | Devolve todos os itens usados para o início da fila. |
| **Configurações (⚙)** | Host, porta, caminho do `.FDB`, usuário e senha do Firebird, porta HTTP, nome da aplicação, estoque mínimo, máximo de itens e palavras proibidas. Quase tudo é aplicado sem reiniciar o servidor. |

---

## Modo Automático

Processa uma **lista inteira de valores** de uma vez. Cole linhas no formato:

```
Pedido 1: 139,00  CREDITO
Pedido 2: 177,00  CREDITO
Pedido 3: 197,00  PIX  [NAO ENCONTRADO]
```

Para cada linha, o sistema:

1. **Sincroniza o estoque** com o banco antes de começar, para nunca trabalhar com números velhos.
2. Procura **a combinação de itens que mais se aproxima do valor**: primeiro o valor exato, depois dentro da tolerância de + R$ 40.
3. **Desconta o que já foi usado nas linhas anteriores** da mesma lista, para não sugerir mais unidades do que existem.
4. Se não achar nada, pode **ampliar a faixa** de tolerância e **buscar mais itens no catálogo completo** do banco (até 5 rodadas de 1.000 itens).
5. Escreve o resultado ao lado de cada linha (`[NAO ENCONTRADO]` é substituído pelos códigos encontrados) para você **copiar**. Depois de copiar, os códigos podem ser marcados como usados.

Opções:

- **Reaproveitar código:** permite repetir o mesmo código em linhas diferentes, até o limite do estoque.
- **Usar lista personalizada:** restringe a busca aos códigos que você cadastrou (veja abaixo).

---

## Lista personalizada

É uma lista fixa de códigos (até **1.000**) que o Modo Automático pode usar com prioridade, **mesmo que estejam abaixo do estoque mínimo ou fora do limite de itens carregados**.

- Formato: um código por linha, com **estoque de parada** opcional: `00278, 30` significa "use o 00278 até sobrarem 30 unidades".
- Códigos duplicados são removidos automaticamente.
- Códigos digitados sem os zeros à esquerda (`703`) são reconhecidos como a forma completa do banco (`00703`).
- A lista fica gravada no servidor (`lista-personalizada.json`) e aparece igual em todos os PCs.
- **Alertas automáticos**, com as opções **Excluir** ou **Deixar para depois**, quando um código:
  - não existe mais no banco;
  - está **inativo** no ERP;
  - está com estoque **negativado** ou **zerado**;
  - atingiu o **estoque de parada** configurado.

  O alerta de "não existe mais no banco" só aparece quando o servidor **confirmou** a consulta de todos os códigos. Uma falha de rede ou de banco nunca gera esse alerta.

---

## Como o estoque é lido do banco

- **Somente leitura:** as consultas usam transações `READ UNCOMMITTED`, que são sempre desfeitas (rollback) no final, sem bloquear o ERP.
- **Itens exibidos:** estoque **> 0** (arredondado em 3 casas), descrição preenchida, código único, sem proibidos e sem inativos.
- **Inativos:** a coluna `ATIVO`/`ATIVADO`/`SITUACAO`/`STATUS` é comparada com `N`, `I`, `X` e `F`. Qualquer outro valor conta como ativo.
- **Estoque mínimo:** os itens acima do mínimo vêm primeiro. Se faltar item para completar a lista, entram os que estão abaixo do mínimo, mas nunca os zerados.
- **Proibidos:** no padrão de fábrica a lista vem **vazia**. Cadastre os termos da sua loja em **Configurações > Palavras Proibidas** (ou na chave `proibidos` do `config.json`). A comparação é por trecho da descrição, sem diferenciar maiúsculas e minúsculas. O campo aceita um termo por linha; se você colar a lista separada por vírgula, ponto e vírgula, `|` ou como JSON, ela é **convertida automaticamente** (maiúsculas, sem repetidos). Vírgula entre números, como em `1,5KG`, é mantida.
- **Proteções:** cada carga tem tempo máximo de 60 s. Duas cargas nunca rodam ao mesmo tempo. Pedidos feitos durante uma carga ficam na fila e rodam assim que ela termina.

---

## Requisitos

- **Windows** (o inicializador `.bat` é para Windows; o servidor em si roda em qualquer sistema com Node.js).
- **Node.js 18 ou superior**. O `.bat` instala o Node 22 LTS automaticamente se não houver nenhum instalado.
- Módulo **`node-firebird`** (instalado automaticamente pelo `.bat`).
- Acesso de rede ao servidor Firebird (porta **3050** por padrão).

---

## Instalação e uso

1. Copie os arquivos do projeto para uma pasta do PC que vai rodar o servidor.
2. Dê dois cliques em **`consulta-estoque.bat`**. Ele:
   - instala o Node.js, se necessário (pede permissão de administrador);
   - instala o `node-firebird`, tentando primeiro o cache local e depois a internet;
   - lê a porta do `config.json` (padrão **7888**);
   - roda as verificações de integridade e os testes, e pergunta antes de continuar se algo falhar;
   - se já houver um servidor antigo na porta, oferece encerrá-lo sem perder dados;
   - inicia o servidor e **abre o navegador** em `http://localhost:7888`.
3. Nos outros PCs da rede, acesse `http://IP-DO-SERVIDOR:7888`.
4. Para encerrar, pressione **0** na janela do `.bat`. Os dados pendentes são gravados antes de sair. **Ctrl+C** e fechar a janela também gravam antes de sair.

Também é possível iniciar manualmente:

```bash
npm install node-firebird
node consulta-estoque.js
```

> O `node-firebird.bat` é um instalador avulso, só do Node.js e do módulo `node-firebird`, útil para preparar a máquina sem iniciar o servidor.

---

## Configuração (`config.json`)

O arquivo é **opcional**: sem ele, o sistema detecta o banco sozinho. Quase todos os campos também podem ser alterados pela tela **Configurações**.

```json
{
  "appName": "Consulta Estoque",
  "fbHost": "192.168.0.10",
  "fbPort": 3050,
  "fdbPath": "C:\\Program Files (x86)\\SmallSoft\\Small Commerce\\SMALL.FDB",
  "fbUser": "SYSDBA",
  "fbPassword": "sua-senha",
  "portaEstoque": 7888,
  "estoqueMinimo": 5,
  "maxItens": 2000,
  "proibidos": ["MARCA X", "PRODUTO Y"]
}
```

| Campo | Padrão | Descrição |
|---|---|---|
| `appName` | `Consulta Estoque` | Nome exibido na interface (mudar exige reiniciar). |
| `fbHost` | detectado (`127.0.0.1` se nada for encontrado) | IP ou nome do servidor Firebird. |
| `fbPort` | `3050` | Porta do Firebird. |
| `fdbPath` | detectado | Caminho do `.FDB` **no servidor do banco**. |
| `fbUser` / `fbPassword` | `SYSDBA` / padrão de instalação | Credenciais do Firebird. Sem senha configurada, o log mostra um aviso de segurança. |
| `portaEstoque` | `7888` | Porta HTTP da interface, de 1024 a 65535 (mudar exige reiniciar). |
| `estoqueMinimo` | `5` | Itens abaixo desse valor só entram para completar a lista. |
| `maxItens` | `2000` | Itens enviados à interface, de 100 a 20.000. |
| `proibidos` | `[]` | Termos a excluir das sugestões (a lista de fábrica é vazia). |

### Padrão de fábrica

O código não traz nenhum dado de loja: nome da aplicação genérico (`Consulta Estoque`), host `127.0.0.1` com detecção automática, lista de proibidos vazia e exemplos sem nomes reais. Tudo o que é específico de uma loja fica no `config.json`, nos arquivos gerados em uso e nunca no código. Para **voltar ao padrão de fábrica**, apague `config.json`, `usados-estoque.json` e `lista-personalizada.json` com o servidor parado.

Arquivos com BOM ou com números escritos com zero à esquerda (ex.: `03050`) são aceitos. Ao salvar, os campos de outros módulos que existirem no arquivo são **preservados**.

---

## Arquivos do projeto

| Arquivo | Função |
|---|---|
| `consulta-estoque.js` | Servidor HTTP, acesso ao Firebird e a interface completa (HTML/CSS/JS embutidos). |
| `estoque-engine.js` | Motor de cálculo do Agrupar, do Combinar e do Modo Automático. Uma cópia dele vai **embutida** no `consulta-estoque.js`; o arquivo solto serve para os testes. |
| `consulta-estoque.bat` | Inicializador para Windows: instalação, verificações, início, monitoramento e encerramento limpo. |
| `node-firebird.bat` | Instalador avulso do Node.js e do `node-firebird`. |
| `consulta-estoque_test.js` | Suíte de testes do motor e do servidor. |
| `validar-client.js` | Valida a sintaxe do JavaScript da interface, que fica dentro de uma string do servidor. |

---

## Arquivos gerados em uso

Ficam na mesma pasta do servidor:

| Arquivo | Conteúdo |
|---|---|
| `config.json` | Configurações salvas pela interface ou descobertas pela varredura de rede. |
| `usados-estoque.json` | Códigos marcados como usados. |
| `lista-personalizada.json` | A lista personalizada do Modo Automático. |
| `*.corrompido-<data>` | Cópia de segurança, criada só se um dos arquivos acima estiver corrompido ao iniciar. |

Todos eles estão no `.gitignore` e nunca vão para o repositório (o `config.json` contém a senha do Firebird).

A gravação é **atômica**: o arquivo é escrito por inteiro antes de substituir o anterior, então uma queda de energia não deixa o arquivo pela metade.

---

## API HTTP

| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Interface web. |
| GET | `/api/itens` | Itens, situação da carga e estoque real dos códigos da lista personalizada. |
| GET | `/api/sse` | Eventos em tempo real (`dados`). |
| GET | `/api/status` | Situação do servidor e do banco. |
| GET | `/api/buscar-mais-itens?offset=N` | Próximo lote do catálogo completo (busca estendida). |
| GET / POST | `/api/lista-personalizada` | Lê ou grava a lista personalizada. |
| POST | `/api/marcar-usado` | Marca um código como usado. |
| POST | `/api/resetar-usados` | Limpa os usados. |
| POST | `/api/atualizar` | Recarrega o estoque do banco. |
| GET / POST | `/api/config` | Lê ou grava as configurações (a senha nunca é devolvida). |
| POST | `/api/encerrar` | Encerra o servidor gravando os dados pendentes. **Só aceita pedidos desta própria máquina.** |

Todo `POST` exige o cabeçalho `X-Requested-With: XMLHttpRequest`, uma proteção contra sites externos que tentem enviar comandos pelo navegador.

---

## Testes e verificações

```bash
node -c consulta-estoque.js        # sintaxe do servidor
node validar-client.js             # sintaxe do JavaScript da interface
node --test consulta-estoque_test.js
```

A suíte cobre o motor de cálculo e o servidor. No servidor, testa a leitura da configuração, a lista personalizada, o SQL gerado, o processamento do estoque e a carga com um **Firebird simulado**. Ela **não conecta no banco, não abre porta e não grava arquivos**, por isso o `.bat` pode executá-la a cada inicialização.

---

## Segurança

- O servidor fica acessível **na rede local** (`0.0.0.0`) de propósito, para os outros PCs da loja usarem. **Não exponha a porta na internet:** não há login.
- A senha do Firebird fica em texto no `config.json`. Proteja a pasta do servidor e troque a senha padrão `masterkey`.
- A interface trata todo texto vindo do banco antes de exibir, para impedir a injeção de HTML (XSS). Os valores enviados ao banco usam parâmetros, e os nomes de tabela e coluna são validados.

---

## Solução de problemas

| Sintoma | O que verificar |
|---|---|
| "Falha na conexão" | `fbHost`, `fbPort`, `fdbPath`, usuário e senha nas Configurações; firewall liberando a porta 3050. |
| "Timeout ao carregar dados" | Banco ou rede lentos. O servidor tenta de novo quando você clica em **Atualizar**. |
| "Porta 7888 já está em uso" | Um servidor antigo continua aberto. O `.bat` oferece encerrá-lo; ou mude `portaEstoque`. |
| Nenhum item aparece | Veja no log a linha `Colunas:`, que mostra a tabela e as colunas detectadas. |
| Clicar na janela do `.bat` trava o sistema | Já resolvido: o `.bat` desativa o "Modo de Edição Rápida" do console. |

---

## Créditos

**Ruda Gabriel**: idealização, desenvolvimento e manutenção do projeto.

© Ruda Gabriel. Todos os direitos reservados.
