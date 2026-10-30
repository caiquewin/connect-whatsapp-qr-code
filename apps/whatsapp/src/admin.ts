// Interface admin: página para gerenciar as conexões de WhatsApp + API JSON.
//
//   GET    /                                   página HTML
//   GET    /api/connections                    lista (estado, QR em SVG, webhook, fila)
//   POST   /api/connections                    cria { friendlyName } e já gera o QR
//   DELETE /api/connections/:id                desconecta e exclui (sessão + fila)
//   POST   /api/connections/:id/connect        gera novo QR / reconecta
//   POST   /api/connections/:id/cancel         descarta o QR pendente
//   POST   /api/connections/:id/logout         desconecta o aparelho (mantém o cadastro)
//   PUT    /api/connections/:id/name           { friendlyName }
//   PUT    /api/connections/:id/webhook        { url, method, token? }  (url vazia = remove e para de
//                                              enfileirar; + discardPending: true exclui as pendentes;
//                                              token omitido = mantém)
//   PUT    /api/connections/:id/filters        { received: {enabled, phones[]}, sent: {...}, groups }
//   PUT    /api/connections/:id/proxy          { url, username?, password? } proxy de saída do WhatsApp
//                                              (url vazia = remove; password omitido = mantém). Reconecta.
//   POST   /api/connections/:id/proxytest      { url, username?, password? } testa sem salvar
//   POST   /api/connections/:id/test           envia mensagem de exemplo ao webhook informado
//   GET    /api/connections/:id/queue          itens da fila do webhook (?kind=pending|failed, ?offset, ?limit)
//   DELETE /api/connections/:id/queue          exclui sem enviar { kind, files: [...] } ou { kind, all: true }
//
//   GET    /api/stream                         SSE: "snapshot" (todas as conexões) ao abrir,
//                                              "connection" (uma conexão que mudou, completa),
//                                              "connection-removed" { id }, e "change" com os
//                                              outros tópicos alterados (tests, messages, events)
//
//   POST   /api/birthdays/run                  verifica e envia os parabéns de hoje agora (fora da janela
//                                              BIRTHDAY_HOURS; teto diário e "não repetir" continuam valendo)
//
//   Dados gravados no banco (só leitura):
//   GET    /api/connections/:id/chats          conversas (?limit, ?before=epoch s)
//   GET    /api/connections/:id/messages       mensagens de uma conversa (?chat=<jid>, ?limit, ?before=epoch s)
//   GET    /api/connections/:id/events         eventos da conexão (?kind, ?ref, ?limit, ?before=id)
//   GET    /api/events                         eventos de todas as conexões (mesmos filtros)
//   GET    /api/media/:mediaId                 arquivo de mídia baixado
//
//   Fluxos de teste com IA (cada conexão tem vários):
//   GET    /api/flows                          lista (?connectionId), com última execução
//   POST   /api/flows                          cria { connectionId, name, to, task, rules[],
//                                              maxTurns?, replyTimeoutSec?, quietSec? }
//   GET    /api/flows/:id                      um fluxo
//   PUT    /api/flows/:id                      edita (mesmo corpo; a conexão não muda)
//   DELETE /api/flows/:id                      apaga o fluxo e as execuções dele
//   POST   /api/flows/:id/run                  executa o fluxo (Claude Code CLI)
//
//   Referência dos testes (card da demanda + fluxo do Twilio Studio):
//   GET    /api/tester/info                    WSL?, tokens de card configurados, limite da referência
//   POST   /api/studio/scan                    { path, location: wsl|windows } → arquivos e fluxos (sem conteúdo)
//   POST   /api/studio/uploads                 { fileName, content } JSON do Studio (até 12 MB) → { id, flows }
//   GET    /api/studio/uploads/:id             fluxos de um JSON anexado
//   POST   /api/cards/preview                  { source, url?, text? } lê o card (só GET na API) → resumo
//   POST   /api/reference/preview              { card, studio } → tamanho + prévia do que a IA vai receber
//
//   Execuções:
//   GET    /api/tests                          lista sem transcrição (?flowId, ?connectionId)
//   GET    /api/tests/:id                      execução completa (transcrição + veredito + análises; sem a referência)
//   GET    /api/tests/:id/reference            referência exata enviada à IA (texto)
//   GET    /api/tests/:id/log                  log da execução em Markdown (download)
//   POST   /api/tests/:id/cancel               cancela uma execução em andamento
//   DELETE /api/tests/:id                      apaga uma execução finalizada
//
// Leituras: todo GET de dados passa pelo ReadCache (versão por tópico + ETag).
// Conexões chegam à página por push (SSE), já com o estado novo: a página não
// consulta a API para se atualizar.
//
// Não há login: a porta só escuta em loopback. Como qualquer site aberto no
// navegador poderia tentar chamar localhost, a API exige Host local, Origin
// igual ao da página (quando presente) e, nas rotas que alteram algo,
// Content-Type JSON — o que força um preflight CORS que nunca é aprovado.

