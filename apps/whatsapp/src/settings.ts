// Cadastro das conexões (um número de WhatsApp cada), salvo na tabela
// `connections` do banco. Cada conexão tem nome amigável, webhook e filtros próprios.
//
// O cadastro inteiro fica também em memória (poucas linhas) e é atualizado a
// cada escrita: o listener/forwarder leem daqui a cada mensagem sem ir ao disco.
// Versões anteriores guardavam em SETTINGS_DIR/connections.json (e antes disso
// settings.json); os dois são migrados uma vez e renomeados para *.migrated.

import { randomBytes } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { type Db, type Row, parseJson, tx } from './db.js'
import { type Filters, parseFilters } from './filters.js'
import { type ProxyConfig, parseProxy } from './proxy.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'settings' })

export const METHODS = ['POST', 'GET', 'OPTIONS'] as const
export type Method = (typeof METHODS)[number]

export type ForwardTarget = {
	url: string
	method: Method
	/** Enviado como "Authorization: Bearer <token>". Vazio = sem header. */
	token: string
}

export type ConnectionConfig = {
	id: string
	friendlyName: string
	/** null = ainda não configurado; as mensagens aguardam na fila. */
	webhook: ForwardTarget | null
	/** O que encaminhar (enviadas/recebidas, telefones, grupos). */
	filters: Filters
	/** Proxy de saída do WhatsApp desta conexão. null = direto. Tem credenciais: não sai para a UI. */
	proxy: ProxyConfig | null
	createdAt: string
}

const MAX_NAME = 60
const ID_RE = /^[a-f0-9]{8}$/

/** Ids viram nomes de pasta: só aceitamos o formato que nós mesmos geramos. */
export const isValidId = (id: string): boolean => ID_RE.test(id)

/** Valida e normaliza um destino vindo da UI ou do arquivo. Lança com mensagem legível. */
export function parseTarget(input: unknown): ForwardTarget {
	const obj = (input ?? {}) as Record<string, unknown>
	const url = String(obj.url ?? '').trim()
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new Error('URL inválida')
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('A URL precisa começar com http:// ou https://')
	}
	const method = String(obj.method ?? 'POST').toUpperCase()
	if (!METHODS.includes(method as Method)) throw new Error(`Método deve ser ${METHODS.join(', ')}`)
	return { url, method: method as Method, token: String(obj.token ?? '').trim() }
}

export function parseFriendlyName(input: unknown): string {
	const name = String(input ?? '').trim()
	if (!name) throw new Error('Informe um nome para a conexão')
	if (name.length > MAX_NAME) throw new Error(`Nome com no máximo ${MAX_NAME} caracteres`)
	return name
}

export class ConnectionsStore {
	private items: ConnectionConfig[] = []

	/** @param defaultFilters filtros de conexões novas ou salvas antes de existirem filtros */
	constructor(
		private readonly db: Db,
		private readonly legacyDir: string,
		private readonly defaultFilters: Filters,
	) {}

	async load(): Promise<void> {
		await this.migrateLegacy()
		this.items = this.db.prepare('SELECT * FROM connections ORDER BY created_at').all().map((r) => this.fromRow(r))
		log.info({ connections: this.items.length }, 'conexões carregadas')
	}

	list(): readonly ConnectionConfig[] {
		return this.items
	}

	get(id: string): ConnectionConfig | undefined {
		return this.items.find((c) => c.id === id)
	}

	async create(friendlyName: string, webhook: ForwardTarget | null = null): Promise<ConnectionConfig> {
		let id: string
		do id = randomBytes(4).toString('hex')
		while (this.get(id))
		const item: ConnectionConfig = {
			id,
			friendlyName,
			webhook,
			filters: this.defaultFilters,
			proxy: null,
			createdAt: new Date().toISOString(),
		}
		this.insert(item)
		this.items = [...this.items, item]
		return item
	}

	async update(id: string, patch: Partial<Pick<ConnectionConfig, 'friendlyName' | 'webhook' | 'filters' | 'proxy'>>): Promise<void> {
		const current = this.get(id)
		if (!current) return
		const next = { ...current, ...patch }
		this.db.prepare('UPDATE connections SET friendly_name = ?, webhook = ?, filters = ?, proxy = ? WHERE id = ?')
			.run(next.friendlyName, json(next.webhook), JSON.stringify(next.filters), json(next.proxy), id)
		this.items = this.items.map((c) => (c.id === id ? next : c))
	}

	/** Apaga a conexão e, em cascata, fluxos, execuções, conversas, mídia (registros) e eventos dela. */
	async remove(id: string): Promise<void> {
		this.db.prepare('DELETE FROM connections WHERE id = ?').run(id)
		this.items = this.items.filter((c) => c.id !== id)
	}

	private insert(c: ConnectionConfig): void {
		this.db.prepare('INSERT INTO connections (id, friendly_name, webhook, filters, proxy, created_at) VALUES (?, ?, ?, ?, ?, ?)')
			.run(c.id, c.friendlyName, json(c.webhook), JSON.stringify(c.filters), json(c.proxy), c.createdAt)
	}

	private fromRow(r: Row): ConnectionConfig {
		const webhook = parseJson<unknown>(r.webhook, null)
		const proxy = parseJson<unknown>(r.proxy, null)
		return {
			id: String(r.id),
			friendlyName: String(r.friendly_name),
			webhook: webhook ? parseTarget(webhook) : null,
			filters: parseFilters(parseJson(r.filters, this.defaultFilters)),
			proxy: proxy ? parseProxy(proxy) : null,
			createdAt: String(r.created_at),
		}
	}

	/**
	 * Migra connections.json (ou o settings.json ainda mais antigo, de uma
	 * conexão só) para o banco, se o banco ainda estiver vazio.
	 */
	private async migrateLegacy(): Promise<void> {
		const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM connections').get() as Row).n)
		if (count > 0) return

		const file = path.join(this.legacyDir, 'connections.json')
		const raw = await readJsonFile<ConnectionConfig[]>(file)
		if (raw) {
			const items = raw.filter((c) => isValidId(c.id)).map((c) => ({
				id: c.id,
				friendlyName: parseFriendlyName(c.friendlyName),
				webhook: c.webhook ? parseTarget(c.webhook) : null,
				filters: c.filters ? parseFilters(c.filters) : this.defaultFilters,
				proxy: null,
				createdAt: c.createdAt ?? new Date().toISOString(),
			}))
			tx(this.db, () => items.forEach((c) => this.insert(c)))
			await rename(file, `${file}.migrated`)
			log.info({ connections: items.length }, 'connections.json migrado para o banco')
			return
		}

		const legacy = path.join(this.legacyDir, 'settings.json')
		const old = await readJsonFile<{ friendlyName?: string; forward?: unknown }>(legacy)
		if (old) {
			const name = old.friendlyName?.trim() || 'Conexão principal'
			await this.create(name, old.forward ? parseTarget(old.forward) : null)
			await rename(legacy, `${legacy}.migrated`)
			log.info({ friendlyName: name }, 'settings.json migrado para o banco')
		}
	}
}

const json = (value: object | null): string | null => (value ? JSON.stringify(value) : null)

/** Lê um JSON; null se o arquivo não existir. */
async function readJsonFile<T>(file: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(file, 'utf8')) as T
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw err
	}
}
