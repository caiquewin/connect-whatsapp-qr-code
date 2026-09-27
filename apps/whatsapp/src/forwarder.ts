// Envio ao endpoint com fila local em disco.
//
// Cada mensagem vira um arquivo em QUEUE_DIR antes de qualquer tentativa de envio,
// então nada se perde se o endpoint estiver fora ou o processo reiniciar.
// Um único worker envia em ordem (FIFO pelo nome do arquivo), com timeout,
// backoff exponencial em falhas e intervalo mínimo entre envios.
// O destino (URL/método/token) é lido a cada envio, então mudanças feitas na
// interface admin valem na hora. Sem webhook configurado, as mensagens
// ficam guardadas na fila até que um seja salvo.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Config } from './config.js'
import { logger } from './logger.js'
import type { NormalizedMessage } from './normalizer.js'
import type { WebhookProxy } from './proxy.js'
import type { ForwardTarget } from './settings.js'

const log = logger.child({ module: 'forwarder' })

// 4xx que não adianta repetir vão para failed/ (inspeção manual); 408/429 são repetidos.
const RETRYABLE_4XX = new Set([408, 429])

/** Nome exato dos itens que o próprio enqueue gera; qualquer outro nome é recusado (sem path traversal). */
const ITEM_RE = /^\d{15}-\d{6}\.json$/
const PREVIEW_CHARS = 140
/** De quanto em quanto tempo confere se a pasta mudou por fora (edição manual). */
const SYNC_MS = 60_000

export type QueueKind = 'pending' | 'failed'

/** Resumo de um item da fila para a interface (texto só como prévia curta). */
export type QueueItem = {
	file: string
	/** Quando entrou na fila (do nome do arquivo). */
	queuedAt: string
	id: string | null
	chatId: string | null
	chatIdAlt: string | null
	isGroup: boolean
	fromMe: boolean
	pushName: string | null
	type: string | null
	timestamp: number | null
	preview: string | null
	/** Arquivo corrompido: só dá para excluir. */
	unreadable: boolean
}

/** Resultado de uma tentativa de entrega (vira evento 'webhook' no banco). */
export type DeliveryAttempt = {
	result: 'ok' | 'retry' | 'drop'
	/** id da mensagem (null se o arquivo da fila não pôde ser lido). */
	messageId: string | null
	status: number | null
	error: string | null
	ms: number
	method: string
	/** Só a origem (esquema + host) — o caminho pode carregar segredo. */
	host: string
}

export type ForwarderHooks = {
	/** Cada tentativa de entrega (vira evento 'webhook'). */
	onAttempt?: (a: DeliveryAttempt) => void
	/** Algo em stats() mudou (enfileirou, entregou, entrou/saiu de backoff): invalida o cache da interface. */
	onChange?: () => void
	/** Proxy de saída global do webhook (WEBHOOK_PROXY_URL). */
	proxy?: WebhookProxy | null
}

/**
 * Nomes dos itens de uma pasta da fila, em memória e em ordem de chegada.
 * Evita reler a pasta a cada envio/contagem/página (com milhares de itens,
 * readdir + sort a cada operação vira O(n²)). O disco continua sendo a verdade:
 * `sync` relê quando o mtime da pasta muda (ex.: arquivos movidos à mão).
 */
class DirIndex {
	private names: string[] = []
	private readonly set = new Set<string>()
	private mtimeMs = -1

	constructor(readonly dir: string) {}

	get size(): number {
		return this.set.size
	}

	get first(): string | undefined {
		return this.names[0]
	}

	has(name: string): boolean {
		return this.set.has(name)
	}

	page(offset: number, limit: number): string[] {
		return this.names.slice(offset, offset + limit)
	}

	all(): string[] {
		return [...this.names]
	}

	add(name: string): void {
		// Um sync entre o rename e o add já pode ter incluído o nome.
		if (this.set.has(name)) return
		this.set.add(name)
		this.names.push(name)
	}

	remove(name: string): void {
		if (!this.set.delete(name)) return
		if (this.names[0] === name) this.names.shift()
		else this.names.splice(this.names.indexOf(name), 1)
	}

	removeMany(names: Set<string>): void {
		this.names = this.names.filter((n) => !names.has(n))
		for (const n of names) this.set.delete(n)
	}