import { createReadStream, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import QRCode from 'qrcode'
import { ADMIN_PAGE } from './admin-page.js'
import type { BirthdaySender } from './birthdays.js'
import type { ChangeBus, ChangeSet, Topic } from './changes.js'
import { EVENT_KINDS, type EventKind, type EventLog, type EventQuery } from './events.js'
import { parseFilters } from './filters.js'
import { type FlowStore, parseFlowInput } from './flows.js'
import { type QueueKind, deliver } from './forwarder.js'
import { logger } from './logger.js'
import type { ConnectionManager, ConnectionView } from './manager.js'
import { type Cursor, type MessageStore, decodeCursor } from './messages.js'
import { fetchCard, parseCardConfig } from './cards.js'
import { parseStudioConfig } from './flows.js'
import { buildReference } from './reference.js'
import { renderRunLog } from './run-log.js'
import { parseStudioJson, resolveProjectPath, scanProject } from './studio.js'
import { TWILIO_ENVS, twilioCreds } from './studio-monitor.js'
import type { NormalizedMessage } from './normalizer.js'
import { type ProxyConfig, type WebhookProxy, parseProxy, testProxy } from './proxy.js'
import { ReadCache } from './read-cache.js'
import { type ConnectionsStore, type ForwardTarget, isValidId, parseFriendlyName, parseTarget } from './settings.js'
import type { TestRunner } from './tester.js'
import type { Config } from './config.js'

const log = logger.child({ module: 'admin' })

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']
const MAX_BODY = 16 * 1024
/** Só para POST /api/studio/uploads (JSON do Studio pode ter MBs). */
const MAX_UPLOAD = 12 * 1024 * 1024
/** Roda no WSL? (a interface já sugere "WSL" ou "Windows" para o caminho do projeto) */
const RUNNING_IN_WSL = (() => {
	try {
		return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
	} catch {
		return false
	}
})()
/** Conexões SSE simultâneas (uma por aba); protege contra esgotar sockets/memória. */
const MAX_STREAMS = 20
/**
 * Comentário SSE de 1 linha para a conexão ociosa não ser derrubada por
 * proxy/NAT/antivírus. Não é requisição da página nem toca banco/disco.
 */
const STREAM_KEEPALIVE_MS = 30_000

export type AdminOptions = {
	host: string
	port: number
	manager: ConnectionManager
	store: ConnectionsStore
	tester: TestRunner
	birthdays: BirthdaySender
	flows: FlowStore
	messages: MessageStore
	events: EventLog
	changes: ChangeBus
	webhookProxy: WebhookProxy | null
	/** Hosts extras aceitos (proxy reverso com domínio), além dos locais. */
	allowedHosts: string[]
	testerCfg: Config['tester']
	cardsCfg: Config['cards']
	twilioCfg: Config['twilio']
	/** Raiz dos arquivos de mídia (caminhos do banco são relativos a ela). */
	mediaDir: string
	timeoutMs: number
}

type Ctx = AdminOptions & {
	req: IncomingMessage
	res: ServerResponse
	cache: ReadCache
	hosts: Set<string>
	hub: StreamHub
}

/** Erro com status HTTP e mensagem mostrada na interface. */
class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
	}
}

export function startAdmin(opts: AdminOptions): { close: () => Promise<void> } {
	const shared = {
		cache: new ReadCache(opts.changes),
		hosts: new Set([...LOCAL_HOSTS, ...opts.allowedHosts]),
		hub: new StreamHub(opts.manager, opts.changes),
	}
	const server = createServer((req, res) => {
		handle({ ...opts, ...shared, req, res }).catch((err) => {
			if (res.headersSent) return
			if (err instanceof HttpError) return json(res, err.status, { error: err.message })
			log.error({ err }, 'erro na interface admin')
			json(res, 500, { error: 'erro interno' })
		})
	})

	server.listen(opts.port, opts.host, () => {
		log.info(`interface admin em http://localhost:${opts.port}`)
	})

	return {
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve())
				// A página aberta mantém conexões keep-alive; sem isto o close() esperaria por elas.
				server.closeAllConnections()
			}),
	}
}

