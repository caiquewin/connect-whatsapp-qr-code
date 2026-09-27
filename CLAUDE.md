# CLAUDE.md

Este arquivo é lido automaticamente pelo Claude Code ao rodar nesta pasta. Ele define o contexto e as regras do projeto.

Documentação completa (leia a parte relevante antes de mudar algo não trivial):

| Documento | Quando ler |
|---|---|
| [README.md](README.md) | Uso, setup, variáveis de ambiente, onde ficam os dados |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Antes de alterar qualquer módulo: fluxo, estados da conexão, fila, filtros, testes com IA, armadilhas da Baileys |
| [docs/API.md](docs/API.md) | Payload do webhook, API do endpoint e da interface admin |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Deploy, backup da sessão, logs, troubleshooting |

## Sobre o projeto

Programa em Node.js (TypeScript) que conecta a **contas próprias** do WhatsApp usando a biblioteca **Baileys** (`@whiskeysockets/baileys`, WhatsApp Web multi-device), escuta eventos de mensagens em tempo real e os encaminha para **webhooks HTTP** para armazenamento e processamento posterior.

É para uso pessoal, no meu computador.

O que existe hoje (além do escopo original):

- **Várias conexões** (números) no mesmo processo, cada uma com nome amigável, webhook (URL/método/token) e filtros próprios.
- **Interface admin** web em `http://localhost:3200` (parear por QR, webhook, filtros, fila).
- **Testes de fluxo com IA**: cada conexão tem vários **fluxos**; executar um fluxo faz a conexão conversar com o número sob teste usando `claude -p` e dar veredito por regra de negócio.
  - **Referência opcional**: card da demanda (texto, Azure DevOps ou Jira — só leitura) + fluxo do **Twilio Studio** (pasta do projeto WSL/Windows ou JSON anexado), condensado num roteiro legível. A IA analisa cada resposta do bot contra o fluxo e o veredito traz divergências e requisitos da demanda.
  - **Execução real no Twilio** (opcional, por ambiente dev/qa/prod): a cada 10 s lê os steps e o contexto da execução do número que testa; a IA julga o caminho real.
  - **Log** de cada execução no banco e em `TEST_LOGS_DIR/*.md` (botão "Baixar log").
- **Proxies**: saída do WhatsApp por conexão (http/https/socks5, na interface), saída do webhook global (`WEBHOOK_PROXY_URL`), proxy reverso Caddy opcional na admin (HTTPS + login).
- **Tempo real sem polling**: `ChangeBus` (versão por tópico + ids de conexão) → SSE (`/api/stream`) manda snapshot e cada conexão alterada já pronta; GETs de dados saem de cache em memória com ETag/304. Fila com índice em memória; banco paginado por cursor. Sem Redis, de propósito.
- **Webhook opcional**: sem webhook nada é enfileirado (só banco); remover pode excluir as pendentes.
- **Banco SQLite** (`node:sqlite`, `DB_PATH`): conexões, fluxos, execuções, conversas/mensagens (todas, filtradas ou não), metadados de mídia e eventos (estado da conexão, entregas do webhook, passos dos testes). **Mídia** baixada para `MEDIA_DIR`.

## Estado atual (atualizado em 27/09/2026)

Ponto de partida para uma sessão nova. Tudo abaixo passa no `npm run typecheck`.

Validado:
- Banco SQLite, migrações v1–v4 (aplicadas no banco real), migração de `connections.json` → banco, paginação por cursor (testada numa cópia do banco).
- SSE com snapshot e conexão alterada; cache de leitura com ETag/304; fila: ver/excluir itens (fila temporária), webhook opcional (código; não testado removendo o webhook real).
- Proxies HTTP e SOCKS5 do WhatsApp com proxies locais de teste (HTTPS e WebSocket até web.whatsapp.com); no-proxy do webhook.
- Referência dos testes: busca no projeto real `~/twilio-project` (achou `twilio-infra/{dev,qa,prod}/state/studioFlows.json`), roteiro dos fluxos, trava de host dos cards, `--system-prompt-file` e esquemas novos numa chamada real do `claude -p`.
- Monitor da execução do Studio com a API **simulada**.