	/** Relê a pasta se ela mudou desde a última leitura (ou sempre, com force). */
	async sync(force = false): Promise<void> {
		const st = await stat(this.dir).catch(() => null)
		if (!st || (!force && st.mtimeMs === this.mtimeMs)) return
		this.mtimeMs = st.mtimeMs
		const files = (await readdir(this.dir)).filter((f) => ITEM_RE.test(f)).sort()
		this.names = files
		this.set.clear()
		for (const f of files) this.set.add(f)
	}
}

export class Forwarder {
	private readonly failedDir: string
	private readonly pending: DirIndex
	private readonly failed: DirIndex
	private lastSync = 0
	private seq = 0
	private stopping = false
	/** true enquanto espera backoff: o shutdown não fica aguardando um endpoint fora. */
	private backingOff = false
	private wake: (() => void) | null = null
	private worker: Promise<void> | null = null
	/** Aborta a espera de backoff/intervalo durante o shutdown. */
	private readonly abort = new AbortController()
	/** Cancela só o backoff atual (ex.: destino alterado na UI → tenta já). */
	private backoffCancel: AbortController | null = null
	private failures = 0
	private lastError: { at: string; message: string } | null = null
	private lastSuccessAt: string | null = null
	private readonly log: typeof log

	constructor(
		private readonly cfg: Config['forward'],
		private readonly dir: string,
		private readonly getTarget: () => ForwardTarget | null,
		connectionId: string,
		private readonly hooks: ForwarderHooks = {},
	) {
		this.failedDir = path.join(dir, 'failed')
		this.pending = new DirIndex(dir)
		this.failed = new DirIndex(this.failedDir)
		this.log = log.child({ connection: connectionId })
	}

	async start(): Promise<void> {
		await mkdir(this.failedDir, { recursive: true })
		// Remove temporários de uma gravação interrompida por crash.
		for (const f of await readdir(this.dir)) {
			if (f.endsWith('.tmp')) await rm(path.join(this.dir, f), { force: true })
		}
		await this.syncIndexes(true)
		const pending = this.pending.size
		if (pending) this.log.info({ pending }, 'fila com mensagens pendentes de execução anterior')
		this.worker = this.run()
	}

	/** Persiste a mensagem na fila. Resolve quando está gravada em disco. */
	async enqueue(msg: NormalizedMessage & { instance: string | null }): Promise<void> {
		// Prefixo de tempo + sequência mantém a ordem de chegada no readdir ordenado.
		const name = `${Date.now().toString().padStart(15, '0')}-${String(this.seq++ % 1e6).padStart(6, '0')}.json`
		const file = path.join(this.dir, name)
		// Grava em .tmp e renomeia: o worker nunca lê um arquivo pela metade.
		await writeFile(`${file}.tmp`, JSON.stringify(msg))
		await rename(`${file}.tmp`, file)
		this.pending.add(name)
		this.changed()
		this.wake?.()
	}

	/**
	 * Para o worker. Tenta drenar a fila por até `drainMs`; o que sobrar
	 * continua em disco e é enviado na próxima execução.
	 */
	async stop(drainMs: number): Promise<void> {
		const deadline = Date.now() + drainMs
		while (Date.now() < deadline && this.pending.size > 0 && !this.backingOff) {
			await sleep(200)
		}
		this.stopping = true
		this.abort.abort()
		this.wake?.()
		await this.worker
		const left = this.pending.size
		this.log.info({ left }, left ? 'fila persistida em disco para a próxima execução' : 'fila drenada')
	}

	/** Interrompe o backoff e tenta enviar de novo imediatamente. */
	nudge(): void {
		this.failures = 0
		this.backoffCancel?.abort()
		this.wake?.()
	}

	/** Para o worker sem drenar e apaga a fila (conexão excluída). */
	async destroy(): Promise<void> {
		this.stopping = true
		this.abort.abort()
		this.wake?.()
		await this.worker
		await rm(this.dir, { recursive: true, force: true })
	}

	/**
	 * Uma página da fila (pendentes ou rejeitados), em ordem de chegada. Só os
	 * arquivos da página são lidos; o total vem do índice em memória.
	 */
	async listItems(kind: QueueKind, offset: number, limit: number): Promise<{ total: number; items: QueueItem[] }> {
		const index = this.indexOf(kind)
		const items = await Promise.all(index.page(offset, limit).map((f) => readItem(index.dir, f)))
		// null = entregue/excluído entre a página e a leitura.
		return { total: index.size, items: items.filter((i): i is QueueItem => i !== null) }
	}