async function handle(ctx: Ctx): Promise<void> {
	const { req, res, manager } = ctx
	const { pathname, searchParams } = new URL(req.url ?? '/', 'http://admin')

	if (!isAllowedRequest(req, ctx.hosts)) throw new HttpError(403, 'acesso permitido só via localhost')

	if (req.method === 'GET' && pathname === '/') {
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
			'x-frame-options': 'DENY',
		})
		res.end(ADMIN_PAGE)
		return
	}

	if (pathname === '/api/stream' && req.method === 'GET') return ctx.hub.open(req, res)

	if (pathname === '/api/connections') {
		if (req.method === 'GET') {
			return cached(ctx, ['connections'], () => allConnections(manager))
		}
		if (req.method === 'POST') {
			const body = await readJson(ctx)
			const item = await manager.create(parseOr400(() => parseFriendlyName(body.friendlyName))).catch((err: Error) => {
				throw err instanceof HttpError ? err : new HttpError(400, err.message)
			})
			return json(res, 201, { id: item.id })
		}
	}

	if (pathname === '/api/birthdays/run' && req.method === 'POST') {
		await readJson(ctx)
		const result = await ctx.birthdays.runNow().catch((err: Error) => {
			throw new HttpError(409, err.message)
		})
		return json(res, 200, result)
	}

	if (pathname === '/api/tests' && req.method === 'GET') {
		const flowId = searchParams.get('flowId') ?? undefined
		const connectionId = searchParams.get('connectionId') ?? undefined
		return cached(ctx, ['tests'], () => ({ runs: ctx.tester.list({ flowId, connectionId }) }))
	}

	if (pathname === '/api/events' && req.method === 'GET') {
		const query = eventQuery(searchParams)
		return cached(ctx, ['events'], () => ({ events: ctx.events.list(query) }))
	}

	const mediaMatch = /^\/api\/media\/(\d{1,12})$/.exec(pathname)
	if (mediaMatch && req.method === 'GET') return sendMedia(ctx, Number(mediaMatch[1]))

	if (pathname === '/api/flows') {
		if (req.method === 'GET') {
			const connectionId = searchParams.get('connectionId') ?? undefined
			return cached(ctx, ['tests'], () => ({ flows: ctx.flows.list(connectionId) }))
		}
		if (req.method === 'POST') {
			const body = await readJson(ctx)
			const input = parseOr400(() => parseFlowInput(body))
			if (!manager.has(input.connectionId)) throw new HttpError(400, 'Conexão não encontrada')
			return json(res, 201, ctx.flows.create(input))
		}
	}

	const flowMatch = /^\/api\/flows\/([a-f0-9]{8})(?:\/(run))?$/.exec(pathname)
	if (flowMatch) {
		const [, flowId = '', action] = flowMatch
		if (req.method === 'GET' && !action) {
			return cached(ctx, ['tests'], () => ctx.flows.get(flowId) ?? notFound('fluxo não encontrado'))
		}
		const flow = ctx.flows.get(flowId)
		if (!flow) throw new HttpError(404, 'fluxo não encontrado')
		if (req.method === 'PUT' && !action) {
			const body = await readJson(ctx)
			// A conexão do fluxo é fixa: valida o resto com ela.
			const { connectionId: _c, ...input } = parseOr400(() => parseFlowInput({ ...body, connectionId: flow.connectionId }))
			return json(res, 200, ctx.flows.update(flowId, input))
		}
		if (req.method === 'DELETE' && !action) {
			await readJson(ctx)
			if (ctx.tester.isFlowRunning(flowId)) throw new HttpError(409, 'Há um teste deste fluxo em andamento; cancele antes de apagar')
			ctx.flows.remove(flowId)
			return json(res, 200, { ok: true })
		}
		if (req.method === 'POST' && action === 'run') {
			await readJson(ctx)
			try {
				const run = await ctx.tester.start(flowId)
				return json(res, 201, { id: run.id })
			} catch (err) {
				throw new HttpError(400, (err as Error).message)
			}
		}
	}

	if (pathname.startsWith('/api/studio/') || pathname.startsWith('/api/cards/') || pathname.startsWith('/api/reference/') || pathname === '/api/tester/info') {
		return referenceRoutes(ctx, pathname)
	}

	const testMatch = /^\/api\/tests\/([a-f0-9]{8})(?:\/(cancel|reference|log))?$/.exec(pathname)
	if (testMatch) {
		const [, runId = '', action] = testMatch
		// A página abre a execução selecionada a cada mudança em 'tests': sai do cache.
		// A referência (pode ter centenas de KB) não vai junto; tem rota própria.
		if (req.method === 'GET' && !action) {
			return cached(ctx, ['tests'], () => {
				const run = ctx.tester.get(runId) ?? notFound('teste não encontrado')
				return { ...run, reference: undefined, hasReference: run.reference !== null, logFile: run.logPath ? path.basename(run.logPath) : null, logPath: undefined }
			})
		}
		if (req.method === 'GET' && action === 'reference') {
			const run = ctx.tester.get(runId) ?? notFound('teste não encontrado')
			res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
			res.end(run.reference ?? '(esta execução não teve referência)')
			return
		}
		if (req.method === 'GET' && action === 'log') {
			const run = ctx.tester.get(runId) ?? notFound('teste não encontrado')
			const name = run.logPath ? path.basename(run.logPath) : `teste_${run.id}.md`
			res.writeHead(200, {
				'content-type': 'text/markdown; charset=utf-8',
				'content-disposition': `attachment; filename="${name.replace(/[^\w.\-]/g, '_')}"`,
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff',
			})
			res.end(renderRunLog(run))
			return
		}
		if (!ctx.tester.get(runId)) throw new HttpError(404, 'teste não encontrado')
		if (req.method === 'POST' && action === 'cancel') {
			await readJson(ctx)
			return json(res, 200, { ok: ctx.tester.cancel(runId) })
		}
		if (req.method === 'DELETE' && !action) {
			await readJson(ctx)
			if (!(await ctx.tester.remove(runId))) throw new HttpError(409, 'não é possível apagar um teste em andamento')
			return json(res, 200, { ok: true })
		}
	}

	// /api/connections/:id[/acao]
	const match = /^\/api\/connections\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname)
	if (match) {
		const [, id = '', action] = match
		if (!isValidId(id) || !manager.has(id)) throw new HttpError(404, 'conexão não encontrada')
		const route = `${req.method} ${action ?? ''}`

		switch (route) {
			case 'DELETE ':
				await readJson(ctx)
				if (ctx.tester.isConnectionRunning(id)) throw new HttpError(409, 'Há um teste em andamento nesta conexão; cancele antes de excluir')
				await manager.remove(id)
				return json(res, 200, { ok: true })

			case 'POST connect':
			case 'POST cancel':
			case 'POST logout':
				await readJson(ctx)
				await manager[action as 'connect' | 'cancel' | 'logout'](id)
				return json(res, 200, { ok: true })

			case 'GET chats': {
				const limit = intParam(searchParams, 'limit')
				const cursor = cursorParam(searchParams)
				return cached(ctx, ['messages'], () => {
					const page = ctx.messages.listChats(id, limit, cursor)
					return { chats: page.items, nextCursor: page.nextCursor }
				})
			}

			case 'GET messages': {
				const chat = searchParams.get('chat') ?? ''
				if (!chat || chat.length > 256) throw new HttpError(400, 'informe ?chat=<jid>')
				const limit = intParam(searchParams, 'limit')
				const cursor = cursorParam(searchParams)
				return cached(ctx, ['messages'], () => {
					const page = ctx.messages.listMessages(id, chat, limit, cursor)
					return { messages: page.items, nextCursor: page.nextCursor }
				})
			}

			case 'GET events': {
				const query = { ...eventQuery(searchParams), connectionId: id }
				return cached(ctx, ['events'], () => ({ events: ctx.events.list(query) }))
			}

			case 'GET queue': {
				const kind = queueKind(searchParams.get('kind'))
				const offset = intParam(searchParams, 'offset') ?? 0
				const limit = Math.min(Math.max(intParam(searchParams, 'limit') ?? 50, 1), 200)
				return cached(ctx, ['connections'], async () => ({ kind, offset, ...(await manager.queueItems(id, kind, offset, limit)) }))
			}

			case 'DELETE queue': {
				const body = await readJson(ctx)
				const kind = queueKind(body.kind)
				let files: string[] | 'all'
				if (body.all === true) files = 'all'
				else if (Array.isArray(body.files) && body.files.length > 0 && body.files.length <= MAX_DELETE) {
					files = body.files.map(String)
					// O forwarder também filtra, mas recusa já aqui qualquer coisa fora do formato.
					if (files.some((f) => !QUEUE_FILE_RE.test(f))) throw new HttpError(400, 'item da fila inválido')
				} else throw new HttpError(400, `Selecione de 1 a ${MAX_DELETE} itens, ou use all: true`)
				return json(res, 200, { removed: await manager.discardQueue(id, kind, files) })
			}

			case 'PUT proxy': {
				const body = await readJson(ctx)
				const url = String(body.url ?? '').trim()
				await manager.setProxy(id, url ? proxyFrom(body, ctx, id) : null)
				return json(res, 200, { ok: true })
			}

			case 'POST proxytest': {
				const proxy = proxyFrom(await readJson(ctx), ctx, id)
				const started = Date.now()
				try {
					const { status } = await testProxy(proxy, ctx.timeoutMs)
					return json(res, 200, { ok: true, status, ms: Date.now() - started })
				} catch (err) {
					return json(res, 200, { ok: false, error: describeFetchError(err), ms: Date.now() - started })
				}
			}

			case 'PUT name': {
				const body = await readJson(ctx)
				await manager.setName(id, parseOr400(() => parseFriendlyName(body.friendlyName)))
				return json(res, 200, { ok: true })
			}

			case 'PUT webhook': {
				const body = await readJson(ctx)
				const url = String(body.url ?? '').trim()
				if (url) {
					await manager.setWebhook(id, targetFrom(body, ctx, id))
					return json(res, 200, { ok: true })
				}
				// URL vazia = remover. Opcionalmente descarta o que estava pendente na fila.
				await manager.setWebhook(id, null)
				const discarded = body.discardPending === true ? await manager.discardQueue(id, 'pending', 'all') : 0
				return json(res, 200, { ok: true, discarded })
			}

			case 'PUT filters': {
				const body = await readJson(ctx)
				await manager.setFilters(id, parseOr400(() => parseFilters(body)))
				return json(res, 200, { ok: true })
			}

			case 'POST test': {
				const target = targetFrom(await readJson(ctx), ctx, id)
				const started = Date.now()
				const sample = JSON.stringify(sampleMessage(ctx.store.get(id)?.friendlyName ?? ''))
				try {
					const { status } = await deliver(target, sample, ctx.timeoutMs, ctx.webhookProxy)
					return json(res, 200, { status, ok: status >= 200 && status < 300, ms: Date.now() - started })
				} catch (err) {
					return json(res, 200, { ok: false, error: describeFetchError(err), ms: Date.now() - started })
				}
			}
		}
	}

	throw new HttpError(404, 'não encontrado')
}

