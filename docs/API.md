# API e contratos

- [Payload enviado ao webhook](#payload-enviado-ao-webhook)
- [Contrato que o webhook deve cumprir](#contrato-que-o-webhook-deve-cumprir)
- [API do serviço endpoint](#api-do-serviço-endpoint)
- [API da interface admin](#api-da-interface-admin)

---

## Payload enviado ao webhook

Tipo `NormalizedMessage` (`apps/whatsapp/src/normalizer.ts`) + `instance`:

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `string` | Id da mensagem no WhatsApp (`key.id`). **Use para deduplicar.** Único por chat, não globalmente — para chave global use `chatId + id`. |
| `chatId` | `string` | JID do chat: `<telefone>@s.whatsapp.net`, `<lid>@lid` ou `<id>@g.us` (grupo). |
| `chatIdAlt` | `string \| null` | JID alternativo do chat (telefone ↔ LID), quando conhecido. |
| `isGroup` | `boolean` | Chat é grupo. |
| `fromMe` | `boolean` | Enviada pela conta conectada (de qualquer aparelho). |
| `senderId` | `string \| null` | Autor: participante em grupo; o outro lado em 1:1 recebida; o próprio número quando `fromMe`. |
| `senderIdAlt` | `string \| null` | JID alternativo do autor. |
| `pushName` | `string \| null` | Nome de perfil do remetente, como enviado pelo WhatsApp. |
| `timestamp` | `number` | Epoch em **segundos**. |
| `type` | `string` | Tipo de conteúdo da Baileys: `conversation`, `extendedTextMessage`, `imageMessage`, `videoMessage`, `audioMessage`, `documentMessage`, `stickerMessage`, `locationMessage`, `contactMessage`, `pollCreationMessage`, `buttonsResponseMessage`, `listResponseMessage`… |
| `text` | `string \| null` | Texto, legenda de mídia ou texto da opção escolhida. |
| `media` | `{ mimetype, fileLength, seconds } \| null` | Metadados de mídia (sem o arquivo). `seconds` em áudio/vídeo. |
| `quotedId` | `string \| null` | `id` da mensagem citada (resposta). |
| `source` | `"live" \| "history"` | `history` só com `CAPTURE_HISTORY=true`. |
| `instance` | `string \| null` | Nome amigável da conexão que capturou. |
| `test` | `true` | **Só** nas mensagens do botão "Enviar teste". |

Não são enviados: reações, edições/revogações (`protocolMessage`), votos de enquete, status, listas de transmissão, canais.

Para obter o telefone: use o JID que termina em `@s.whatsapp.net` entre `senderId`/`senderIdAlt` (ou `chatId`/`chatIdAlt`) e pegue o trecho antes de `@` (ignorando `:<device>` se houver).

### Formato por método

| Método | Como o payload vai |
|---|---|
| `POST` (recomendado) | Corpo JSON, `content-type: application/json` |
| `OPTIONS` | Idem `POST` |
| `GET` | Sem corpo; cada campo não nulo vira query string (`media` como JSON). Textos longos podem ultrapassar o limite de URL (~8 KB). |

Headers: `authorization: Bearer <token>` quando a conexão tem token configurado.

---

## Contrato que o webhook deve cumprir

| Resposta do webhook | Comportamento do app |
|---|---|
| `2xx` | Entregue; removida da fila. |
| `4xx` exceto `408` e `429` | **Desistência**: arquivo movido para `QUEUE_DIR/<id>/failed/`. Não é reenviado. |
| `408`, `429`, `5xx`, outros | Retry com backoff exponencial (1 s → 5 min, com jitter). A fila dessa conexão fica parada nesse item até ele passar. |
| Timeout (`FORWARD_TIMEOUT_MS`) / erro de rede | Retry, idem. |

Recomendações:

- Responda rápido (enfileire internamente) — o envio é sequencial por conexão.
- Seja **idempotente** por `chatId + id`: a entrega é *at-least-once*.
- Não retorne `4xx` para falhas temporárias do seu lado; use `503`.

---

## API do serviço endpoint

Base: `http://endpoint:3000` (rede do compose) ou `http://localhost:${PORT}` (local).

| Método | Rota | Auth | Corpo | Resposta |
|---|---|---|---|---|
| `POST` | `/messages` | `Bearer ENDPOINT_TOKEN` | Payload acima (exige `id`, `chatId`, `timestamp`, `type`; máx. 256 KB) | `202 { "ok": true }` · `400` schema · `401` token |
| `GET` | `/health` | — | — | `200 { "ok": true }` |

Armazenamento: uma linha JSON por mensagem em `DATA_DIR/messages-AAAA-MM-DD.jsonl`, com o campo extra `receivedAt` (ISO). Exemplo de leitura deduplicada:

```bash
jq -c 'select(.test != true)' data/messages-2026-09-26.jsonl | jq -s 'unique_by(.chatId + .id)'
```

---

## API da interface admin

Base: `http://localhost:3200` (ou o proxy reverso, `https://localhost:8443`). Requisitos para **toda** chamada: `Host` local (ou em `ADMIN_ALLOWED_HOSTS`) e, se houver, `Origin` igual ao da página. Rotas que alteram estado exigem `Content-Type: application/json` (corpo pode ser `{}`), máx. 16 KB. Erros: `{ "error": "<mensagem legível>" }`.

### Leituras: cache, ETag e push (SSE)

Todo `GET` de dados (`/api/connections`, `/api/flows*`, `/api/tests*`, `/chats`, `/messages`, `/events`) sai de um **cache em memória** invalidado por versão de tópico. A resposta traz `ETag` e `Cache-Control: private, no-cache`; mande `If-None-Match` e receba `304` sem corpo quando nada mudou (o navegador faz isso sozinho). O ETag muda a cada reinício do app.

| Método | Rota | Resposta |
|---|---|---|
| `GET` | `/api/stream` | `text/event-stream`. Ao abrir: `snapshot` com `{ connections: ConnectionView[] }`. Depois, agrupado a cada 300 ms: `connection` com o `ConnectionView` completo de cada conexão que mudou, `connection-removed` com `{ id }`, e `change` com `data: ["tests"\|"messages"\|"events", …]` para os outros tópicos. Comentário `: keepalive` a cada 30 s (não é requisição). | Comentário `: ping` a cada 25 s. Máx. 20 conexões simultâneas (`503` acima disso). |

| Tópico | Muda quando |
|---|---|
| `connections` | estado do socket (inclusive QR renovado), cadastro (nome, webhook, filtros, proxy), fila (enfileirou, entregou, backoff) |
| `tests` | fluxos criados/editados/apagados, execuções (cada entrada da transcrição) |
| `messages` | mensagem gravada, mídia baixada/falhou |
| `events` | qualquer evento gravado |

### Conexões

| Método | Rota | Corpo | Resposta / efeito |
|---|---|---|---|
| `GET` | `/api/connections` | — | `{ connections: ConnectionView[] }` |
| `POST` | `/api/connections` | `{ friendlyName }` (1–60 chars) | `201 { id }`; cria e já gera QR. `400` se exceder `MAX_CONNECTIONS`. |
| `DELETE` | `/api/connections/:id` | `{}` | Logout no celular, apaga sessão, fila, mídia e cadastro (o banco apaga em cascata fluxos, execuções, conversas e eventos). `409` se houver teste em andamento na conexão. |
| `POST` | `/api/connections/:id/connect` | `{}` | Gera QR (sem sessão) ou reconecta. Sem efeito se já conectando/conectado. |
| `POST` | `/api/connections/:id/cancel` | `{}` | Descarta QR/conexão/reconexão em andamento → `idle`. |
| `POST` | `/api/connections/:id/logout` | `{}` | Remove de "Aparelhos conectados" e apaga a sessão; mantém cadastro e fila. |
| `PUT` | `/api/connections/:id/name` | `{ friendlyName }` | Renomeia. |
| `PUT` | `/api/connections/:id/webhook` | `{ url, method?, token? }` ou `{ url: "", discardPending? }` | Com `url`: salva (`token` omitido mantém o atual; `""` remove o token) e dispara nova tentativa imediata. `url` vazia **remove** o webhook: nada novo é enfileirado; com `discardPending: true` as pendentes são excluídas da fila. Resposta `{ ok, discarded? }`. |
| `PUT` | `/api/connections/:id/filters` | `{ received:{enabled,phones}, sent:{enabled,phones}, groups }` | `phones` aceita array ou string separada por `\n`, `,` ou `;`. |
| `POST` | `/api/connections/:id/test` | `{ url, method?, token? }` | Envia uma mensagem de exemplo (`test: true`) ao destino informado **sem salvar** (passa pelo `WEBHOOK_PROXY_URL`, se houver). `{ ok, status?, error?, ms }` |
| `GET` | `/api/connections/:id/queue?kind=pending\|failed&offset=0&limit=50` | — | `{ kind, offset, total, items: QueueItem[] }` em ordem de chegada; `limit` ≤ 200. `QueueItem` = `{ file, queuedAt, id, chatId, chatIdAlt, isGroup, fromMe, pushName, type, timestamp, preview (≤ 140 chars), unreadable }` |
| `DELETE` | `/api/connections/:id/queue` | `{ kind, files: ["<file>", …] }` (1–400) ou `{ kind, all: true }` | `{ removed }`. Exclui sem enviar ao webhook; `file` precisa ter o formato `^\d{15}-\d{6}\.json$`. Gera evento `webhook/discarded`. |
| `PUT` | `/api/connections/:id/proxy` | `{ url, username?, password? }` | Proxy de saída do WhatsApp. `url` = `http\|https\|socks5://host:porta` (sem credenciais na URL); vazia remove. `password` omitido mantém a salva (se o usuário não mudou). Com o socket ativo, **reconecta pela mesma sessão**. |
| `POST` | `/api/connections/:id/proxytest` | `{ url, username?, password? }` | Abre `HEAD https://web.whatsapp.com/` pelo proxy, **sem salvar**. `{ ok, status?, error?, ms }` |

`ConnectionView`:

```jsonc
{
  "id": "5848b66d",
  "friendlyName": "Meu número",
  "createdAt": "2026-09-26T02:44:57.001Z",
  "webhook": { "url": "https://…", "method": "POST", "tokenSet": true },   // ou null
  "filters": { "received": { "enabled": true, "phones": [] }, "sent": { "enabled": true, "phones": [] }, "groups": true },
  "proxy": { "url": "socks5://proxy.exemplo:1080", "username": "u", "passwordSet": true },   // ou null
  "state": { "status": "open", "user": { "id": "5511…:12@s.whatsapp.net", "name": "…" } },
  // outros: {status:"connecting"} | {status:"qr", qrSvg:"<svg…>"} |
  //         {status:"reconnecting", retryAt, attempts} |
  //         {status:"idle", reason:"not_started"|"qr_expired"|"logged_out"|"replaced"|"forbidden"}
  "queue": { "pending": 0, "failed": 0, "backingOff": false, "consecutiveFailures": 0,
             "lastError": null, "lastSuccessAt": "…" }
}
```

### Conversas, mídia e eventos (banco, só leitura)

| Método | Rota | Query | Resposta |
|---|---|---|---|
| `GET` | `/api/connections/:id/chats` | `limit?` (≤ 200, padrão 100), `cursor?` (o `nextCursor` da página anterior) | `{ chats: [{ chatId, chatIdAlt, isGroup, name, lastMessageAt, messages }], nextCursor }` (`nextCursor` null = última página), mais recentes primeiro |
| `GET` | `/api/connections/:id/messages` | `chat` (JID, obrigatório), `limit?` (≤ 200), `cursor?` | `{ messages: StoredMessage[], nextCursor }`, mais recentes primeiro. Paginação por cursor (tempo + id): custo constante por página, sem pular nem repetir mensagens do mesmo segundo. |
| `GET` | `/api/connections/:id/events` | `kind?`, `ref?`, `limit?`, `before?` (id do evento) | `{ events: EventEntry[] }` da conexão, mais recentes primeiro |
| `GET` | `/api/events` | idem | Eventos de todas as conexões |
| `GET` | `/api/media/:mediaId` | — | O arquivo. Imagem (jpeg/png/gif/webp), áudio e vídeo vão *inline*; o resto (inclusive SVG, PDF, HTML) como download `application/octet-stream`. `404` se não baixada. |

`StoredMessage` = campos do payload do webhook (sem `chatIdAlt`/`isGroup`, que ficam na conversa) + `forwarded` (passou nos filtros e foi para a fila do webhook) + `media: { id, mimetype, fileLength, seconds, fileName, status: "pending"|"saved"|"skipped"|"failed", error } | null`.

`EventEntry` = `{ id, at, connectionId, kind, type, ref, data }`:

| `kind` | `type` | `ref` | `data` |
|---|---|---|---|
| `connection` | `connecting`, `qr`, `open`, `reconnecting`, `idle` | — | `from` (estado anterior), `code`/`error` (queda), `reason` (idle), `user` (open), `attempts`/`retryAt` (reconnecting) |
| `webhook` | `ok`, `retry`, `drop` | id da mensagem | `status`, `error`, `ms`, `method`, `host` (só a origem da URL) |
| `webhook` | `discarded` | — | `kind` (`pending`/`failed`), `count`, `all` — itens excluídos da fila pela interface |
| `test` | `started`, `ai`, `sent`, `replies`, `no_reply`, `finished` | id da execução | `flowId` + metadados do passo (custo, turno, contagens, status final) |

Eventos guardam só metadados — nunca texto de mensagem, token ou QR. São apagados após `EVENTS_RETENTION_DAYS`.

### Fluxos de teste com IA

Cada conexão (número que envia) tem vários fluxos; cada fluxo, várias execuções.

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| `GET` | `/api/flows?connectionId=` | — | `{ flows: FlowView[] }` por nome; `FlowView` = `Flow` + `runs` (contagem) + `lastRun: { id, status, createdAt } \| null` |
| `POST` | `/api/flows` | `{ connectionId, name, to, task, rules, maxTurns?, replyTimeoutSec?, quietSec? }` | `201 Flow` |
| `GET` | `/api/flows/:id` | — | `Flow` |
| `PUT` | `/api/flows/:id` | mesmo corpo (`connectionId` é ignorado: a conexão do fluxo não muda) | `Flow` |
| `DELETE` | `/api/flows/:id` | `{}` | Apaga o fluxo e as execuções dele. `409` se houver execução em andamento. |
| `POST` | `/api/flows/:id/run` | `{}` | `201 { id }` da execução. `400` se a conexão não estiver conectada, já houver teste nela, ou o número não tiver WhatsApp. |

Validação do fluxo: `name` 1–80 chars; `to` com 10–15 dígitos (10/11 recebem `55`); `task` ≤ 4000 chars; `rules` array ou texto com uma por linha, ≤ 30 regras de ≤ 500 chars; `maxTurns` 1–30 (8); `replyTimeoutSec` 10–600 (60); `quietSec` 2–60 (6).

### Referência dos testes (card + fluxo do Studio)

Todas somente leitura em sistemas externos (Azure DevOps, Jira, disco).

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| `GET` | `/api/tester/info` | — | `{ wsl, azureConfigured, jiraConfigured, referenceMaxKb, twilioEnvs: { dev, qa, prod }, studioPollSec }` (booleans; nunca os tokens) |
| `POST` | `/api/studio/scan` | `{ path, location: "wsl"\|"windows" }` | `{ resolvedPath, sources: [{ file, kind: "state"\|"export", flows: [{ name, states }] }] }` — só nomes e contagens |
| `POST` | `/api/studio/uploads` | `{ fileName, content }` (JSON do Studio, até 12 MB) | `201 { id, fileName, flows }` |
| `GET` | `/api/studio/uploads/:id` | — | `{ fileName, flows }` |
| `POST` | `/api/cards/preview` | `{ source: "text"\|"azure"\|"jira", text?, url? }` | `{ title, ref, type, state, body (≤ 3000), bodyChars, comments, attachments, studioFlowsInAttachments }` |
| `POST` | `/api/reference/preview` | `{ card, studio }` (como no fluxo) | `{ summary: { card, studio, bytes }, preview (≤ 20 000), truncated }` |

No fluxo (`POST`/`PUT /api/flows`), os campos opcionais são `card: { source, text?, url? }` e `studio: { mode: "project", projectPath, location, file, flows[], includeSubflows, monitorEnv }` ou `{ mode: "upload", uploadId, fileName, flows[], includeSubflows, monitorEnv }`. `monitorEnv` = `"dev"\|"qa"\|"prod"\|null`. Com card ou studio, `task` pode ser vazio.

### Execuções

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| `GET` | `/api/tests?flowId=&connectionId=` | — | `{ runs: TestRun[] }` (sem `transcript`), mais recentes primeiro, até 200 |
| `GET` | `/api/tests/:id` | — | `TestRun` completo, com `analysis` (`reference`, `steps` da IA, `deviations`, `requirements`, `studio: { env, executions, steps }`), `hasReference` e `logFile`. Sem o texto da referência. |
| `GET` | `/api/tests/:id/reference` | — | Referência exata enviada à IA (`text/plain`) |
| `GET` | `/api/tests/:id/log` | — | Log da execução em Markdown (download) |
| `POST` | `/api/tests/:id/cancel` | `{}` | `{ ok }` (`false` se não estava rodando) |
| `DELETE` | `/api/tests/:id` | `{}` | `409` se ainda em andamento |

`TestRun.flowId` é `null` nas execuções migradas da versão sem fluxos. `TestRun.input` é a cópia do fluxo (inclui `name`) no momento da execução.

`TestRun.status`: `running`, `passed`, `failed`, `inconclusive`, `error`, `cancelled`, `interrupted`. `rules[]`: `{ rule, status: "ok"|"violated"|"not_tested", evidence }`. `transcript[]`: `{ at, from: "tester"|"target"|"system", text }`. `costUsd` soma o custo reportado pelo CLI.

Exemplo com curl:

```bash
curl -s localhost:3200/api/connections | jq '.connections[] | {friendlyName, status: .state.status, queue}'

curl -s -X PUT localhost:3200/api/connections/5848b66d/webhook \
  -H 'content-type: application/json' \
  -d '{"url":"http://endpoint:3000/messages","method":"POST","token":"<ENDPOINT_TOKEN>"}'
```