Ainda NÃO validado (fazer antes de confiar):
- Um teste com IA completo pelo WhatsApp com referência (card + Studio) — ninguém rodou ainda.
- Monitor contra a API real do Twilio: faltam `TWILIO_<ENV>_API_KEY_SID/SECRET` no `.env` (as chaves existem em `twilio-infra/.env-*`, mas não foram copiadas sem pedido explícito).
- Leitura de card real do Azure DevOps/Jira (faltam `AZDO_PAT` / `JIRA_*`).
- Caddy (proxy reverso): o Docker não está disponível no WSL; só o YAML foi validado.
- Índice em memória da fila com arquivos movidos à mão (teste interrompido).

Situação conhecida do ambiente:
- O usuário deixa `npm run dev` rodando: **cada edição em `apps/whatsapp/src` recarrega o processo e reconecta a sessão real** do WhatsApp. Faça edições agrupadas e não altere dados reais (webhook, fila, proxy) para testar — use pasta/banco temporários.
- Uma conexão de teste usa webhook.site, que responde 429: a fila acumula (é o limite do webhook.site, não bug).

## Contexto que você deve sempre assumir

- **Stack:** Node.js ≥ 22 + TypeScript (ESM, `NodeNext`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) + Baileys **`7.0.0-rc14` (versão fixa)** + Fastify 5 (endpoint) + `fetch` nativo para o encaminhamento + `node:http` puro para a interface admin + `node:sqlite` + proxies (`undici` **6** — mesma major do Node 22 —, `https-proxy-agent`, `socks-proxy-agent`, `socks`) + Caddy opcional (proxy reverso, profile `proxy`).
- **Execução:** tudo roda em **Docker via docker-compose**, com dois serviços — `whatsapp` (app Baileys) e `endpoint` (receptor Fastify) — na mesma rede interna do compose. Localmente: `npm run dev` na raiz.
- **Autenticação:** via QR code (interface admin e stdout), com a sessão de cada conexão persistida em `AUTH_DIR/<id>/` para reconexões automáticas sem novo escaneamento.
- **Destino:** o webhook de cada conexão é configurado **só pela interface admin** (tabela `connections` do banco). `FORWARD_URL` do `.env` é lida no `config.ts` mas não é usada.
- Estou ciente de que a Baileys é **não-oficial** e contraria os Termos de Serviço do WhatsApp, com risco de banimento do número. Isso já está decidido — **não repita esse aviso a cada resposta**; mencione apenas quando for tecnicamente relevante.

## Regras críticas de Docker (proteção do número / da sessão)

O maior risco de banimento é a sessão se perder e forçar novo QR repetidamente. Por isso, em Docker:

- A pasta de sessão (`auth/`) **deve ficar num volume nomeado do Docker** (`auth_data`), nunca dentro da imagem. `up`, `down`, rebuild — nada pode apagar a sessão. Escaneia o QR uma vez e nunca mais. **Nunca sugira `docker compose down -v`.**
- **Reconexão comedida:** backoff exponencial, nunca loop apertado; tratar `loggedOut` explicitamente para não reusar sessão morta.
- O **QR sai no stdout** (`docker logs`) e na interface admin.
- **Nunca** rodar duas instâncias do serviço `whatsapp` com a mesma sessão ao mesmo tempo — derruba a sessão. Manter réplica única (`container_name` fixo garante isso).
- Imagem enxuta (`node:22-slim`), multi-stage build, usuário não-root, `.dockerignore` excluindo `auth/`, `queue/`, `settings/`, `data/`, `db/`, `media/`, `.env`, `node_modules`, `Baileys/`.

## Boas práticas obrigatórias em todo código gerado