const QUEUE_FILE_RE = /^\d{15}-\d{6}\.json$/
/** Por requisição (cabe nos 16 KB do corpo). Para mais, use all: true. */
const MAX_DELETE = 400

function queueKind(value: unknown): QueueKind {
	if (value === undefined || value === null || value === '' || value === 'pending') return 'pending'
	if (value === 'failed') return 'failed'
	throw new HttpError(400, 'kind deve ser pending ou failed')
}

/** Número inteiro opcional da query string (?limit=, ?before=). */
function intParam(params: URLSearchParams, name: string): number | undefined {
	const raw = params.get(name)
	if (raw === null || raw === '') return undefined
	const n = Number(raw)
	if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, `${name} inválido`)
	return n
}

/** ?cursor= devolvido em nextCursor da página anterior. */
function cursorParam(params: URLSearchParams): Cursor | undefined {
	const raw = params.get('cursor')
	if (!raw) return undefined
	return parseOr400(() => decodeCursor(raw))
}

function eventQuery(params: URLSearchParams): EventQuery {
	const kind = params.get('kind') ?? undefined
	if (kind && !EVENT_KINDS.includes(kind as EventKind)) throw new HttpError(400, `kind deve ser ${EVENT_KINDS.join(', ')}`)
	return {
		kind: kind as EventKind | undefined,
		ref: params.get('ref') ?? undefined,
		before: intParam(params, 'before'),
		limit: intParam(params, 'limit'),
	}
}

