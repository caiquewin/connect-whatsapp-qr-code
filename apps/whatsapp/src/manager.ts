// Gerencia várias conexões de WhatsApp no mesmo processo.
//
// Cada conexão tem pastas próprias, nomeadas pelo id:
//   AUTH_DIR/<id>/   sessão da Baileys
//   QUEUE_DIR/<id>/  fila de envio (um webhook fora do ar não trava as outras)
//
// E no banco (db.ts), por id de conexão: mensagens/conversas, mídia (arquivo
// em MEDIA_DIR/<id>/) e eventos (estado do socket, entregas do webhook).
//
// Regra que continua valendo: a mesma sessão nunca pode estar aberta em dois
// processos. Aqui cada id tem exatamente um socket.

import { EventEmitter } from 'node:events'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Config } from './config.js'
import { type ConnectionState, WhatsAppConnection, hasSavedSession } from './connection.js'
import type { ChangeBus } from './changes.js'
import type { EventLog } from './events.js'
import { Forwarder, type QueueKind } from './forwarder.js'
import { type MediaDownloader, documentFileName } from './media.js'
import type { MessageStore } from './messages.js'
import { type ProxyConfig, type WebhookProxy, maskProxy } from './proxy.js'
import type { NormalizedMessage } from './normalizer.js'
import type { WASocket } from '@whiskeysockets/baileys'
import { attachListener } from './listener.js'
import { logger } from './logger.js'
import { type Filters, defaultFilters } from './filters.js'
import type { ConnectionConfig, ConnectionsStore, ForwardTarget } from './settings.js'

const log = logger.child({ module: 'manager' })

type Instance = { connection: WhatsAppConnection; forwarder: Forwarder }

/** Onde cada conexão grava o que captura. */
export type ManagerDeps = {
	messages: MessageStore
	media: MediaDownloader
	events: EventLog
	changes: ChangeBus
	/** Proxy global das entregas ao webhook (null = direto). */
	webhookProxy: WebhookProxy | null
}

export type ConnectionView = {
	id: string
	friendlyName: string
	createdAt: string
	webhook: { url: string; method: string; tokenSet: boolean } | null
	filters: Filters
	/** Sem a senha: esquema://host:porta, usuário e se há senha salva. */
	proxy: { url: string; username: string; passwordSet: boolean } | null
	state: ConnectionState
	queue: Awaited<ReturnType<Forwarder['stats']>>
}

export class ConnectionManager {
	private readonly instances = new Map<string, Instance>()
	/** 'message' (connectionId, msg): toda mensagem ao vivo de qualquer conexão. */
	readonly events = new EventEmitter<{ message: [string, NormalizedMessage] }>()

	constructor(
		private readonly store: ConnectionsStore,
		private readonly cfg: Config,
		private readonly deps: ManagerDeps,
	) {}

	async init(): Promise<void> {
		await this.migrateLegacyDirs()
		for (const item of this.store.list()) {
			const inst = await this.createInstance(item)
			// Sessão já pareada: reconecta sozinho. Sem sessão, espera "Gerar QR".
			if (await hasSavedSession(this.authDir(item.id))) {
				inst.connection.start().catch((err) => log.error({ err, id: item.id }, 'falha ao conectar'))
			}
		}
	}

	async list(): Promise<ConnectionView[]> {
		return Promise.all(this.store.list().map((c) => this.view(c)))
	}

	/** Visão atual de uma conexão (null se foi excluída). Usada pelo push SSE. */
	async viewOf(id: string): Promise<ConnectionView | null> {
		const c = this.store.get(id)
		return c && this.instances.has(id) ? this.view(c) : null
	}

	has(id: string): boolean {
		return this.instances.has(id)
	}

	getSocket(id: string): WASocket | null {
		return this.instances.get(id)?.connection.getSocket() ?? null
	}

	friendlyName(id: string): string {
		return this.store.get(id)?.friendlyName ?? id
	}