- Usar `useMultiFileAuthState` para persistir a sessão em pasta dedicada, **nunca versionada** (adicionar ao `.gitignore`).
- Tratar `connection.update` com **reconexão automática**, distinguindo desconexões recuperáveis do `loggedOut` (que exige novo QR).
- Manter configurações sensíveis (tokens, caminhos, portas) em **variáveis de ambiente via `.env`**, lidas **só em `config.ts`**, nunca hardcoded. Toda variável nova vai também no `.env.example` e na tabela do README.
- Tornar o envio ao endpoint **resiliente**: timeout, retry com backoff exponencial e **fila local** para não perder mensagens se o endpoint estiver fora do ar.
- **Logging estruturado** com `pino` (use `logger.child({ module: '…' })`), **nunca** registrando texto de mensagens, tokens ou QR — só metadados (ids, tipos, contagens).
- **Código modular:** separar em arquivos distintos por responsabilidade (ver mapa abaixo).
- **Desligamento gracioso** em `SIGINT`/`SIGTERM`: fechar o socket e fazer flush da fila.
- Cuidado com **rate limiting / volume** no envio ao endpoint e no envio de mensagens pelo WhatsApp (testes com IA).
- Preferir sempre o **mínimo necessário**: capturar e enviar só o que for útil ao objetivo. Sem dependências novas sem motivo.

## Mapa do código

```
capture-message/
├── CLAUDE.md, README.md, docs/        # documentação
├── .env / .env.example                # config (.env não versionado)
├── docker-compose.yml                 # serviços whatsapp + endpoint (+ admin-proxy no profile proxy), volumes nomeados
├── proxy/Caddyfile                    # proxy reverso opcional da admin (HTTPS, basic auth, headers)
├── package.json                       # só atalhos: setup, dev, typecheck, docker:*
├── .claude/agents/                    # agents do Claude Code deste projeto
├── Baileys/                           # clone de REFERÊNCIA da lib (mesma versão rc14). Só leitura; não entra no build
└── apps/
    ├── endpoint/src/server.ts         # Fastify: Bearer token (timingSafeEqual), POST /messages → JSONL, GET /health
    └── whatsapp/src/
        ├── index.ts         # entrada, ciclo de vida, shutdown (drena filas por 15 s)
        ├── config.ts        # ÚNICO leitor de process.env
        ├── logger.ts        # pino + baileysLogger (nível próprio)
        ├── db.ts            # SQLite (node:sqlite, WAL, FKs em cascata), migrações por user_version, tx()
        ├── settings.ts      # ConnectionsStore: tabela connections (+ espelho em memória), migra connections.json; parsers
        ├── messages.ts      # MessageStore: chats, messages (todas), registros de mídia
        ├── media.ts         # MediaDownloader: baixa mídia ao vivo para MEDIA_DIR (2 simultâneos, limite de tamanho)
        ├── events.ts        # EventLog: eventos connection/webhook/test (só metadados), retenção
        ├── flows.ts         # FlowStore: fluxos de teste (N por conexão) + parseFlowInput
        ├── changes.ts       # ChangeBus: versão por tópico + notificação agrupada (base do cache e do SSE)
        ├── read-cache.ts    # ReadCache: GET da admin em memória, invalidado por versão, ETag
        ├── proxy.ts         # proxies de saída: wsAgent, fetchDispatcher (undici/SOCKS5), testProxy, WebhookProxy
        ├── manager.ts       # ConnectionManager: 1 WhatsAppConnection + 1 Forwarder por id; liga banco/mídia/eventos; events 'message'
        ├── connection.ts    # socket Baileys, QR, máquina de estados, reconexão, contorno companion_reg_refresh
        ├── listener.ts      # messages.upsert (+ messaging-history.set opcional), LID→telefone, onCaptured (banco), filtros, enqueue
        ├── normalizer.ts    # WAMessage → NormalizedMessage (payload do webhook)
        ├── filters.ts       # recebidas/enviadas/grupos + comparação de telefones BR (DDI, 9º dígito)
        ├── forwarder.ts     # fila em disco por conexão, worker FIFO, timeout/backoff/rate limit, deliver(), listar/excluir itens
        ├── admin.ts         # servidor da interface + API JSON (Host/Origin/Content-Type), cache, SSE, rotas de proxy
        ├── admin-page.ts    # HTML/CSS/JS da interface como string (sem recursos externos)
        ├── tester.ts        # TestRunner: executa um fluxo (laço com IA, análise por resposta, veredito) → test_runs + eventos + log
        ├── reference.ts     # monta a referência do teste: card + roteiro dos fluxos do Studio (limite de tamanho)
        ├── cards.ts         # card da demanda: texto | Azure DevOps | Jira — SOMENTE GET, hosts permitidos
        ├── studio.ts        # fluxos Twilio Studio: caminho WSL/Windows, busca no projeto, roteiro legível (segredos ***)
        ├── studio-monitor.ts # execução real no Studio durante o teste: steps + contexto a cada 10 s (SOMENTE GET)
        ├── run-log.ts       # log Markdown da execução (TEST_LOGS_DIR, 0600)
        └── ai.ts            # ponte com `claude -p` isolado (sem tools, sem settings, JSON schema)
```