// Tipos que o navegador pode exibir sem risco. Qualquer outro (HTML, SVG, PDF,
// documentos…) vai como download: um arquivo recebido de terceiros nunca roda
// na origem da interface admin, que tem acesso à API.
const INLINE_MEDIA = /^(image\/(jpeg|png|gif|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/

async function sendMedia({ res, messages, mediaDir }: Ctx, mediaId: number): Promise<void> {
	const media = messages.getMediaFile(mediaId)
	if (!media) throw new HttpError(404, 'mídia não encontrada')
	if (media.status !== 'saved' || !media.path) throw new HttpError(404, 'mídia não baixada')
	// Caminho vem do banco, mas confere que continua dentro de MEDIA_DIR.
	const root = path.resolve(mediaDir)
	const file = path.resolve(root, media.path)
	if (!file.startsWith(root + path.sep)) throw new HttpError(404, 'mídia não encontrada')
	const info = await stat(file).catch(() => null)
	if (!info?.isFile()) throw new HttpError(404, 'arquivo de mídia não existe mais')

	const mime = (media.mimetype ?? '').split(';')[0]!.trim().toLowerCase()
	const inline = INLINE_MEDIA.test(mime)
	const name = (media.fileName ?? path.basename(file)).replace(/[^\w.\- ]/g, '_')
	res.writeHead(200, {
		'content-type': inline ? mime : 'application/octet-stream',
		'content-length': info.size,
		'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
		'cache-control': 'private, max-age=86400',
	})
	await pipeline(createReadStream(file), res)
}

// Converter o QR em SVG é barato, mas o QR se renova a cada ~20 s; guarda por texto de QR.
const qrCache = new Map<string, string>()

async function withQrSvg(view: ConnectionView) {
	const { state } = view
	if (state.status !== 'qr') return view
	let svg = qrCache.get(state.qr)
	if (!svg) {
		svg = await QRCode.toString(state.qr, { type: 'svg', margin: 2, errorCorrectionLevel: 'L' })
		if (qrCache.size > 50) qrCache.clear()
		qrCache.set(state.qr, svg)
	}
	// O texto bruto do QR não sai daqui; só a imagem.
	return { ...view, state: { status: 'qr' as const, qrSvg: svg } }
}

/** Monta o webhook do corpo; token omitido = mantém o salvo (a UI nunca recebe o token). */
function targetFrom(body: Record<string, unknown>, ctx: Ctx, id: string): ForwardTarget {
	if (body.token === undefined) body.token = ctx.store.get(id)?.webhook?.token ?? ''
	return parseOr400(() => parseTarget(body))
}

function parseOr400<T>(fn: () => T): T {
	try {
		return fn()
	} catch (err) {
		throw new HttpError(400, (err as Error).message)
	}
}

/** Lê o corpo JSON (exigindo Content-Type). */
async function readJson({ req }: Ctx, maxBytes = MAX_BODY): Promise<Record<string, unknown>> {
	if (!req.headers['content-type']?.startsWith('application/json')) {
		throw new HttpError(415, 'use Content-Type: application/json')
	}
	let parsed: unknown
	try {
		const raw = await readBody(req, maxBytes)
		parsed = raw ? JSON.parse(raw) : {}
	} catch (err) {
		if (err instanceof HttpError) throw err
		throw new HttpError(400, 'JSON inválido')
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'JSON inválido')
	return parsed as Record<string, unknown>
}

/** Rotas de apoio à referência dos testes (card + fluxo do Studio). */
async function referenceRoutes(ctx: Ctx, pathname: string): Promise<void> {
	const { req, res, testerCfg, cardsCfg } = ctx
	const route = `${req.method} ${pathname.replace(/\/\d+$/, '/:id')}`
	const run400 = async <T>(fn: () => Promise<T> | T): Promise<T> => {
		try {
			return await fn()
		} catch (err) {
			throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message)
		}
	}

	switch (route) {
		case 'GET /api/tester/info':
			return json(res, 200, {
				wsl: RUNNING_IN_WSL,
				azureConfigured: Boolean(cardsCfg.azurePat),
				jiraConfigured: Boolean(cardsCfg.jiraEmail && cardsCfg.jiraToken),
				referenceMaxKb: Math.round(testerCfg.referenceMaxBytes / 1024),
				// Só se há credenciais por ambiente (nunca os valores).
				twilioEnvs: Object.fromEntries(TWILIO_ENVS.map((e) => [e, twilioCreds(ctx.twilioCfg, e) !== null])),
				studioPollSec: Math.round(ctx.twilioCfg.pollMs / 1000),
			})

		case 'POST /api/studio/scan': {
			const body = await readJson(ctx)
			const location = body.location === 'windows' ? 'windows' : 'wsl'
			return json(res, 200, await run400(async () => {
				const resolved = resolveProjectPath(String(body.path ?? ''), location)
				const { sources } = await scanProject(resolved, testerCfg.studioAllowedRoots)
				if (!sources.length) throw new Error('Nenhum fluxo do Studio encontrado nessa pasta (procuro studioFlows.json e pastas exports/flows)')
				return { resolvedPath: resolved, sources }
			}))
		}

		case 'POST /api/studio/uploads': {
			const body = await readJson(ctx, MAX_UPLOAD)
			const fileName = String(body.fileName ?? 'fluxo.json').replace(/[^\w.\- ]/g, '_').slice(0, 200)
			const content = String(body.content ?? '')
			const flows = await run400(() => parseStudioJson(content, fileName.replace(/\.json$/i, '')))
			const id = ctx.flows.saveUpload(fileName, content)
			return json(res, 201, { id, fileName, flows: flows.map((f) => ({ name: f.name, states: f.definition.states.length })) })
		}

		case 'GET /api/studio/uploads/:id': {
			const upload = ctx.flows.getUpload(Number(pathname.split('/').pop()))
			if (!upload) throw new HttpError(404, 'anexo não encontrado')
			const flows = parseStudioJson(upload.content, upload.fileName.replace(/\.json$/i, ''))
			return json(res, 200, { fileName: upload.fileName, flows: flows.map((f) => ({ name: f.name, states: f.definition.states.length })) })
		}

		case 'POST /api/cards/preview': {
			const body = await readJson(ctx, 128 * 1024)
			const card = await run400(async () => {
				const cfg = parseCardConfig(body)
				if (!cfg) throw new Error('Escolha a fonte do card')
				return fetchCard(cfg, cardsCfg)
			})
			return json(res, 200, {
				title: card.title,
				ref: card.ref,
				type: card.type,
				state: card.state,
				body: card.body.slice(0, 3000),
				bodyChars: card.body.length,
				comments: card.comments.length,
				attachments: card.attachments,
				studioFlowsInAttachments: card.attachmentFlows.map((f) => f.name),
			})
		}

		case 'POST /api/reference/preview': {
			const body = await readJson(ctx, 128 * 1024)
			const ref = await run400(async () => buildReference(
				{ card: parseCardConfig(body.card), studio: parseStudioConfig(body.studio) } as Parameters<typeof buildReference>[0],
				{ cards: cardsCfg, flows: ctx.flows, allowedRoots: testerCfg.studioAllowedRoots, maxBytes: testerCfg.referenceMaxBytes },
			))
			if (!ref) throw new HttpError(400, 'Informe o card e/ou o fluxo do Studio')
			return json(res, 200, { summary: ref.summary, preview: ref.text.slice(0, 20_000), truncated: ref.text.length > 20_000 })
		}
	}
	throw new HttpError(404, 'não encontrado')
}

/**
 * GET com cache por versão (read-cache.ts) + ETag: sem mudança nos tópicos,
 * não toca banco/disco; com If-None-Match igual, responde 304 sem corpo.
 */
async function cached(ctx: Ctx, topics: readonly Topic[], compute: () => unknown | Promise<unknown>): Promise<void> {
	const { req, res } = ctx
	const entry = await ctx.cache.get(req.url ?? '', topics, compute)
	// no-cache = o navegador pode guardar, mas revalida sempre (If-None-Match).
	const headers = { etag: entry.etag, 'cache-control': 'private, no-cache' }
	if (req.headers['if-none-match'] === entry.etag) {
		res.writeHead(304, headers)
		res.end()
		return
	}
	res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...headers })
	res.end(entry.body)
}

