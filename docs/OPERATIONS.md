# Operação (runbook)

- [Regras de ouro](#regras-de-ouro)
- [Deploy e atualização](#deploy-e-atualização)
- [Backup e restauração da sessão](#backup-e-restauração-da-sessão)
- [Logs](#logs)
- [Proxies](#proxies)
- [Inspecionar a fila e o armazenamento](#inspecionar-a-fila-e-o-armazenamento)
- [Solução de problemas](#solução-de-problemas)
- [Atualizar a Baileys](#atualizar-a-baileys)

---

## Regras de ouro

1. **Escaneie o QR uma vez e nunca mais.** A sessão vive no volume `auth_data`; rebuild, `up`, `down` e restart não a apagam.
2. **Nunca** `docker compose down -v` nem `docker volume rm capture-message_auth_data`.
3. **Nunca** duas instâncias com a mesma sessão (não escale o serviço, não rode local e Docker apontando para a mesma pasta de auth, não copie `auth/` para outro lugar enquanto o original está rodando).
4. Se a interface mostrar "Esta sessão foi aberta em outro lugar" ou "O WhatsApp recusou a conexão (403)", não fique clicando em "Gerar QR code": descubra a causa antes.

---

## Deploy e atualização

```bash
# atualizar código e reconstruir (a sessão e a fila são preservadas)
npm run docker:up

# ver se subiu
docker compose ps
npm run docker:logs
```

O restart fecha os sockets e tenta drenar as filas por até 15 s; o que sobrar é enviado quando o serviço voltar.

Mudanças no `.env` exigem recriar o container: `docker compose up -d` (o compose detecta a mudança).

---

## Backup e restauração da sessão

Backup (com o serviço **parado**, para não copiar arquivos no meio da escrita):

```bash
docker compose stop whatsapp
docker run --rm -v capture-message_auth_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/auth-backup-$(date +%F).tgz -C /data .
docker compose start whatsapp
```

Faça o mesmo com `capture-message_db_data` (banco: cadastro/webhooks, fluxos, conversas, eventos) e `capture-message_media_data` (arquivos de mídia). Com o serviço parado o banco está consistente; com ele rodando, copie `app.db`, `app.db-wal` e `app.db-shm` juntos.

Restauração (em máquina nova; **desligue a instância antiga antes**):

```bash
docker volume create capture-message_auth_data
docker run --rm -v capture-message_auth_data:/data -v "$PWD":/backup alpine \
  sh -c 'tar xzf /backup/auth-backup-AAAA-MM-DD.tgz -C /data && chown -R 1000:1000 /data'
```

> O backup contém as chaves da sessão: quem tem o arquivo tem acesso à conta. Guarde com o mesmo cuidado de uma senha.

---

## Logs

JSON estruturado (pino). Campos úteis: `service` (`whatsapp`/`endpoint`), `module` (`connection`, `listener`, `forwarder`, `manager`, `admin`, `settings`, `tester`, `db`, `media`, `events`, `baileys`). Proxies aparecem só como `esquema://host:porta` (nunca com usuário/senha): `conectando via proxy`, `proxy da conexão alterado`, `entregas do webhook via proxy`, `connection` (id da conexão).

```bash
docker compose logs -f whatsapp | npx pino-pretty           # legível
docker compose logs whatsapp | grep '"module":"forwarder"'   # só envio
```

- `LOG_LEVEL=debug` mostra cada mensagem enfileirada (só metadados: id, tipo, fromMe).
- `BAILEYS_LOG_LEVEL=debug|trace` só para depurar protocolo — **muito** volume.
- O texto das mensagens **nunca** é logado.

Mensagens importantes:

| Log | Significado |
|---|---|
| `QR disponível na interface admin…` | Aguardando leitura do QR |
| `reinício solicitado pelo servidor (normal após o QR)` | Esperado logo após parear |
| `conectado` | Sessão aberta |
| `conexão caiu; reconectando` (`retryInMs`) | Queda recuperável, em backoff |
| `QR expirou sem leitura…` | Peça outro QR na interface |
| `sessão encerrada no celular; apagando credenciais` | Aparelho desconectado no celular → parear de novo |
| `outra instância abriu esta sessão` | Há outro processo com a mesma sessão |
| `endpoint indisponível, tentando novamente` | Webhook fora/erro 5xx; fila acumulando |
| `endpoint rejeitou a mensagem; movida para failed/` | Webhook respondeu 4xx |
| `servidor pediu novo segredo de pareamento; QR atualizado` | Contorno do `companion_reg_refresh` agindo (normal) |
| `ExperimentalWarning: SQLite is an experimental feature` | Aviso do Node ao carregar `node:sqlite`, na inicialização. Esperado. |
| `connections.json migrado para o banco` / `execuções de teste migradas para o banco` | Primeira execução após a atualização; os arquivos antigos viram `*.migrated` |
| `falha ao baixar mídia` | Download de mídia falhou (registro fica `failed` com o erro); a mensagem continua gravada e encaminhada |
| `falha ao gravar mensagem no banco` | Erro no SQLite; a mensagem **ainda assim** vai para o webhook |

---

## Proxies

### Proxy de saída do WhatsApp (por conexão)

Na interface, card da conexão → **Proxy de saída**: `socks5://host:porta` ou `http(s)://host:porta`, usuário e senha opcionais. **Testar** antes de salvar.

- Vale para o WebSocket e para upload/download de mídia. A resolução de DNS em SOCKS é feita pelo proxy.
- Salvar/remover com a conexão ativa **reconecta na hora pela mesma sessão** (sem QR). Com a conexão parada, vale no próximo "Gerar QR"/reconexão.
- Boas práticas: um proxy **estável** por número (residencial/IP fixo), no mesmo país do número. Trocar de IP com frequência e usar proxy de datacenter compartilhado aumentam o risco de restrição.
- Proxy caiu → a conexão entra em `reconnecting` com backoff, como numa queda de rede. Remova ou troque o proxy na interface.

### Proxy de saída do webhook (global)

`WEBHOOK_PROXY_URL=http://usuario:senha@proxy.corp:3128` no `.env` (reinicie o serviço). Hosts em `WEBHOOK_NO_PROXY` saem direto — por padrão o serviço `endpoint` do compose e o loopback. Só HTTP(S) (proxies corporativos); o "Enviar teste" também passa pelo proxy.

### Proxy reverso da interface admin

Só para acessar a interface fora deste computador. Caddy no profile `proxy` do compose (`proxy/Caddyfile`): HTTPS, login (basic auth bcrypt), limite de corpo, cabeçalhos de segurança, container `read_only` sem capabilities extras.

```bash
docker run --rm caddy:2.10-alpine caddy hash-password --plaintext 'sua-senha'
# .env:
#   ADMIN_PROXY_USER=admin
#   ADMIN_PROXY_PASSWORD_HASH='$2a$14$...'   # aspas simples (o hash tem "$")
#   ADMIN_PROXY_BIND=0.0.0.0                 # rede local; padrão 127.0.0.1
docker compose --profile proxy up -d
docker compose --profile proxy logs -f admin-proxy

# validar o Caddyfile sem subir nada
docker run --rm -v "$PWD/proxy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -e ADMIN_PROXY_USER=x -e ADMIN_PROXY_PASSWORD_HASH="$(docker run --rm caddy:2.10-alpine caddy hash-password --plaintext teste)" \
  caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

- **Certificado**: com `ADMIN_PROXY_SITE=localhost` (ou IP) o Caddy usa a própria CA local e o navegador avisa até você confiar nela: copie `docker compose cp admin-proxy:/data/caddy/pki/authorities/local/root.crt .` e importe como autoridade confiável. Com um **domínio real** apontando para esta máquina (portas 80/443 públicas), o certificado vem do Let's Encrypt — ajuste `ADMIN_PROXY_SITE=admin.seudominio.com`, publique `443:443` e **adicione o domínio em `ADMIN_ALLOWED_HOSTS`** (senão a admin responde 403).
- Sem `ADMIN_PROXY_USER`/`ADMIN_PROXY_PASSWORD_HASH` nenhum login é aceito (falha fechada).
- A porta `3200` continua publicada só em `127.0.0.1`: o proxy não substitui essa proteção, soma a ela.

---

## Inspecionar a fila e o armazenamento

```bash
# contagem por conexão
docker compose exec whatsapp sh -c 'for d in /app/queue/*/; do echo "$d $(ls $d*.json 2>/dev/null | wc -l) pend, $(ls ${d}failed/*.json 2>/dev/null | wc -l) failed"; done'

# ver um item que falhou
docker compose exec whatsapp sh -c 'cat /app/queue/<id>/failed/*.json | head -c 2000'

# excluir itens: pela interface (card > Mensagens na fila), ou à mão:
# reprocessar os que falharam (depois de corrigir o webhook)
docker compose exec whatsapp sh -c 'mv /app/queue/<id>/failed/*.json /app/queue/<id>/'

# mensagens gravadas pelo endpoint
docker compose exec endpoint sh -c 'tail -n 5 /app/data/messages-$(date -u +%F).jsonl'
```

Banco SQLite (a imagem não tem o CLI `sqlite3`; use o próprio Node, em modo somente leitura):

```bash
docker compose exec whatsapp node -e "
const d = new (require('node:sqlite').DatabaseSync)('/app/db/app.db', { readOnly: true })
console.table(d.prepare('SELECT kind, type, COUNT(*) n FROM events GROUP BY 1, 2').all())
console.table(d.prepare('SELECT connection_id, COUNT(*) n FROM messages GROUP BY 1').all())
console.table(d.prepare('SELECT status, COUNT(*) n FROM media GROUP BY 1').all())"
```

Localmente dá para abrir `apps/whatsapp/db/app.db` em qualquer cliente SQLite (DB Browser, `sqlite3`, extensão do VS Code). Ou use as rotas de leitura da interface admin (`/api/connections/:id/chats`, `/messages`, `/events`, `/api/media/:id` — ver [API.md](API.md)).

Localmente os mesmos caminhos ficam em `apps/whatsapp/queue/<id>/` e `apps/endpoint/data/`.

---

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Celular lê o QR mas não conecta | Servidor pediu rotação do segredo (`companion_reg_refresh`) | Já tratado no `connection.ts`; confira se o log "QR atualizado" aparece e escaneie o QR **novo** exibido |
| "O QR code expirou antes de ser lido." | Ninguém escaneou a tempo (~1 min) | Clique em "Gerar novo QR" |
| "Desconectado. Gere um novo QR…" | Aparelho removido no celular (`loggedOut`) ou botão Desconectar | "Gerar QR code" e parear de novo (a sessão antiga já foi apagada) |
| "Esta sessão foi aberta em outro lugar…" | Outra instância usa a mesma sessão (`connectionReplaced`) | Encontre e pare a outra (`docker ps`, `npm run dev` esquecido, outra máquina) |
| "O WhatsApp recusou a conexão (403)…" | Conta restrita pelo WhatsApp | Verifique o número no celular; não force reconexões |
| Fila só cresce, "endpoint indisponível" | Webhook fora do ar, URL errada, DNS | Use "Enviar teste" na interface; no Docker o endpoint interno é `http://endpoint:3000/messages`, não `localhost` |
| Mensagens indo para `failed/` | Webhook responde 4xx (ex.: 401 token errado, 400 schema) | Corrija o token/URL e reprocesse (ver acima) |
| Nada chega e não há erro | Filtros descartando ou webhook não configurado (mensagens aguardando na fila) | Confira a seção Filtros e o card Fila; `LOG_LEVEL=debug` mostra `filtered` |
| Filtro por telefone não casa em alguns chats | Chat `@lid` sem mapeamento para telefone ainda | Normalmente resolve após a sincronização inicial; mensagens em grupo enviadas por você são descartadas se `sent.phones` não estiver vazio (por design) |
| `ETIMEDOUT` no envio no WSL com destino no ar | Happy Eyeballs com IPv6 quebrado | Já mitigado em `index.ts` (2 s por família); se persistir, use o IP/host IPv4 |
| Aba "Testes com IA": "Claude CLI não encontrado" | CLI ausente (sempre no Docker) | Rode localmente com `claude` instalado e logado, ou ajuste `TESTER_CLAUDE_BIN` |
| Teste com IA `inconclusive` | IA não devolveu veredito completo em 3 tentativas | Veja a transcrição e rode de novo; regras mais objetivas ajudam |
| Endpoint sai na inicialização | `ENDPOINT_TOKEN` vazio | Preencha no `.env` |
| Conexão fica em "Reconectando" logo após salvar um proxy | Proxy fora do ar, credencial errada ou bloqueando o WhatsApp | Use **Testar** no card; remova o proxy para voltar a sair direto |
| "o proxy recusou a autenticação (407)" | Usuário/senha do proxy HTTP errados | Corrija no card e teste de novo |
| Interface pelo proxy reverso responde 403 "acesso permitido só via localhost" | Domínio não está em `ADMIN_ALLOWED_HOSTS` | Adicione e reinicie o `whatsapp` |
| Interface não atualiza sozinha / aviso "Sem contato com o app" | App reiniciando, ou SSE bloqueado por proxy/antivírus | O navegador reconecta sozinho; confira `/api/stream` no DevTools (aba Rede) e recarregue a página |
| "Configure AZDO_PAT…" / "JIRA_EMAIL e JIRA_API_TOKEN…" | Token do card ausente | Preencha no `.env` (escopo só de leitura) e reinicie |
| "Token recusado (a API devolveu a página de login)" | PAT do Azure inválido/expirado | Gere outro com "Work Items: Read" |
| "Host … não permitido" | Link de card fora de dev.azure.com / *.visualstudio.com / *.atlassian.net | Use o link oficial ou adicione o host em `AZDO_HOSTS`/`JIRA_HOSTS` |
| "Pasta não encontrada: /mnt/c/…" | Caminho do Windows com o app fora do WSL (ex.: Docker) ou disco não montado | Rode o app no WSL, ou escolha "WSL/Linux" com o caminho Linux |
| "A referência ficou com … KB" | Fluxos demais (subfluxos incluídos) | Marque menos fluxos ou desmarque "incluir subfluxos"; ou aumente `TESTER_REFERENCE_MAX_KB` |
| "Não consegui ler a execução no Twilio: …" na conversa | API Key do ambiente errada, fluxo inexistente naquela conta, ou 429 | Confira `TWILIO_<ENV>_API_KEY_SID/SECRET` e o ambiente escolhido; o teste segue sem os passos |
| Execução acompanhada sem passos | O número que testa não disparou o fluxo marcado (outro fluxo recebe a mensagem) | Marque o fluxo de entrada do canal (ex.: `Whatsapp_Relacionamento`) |
| `EACCES` ao gravar em `/app/auth` | Volume criado com dono errado (ex.: restaurado como root) | `docker run --rm -v capture-message_auth_data:/d alpine chown -R 1000:1000 /d` |

---

## Atualizar a Baileys

A versão está **fixa** em `apps/whatsapp/package.json` (`7.0.0-rc14`). Antes de trocar:

1. `npm list @whiskeysockets/baileys --prefix apps/whatsapp` e leia o `CHANGELOG` da nova versão.
2. Verifique se o PR #2765 (`companion_reg_refresh`) foi incorporado — se sim, remova o contorno em `connection.ts` (`handleCompanionRegRefresh`, `withAdvSecret`, `lastQr`).
3. Revise: `DisconnectReason`, campos `remoteJidAlt`/`participantAlt`, `signalRepository.lidMapping.getPNForLID`, `normalizeMessageContent`, `getContentType`, `fetchLatestBaileysVersion`, `useMultiFileAuthState`.
4. `npm run typecheck`, teste **localmente com um número secundário** antes de subir no Docker com a sessão principal.
5. Atualize também o clone de referência `Baileys/` (`git -C Baileys checkout <tag>`) e as menções à versão em `CLAUDE.md` e `docs/`.