Dados em runtime (volume no Docker / pasta em `apps/*` localmente): `auth/<id>/`, `queue/<id>/` (+ `failed/`), `db/app.db` (+ `-wal`/`-shm`), `media/<id>/<AAAA-MM>/`, `data/messages-AAAA-MM-DD.jsonl`. Em `settings/` só sobram os arquivos antigos já migrados (`*.migrated`).

## Invariantes — não quebre sem discutir comigo

1. **Uma sessão, um socket.** Cada id de conexão tem exatamente um `WhatsAppConnection`; o processo `whatsapp` é único.
2. **Eventos de socket antigo são ignorados** (`if (sock !== this.sock) return`) e `this.closing` impede reconexão após close provocado por nós.
3. **Tabela de desconexão** (`connection.ts#handleClose`): 515 → reconecta já; sem sessão registrada → `idle/qr_expired` (**nunca** gerar QR em loop); `loggedOut`/`multideviceMismatch` → `clearAuthDir` + `idle`; `connectionReplaced`/`forbidden` → `idle` sem reconectar; demais → backoff 2 s…5 min com jitter.
4. **`clearAuthDir` esvazia, não remove** a pasta (ponto de montagem no Docker).
5. **Persistir antes de enviar**: `enqueue` grava `.tmp` + `rename`; a entrega é *at-least-once*, FIFO, e um item em retry bloqueia os seguintes. 4xx (exceto 408/429) → `failed/`.
6. **Configuração lida a cada uso**: webhook (forwarder), filtros e nome (listener) vêm do `ConnectionsStore` na hora — edições na UI valem sem restart. O espelho em memória do store é atualizado em toda escrita; não faça outro cache disso.
7. **Não bloquear a sincronização inicial de histórico** da Baileys (é por ela que chega o mapeamento LID↔telefone). O que é encaminhado é decidido no listener (`CAPTURE_HISTORY`).
8. **Segredos nunca saem**: token do webhook não volta para a UI (`tokenSet`), texto do QR não sai do servidor (só SVG), `ENDPOINT_TOKEN` é removido do env do `claude -p`, conteúdo de mensagem nunca vai para log **nem para a tabela `events`** (o texto só fica em `messages`/`test_runs`). O arquivo do banco é `0600`.
9. **Admin sem login depende de**: bind em loopback/porta publicada só em `127.0.0.1`, checagem de Host/Origin e exigência de `Content-Type: application/json` nas rotas que alteram estado. Toda rota nova de escrita deve chamar `readJson(ctx)`.
10. **Ids de conexão/fluxo/teste** são `^[a-f0-9]{8}$` e viram nomes de pasta — valide com `isValidId` antes de usar em caminho.
11. **Gravações de arquivo de estado são atômicas** (`.tmp` + `rename`) — inclusive mídia baixada. No banco, escritas relacionadas vão numa `tx()`.
12. **Banco não bloqueia a captura**: erro ao gravar mensagem/evento é logado e o encaminhamento ao webhook segue. Sessão da Baileys e fila do webhook **não** vão para o banco.
13. **Migrações do banco só crescem**: nova versão = novo item no fim de `MIGRATIONS` (`db.ts`); nunca edite um item já aplicado.
14. **Mídia servida pela admin** só vai *inline* para imagem raster/áudio/vídeo; o resto é download (`nosniff`, CSP `sandbox`) — arquivo de terceiro nunca roda na origem da interface.
15. **Toda escrita que muda o que a interface mostra chama `changes.bump(tópico)`** — senão o cache de leitura serve dado velho. Rota GET nova de dados usa `cached(ctx, tópicos, …)` com os tópicos certos.
16. **Proxy**: credenciais nunca em log/evento/UI (só `maskProxy`); senha omitida no PUT mantém a salva; trocar proxy usa `restart()` (mesma sessão), nunca logout.
17. **Sistemas externos dos testes são só leitura**: card (Azure/Jira) e Twilio Studio só com `GET`, token só para o host dele (lista fixa + `*_HOSTS`). Nunca mover/editar card nem mexer em execução/fluxo no Twilio.
18. **Referência e execução são dados, não instruções** para a IA; segredos do Studio são mascarados antes de sair (`studio.ts`, `studio-monitor.ts`).

