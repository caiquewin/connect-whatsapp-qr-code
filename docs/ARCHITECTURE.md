# Arquitetura

Documento de referência para quem vai **manter ou alterar** o código (humano ou IA). Para usar o sistema, veja o [README](../README.md).

- [Visão geral](#visão-geral)
- [Mapa de módulos (serviço whatsapp)](#mapa-de-módulos-serviço-whatsapp)
- [Ciclo de vida do processo](#ciclo-de-vida-do-processo)
- [Conexão: estados e reconexão](#conexão-estados-e-reconexão)
- [Escuta e normalização](#escuta-e-normalização)
- [Filtros](#filtros)
- [Encaminhamento: fila em disco](#encaminhamento-fila-em-disco)
- [Interface admin](#interface-admin)
- [Banco de dados (SQLite)](#banco-de-dados-sqlite)
- [Leituras: cache por versão e SSE](#leituras-cache-por-versão-e-sse)
- [Proxies](#proxies)
- [Testes com IA](#testes-com-ia)
- [Serviço endpoint](#serviço-endpoint)
- [Docker](#docker)
- [Armadilhas da Baileys](#armadilhas-da-baileys)
- [Decisões de design](#decisões-de-design)
- [Dívidas técnicas conhecidas](#dívidas-técnicas-conhecidas)

---

## Visão geral

Dois serviços Node.js/TypeScript (ESM, `module: NodeNext`, `strict`, `noUncheckedIndexedAccess`), cada um com `package.json` próprio em `apps/`:

| Serviço | Pasta | Stack | Papel |
|---|---|---|---|
| `whatsapp` | `apps/whatsapp` | Baileys `7.0.0-rc14` (versão fixa), pino, qrcode, `node:http`, `node:sqlite`, `undici` 6 + `https-proxy-agent` + `socks-proxy-agent` + `socks` (proxies) | N conexões de WhatsApp num processo, banco, mídia, fila, admin, testes com IA |
| `endpoint` | `apps/endpoint` | Fastify 5 | Receptor de exemplo: valida token e grava JSONL |

A raiz tem só atalhos (`package.json` com `concurrently`), `docker-compose.yml`, `.env*` e a pasta `Baileys/` — **clone de referência** do código-fonte da biblioteca na mesma versão (`7.0.0-rc14`), útil para consultar a API real. Ela não é usada no build (o app usa o pacote do npm) e é ignorada pelo git e pelo Docker.

### Fluxo de uma mensagem

```
WhatsApp ──ws──► Baileys socket
                   │  ev 'messages.upsert' (notify/append)   [e 'messaging-history.set' se CAPTURE_HISTORY]
                   ▼
            listener.handle()
                   │ normalize()           → null descarta (sistema, status, canais, reações…)
                   │ fillPhones()          → resolve LID → telefone quando faltar
                   │ events.emit('message')→ só 'live'; consumido pelo tester
                   │ passesFilters()       → filtros da conexão (lidos a cada lote)
                   │ onCaptured()          → SQLite: chats + messages (forwarded = passou nos filtros)
                   │                         mídia nova → media.ts baixa para MEDIA_DIR (só 'live')
                   ▼  (só as que passaram nos filtros)
            forwarder.enqueue()   → grava QUEUE_DIR/<id>/<ts>-<seq>.json (tmp + rename)
                   ▼
            worker (1 por conexão, FIFO)           cada tentativa → evento 'webhook' no banco
                   │ deliver(target)       → fetch com timeout
                   ├─ 2xx                  → apaga o arquivo, espera FORWARD_MIN_INTERVAL_MS
                   ├─ 4xx (≠408/429)       → move para failed/ (não repete)
                   └─ rede/5xx/408/429     → backoff exponencial com jitter e repete o MESMO arquivo
```

---

## Mapa de módulos (serviço whatsapp)

`apps/whatsapp/src/`

| Arquivo | Responsabilidade | Exporta |
|---|---|---|
| `index.ts` | Entrada: cria pastas, abre o banco, carrega cadastro, inicia manager/tester/admin, trata `SIGINT`/`SIGTERM`. Ajusta `net.setDefaultAutoSelectFamilyAttemptTimeout(2000)` (contorno de IPv6 quebrado no WSL). | — |
| `config.ts` | Lê variáveis de ambiente com validação (`str`, `int`, `bool`). Único lugar que toca `process.env` (exceto `ai.ts`, que remove `ENDPOINT_TOKEN` do env do filho). | `config`, `Config` |
| `logger.ts` | Logger pino da app + `baileysLogger` com nível próprio. | `logger`, `baileysLogger` |
| `db.ts` | Abre o SQLite (`node:sqlite`, WAL, `foreign_keys`, arquivo `0600`), aplica migrações por `PRAGMA user_version`. Helpers `tx`, `v`, `parseJson`. | `openDb`, `tx`, `v`, `parseJson`, `Db`, `Row` |
| `settings.ts` | `ConnectionsStore`: cadastro na tabela `connections`, espelhado em memória (lido a cada mensagem sem ir ao disco). Validação de destino (`parseTarget`), nome (`parseFriendlyName`) e id (`isValidId`, `^[a-f0-9]{8}$`). Migra `connections.json` / `settings.json` antigos. | `ConnectionsStore`, `ConnectionConfig`, `ForwardTarget`, `METHODS`, parsers |
| `messages.ts` | `MessageStore`: grava conversas, mensagens (todas) e registros de mídia; consultas para a API. | `MessageStore`, `ChatView`, `StoredMessage`, `MediaView` |
| `media.ts` | `MediaDownloader`: fila de download (2 simultâneos, só ao vivo, limite `MEDIA_MAX_MB`, timeout 120 s), `.tmp` + `rename`, sha256. | `MediaDownloader`, `documentFileName` |
| `events.ts` | `EventLog`: grava/consulta eventos `connection`/`webhook`/`test` (só metadados); apaga os antigos 1×/dia. | `EventLog`, `EventEntry`, `EVENT_KINDS` |
| `changes.ts` | `ChangeBus`: versão por tópico (`connections`, `tests`, `messages`, `events`) + notificação agrupada (300 ms). | `ChangeBus`, `Topic` |
| `read-cache.ts` | `ReadCache`: respostas GET prontas, válidas enquanto as versões dos tópicos não mudam; LRU (300 entradas / ~16 MB); ETag. | `ReadCache` |
| `proxy.ts` | Validação/máscara de proxy; `wsAgent` (WebSocket), `fetchDispatcher` (undici: `ProxyAgent` ou conector SOCKS5 próprio), `testProxy`, `WebhookProxy` (com no-proxy). | `parseProxy`, `maskProxy`, `wsAgent`, `fetchDispatcher`, `testProxy`, `WebhookProxy`, `ProxyConfig` |
| `flows.ts` | `FlowStore`: CRUD de fluxos de teste (vários por conexão) + validação `parseFlowInput`. | `FlowStore`, `Flow`, `FlowView`, `parseFlowInput` |
| `manager.ts` | `ConnectionManager`: um `WhatsAppConnection` + um `Forwarder` por id. Criar/remover/conectar/cancelar/logout, editar nome/webhook/filtros, `shutdown`. Emite `events.on('message', (connectionId, msg))`. Migra pastas da versão antiga. | `ConnectionManager`, `ConnectionView` |
| `connection.ts` | `WhatsAppConnection`: socket Baileys, `useMultiFileAuthState`, QR (terminal + interface), máquina de estados, reconexão com backoff, contorno do `companion_reg_refresh`. | `WhatsAppConnection`, `ConnectionState`, `IdleReason`, `hasSavedSession`, `clearAuthDir` |
| `listener.ts` | Registra `messages.upsert` (e `messaging-history.set` opcional), normaliza, completa telefones via mapeamento LID, filtra e enfileira. | `attachListener` |
| `normalizer.ts` | `WAMessage` → `NormalizedMessage` (payload mínimo, sem baixar mídia). | `normalize`, `NormalizedMessage` |
| `filters.ts` | Regras de encaminhamento por conexão + normalização/comparação de telefones BR. | `Filters`, `defaultFilters`, `parseFilters`, `passesFilters`, `phoneOf`, `matchesAny` |
| `forwarder.ts` | `Forwarder`: fila em disco + worker com timeout/retry/backoff/rate limit. `deliver()` faz a requisição HTTP (também usada pelo botão "Enviar teste"). | `Forwarder`, `deliver` |
| `admin.ts` | Servidor HTTP da interface + API JSON; proteção por Host/Origin/Content-Type. | `startAdmin` |
| `admin-page.ts` | HTML/CSS/JS da interface como string TS (entra no build do `tsc` sem etapa de cópia). Recebe as conexões prontas por SSE (`/api/stream`); busca testes só quando mudam; sem polling. Sem recursos externos. | `ADMIN_PAGE` |
| `tester.ts` | `TestRunner`: executa um fluxo — laço com IA, coleta de respostas, veredito; grava em `test_runs` e eventos `test`. Migra `test-runs/*.json` antigos. | `TestRunner`, tipos, `SYSTEM_PROMPT`, schemas |
| `birthdays.ts` | `BirthdaySender`: lê o CSV de aniversários, envia os parabéns pela conexão `BIRTHDAY_CONNECTION_ID` ao iniciar e 1×/dia (janela `BIRTHDAY_HOURS`, teto `BIRTHDAY_MAX_PER_DAY`), registra em `.aniversarios-enviados.json` e marca `enviado` no CSV. Parser CSV próprio (RFC 4180, `;`/`,`, BOM). | `BirthdaySender`, `parseCsv`, `serializeCsv`, `BIRTHDAY_TEMPLATE` |
| `ai.ts` | Ponte com `claude -p` (sem ferramentas, sem sessão, sem settings locais, saída validada por `--json-schema`). | `askClaude` |

Dependências entre módulos (setas = "importa"):

```
index ─► config, logger, db, events, messages, media, flows, settings, manager, admin, tester, filters, birthdays
birthdays ─► filters, settings(isValidId), manager(tipo)
manager ─► connection, listener, forwarder, media, filters, settings/messages/events(tipos)
listener ─► normalizer, filters, forwarder(tipo)
admin ─► admin-page, events, flows, filters, forwarder(deliver), settings, manager/messages/tester(tipos)
tester ─► ai, db, filters, flows/events/manager(tipos)
settings, messages, flows, events ─► db
```

---

## Ciclo de vida do processo

**Inicialização** (`index.ts → main`):

1. Cria `AUTH_DIR`, `QUEUE_DIR` e `MEDIA_DIR`; abre o banco (`DB_PATH`) aplicando migrações; inicia a limpeza de eventos antigos; marca como `failed` downloads de mídia que ficaram `pending`.
2. `ConnectionsStore.load()` — com o banco vazio, migra `SETTINGS_DIR/connections.json` (ou o `settings.json` legado) e renomeia para `*.migrated`; depois lê a tabela `connections`. `CAPTURE_FROM_ME`/`CAPTURE_GROUPS` viram os **filtros padrão**.
3. `ConnectionManager.init()` — migra arquivos soltos da versão de uma conexão só; para cada conexão cadastrada cria forwarder (já começa a drenar a fila) e connection. **Só inicia o socket se houver sessão pareada** (`creds.json` com `me`); caso contrário fica `idle/not_started` esperando "Gerar QR".
4. `TestRunner.load()` — migra `SETTINGS_DIR/test-runs/*.json` (se houver) e renomeia a pasta; execuções `running` viram `interrupted`.
5. `startAdmin()` — sobe a interface.

**Desligamento** (`SIGINT`/`SIGTERM`, uma única vez):

1. `tester.stopAll()` — aborta testes em andamento; `media.stop()` descarta downloads na fila.
2. `manager.shutdown(15000)` — fecha todos os sockets **sem** invalidar a sessão (`sock.end`), depois tenta drenar cada fila por até 15 s (desiste antes se o forwarder estiver em backoff). O que sobrar fica em disco para a próxima execução.
3. Fecha o servidor admin (`closeAllConnections` para não esperar keep-alive).
4. Fecha o banco (por último: os passos acima ainda gravam eventos e execuções).

O `stop_grace_period: 30s` do compose é maior que os 15 s de drenagem de propósito.

---

## Conexão: estados e reconexão

`ConnectionState` (exposto na interface):

```
                 start()
   idle ──────────────────► connecting ──(qr)──► qr ──(scan)──► [close 515] ──► connecting ──► open
    ▲                            │                  │                                           │
    │                            │                  └─(expira sem scan)──► idle(qr_expired)     │
    │                            ▼                                                               │
    │                    reconnecting ◄───────────── close recuperável (rede, 5xx, timeout) ◄────┘
    │                    (backoff 2s → 5min, jitter)
    └── idle(logged_out | replaced | forbidden | not_started)
```

Tratamento de `connection: 'close'` (`handleClose`), pelo `statusCode` do erro:

| Situação | Ação | Por quê |
|---|---|---|
| `restartRequired` (515) | Reconecta **imediatamente** | Normal logo após escanear o QR |
| Sem sessão registrada (`!creds.registered && !creds.me`), qualquer código (inclui 408 "QR refs attempts ended") | `idle/qr_expired`, **não** gera QR novo sozinho | Evita ficar gerando QR em loop; usuário pede outro |
| `loggedOut` (401) / `multideviceMismatch` | Apaga o conteúdo de `auth/<id>` e vai para `idle/logged_out` | Sessão morta — reutilizá-la causaria erros e reconexões inúteis |
| `connectionReplaced` (440) | `idle/replaced`, sem reconectar | Outra instância abriu a mesma sessão. Reconectar criaria briga entre as duas |
| `forbidden` (403) | `idle/forbidden`, sem reconectar | Conta bloqueada/banida |
| Demais | `reconnecting`, backoff `min(300s, 2s·2^(n-1))` com jitter de 50–100% | Nunca loop apertado |

Outros pontos:

- **Eventos de socket antigo são ignorados** (`if (sock !== this.sock) return`) — após reconexão, callbacks tardios do socket anterior não mexem no estado.
- `this.closing` impede que um `close` provocado por nós (shutdown, cancel, logout) dispare reconexão.
- `clearAuthDir` **esvazia** a pasta, não a remove — no Docker o diretório pai é ponto de montagem do volume.
- `fetchLatestBaileysVersion()` é chamado uma única vez por processo (compartilhado entre conexões).
- Opções do socket: `markOnlineOnConnect: false` (o celular continua recebendo notificações), `syncFullHistory: CAPTURE_HISTORY`, `getMessage: async () => undefined` (não reenviamos mensagens em retries de criptografia).
- `logout()` só age com status `open`; `cancel()` só com `qr`/`connecting`/`reconnecting` e descarta credenciais de pareamento incompleto (mantém sessão já pareada).

### Contorno do `companion_reg_refresh` (Baileys rc14)

Desde ~28/07/2026, ao ler o QR o servidor envia `<notification type="companion_reg_refresh">` e espera que o cliente gere um novo `advSecretKey` e mostre o QR com ele. A rc14 ignora isso (issue #2737 / PR #2765 upstream), e o pareamento nunca completa. O `connection.ts`:

1. Escuta `sock.ws.on('CB:notification,type:companion_reg_refresh')`.
2. Se ainda **não** pareado (`!creds.me`), gera um `advSecretKey` novo, salva as creds e redesenha o último QR com o segredo trocado (`withAdvSecret` substitui o 4º campo após `#` no texto do QR).
3. Todo QR emitido pela Baileys também passa por `withAdvSecret` com o segredo atual.

**Remover** quando a Baileys incorporar o PR (verifique antes de atualizar a versão).

---

## Escuta e normalização

`listener.ts`:

- `messages.upsert` traz `type: 'notify'` (tempo real) e `'append'` (enviadas por você em outro aparelho, recebidas enquanto offline). **Ambos** são tratados como `source: 'live'`.
- `messaging-history.set` (histórico) só é assinado com `CAPTURE_HISTORY=true` → `source: 'history'`.
- `self = { pn, lid }` (meus JIDs) é recalculado a cada lote a partir de `sock.user`.
- `fillPhones`: na v7 muitos chats chegam como `@lid`. Se o campo `*Alt` não veio, consulta `sock.signalRepository.lidMapping.getPNForLID()`. Sem isso o filtro por telefone não teria com o que comparar.
- Os **filtros são lidos a cada lote** (`getFilters()`), assim como o nome (`getInstance()`) — edições na interface valem na hora.
- `onMessage` (evento para o tester) recebe só mensagens `live`, **antes** dos filtros.

`normalizer.ts` retorna `null` (descarta) para:

- mensagens sem `key.id`/`remoteJid`;
- broadcast (status, listas de transmissão) e newsletters (canais);
- tipos internos: `protocolMessage`, `senderKeyDistributionMessage`, `messageContextInfo`, `reactionMessage`, `pollUpdateMessage`, `keepInChatMessage`.

Regras de preenchimento:

- Conteúdo é desembrulhado com `normalizeMessageContent` (ephemeral, viewOnce, documentWithCaption…); `type` = `getContentType()`.
- `media` é preenchido quando o conteúdo interno tem `mimetype` (só metadados no payload do webhook; o arquivo é baixado à parte por `media.ts`).
- `text`: `conversation` → `extendedTextMessage.text` → legendas de imagem/vídeo/documento → respostas de botão/lista.
- `senderId`: em grupo, `key.participant`; em 1:1 recebida, o próprio chat; em mensagem minha, meu JID no mesmo "espaço" do chat (LID se o chat é `@lid`, telefone caso contrário).
- `timestamp`: `Number(messageTimestamp)` (pode vir como `Long` do protobuf), em **segundos**.

---

## Filtros

`filters.ts` — por conexão, persistidos na tabela `connections` (coluna `filters`, JSON). **Valem só para o webhook**: o banco grava todas as mensagens, com `forwarded` indicando se passou.

```ts
type Filters = {
  received: { enabled: boolean; phones: string[] } // phones = quem ENVIOU
  sent:     { enabled: boolean; phones: string[] } // phones = quem RECEBEU (chat 1:1)
  groups: boolean
}
```

`passesFilters(msg, f)`:

1. Grupo e `!groups` → descarta.
2. `fromMe`: `sent.enabled` falso → descarta; lista vazia → passa; **em grupo com lista preenchida → descarta** (não há um telefone de destino); senão compara o telefone do chat.
3. Recebida: `received.enabled` falso → descarta; lista vazia → passa; senão compara o telefone do remetente (`senderId`/`senderIdAlt`).

Telefones:

- Guardados só com dígitos; 10/11 dígitos (sem DDI) recebem `55` na gravação; válidos entre 8 e 15 dígitos; no máximo 200 por lista; aceita separação por quebra de linha, vírgula ou ponto e vírgula.
- `phoneOf(...jids)` pega o primeiro JID `@s.whatsapp.net` e extrai os dígitos (ignora sufixo `:device`).
- `matchesAny` compara variantes: com/sem DDI 55 e **com/sem o 9º dígito** de celular BR (o WhatsApp às vezes usa a forma antiga de 8 dígitos).

---

## Encaminhamento: fila em disco

`forwarder.ts` — um `Forwarder` por conexão, pasta `QUEUE_DIR/<id>/`:

- **Persistir antes de enviar**: `enqueue` grava `<epoch-ms 15 dígitos>-<seq 6 dígitos>.json` via `.tmp` + `rename` (o worker nunca lê arquivo pela metade). Temporários órfãos são apagados no `start()`.
- **Um worker, FIFO**: pega sempre o primeiro arquivo em ordem alfabética (= ordem de chegada). Um item com falha recuperável **bloqueia os seguintes** até ser entregue (preserva ordem).
- **Destino lido a cada envio** (`getTarget()`): trocar o webhook na interface vale imediatamente; `nudge()` zera o contador de falhas e interrompe o backoff atual.
- **Sem webhook**: o listener **não enfileira** (`hasWebhook()`; a mensagem fica só no banco com `forwarded = 0`). O que já estava na fila fica parado até um webhook ser salvo, ou é excluído se a remoção pedir `discardPending`.
- **Fila vazia ou sem webhook**: o worker dorme até `enqueue`/`nudge` ou 5 s.
- **Índice em memória** (`DirIndex`): nomes pendentes/rejeitados carregados no `start()` e atualizados a cada `enqueue`/entrega/exclusão. `stats()`, a página da fila e a escolha do próximo item não leem a pasta. A pasta continua sendo a verdade: a cada 60 s, se o `mtime` mudou (ex.: arquivos movidos à mão), ela é relida.
- **Classificação da resposta**:
  - `2xx` → apaga o arquivo; pausa `FORWARD_MIN_INTERVAL_MS`.
  - `4xx` exceto `408`/`429` → move para `failed/` (inspeção manual; não é reprocessado automaticamente).
  - Erro de rede, timeout, `5xx`, `408`, `429`, outros → `retry` com backoff `min(MAX, BASE·2^(n-1))` e jitter 50–100%.
  - Falha ao **ler** o arquivo → `failed/`.
- **`deliver()`**: `POST`/`OPTIONS` enviam JSON com `content-type: application/json`; `GET` converte cada campo em query string (objetos como JSON, nulos omitidos — textos longos podem estourar o limite de URL). Header `authorization: Bearer <token>` só se houver token. O corpo da resposta é consumido para liberar o keep-alive.
- `stats()` alimenta o card "Fila" da interface.
- **Ver/excluir pela interface**: `listItems(kind, offset, limit)` lê os arquivos da página (prévia de 140 chars) e `removeItems(kind, files | 'all')` apaga sem enviar. Só nomes no formato gerado pelo `enqueue` (`^\d{15}-\d{6}\.json$`) são aceitos. Se o item removido era a cabeça da fila (a que bloqueia em retry), chama `nudge()` e o worker segue na hora. O worker tolera o arquivo sumir no meio (`ENOENT` na leitura = pula; no `rename` para `failed/` = ignora). Corrida inevitável: um item que o worker já leu e está enviando pode ainda ser entregue. Cada exclusão gera evento `webhook/discarded`.
- `destroy()` (exclusão da conexão) para o worker **sem drenar** e apaga a pasta.

Garantia resultante: **at-least-once**. Pode haver duplicatas (ex.: timeout após o destino ter gravado); o destino deve deduplicar por `id`.

---

## Interface admin

`admin.ts` — `node:http` puro (sem framework, para manter o serviço enxuto).

Segurança (não há login):

- Escuta em `127.0.0.1` localmente; no Docker escuta em `0.0.0.0` dentro do container, mas a porta é publicada só em `127.0.0.1:3200` do host.
- **Host** deve ser `localhost`, `127.0.0.1` ou `[::1]` (bloqueia DNS rebinding).
- **Origin**, quando presente, deve ser a própria página.
- Toda rota que altera algo exige `Content-Type: application/json` (força preflight CORS, que nunca é aprovado → um site qualquer não consegue disparar ações).
- Corpo máximo 16 KB. CSP restritiva e `X-Frame-Options: DENY` na página.
- O **token do webhook nunca é devolvido** (`tokenSet: boolean`); `PUT webhook` sem `token` mantém o salvo.
- O texto bruto do QR não sai do servidor; só o SVG (cacheado por texto, máx. 50).

Rotas: ver [API.md](API.md#api-da-interface-admin).

---

## Banco de dados (SQLite)

`db.ts` — `node:sqlite` embutido no Node 22 (sem dependência nova; imprime um `ExperimentalWarning` ao carregar). Arquivo `DB_PATH` (`0600`), WAL, `foreign_keys = ON`, `busy_timeout` 5 s. API **síncrona**: cada escrita é curta e o volume é de uso pessoal.

```
connections 1─┬─N flows 1─N test_runs      (test_runs.flow_id NULL = execução antiga, sem fluxo)
              ├─N test_runs
              ├─N chats 1─N messages 1─0..1 media
              └─N events                    (connection_id NULL permitido)
```

Todas as FKs têm `ON DELETE CASCADE`: excluir a conexão apaga tudo dela no banco; `manager.remove` apaga também `MEDIA_DIR/<id>/`.

| Tabela | Chave | Observações |
|---|---|---|
| `connections` | `id` | `webhook` e `filters` em JSON. Espelhada em memória pelo `ConnectionsStore`. |
| `flows` | `id` (8 hex) | Cenário: `to_phone`, `task`, `rules` (JSON), tempos. |
| `test_runs` | `id` (8 hex) | `input` = cópia do fluxo na hora da execução; `transcript`/`rules` em JSON; regravada a cada entrada da transcrição. |
| `chats` | `(connection_id, chat_id)` | `name` = último `pushName` de 1:1 recebida; `last_message_at` (epoch s). |
| `messages` | `(connection_id, chat_id, id)` | Toda mensagem normalizada (ao vivo; histórico só com `CAPTURE_HISTORY`). Repetida (`append` após `notify`) não duplica; `forwarded` só sobe de 0 → 1. |
| `media` | `id` + único `(connection_id, chat_id, message_id)` | `status`: `pending` → `saved` (com `path` relativo a `MEDIA_DIR`, `sha256`) \| `skipped` (histórico, `MEDIA_DOWNLOAD=false`, > `MEDIA_MAX_MB`) \| `failed` (erro; ou `pending` ao reiniciar). |
| `events` | `id` autoincremento | `kind` `connection`/`webhook`/`test`, `type`, `ref`, `data` JSON. Só metadados. Apagados após `EVENTS_RETENTION_DAYS`. |

**Migrações**: `MIGRATIONS[]` em `db.ts`, uma por versão de `PRAGMA user_version`, aplicadas em transação na abertura. Só acrescente no fim; nunca edite uma já publicada.

**Robustez**: falha ao gravar mensagem no banco é logada e **não** impede o envio ao webhook; falha ao gravar evento é só logada. A fila do webhook e a sessão da Baileys continuam em arquivo (invariantes 4, 5 e 11).

**Mídia** (`media.ts`): baixada com `downloadMediaMessage(..., 'stream')` + `reuploadRequest: sock.updateMediaMessage` (URL expirada → pede reupload ao celular). 2 downloads simultâneos, timeout 120 s, contagem de bytes durante a gravação (aborta acima de `MEDIA_MAX_MB` mesmo sem `fileLength`). Caminho `MEDIA_DIR/<conexão>/<AAAA-MM>/<id-da-mensagem>.<ext>`. A `WAMessage` original não é guardada, então download interrompido não é retomado.

**Servir mídia** (`GET /api/media/:id`): caminho do banco conferido dentro de `MEDIA_DIR`; `nosniff`, CSP `sandbox`; só imagem raster/áudio/vídeo vão *inline* — o resto é download, para que um arquivo recebido (HTML/SVG) nunca rode na origem da interface admin.

---

## Leituras: cache por versão e SSE

Antes, a página consultava `/api/connections` a cada 2 s e `/api/flows` + `/api/tests` (+ a execução aberta) a cada 2,5 s, mesmo sem mudança e com a aba escondida — cada consulta era `readdir` da fila, SQL e SVG de QR. Agora:

```
escrita (store, fila, socket, tester) ──► ChangeBus.bump(tópico)   versão++ ; agrupa 300 ms
                                              │
             ┌────────────────────────────────┴───────────────┐
             ▼                                                ▼
   GET /api/stream (SSE, StreamHub)              GET /api/... → ReadCache.get(url, tópicos, calcular)
   abrir: snapshot (todas as conexões)             carimbo igual → JSON da memória (ou 304 por ETag)
   mudou: connection {view completa}                carimbo novo → calcula, guarda
          (montada 1× p/ todas as abas)
          change ["tests",…]
             ▼
   página: aplica conexões direto nos cards (sem requisição); testes: busca só
           se a aba estiver visível; sem polling
```

- O carimbo é lido **antes** de calcular: se algo mudar durante o cálculo, a próxima leitura recalcula (nunca serve dado velho como novo).
- ETag = `W/"<id do boot>.<versões>"` — muda ao reiniciar (as versões recomeçam em 0).
- Quem incrementa: `MessageStore` (`messages`), `EventLog` (`events`), `FlowStore` e `TestRunner` (`tests`), `ConnectionManager` (cadastro), `WhatsAppConnection.onUpdate` (todo `setState`, inclusive QR renovado) e `Forwarder.onChange` (enfileirou, entregou, backoff) em `connections`.
- **Por que não Redis**: um processo só (invariante 1) e banco local no mesmo processo. Redis acrescentaria serviço, rede e a mesma invalidação — mais lento que ler da memória. Se o banco um dia for remoto/pago por leitura, o `ReadCache` é o ponto para trocar por um cache compartilhado.
- O cliente SSE entra na lista antes do snapshot, mas os eventos ficam retidos até o snapshot sair: nenhum se perde e nenhum mais velho chega depois dele. Sem abas abertas, nenhuma visão é montada.
- Queda do app: o navegador reconecta sozinho (`retry: 5000`) e o snapshot novo repõe tudo.
- Máx. 20 conexões SSE; comentário `keepalive` a cada 30 s (proxy/NAT não derrubam a conexão ociosa); `X-Accel-Buffering: no` e `flush_interval -1` no Caddy.
- Banco: conversas e mensagens paginam por **cursor** (`(tempo, id)`, índices `chats_page`/`messages_page`, migração v3), não por `OFFSET`; `chats.message_count` é mantido na gravação (sem `COUNT(*)` ao listar).

---

## Proxies

`proxy.ts`. Credenciais nunca vão para log, eventos ou UI (só `esquema://host:porta`); ficam no banco (`0600`).

| Proxy | Configuração | Aplicado em |
|---|---|---|
| Saída do WhatsApp, **por conexão** | Interface (`PUT /api/connections/:id/proxy`), coluna `connections.proxy` (migração v2) | `makeWASocket({ agent, fetchAgent })` + `dispatcher` no download de mídia (`media.ts`) |
| Saída do webhook, **global** | `WEBHOOK_PROXY_URL` / `WEBHOOK_NO_PROXY` | `deliver()` (worker e "Enviar teste") |
| Reverso da admin | `proxy/Caddyfile`, profile `proxy` do compose | HTTPS + basic auth na frente de `whatsapp:3200` |

- WebSocket: `HttpsProxyAgent` (CONNECT) ou `SocksProxyAgent` (sempre `socks5h`: DNS no proxy).
- fetch: o nativo só aceita dispatcher do undici (a Baileys ignora `fetchAgent` sem `.dispatch`). HTTP(S) → `undici.ProxyAgent` com `Proxy-Authorization`; SOCKS5 → `undici.Agent` com `connect` próprio (lib `socks` + `tls.connect` com SNI/verificação normais). `undici` fixado na **mesma major (6)** do Node 22 para compatibilidade com o `fetch` embutido.
- O proxy é lido a cada `start()` (invariante 6). `WhatsAppConnection.restart()` fecha o socket (`closing`, sem logout) e abre outro com a mesma sessão — usado ao salvar/remover o proxy. O dispatcher do socket anterior é fechado.
- `fetchLatestBaileysVersion` (GitHub) sai direto: não identifica o número.
- Admin atrás do proxy reverso: Host/Origin continuam checados; domínio próprio precisa estar em `ADMIN_ALLOWED_HOSTS`.

---

## Testes com IA

`tester.ts` + `ai.ts` — testa um fluxo de atendimento conversando de verdade pelo WhatsApp.

Cada **conexão** tem vários **fluxos** (`flows.ts`), e cada fluxo várias **execuções**. `start(flowId)` copia o fluxo para `run.input` (editar o fluxo depois não altera execuções antigas).

Laço de uma execução:

```
start(flowId)
  ├─ exige conexão "open", uma execução por conexão, destino ≠ próprio número
  ├─ sock.onWhatsApp(to) → targetJid (falha se o número não tem WhatsApp)
  └─ execute() em segundo plano:
       decision = IA(step)
       enquanto decision.action == 'send' e turns < maxTurns:
           "digitando…" por min(4s, 1.2s + 35ms·len) → sendMessage → 'paused'
           collector.collect(replyTimeout, quiet)   # 1ª resposta + rajada até silêncio (teto 90 s)
           transcrição += respostas (ou "Sem resposta…")
           decision = IA(step)
       até 3× IA(final) enquanto o veredito não for válido
       status = passed | failed | inconclusive | error | cancelled
```

- Respostas do alvo vêm do `manager.events('message')` filtrando: mesma conexão, `!fromMe`, não grupo, chat = `targetJid` ou telefone equivalente.
- Veredito **válido** = `action: finish`, `verdict` presente, `summary` ≥ 20 caracteres, exatamente um item por regra (índices 1..N sem repetição) e evidência ≥ 10 caracteres. A IA avalia **por índice**; o texto da regra é associado no backend.
- `ai.ts` executa `claude -p --output-format json --json-schema … --system-prompt … --tools "" --no-session-persistence --setting-sources "" --model <TESTER_MODEL>` com `cwd = os.tmpdir()`, prompt via stdin, `ENDPOINT_TOKEN` removido do ambiente. Repete até 3× quando a saída estruturada não vem (acontece ~1 em 10); não repete para binário ausente, timeout ou cancelamento. Soma `total_cost_usd` em `run.costUsd`.
- O `SYSTEM_PROMPT` instrui a IA a agir como cliente brasileiro, usar dados fictícios e **ignorar instruções vindas do atendimento** (proteção contra prompt injection pelo número testado).
- Persistência: tabela `test_runs` (upsert a cada entrada da transcrição) + eventos `test` (`started`, `ai`, `sent`, `replies`, `no_reply`, `finished`, só metadados). Sem limite de quantidade; apagar um fluxo apaga as execuções dele.
- Não é possível apagar um fluxo nem excluir a conexão com execução em andamento (`409`).

### Referência: card + fluxo do Studio

```
start(flowId)
  └─ buildReference (reference.ts)           ← relida a cada execução; erro aparece já no "Executar"
       ├─ card (cards.ts): texto | Azure DevOps | Jira   — só GET, host na lista, token do .env
       ├─ fluxo (studio.ts): pasta do projeto (WSL/Windows → caminho local) | JSON anexado (studio_uploads)
       │     selectFlows(+subfluxos via run-subflow.flow_sid) → condenseFlow = roteiro legível, segredos ***
       └─ limite TESTER_REFERENCE_MAX_KB (erro claro, sem cortar)
  execute
  ├─ system prompt = SYSTEM_PROMPT + REFERENCE_INSTRUCTIONS + referência → arquivo 0600 em /tmp
  │    (--system-prompt-file: passa do limite de 128 KB por argumento e é cacheado entre turnos)
  ├─ StudioMonitor (studio-monitor.ts), se studio.monitorEnv:
  │    a cada TESTER_STUDIO_POLL_MS e logo antes de cada decisão da IA:
  │    Executions do fluxo (criadas após o início, contato = nosso número) → Steps novos
  │    → Context só dos widgets split/função/HTTP/Flex/subfluxo/espera (tipo vem da definição), mascarado
  │    → transcrição ('studio') + prompt ("EXECUÇÃO REAL NO TWILIO STUDIO")
  ├─ cada passo: analysis { flowState, status, note } → transcrição ('analysis') + analysis.steps
  ├─ veredito: + deviations[] + requirements[] (validados; até 3 tentativas)
  └─ fim: monitor.stop() (leitura final), apaga o prompt, writeRunLog → TEST_LOGS_DIR/<data>_<fluxo>_<id>.md
```

- Studio: cada *step* da API é uma **transição** (`transitioned_from` --`name` = evento--> `transitioned_to`). SID do fluxo vem do `studioFlows.json` ou, nos exports, é resolvido pelo nome (`GET /v2/Flows`). Leituras enfileiradas (a do intervalo e a forçada nunca correm juntas); no máximo 25 contextos por rodada; 2000 passos guardados.
- Segurança: toda saída para fora é `GET`; o token do card só vai para hosts permitidos e o do Twilio só para `studio.twilio.com`. A leitura de disco só aceita `.json` (≤ 12 MB), com busca limitada que ignora `node_modules`/`.git`/`backups`/`migrations`, respeita `STUDIO_ALLOWED_ROOTS` e resolve symlinks. A interface só recebe nomes e contagens. Card e execução são tratados pela IA como dados, não instruções (proteção contra prompt injection).
- Custo: a referência é igual em todos os turnos (cache de prompt). O fluxo `Whatsapp_Relacionamento` com todos os subfluxos dá cerca de 350 KB de roteiro; escolha só os fluxos do caminho testado.
- Execuções `running` ao reiniciar o processo viram `interrupted`.

---

## Aniversários (CSV)

`birthdays.ts` — `BirthdaySender`, criado no `index.ts` depois do `manager.init()`; `stop()` no shutdown (cancela o timer e a espera entre envios). `runNow()` atende o `POST /api/birthdays/run` (botão da interface): roda a mesma verificação fora da janela; uma flag impede duas verificações ao mesmo tempo (a agendada, se cair durante o botão, tenta de novo em 5 min).

```
start() ── 30 s ──► tick()
                      ├─ fora de BIRTHDAY_HOURS            → agenda para o início da janela
                      └─ check()
                      ├─ conexão não cadastrada            → aviso; próxima amanhã
                      ├─ CSV não existe                    → cria o modelo (wx); próxima amanhã
                      ├─ lê CSV → modelos F/M + pessoas válidas (inválidas: aviso com nº da linha)
                      ├─ devidos = aniversário hoje (BIRTHDAY_TZ; 29/02 → 28/02)
                      │            e "enviado" sem o ano atual e fora do registro (.aniversarios-enviados.json)
                      └─ para cada um: teto diário? → getSocket (fechada → false) → onWhatsApp
                           → telefone do servidor já no registro? só marca → pausa ±25%
                           → "digitando…" → sendMessage → registro (.tmp + rename) → relê o CSV e grava "enviado"
false/erro → nova tentativa em 5 min; true → amanhã no início da janela (~24 h)
```

- **Marca no próprio CSV**, relendo o arquivo depois de cada envio (casa por telefone + nome). Isso preserva edições feitas durante o envio e não perde a marca se o processo cair no meio da lista. O arquivo é regravado inteiro: as aspas são normalizadas, mas comentários (`#`), linhas em branco, BOM e quebra de linha são mantidos.
- **Registro de envios** `.aniversarios-enviados.json` (ao lado do CSV, `telefone|ano → data`, só o ano corrente): é a fonte que impede reenvio. Sobrevive a restart (no `npm run dev`, cada edição reinicia) e ao Excel salvar uma cópia antiga por cima da coluna. A chave é o telefone devolvido pelo `onWhatsApp`, então grafias diferentes do mesmo número contam uma vez. Ele também conta o teto diário.
- Se a marca no CSV falhar (arquivo travado pelo Excel no Windows), o envio continua registrado; só a planilha fica sem a data.
- Log só com número da linha e contagens (invariante 8: nada de nome, telefone ou texto). Não grava em `events`.
- A mensagem enviada volta pelo `messages.upsert` como `fromMe` e segue o caminho normal (banco + filtros do webhook).
- No Docker o CSV é um **bind mount** (`./apps/whatsapp/birthdays`, sintaxe longa com `create_host_path: false`) para ser editável no host. A pasta precisa existir e ser gravável pelo uid 1000 (usuário `node`); sem ela o compose falha em vez de criar a pasta como root.

---

## Serviço endpoint

`apps/endpoint/src/server.ts` (arquivo único):

- Sai com erro se `ENDPOINT_TOKEN` estiver ausente.
- Hook `onRequest`: exceto `/health`, exige `Authorization: Bearer <token>` com comparação em tempo constante (`timingSafeEqual`) → `401` se inválido.
- `POST /messages`: schema mínimo (`id`, `chatId`, `timestamp`, `type`), `bodyLimit` 256 KB; acrescenta `receivedAt` e faz append em `DATA_DIR/messages-AAAA-MM-DD.jsonl` (data UTC do recebimento); responde `202 {ok:true}`. Loga só `id` e `type`.
- `GET /health` → `{ ok: true }` sem autenticação.
- Shutdown gracioso com `app.close()`.

Como qualquer 4xx não recuperável manda a mensagem para `failed/` no app, **um token errado no webhook faz as mensagens irem para `failed/`** (401) em vez de ficarem em retry.

---

## Docker

- Build com `context: .` (raiz) e `dockerfile: apps/<svc>/Dockerfile`; cada Dockerfile copia só o necessário.
- Multi-stage `node:22-slim`: estágio `build` (`npm ci`, `tsc`, `npm prune --omit=dev`) → runtime com `dist` + `node_modules` de produção, `NODE_ENV=production`, `USER node`.
- As pastas `/app/{auth,queue,settings}` (e `/app/data` no endpoint) são criadas com dono `node` **antes** da montagem, para que o volume nomeado herde a permissão.
- `container_name: capture-whatsapp` fixo impede `--scale whatsapp=2` (duas instâncias com a mesma sessão derrubam a conexão).
- `restart: on-failure` no `whatsapp`: reinicia só em crash; logout/QR expirado **não** derrubam o processo (ele fica parado aguardando ação na interface).
- `init: true` (tini) para repassar sinais corretamente; `stop_grace_period: 30s`.
- `endpoint` não publica porta no host (só rede interna do compose), `restart: unless-stopped`.
- Volumes nomeados: `auth_data`, `queue_data`, `settings_data` (só arquivos antigos já migrados), `db_data` (`/app/db`), `media_data` (`/app/media`), `endpoint_data`. **`docker compose down -v` apaga todos.**

---

## Armadilhas da Baileys

1. **Versão fixa `7.0.0-rc14`**. A API muda entre RCs (nomes de eventos, campos de `key`, `lidMapping`, `DisconnectReason`). Antes de atualizar ou de assumir uma sintaxe, confira `npm list @whiskeysockets/baileys --prefix apps/whatsapp` e consulte `Baileys/src/` (clone local na mesma versão).
2. **LID (`@lid`)**: na v7 os chats chegam endereçados por LID e o telefone vem em `remoteJidAlt`/`participantAlt` — nem sempre. Por isso `fillPhones` consulta o mapeamento.
3. **Não bloquear a sincronização inicial de histórico** (`shouldSyncHistoryMessage`): é por ela que a v7 recebe o mapeamento LID↔telefone; desligá-la causa erros de sessão. O que é *encaminhado* é controlado no listener.
4. **`messages.upsert` com `append`** também contém mensagens relevantes (enviadas de outro aparelho, recebidas offline).
5. **`restartRequired` (515) logo após o QR** é normal — não trate como erro.
6. **`companion_reg_refresh`**: ver contorno acima.
7. **`messageTimestamp`** pode ser `Long`; sempre `Number()`.
8. **Eventos do socket antigo** continuam chegando após reconectar — sempre compare com o socket atual.
9. **Uma sessão, um processo**: abrir a mesma pasta de auth em dois lugares gera `connectionReplaced` alternado e risco ao número.

---

## Decisões de design

| Decisão | Motivo |
|---|---|
| Várias conexões num processo, pastas por id | Um webhook fora do ar não trava outras conexões; um único container mantém a regra de "réplica única" |
| Fila em arquivos (um JSON por mensagem) em vez de SQLite/Redis | Zero dependências, sobrevive a crash, fácil de inspecionar/reprocessar à mão |
| SQLite nativo (`node:sqlite`) para cadastro, fluxos, conversas e eventos | Consultas e relações (conexão → fluxos → execuções; conversa → mensagens → mídia) sem dependência nem serviço novo; um arquivo num volume |
| Mídia em disco, metadados no banco | Banco pequeno e rápido; arquivos acessíveis direto no volume |
| Cache em memória por versão + SSE em vez de Redis + polling | Um processo, banco local: invalidação exata e zero serviço novo; a página só busca quando algo mudou |
| Proxy do WhatsApp por conexão (não global) | Isola o IP de cada número; um proxy ruim afeta só aquela conexão |
| Proxy reverso opcional (profile) | Uso padrão é local; HTTPS/login só quando a interface sai do loopback |
| Sessão da Baileys e fila do webhook continuam em arquivo | Formato da Baileys / garantia "persistir antes de enviar" já testados; mexer nisso arrisca a sessão e a entrega |
| Ordem FIFO estrita com bloqueio em retry | Preserva a ordem das mensagens no destino |
| 4xx → `failed/` | Repetir um erro de validação/autorização é inútil e travaria a fila |
| Webhook configurado pela UI (não pelo `.env`) | Cada conexão tem destino próprio e pode trocar sem reiniciar |
| QR expirado não gera novo sozinho | Gerar QR em loop é sinal de automação e não tem ninguém para escanear |
| Interface em `node:http` + HTML embutido | Sem framework/bundler; o HTML vai junto no `tsc` |
| JSONL no endpoint | Armazenamento mais simples que funciona; append-only e fácil de importar |
| Testes com IA via `claude -p` isolado | Reusa o login da máquina; sem ferramentas nem contexto local, só texto → JSON validado |

---

## Dívidas técnicas conhecidas

- `config.forward.url` / `config.forward.token` (`FORWARD_URL`, `ENDPOINT_TOKEN`) são lidos mas **não usados** pelo serviço `whatsapp` desde que o webhook passou a ser por conexão.
- Não há testes automatizados; a verificação é `npm run typecheck` + uso real.
- Itens em `failed/` não têm reprocessamento pela interface (mover de volta para a pasta da fila manualmente — ver [OPERATIONS.md](OPERATIONS.md)).
- Mídia de histórico não é baixada, e download interrompido por reinício não é retomado (a `WAMessage` original não é guardada).
- Não há tela para navegar conversas/eventos: só a API de leitura (`/api/connections/:id/chats`, `/messages`, `/events`, `/api/media/:id`).
- Listas de fluxos e de execuções não paginam (execuções: até 200 mais recentes por consulta).
- Cada execução guarda a referência inteira (`test_runs.reference`, até `TESTER_REFERENCE_MAX_KB`); muitas execuções com fluxos grandes aumentam o banco.
- A IA analisa a execução do Studio a cada decisão dela, não a cada leitura de 10 s (a leitura é só coleta). Não há parada antecipada da espera quando o Studio termina ou transfere.
- Monitor do Studio: o contexto dos widgets é buscado só para tipos de decisão/integração (máx. 25 por rodada); set-variables e mensagens não trazem contexto.
- Aniversários: sem tela na interface nem eventos no banco; a verificação é 1×/dia no início da janela, e aniversário perdido com a conexão fechada o dia todo não é enviado depois.
- Mascaramento de segredos por nome de chave (token/senha/auth…): pode esconder valores inofensivos (ex.: `tentativas_enviar_tokenSms`) e não detecta segredo em chave de nome neutro.