	/** Cria a conexão e já inicia o pareamento (gera o QR). */
	async create(friendlyName: string): Promise<ConnectionConfig> {
		if (this.store.list().length >= this.cfg.maxConnections) {
			throw new Error(`Limite de ${this.cfg.maxConnections} conexões atingido (MAX_CONNECTIONS)`)
		}
		const item = await this.store.create(friendlyName)
		const inst = await this.createInstance(item)
		this.deps.changes.bump('connections', item.id)
		await inst.connection.start()
		log.info({ id: item.id, friendlyName }, 'conexão criada')
		return item
	}

	/**
	 * Desconecta (remove de "Aparelhos conectados"), apaga sessão, fila e mídia e
	 * tira do cadastro — o banco apaga em cascata fluxos, execuções, conversas e eventos.
	 */
	async remove(id: string): Promise<void> {
		const inst = this.instances.get(id)
		if (inst) {
			await inst.connection.logout()
			await inst.connection.cancel()
			await inst.connection.close()
			await inst.forwarder.destroy()
			this.instances.delete(id)
		}
		await rm(this.authDir(id), { recursive: true, force: true })
		await this.store.remove(id)
		await this.deps.media.removeConnection(id)
		// Cascata no banco: tudo que era desta conexão sumiu.
		for (const topic of ['connections', 'tests', 'messages', 'events'] as const) this.deps.changes.bump(topic, id)
		log.info({ id }, 'conexão excluída')
	}

	connect(id: string): Promise<void> {
		return this.get(id).connection.start()
	}

	cancel(id: string): Promise<void> {
		return this.get(id).connection.cancel()
	}

	logout(id: string): Promise<void> {
		return this.get(id).connection.logout()
	}

	async setName(id: string, friendlyName: string): Promise<void> {
		await this.store.update(id, { friendlyName })
		this.deps.changes.bump('connections', id)
	}

	async setWebhook(id: string, webhook: ForwardTarget | null): Promise<void> {
		await this.store.update(id, { webhook })
		this.deps.changes.bump('connections', id)
		// Webhook novo: tenta já, sem esperar o backoff do anterior.
		this.get(id).forwarder.nudge()
	}

	async setFilters(id: string, filters: Filters): Promise<void> {
		this.get(id)
		await this.store.update(id, { filters })
		this.deps.changes.bump('connections', id)
	}

	/** Itens da fila do webhook desta conexão (pendentes ou rejeitados). */
	queueItems(id: string, kind: QueueKind, offset: number, limit: number) {
		return this.get(id).forwarder.listItems(kind, offset, limit)
	}

	/**
	 * Exclui itens da fila sem enviar ao webhook. As mensagens continuam no
	 * banco; fica um evento 'webhook/discarded' para auditoria.
	 */
	async discardQueue(id: string, kind: QueueKind, files: string[] | 'all'): Promise<number> {
		const removed = await this.get(id).forwarder.removeItems(kind, files)
		if (removed) this.deps.events.record(id, 'webhook', 'discarded', { kind, count: removed, all: files === 'all' })
		return removed
	}

	/**
	 * Troca o proxy de saída. Com o socket ativo, reconecta na hora pela mesma
	 * sessão (sem QR); parado, vale na próxima conexão.
	 */
	async setProxy(id: string, proxy: ProxyConfig | null): Promise<void> {
		const inst = this.get(id)
		await this.store.update(id, { proxy })
		this.deps.changes.bump('connections', id)
		log.info({ id, proxy: proxy ? maskProxy(proxy) : null }, 'proxy da conexão alterado')
		await inst.connection.restart()
	}

	async shutdown(drainMs: number): Promise<void> {
		const all = [...this.instances.values()]
		await Promise.all(all.map((i) => i.connection.close().catch((err) => log.warn({ err }, 'erro ao fechar socket'))))
		await Promise.all(all.map((i) => i.forwarder.stop(drainMs)))
	}

	private get(id: string): Instance {
		const inst = this.instances.get(id)
		if (!inst) throw new Error('conexão não encontrada')
		return inst
	}