function notFound(message: string): never {
	throw new HttpError(404, message)
}

async function allConnections(manager: ConnectionManager) {
	return { connections: await Promise.all((await manager.list()).map(withQrSvg)) }
}

type StreamClient = { res: ServerResponse; ready: boolean; queued: string[] }

/**
 * Push em tempo real para as abas abertas (SSE). Ao abrir: "snapshot" com
 * todas as conexões. Depois, a cada mudança (agrupada em 300 ms pelo
 * ChangeBus), a conexão alterada é montada UMA vez e enviada a todas as abas —
 * a página nunca precisa consultar a API para se atualizar. Sem abas abertas,
 * nada é calculado.
 */
class StreamHub {
	private readonly clients = new Set<StreamClient>()

	constructor(
		private readonly manager: ConnectionManager,
		changes: ChangeBus,
	) {
		changes.subscribe((change) => {
			this.broadcast(change).catch((err) => log.warn({ err }, 'falha ao enviar atualização em tempo real'))
		})
	}

	async open(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (this.clients.size >= MAX_STREAMS) throw new HttpError(503, 'muitas abas abertas da interface')
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			// Proxies (nginx/Caddy) não devem segurar os eventos em buffer.
			'x-accel-buffering': 'no',
		})
		res.write('retry: 5000\n\n')
		// Entra na lista ANTES de montar o snapshot, mas segura os eventos até ele
		// sair: nada se perde e nada mais velho que o snapshot chega depois dele.
		const client: StreamClient = { res, ready: false, queued: [] }
		this.clients.add(client)
		const keepalive = setInterval(() => res.write(': keepalive\n\n'), STREAM_KEEPALIVE_MS)
		req.on('close', () => {
			clearInterval(keepalive)
			this.clients.delete(client)
		})
		res.write(frame('snapshot', await allConnections(this.manager)))
		for (const chunk of client.queued) res.write(chunk)
		client.queued = []
		client.ready = true
	}

	private async broadcast(change: ChangeSet): Promise<void> {
		if (!this.clients.size) return
		for (const id of change.connections) {
			const view = await this.manager.viewOf(id)
			this.send(view ? frame('connection', await withQrSvg(view)) : frame('connection-removed', { id }))
		}
		const topics = change.topics.filter((t) => t !== 'connections')
		if (topics.length) this.send(frame('change', topics))
	}

	private send(chunk: string): void {
		for (const c of this.clients) {
			if (c.ready) c.res.write(chunk)
			else c.queued.push(chunk)
		}
	}
}