	/**
	 * Exclui itens da fila sem enviar. `files` = nomes vindos da interface
	 * (só os que existem e têm o formato gerado aqui); 'all' = tudo que está na
	 * pasta agora. Se o item que estava bloqueando a fila (o primeiro, em retry)
	 * sair, o worker segue na hora para o próximo.
	 */
	async removeItems(kind: QueueKind, files: string[] | 'all'): Promise<number> {
		const index = this.indexOf(kind)
		const head = index.first
		const targets = files === 'all' ? index.all() : files.filter((f) => index.has(f))
		const gone = new Set<string>()
		let removed = 0
		for (const f of targets) {
			try {
				await rm(path.join(index.dir, f))
				removed++
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
			}
			gone.add(f)
		}
		index.removeMany(gone)
		if (kind === 'pending' && head && gone.has(head)) this.nudge()
		if (removed) {
			this.log.info({ kind, removed, all: files === 'all' }, 'itens excluídos da fila pela interface')
			this.changed()
		}
		return removed
	}

	/** Situação da fila para a interface admin (da memória, sem tocar no disco). */
	stats() {
		return {
			pending: this.pending.size,
			failed: this.failed.size,
			/** Próximo a enviar (nome do item): muda a cada entrega; a interface usa para saber se a lista mudou. */
			head: this.pending.first ?? null,
			backingOff: this.backingOff,
			consecutiveFailures: this.failures,
			lastError: this.lastError,
			lastSuccessAt: this.lastSuccessAt,
		}
	}

	private indexOf(kind: QueueKind): DirIndex {
		return kind === 'pending' ? this.pending : this.failed
	}

	/** Relê as pastas só se mudaram por fora; no máximo a cada SYNC_MS (ou já, com force). */
	private async syncIndexes(force = false): Promise<void> {
		if (!force && Date.now() - this.lastSync < SYNC_MS) return
		this.lastSync = Date.now()
		const before = [this.pending.size, this.failed.size]
		await this.pending.sync(force)
		await this.failed.sync(force)
		if (!force && (before[0] !== this.pending.size || before[1] !== this.failed.size)) this.changed()
	}

	private async run(): Promise<void> {
		while (!this.stopping) {
			await this.syncIndexes()
			const next = this.pending.first
			const target = this.getTarget()
			if (!next || !target) {
				// Fila vazia ou sem webhook: dorme até o próximo enqueue/nudge (ou 5s).
				await new Promise<void>((resolve) => {
					this.wake = resolve
					setTimeout(resolve, 5_000).unref()
				})
				this.wake = null
				continue
			}

			const file = path.join(this.dir, next)
			const result = await this.send(file, target)

			if (result === 'gone') {
				// Excluído pela interface (ou à mão) antes da leitura: segue para o próximo.
				this.pending.remove(next)
			} else if (result === 'ok') {
				await rm(file, { force: true })
				this.pending.remove(next)
				this.failures = 0
				this.lastSuccessAt = new Date().toISOString()
				await this.pause(this.cfg.minIntervalMs)
			} else if (result === 'drop') {
				// ENOENT = excluído pela interface durante o envio; nada a mover.
				const moved = await rename(file, path.join(this.failedDir, next)).then(() => true, (err: NodeJS.ErrnoException) => {
					if (err.code !== 'ENOENT') throw err
					return false
				})
				this.pending.remove(next)
				if (moved) this.failed.add(next)
			} else {
				this.failures++
				// Backoff exponencial com jitter, limitado a backoffMaxMs.
				const delay = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** (this.failures - 1))
				const jittered = Math.round(delay / 2 + Math.random() * (delay / 2))
				this.log.warn({ failures: this.failures, retryInMs: jittered }, 'endpoint indisponível, tentando novamente')
				this.backingOff = true
				this.changed()
				this.backoffCancel = new AbortController()
				await this.pause(jittered, this.backoffCancel.signal)
				this.backoffCancel = null
				this.backingOff = false
			}
			this.changed()
		}
	}

	private changed(): void {
		try {
			this.hooks.onChange?.()
		} catch (err) {
			this.log.warn({ err }, 'falha ao notificar mudança da fila')
		}
	}

	private async send(file: string, target: ForwardTarget): Promise<'ok' | 'retry' | 'drop' | 'gone'> {
		const started = Date.now()
		let messageId: string | null = null
		const report = (result: DeliveryAttempt['result'], status: number | null, error: string | null) => {
			try {
				this.hooks.onAttempt?.({ result, messageId, status, error, ms: Date.now() - started, method: target.method, host: originOf(target.url) })
			} catch (err) {
				this.log.warn({ err }, 'falha ao registrar tentativa de entrega')
			}
			return result
		}

		let body: string
		try {
			body = await readFile(file, 'utf8')
			messageId = (JSON.parse(body) as { id?: string }).id ?? null
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
			this.log.error({ err, file }, 'falha ao ler item da fila')
			return report('drop', null, 'item da fila ilegível')
		}

		try {
			const { status } = await deliver(target, body, this.cfg.timeoutMs, this.hooks.proxy)

			if (status >= 200 && status < 300) return report('ok', status, null)
			this.lastError = { at: new Date().toISOString(), message: `HTTP ${status}` }
			if (status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
				this.log.error({ status, file: path.basename(file) }, 'endpoint rejeitou a mensagem; movida para failed/')
				return report('drop', status, null)
			}
			this.log.warn({ status }, 'endpoint respondeu com erro')
			return report('retry', status, null)
		} catch (err) {
			const message = (err as Error).message
			this.lastError = { at: new Date().toISOString(), message }
			this.log.warn({ err: message }, 'falha de rede ao enviar')
			return report('retry', null, message)
		}
	}

	/** sleep que termina antes se o shutdown (ou `extra`) abortar. */
	private async pause(ms: number, extra?: AbortSignal): Promise<void> {
		if (ms <= 0) return
		const signal = extra ? AbortSignal.any([this.abort.signal, extra]) : this.abort.signal
		await sleep(ms, undefined, { signal }).catch(() => undefined)
	}
}