	private async view(c: ConnectionConfig): Promise<ConnectionView> {
		const inst = this.get(c.id)
		return {
			id: c.id,
			friendlyName: c.friendlyName,
			createdAt: c.createdAt,
			webhook: c.webhook && { url: c.webhook.url, method: c.webhook.method, tokenSet: c.webhook.token.length > 0 },
			filters: c.filters,
			proxy: c.proxy && { url: maskProxy(c.proxy), username: c.proxy.username, passwordSet: c.proxy.password.length > 0 },
			state: inst.connection.getState(),
			queue: await inst.forwarder.stats(),
		}
	}

	private async createInstance(item: ConnectionConfig): Promise<Instance> {
		const { id } = item
		await mkdir(this.authDir(id), { recursive: true })
		const queueDir = path.join(this.cfg.queueDir, id)
		await mkdir(queueDir, { recursive: true })

		// Lê sempre do cadastro: nome e webhook editados valem na hora.
		const current = () => this.store.get(id)
		const { messages, media, events: eventLog, changes, webhookProxy } = this.deps
		const forwarder = new Forwarder(this.cfg.forward, queueDir, () => current()?.webhook ?? null, id, {
			proxy: webhookProxy,
			onChange: () => changes.bump('connections', id),
			onAttempt: (a) =>
				eventLog.record(id, 'webhook', a.result, { status: a.status, error: a.error, ms: a.ms, method: a.method, host: a.host }, a.messageId),
		})
		await forwarder.start()

		const connection: WhatsAppConnection = new WhatsAppConnection({
			id,
			authDir: this.authDir(id),
			syncHistory: this.cfg.capture.history,
			getProxy: () => current()?.proxy ?? null,
			onUpdate: () => changes.bump('connections', id),
			onStateChange: (status, detail) => eventLog.record(id, 'connection', status, detail),
			onSocket: (sock) =>
				attachListener(sock, forwarder, {
					history: this.cfg.capture.history,
					getInstance: () => current()?.friendlyName ?? '',
					hasWebhook: () => current()?.webhook != null,
					getFilters: () =>
						current()?.filters ?? defaultFilters({ fromMe: this.cfg.capture.fromMe, groups: this.cfg.capture.groups }),
					onMessage: (msg) => this.events.emit('message', id, msg),
					onCaptured: (msg, raw, forwarded) => {
						const mediaId = messages.save(id, msg, forwarded, documentFileName(raw))
						// Mídia sai pelo mesmo proxy do socket.
						if (mediaId !== null) media.enqueue({ mediaId, connectionId: id, sock, raw, msg, dispatcher: connection.getFetchDispatcher() })
					},
				}),
		})

		const inst = { connection, forwarder }
		this.instances.set(id, inst)
		return inst
	}

	private authDir(id: string): string {
		return path.join(this.cfg.authDir, id)
	}

	/**
	 * Versão anterior (uma conexão só) guardava sessão e fila direto na raiz de
	 * AUTH_DIR/QUEUE_DIR. Move esses arquivos para a pasta da primeira conexão.
	 */
	private async migrateLegacyDirs(): Promise<void> {
		const first = this.store.list()[0]
		if (!first) return
		const moveFiles = async (from: string, to: string, filter: (name: string) => boolean) => {
			const entries = await readdir(from, { withFileTypes: true }).catch(() => [])
			const files = entries.filter((e) => e.isFile() && filter(e.name))
			if (!files.length) return 0
			await mkdir(to, { recursive: true })
			for (const f of files) await rename(path.join(from, f.name), path.join(to, f.name))
			return files.length
		}
		const auth = await moveFiles(this.cfg.authDir, this.authDir(first.id), () => true)
		const queueTo = path.join(this.cfg.queueDir, first.id)
		const queued = await moveFiles(this.cfg.queueDir, queueTo, (n) => n.endsWith('.json'))
		const failed = await moveFiles(path.join(this.cfg.queueDir, 'failed'), path.join(queueTo, 'failed'), (n) => n.endsWith('.json'))
		await rm(path.join(this.cfg.queueDir, 'failed'), { recursive: true, force: true })
		if (auth || queued || failed) log.info({ id: first.id, auth, queued, failed }, 'arquivos da versão anterior migrados')
	}
}