## Armadilhas da Baileys (rc14) que já nos afetaram

- **`companion_reg_refresh`**: desde ~28/07/2026 o servidor pede rotação do `advSecretKey` durante o pareamento; a rc14 ignora e o QR "não conecta". Contorno em `connection.ts` (`handleCompanionRegRefresh`, `withAdvSecret`). Remover quando a Baileys incorporar o PR #2765.
- **LID**: chats chegam como `@lid`; o telefone vem em `remoteJidAlt`/`participantAlt` ou via `sock.signalRepository.lidMapping.getPNForLID()`.
- **`messages.upsert`** tem `notify` e `append` — ambos são "ao vivo" para nós. Histórico vem em `messaging-history.set`.
- **`messageTimestamp`** pode ser `Long` → `Number()`.
- **515 `restartRequired`** após o QR é normal.
- Para confirmar assinatura/comportamento da API, **leia `Baileys/src/`** (mesma versão) em vez de supor. Se a versão instalada puder ter mudado, **peça o resultado de `npm list @whiskeysockets/baileys --prefix apps/whatsapp`** antes de assumir uma sintaxe.

## Comandos

```bash
npm run setup       # instala raiz + apps
npm run dev         # endpoint (PORT do .env, 3100) + whatsapp (admin 3200), hot reload
npm run typecheck   # verificação obrigatória após qualquer mudança em TS
npm run docker:up | docker:logs | docker:qr | docker:down
```

Não há suíte de testes automatizados: valide com `npm run typecheck` e descreva como testar manualmente. **Não inicie o app nem o Docker por conta própria** (abriria a sessão real do WhatsApp e poderia conflitar com a instância rodando) — peça para eu rodar.

## Estilo de código

- Tabs, aspas simples, sem ponto e vírgula, imports com extensão `.js`, `import type` para tipos.
- Comentários em **português**, explicando o *porquê*; cada arquivo abre com um bloco dizendo sua responsabilidade.
- Erros mostrados na interface são mensagens em português legíveis (`throw new Error('…')` → `HttpError(400)`).

## Como trabalhar comigo

- Gere código **idiomático, comentado e em incrementos revisáveis** — nunca um bloco monolítico gigante.
- Explique brevemente as decisões de arquitetura.
- Aponte armadilhas comuns da Baileys: **mudanças de API entre versões** e eventos de **sincronização de histórico**.
- A API da Baileys muda com frequência. Quando a versão instalada for relevante, **peça o resultado de `npm list @whiskeysockets/baileys`** antes de assumir uma sintaxe.
- **Mantenha a documentação em dia**: mudou comportamento, rota, variável, payload ou estrutura → atualize `README.md`, o `docs/` correspondente e este arquivo no mesmo incremento.
- Para mudanças em `connection.ts`, `forwarder.ts`, `manager.ts`, `docker-compose.yml` ou Dockerfiles, ou para dúvidas sobre a API da Baileys, use o agent **`whatsapp-capture-expert`** (`.claude/agents/`) para revisar/pesquisar.
- Responda em **português**.