function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Monta o proxy do corpo; senha omitida = mantém a salva (a UI nunca recebe a senha). */
function proxyFrom(body: Record<string, unknown>, ctx: Ctx, id: string): ProxyConfig {
	const saved = ctx.store.get(id)?.proxy
	if (body.password === undefined && saved && String(body.username ?? '').trim() === saved.username) {
		body.password = saved.password
	}
	return parseOr400(() => parseProxy(body))
}

function isAllowedRequest(req: IncomingMessage, hosts: Set<string>): boolean {
	// Host protege contra DNS rebinding (domínio externo apontando para 127.0.0.1).
	// Além dos locais, só os de ADMIN_ALLOWED_HOSTS (proxy reverso com domínio).
	const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
	if (!hosts.has(host)) return false
	// Origin, quando presente, precisa ser a própria página.
	const origin = req.headers.origin
	if (origin) {
		try {
			const o = new URL(origin)
			if (!hosts.has(o.hostname) || o.host !== req.headers.host) return false
		} catch {
			return false
		}
	}
	return true
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => {
			size += c.length
			if (size > maxBytes) {
				reject(new HttpError(413, 'corpo grande demais'))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}

function json(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
	res.end(JSON.stringify(data))
}

function describeFetchError(err: unknown): string {
	const e = err as Error
	if (e.name === 'TimeoutError') return 'tempo esgotado (timeout)'
	// fetch embrulha o erro real em causas ("fetch failed" → … → motivo): usa a mais interna.
	let root: Error & { code?: unknown } = e
	while (root.cause instanceof Error) root = root.cause
	const message = root.message || e.message
	if (message.includes('(407)')) return 'o proxy recusou a autenticação (407): confira usuário e senha'
	return typeof root.code === 'string' && !message.includes(root.code) ? `${root.code}: ${message}` : message
}

/** Payload no mesmo formato de uma mensagem real, marcado como teste. */
function sampleMessage(instance: string): NormalizedMessage & { instance: string | null; test: true } {
	return {
		id: `TEST-${Date.now()}`,
		chatId: '5511999999999@s.whatsapp.net',
		chatIdAlt: null,
		isGroup: false,
		fromMe: false,
		senderId: '5511999999999@s.whatsapp.net',
		senderIdAlt: null,
		pushName: 'Teste',
		timestamp: Math.floor(Date.now() / 1000),
		type: 'conversation',
		text: 'Mensagem de teste da interface admin',
		media: null,
		quotedId: null,
		source: 'live',
		instance: instance || null,
		test: true,
	}
}