async function readItem(dir: string, file: string): Promise<QueueItem | null> {
	const queuedAt = new Date(Number(file.slice(0, 15))).toISOString()
	let raw: string
	try {
		raw = await readFile(path.join(dir, file), 'utf8')
	} catch {
		return null
	}
	try {
		const m = JSON.parse(raw) as Partial<NormalizedMessage>
		const text = typeof m.text === 'string' ? m.text : null
		return {
			file,
			queuedAt,
			id: m.id ?? null,
			chatId: m.chatId ?? null,
			chatIdAlt: m.chatIdAlt ?? null,
			isGroup: Boolean(m.isGroup),
			fromMe: Boolean(m.fromMe),
			pushName: m.pushName ?? null,
			type: m.type ?? null,
			timestamp: typeof m.timestamp === 'number' ? m.timestamp : null,
			preview: text && text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text,
			unreadable: false,
		}
	} catch {
		const empty = { id: null, chatId: null, chatIdAlt: null, pushName: null, type: null, timestamp: null, preview: null }
		return { file, queuedAt, ...empty, isGroup: false, fromMe: false, unreadable: true }
	}
}

function originOf(url: string): string {
	try {
		return new URL(url).origin
	} catch {
		return ''
	}
}

/**
 * Faz uma requisição ao destino com o payload JSON de uma mensagem.
 * - POST e OPTIONS: JSON no corpo.
 * - GET: sem corpo; cada campo vira um parâmetro da query string
 *   (objetos como JSON, nulos omitidos). Textos longos podem estourar o
 *   limite de URL do servidor (~8 KB) — prefira POST quando possível.
 * Lança em erro de rede/timeout; status HTTP é devolvido para o chamador decidir.
 */
export async function deliver(
	target: ForwardTarget,
	body: string,
	timeoutMs: number,
	proxy?: WebhookProxy | null,
): Promise<{ status: number }> {
	const headers: Record<string, string> = {}
	if (target.token) headers.authorization = `Bearer ${target.token}`

	let url = target.url
	let reqBody: string | undefined
	if (target.method === 'GET') {
		const u = new URL(target.url)
		for (const [k, v] of Object.entries(JSON.parse(body) as Record<string, unknown>)) {
			if (v == null) continue
			u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
		}
		url = u.toString()
	} else {
		headers['content-type'] = 'application/json'
		reqBody = body
	}

	const dispatcher = proxy?.for(url)
	const res = await fetch(url, {
		method: target.method,
		headers,
		body: reqBody,
		signal: AbortSignal.timeout(timeoutMs),
		...(dispatcher ? { dispatcher: dispatcher as never } : {}),
	} as RequestInit)
	// Consome o corpo para liberar a conexão (keep-alive).
	await res.arrayBuffer().catch(() => undefined)
	return { status: res.status }
}
