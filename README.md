# capture-message

Captura as mensagens de uma ou mais contas de WhatsApp (via **Baileys**, protocolo do WhatsApp Web multi-device) e encaminha cada uma, em tempo real, para um **webhook HTTP** configurável por conta.

Inclui:

- **Serviço `whatsapp`** — mantém as conexões, normaliza as mensagens, aplica filtros e envia ao webhook com fila em disco, retry e backoff. Tem uma **interface admin** web (`http://localhost:3200`) para parear números por QR, configurar webhook/filtros e rodar **testes de fluxo com IA**.
- **Serviço `endpoint`** — receptor Fastify de exemplo que valida um token e grava cada mensagem em arquivos JSONL.

> Uso pessoal, na própria conta. A Baileys é não-oficial e contraria os Termos de Serviço do WhatsApp (risco de banimento do número) — por isso o projeto é conservador com reconexões e com a sessão.

---

## Sumário

- [Como funciona (visão rápida)](#como-funciona-visão-rápida)
- [Pré-requisitos](#pré-requisitos)
- [Início rápido com Docker](#início-rápido-com-docker)
- [Execução local (desenvolvimento)](#execução-local-desenvolvimento)
- [Usando a interface admin](#usando-a-interface-admin)
- [Formato da mensagem enviada ao webhook](#formato-da-mensagem-enviada-ao-webhook)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Onde ficam os dados](#onde-ficam-os-dados)
- [Documentação detalhada](#documentação-detalhada)

---

## Como funciona (visão rápida)

```
 Celular(es)                 serviço whatsapp (1 processo, N conexões)                      destino
┌──────────┐  WebSocket   ┌───────────────────────────────────────────────────────┐
│ WhatsApp │◄────────────►│ connection.ts ─► listener.ts ─► normalizer.ts          │
└──────────┘   (Baileys)  │                        │            │                  │
                          │                        ▼            ▼                  │   HTTP (POST/GET/OPTIONS)
                          │                   filters.ts ─► forwarder.ts ──────────┼──► webhook da conexão
                          │                                  (fila em disco)       │    (ex.: serviço endpoint)
                          │        │ (toda mensagem)                               │
                          │        ▼                                               │
                          │  messages.ts / media.ts ─► SQLite (db/app.db) + media/ │
                          │  events.ts (estado, entregas, testes) ─► SQLite        │
                          │  admin.ts  ◄── navegador http://localhost:3200         │
                          │  tester.ts ─► ai.ts ─► `claude -p` (testes com IA)     │
                          └───────────────────────────────────────────────────────┘
```

1. Cada **conexão** é um número de WhatsApp pareado por QR. A sessão fica salva em disco e reconecta sozinha.
2. Toda mensagem nova (`messages.upsert`) é **normalizada** num JSON enxuto e **gravada no banco SQLite** (conversa + mensagem). Se tiver mídia, o arquivo é **baixado** para `media/` e os metadados vão para o banco.
3. Os **filtros** da conexão decidem se ela é encaminhada ao webhook (enviadas/recebidas, lista de telefones, grupos). O banco guarda todas, filtradas ou não.
4. A mensagem aprovada é **gravada na fila em disco** e um worker a envia ao **webhook** da conexão, com timeout, retry exponencial e limite de taxa. Nada se perde se o destino estiver fora do ar.
5. **Eventos** vão para o banco: mudanças de estado da conexão, cada tentativa de entrega ao webhook e cada passo dos testes com IA.
6. **Proxies de saída** (opcionais): cada conexão pode sair por um proxy próprio (http/https/socks5), e as entregas ao webhook por um proxy corporativo (`WEBHOOK_PROXY_URL`).
7. A interface é atualizada por **push (SSE)**, e as leituras da API saem de um **cache em memória** invalidado por versão (com ETag/304): sem polling nem consultas repetidas ao banco.

Detalhes em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Pré-requisitos

- **Docker** + **Docker Compose v2** (modo recomendado), ou
- **Node.js ≥ 22** (execução local).
- Opcional, para a aba *Testes com IA*: **Claude Code CLI** (`claude`) instalado e logado na máquina (só funciona na execução local — a imagem Docker não inclui o CLI).

---

## Início rápido com Docker

```bash
# 1. Configure o ambiente
cp .env.example .env
# gere um token e cole em ENDPOINT_TOKEN
openssl rand -hex 32

# 2. Suba os dois serviços
npm run docker:up          # = docker compose up -d --build

# 3. Abra a interface admin
#    http://localhost:3200
```

Na interface:

1. **+ Nova conexão** → dê um nome → **Criar e gerar QR** → escaneie o QR no celular (*WhatsApp > Aparelhos conectados > Conectar um aparelho*). O QR também aparece em `npm run docker:qr`.
2. No card da conexão, em **Webhook**, informe o destino. Para usar o serviço `endpoint` incluído:
   - URL: `http://endpoint:3000/messages`
   - Método: `POST`
   - Token: o mesmo valor de `ENDPOINT_TOKEN` do `.env`
3. Clique **Enviar teste** para validar e depois **Salvar webhook**.

As mensagens passam a ser gravadas pelo endpoint no volume `endpoint_data` (`/app/data/messages-AAAA-MM-DD.jsonl`).

> ⚠️ **Nunca** rode `docker compose down -v`: o `-v` apaga os volumes, **inclusive a sessão do WhatsApp**, obrigando a parear de novo. Use `npm run docker:down` (sem `-v`).

### Acesso fora deste computador (opcional)

A interface não tem login e só escuta em `127.0.0.1`. Para abri-la na rede local ou por um domínio, suba o **proxy reverso** (Caddy, com HTTPS e login):

```bash
# 1. gere o hash da senha e ponha no .env (entre aspas simples)
docker run --rm caddy:2.10-alpine caddy hash-password --plaintext 'sua-senha'
#    ADMIN_PROXY_USER=admin
#    ADMIN_PROXY_PASSWORD_HASH='$2a$14$...'
#    ADMIN_PROXY_BIND=0.0.0.0          # só se for acessar pela rede local
# 2. suba com o profile
docker compose --profile proxy up -d
# 3. abra https://localhost:8443 (ou https://<ip-desta-máquina>:8443)
```

Detalhes (certificado, domínio próprio): [docs/OPERATIONS.md](docs/OPERATIONS.md#proxy-reverso-da-interface-admin).

Comandos úteis:

| Comando | O que faz |
|---|---|
| `npm run docker:up` | Build + sobe em segundo plano |
| `npm run docker:logs` | Logs dos dois serviços |
| `npm run docker:qr` | Logs do `whatsapp` (onde o QR aparece em ASCII) |
| `npm run docker:down` | Para e remove os containers (volumes preservados) |

---

## Execução local (desenvolvimento)

```bash
cp .env.example .env        # preencha ENDPOINT_TOKEN
npm run setup               # instala dependências da raiz e dos dois apps
npm run dev                 # endpoint (porta PORT=3100) + whatsapp (admin em 3200), com hot reload
npm run typecheck           # checagem de tipos dos dois apps
```

No modo local o webhook do serviço `endpoint` é `http://localhost:3100/messages`.

Os dados locais ficam em `apps/whatsapp/{auth,queue,db,media,settings}` e `apps/endpoint/data` (todos ignorados pelo git).
A sessão local é **diferente** da sessão do Docker (são pastas diferentes) — cada uma aparece como um aparelho conectado separado.

---

## Usando a interface admin

A interface (`http://localhost:3200`) tem duas abas. Ela só aceita acesso via `localhost` (não há login).

### Aba "Conexões"

Cada card representa um número:

| Seção | O que faz |
|---|---|
| **Status** | `Conectando…`, `Aguardando leitura` (QR na tela), `Conectado` (nome e telefone), `Reconectando` (horário e nº da próxima tentativa) ou `Desconectado` (com o motivo: nunca conectado, QR expirou, desconectado no celular, sessão aberta em outro lugar, recusado pelo WhatsApp/403). Botões *Gerar QR code / Gerar novo QR*, *Cancelar QR*, *Cancelar*, *Desconectar*. |
| **Nome** | Nome amigável; vai em cada mensagem no campo `instance`. |
| **Filtros** | *Recebidas* (liga/desliga + lista de telefones de quem enviou), *Enviadas* (liga/desliga + lista de telefones de quem recebeu) e *Grupos*. Lista vazia = todos. Telefones aceitam qualquer formato; sem DDI assume Brasil (55), e o 9º dígito é tolerado. |
| **Webhook** | URL, método (`POST`, `GET` ou `OPTIONS`) e token (vai como `Authorization: Bearer <token>`; o token nunca volta para a página). *Enviar teste* manda uma mensagem de exemplo com `"test": true`. |
| **Proxy de saída** | Proxy `http://`, `https://` ou `socks5://` (host:porta) + usuário/senha opcionais, por onde o WhatsApp desta conexão sai (WebSocket e mídia). *Testar* abre HTTPS até o WhatsApp Web pelo proxy, sem salvar. Salvar/remover com a conexão ativa **reconecta na hora pela mesma sessão** (sem QR). A senha nunca volta para a página. |
| **Mensagens na fila** | Lista as mensagens **pendentes** (aguardando envio ao webhook) e **rejeitadas** (webhook respondeu 4xx), com remetente/destinatário, prévia do texto e horários, 50 por página. Marque uma a uma ou a página inteira e **Excluir selecionadas**, ou **Excluir tudo**. Excluir tira da fila sem enviar (não dá para desfazer); a mensagem continua no banco. Excluir a pendente que está travando a fila faz o envio seguir na hora. |
| **Fila** | Pendentes, falhas definitivas (`failed/`), último erro e último sucesso. |
| **Excluir** | Desconecta o aparelho, apaga sessão, fila e mídia e remove o cadastro — com ele, do banco, os fluxos, execuções, conversas e eventos da conexão. |

O webhook **não é obrigatório**. Sem ele, **nada é enviado nem enfileirado**: as mensagens ficam só no banco. Para remover, use *Remover webhook* ou apague a URL e salve. A tela pergunta se as mensagens que já estavam pendentes na fila devem ser excluídas; se forem mantidas, elas são enviadas quando um webhook for salvo de novo.

A interface se atualiza **em tempo real por push (SSE)**: ao abrir, recebe o estado de todas as conexões, e depois só a conexão que mudou, já pronta. A página não faz requisições periódicas.

### Aba "Testes com IA"

Testa fluxos de atendimento/bot pelo WhatsApp: uma conexão sua conversa com o número sob teste, com o Claude fazendo o papel de cliente, e no fim dá um veredito regra a regra.

Organização: **conexão → fluxos → execuções**. Escolha a conexão (número que envia) e crie quantos **fluxos** quiser para ela. Cada fluxo tem nome, telefone que recebe, **tarefa** (cenário) e **regras de negócio** (uma por linha), além de opções: máximo de mensagens (1–30, padrão 8), espera pela resposta (10–600 s, padrão 60) e silêncio que encerra uma rajada de respostas (2–60 s, padrão 6).

- **Executar** roda o fluxo (a conexão precisa estar conectada; uma execução por conexão por vez).
- Clicar num fluxo filtra a lista de **execuções** só dele; cada execução guarda a conversa e o veredito.
- Editar um fluxo não altera execuções antigas (cada uma guarda a cópia do cenário com que rodou). Excluir um fluxo apaga as execuções dele.

**Referência para a IA comparar** (opcional, no formulário do fluxo). Com ela, a tarefa pode ficar vazia: a IA monta o cenário a partir da demanda.

- **Demanda (card):** colar o texto ou anexar `.txt`/`.md`, ou colar o **link** do card do **Azure DevOps** ou do **Jira**. É **somente leitura** (só `GET` na API; nada no card é alterado). "Ler card" mostra o que foi lido. Anexos de texto do card entram na referência; anexos `.json` do Studio viram fluxos.
- **Fluxo desenvolvido (Twilio Studio):** informe o **caminho do projeto** e **onde ele está (WSL/Linux ou Windows)**. `C:\...` vira `/mnt/c/...`, e `\\wsl.localhost\...` também é aceito. *Procurar fluxos* acha os `studioFlows.json` (dev/qa/prod) e os exports. Outra opção é **anexar o JSON exportado**. Depois marque os fluxos; os subfluxos chamados podem entrar junto. O fluxo é relido a cada execução, então vale sempre a versão atual.
- **Acompanhar a execução real no Twilio (dev/qa/prod):** enquanto o Studio envia e espera a resposta, o teste lê a cada 10 s (`TESTER_STUDIO_POLL_MS`) a **execução do seu número**. Ela traz os widgets percorridos, o evento de cada transição e as saídas de decisões, funções, HTTP e transferência para o Flex. Os passos aparecem na conversa ao vivo e vão para a IA, que julga o **caminho real**, inclusive o que não aparece no WhatsApp. Somente leitura, com a API Key do ambiente no `.env`.
- **Ver o que a IA vai receber** mostra o tamanho e a prévia da referência (limite `TESTER_REFERENCE_MAX_KB`).

A cada resposta do bot, a IA registra uma **análise** (conforme / parcial / divergente, com o widget esperado). No veredito saem as **divergências em relação ao fluxo** (esperado × recebido, com severidade) e os **requisitos da demanda** (cumprido / violado / não verificado, com evidência).

**Log da execução:** tudo fica no banco e num arquivo Markdown em `TEST_LOGS_DIR` (`AAAA-MM-DD_<fluxo>_<id>.md`). O arquivo traz a conversa, as análises, os passos da IA com custo, a execução no Studio, o veredito e a referência exata enviada. O botão **Baixar log** baixa o mesmo conteúdo.

Requer o Claude Code CLI local (`TESTER_CLAUDE_BIN`). No Docker a aba mostra o erro e o resto do sistema funciona normalmente. Detalhes em [docs/ARCHITECTURE.md#testes-com-ia](docs/ARCHITECTURE.md#testes-com-ia).

> Esses testes **enviam mensagens de verdade** a partir da sua conta.

---

## Formato da mensagem enviada ao webhook

```json
{
  "id": "3EB0C5A1F2D4E6B8A9C1",
  "chatId": "5511988887777@s.whatsapp.net",
  "chatIdAlt": "123456789012345@lid",
  "isGroup": false,
  "fromMe": false,
  "senderId": "5511988887777@s.whatsapp.net",
  "senderIdAlt": "123456789012345@lid",
  "pushName": "Maria",
  "timestamp": 1790000000,
  "type": "conversation",
  "text": "Olá!",
  "media": null,
  "quotedId": null,
  "source": "live",
  "instance": "Meu número"
}
```

Com `POST`/`OPTIONS` vai como JSON no corpo; com `GET`, cada campo vira parâmetro da query string. O webhook deve responder `2xx`. **Reentregas são possíveis** (ex.: timeout depois de o destino já ter gravado) — deduplique pelo `id`.

Referência completa dos campos e códigos de resposta: [docs/API.md](docs/API.md).

---

## Variáveis de ambiente

Definidas no `.env` (modelo em [`.env.example`](.env.example)). No Docker, o bloco `environment:` do `docker-compose.yml` sobrescreve caminhos, portas e hosts.

| Variável | Serviço | Padrão | Descrição |
|---|---|---|---|
| `ENDPOINT_TOKEN` | endpoint | — (obrigatória) | Token que o endpoint exige em `Authorization: Bearer`. |
| `PORT` / `HOST` | endpoint | `3000` / `127.0.0.1` | Porta/interface do endpoint (compose: `3000`/`0.0.0.0`). |
| `DATA_DIR` | endpoint | `./data` | Onde os `.jsonl` são gravados. |
| `ADMIN_PORT` / `ADMIN_HOST` | whatsapp | `3200` / `127.0.0.1` | Interface admin. |
| `AUTH_DIR` / `QUEUE_DIR` | whatsapp | `./auth` `./queue` | Sessões e filas do webhook. |
| `SETTINGS_DIR` | whatsapp | `./settings` | Só para migrar os arquivos da versão anterior (`connections.json`, `test-runs/`) para o banco. |
| `DB_PATH` | whatsapp | `./db/app.db` | Banco SQLite (conexões, fluxos, execuções, conversas, mídia, eventos). |
| `EVENTS_RETENTION_DAYS` | whatsapp | `90` | Eventos mais antigos são apagados (1×/dia). `0` = nunca. Mensagens não expiram. |
| `MEDIA_DIR` | whatsapp | `./media` | Arquivos de mídia baixados. |
| `MEDIA_DOWNLOAD` | whatsapp | `true` | `false` = guarda só os metadados da mídia. |
| `MEDIA_MAX_MB` | whatsapp | `50` | Mídia maior que isso não é baixada. |
| `FORWARD_TIMEOUT_MS` | whatsapp | `10000` | Timeout de cada envio. |
| `FORWARD_BACKOFF_BASE_MS` / `FORWARD_BACKOFF_MAX_MS` | whatsapp | `1000` / `300000` | Backoff exponencial do envio. |
| `FORWARD_MIN_INTERVAL_MS` | whatsapp | `100` | Intervalo mínimo entre envios (limite de taxa, por conexão). |
| `MAX_CONNECTIONS` | whatsapp | `10` | Máximo de números cadastrados. |
| `CAPTURE_FROM_ME` / `CAPTURE_GROUPS` | whatsapp | `true` / `true` | Filtro **padrão** de conexões novas (cada uma edita os seus na interface). |
| `CAPTURE_HISTORY` | whatsapp | `false` | Pede e encaminha o histórico antigo na 1ª conexão (volume alto). |
| `TESTER_CLAUDE_BIN` / `TESTER_MODEL` / `TESTER_AI_TIMEOUT_MS` | whatsapp | `claude` / `sonnet` / `120000` | Testes com IA. |
| `TEST_LOGS_DIR` | whatsapp | `./test-logs` | Logs Markdown das execuções de teste. |
| `TESTER_REFERENCE_MAX_KB` | whatsapp | `400` | Tamanho máximo da referência (card + roteiro dos fluxos) enviada à IA. |
| `STUDIO_ALLOWED_ROOTS` | whatsapp | — | Se preenchido, o projeto Twilio informado precisa estar dentro destas pastas. |
| `AZDO_PAT` / `AZDO_HOSTS` | whatsapp | — | Leitura de cards do Azure DevOps (PAT "Work Items: Read"). |
| `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_HOSTS` | whatsapp | — | Leitura de issues do Jira. |
| `TWILIO_<DEV\|QA\|PROD>_API_KEY_SID` / `_API_KEY_SECRET` (ou `_ACCOUNT_SID` + `_AUTH_TOKEN`) | whatsapp | — | Leitura da execução no Twilio Studio, por ambiente. |
| `TESTER_STUDIO_POLL_MS` | whatsapp | `10000` | Intervalo de leitura da execução durante o teste. |
| `WEBHOOK_PROXY_URL` | whatsapp | — | Proxy HTTP(S) de saída das entregas ao webhook (aceita `usuário:senha@`). Vazio = direto. |
| `WEBHOOK_NO_PROXY` | whatsapp | `localhost,127.0.0.1,::1,endpoint` | Hosts que saem direto mesmo com proxy (`.dominio` pega subdomínios). |
| `ADMIN_ALLOWED_HOSTS` | whatsapp | — | Domínios extras aceitos pela admin (proxy reverso com domínio próprio). |
| `ADMIN_PROXY_SITE` / `ADMIN_PROXY_BIND` / `ADMIN_PROXY_PORT` | admin-proxy | `localhost` / `127.0.0.1` / `8443` | Proxy reverso Caddy (profile `proxy`): site, interface e porta publicadas. |
| `ADMIN_PROXY_USER` / `ADMIN_PROXY_PASSWORD_HASH` | admin-proxy | — | Login do proxy reverso (hash bcrypt, entre aspas simples). Sem eles, nenhum login é aceito. |
| `LOG_LEVEL` | ambos | `info` | Nível do pino. |
| `BAILEYS_LOG_LEVEL` | whatsapp | `warn` | Nível dos logs internos da Baileys (muito verbosos abaixo de `warn`). |

> `FORWARD_URL` existe no `config.ts` mas **não é usada**: o destino de cada conexão é configurado só pela interface admin.

---

## Onde ficam os dados

| Dado | Local (dev) | Docker (volume) | Sensível? |
|---|---|---|---|
| Sessão Baileys de cada conexão | `apps/whatsapp/auth/<id>/` | `auth_data` → `/app/auth/<id>/` | **Sim** — dá acesso à conta |
| Fila de envio | `apps/whatsapp/queue/<id>/` (+ `failed/`) | `queue_data` → `/app/queue/<id>/` | Sim (conteúdo das mensagens) |
| Banco: conexões (webhooks, tokens, filtros), fluxos, execuções de teste, conversas, mensagens, metadados de mídia, eventos | `apps/whatsapp/db/app.db` (+ `-wal`, `-shm`) | `db_data` → `/app/db/` | **Sim** (tokens e conteúdo; arquivo `0600`) |
| Arquivos de mídia | `apps/whatsapp/media/<id>/<AAAA-MM>/` | `media_data` → `/app/media/` | Sim |
| Logs das execuções de teste com IA | `apps/whatsapp/test-logs/*.md` (`0600`) | — (testes só rodam localmente) | Sim (conversa completa) |
| Proxy de cada conexão (com usuário/senha) | no banco, tabela `connections` | `db_data` | **Sim** |
| Certificados do proxy reverso (CA local / Let's Encrypt) | — | `caddy_data`, `caddy_config` | Sim (chave privada da CA local) |
| Arquivos da versão anterior, já migrados (`connections.json.migrated`, `test-runs.migrated/`) | `apps/whatsapp/settings/` | `settings_data` → `/app/settings/` | Sim — pode apagar depois de conferir |
| Mensagens recebidas pelo endpoint | `apps/endpoint/data/messages-AAAA-MM-DD.jsonl` | `endpoint_data` → `/app/data/` | Sim |

Nada disso vai para a imagem Docker nem para o git (`.dockerignore` / `.gitignore`).

---

## Documentação detalhada

| Documento | Conteúdo |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Módulos, ciclo de vida, máquina de estados da conexão, fila, filtros, testes com IA, decisões de design e armadilhas da Baileys |
| [docs/API.md](docs/API.md) | Payload enviado ao webhook, API do endpoint, API JSON da interface admin |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Runbook: deploy, backup/restauração da sessão, logs, solução de problemas |
| [CLAUDE.md](CLAUDE.md) | Regras e contexto para assistentes de IA (Claude Code) |
