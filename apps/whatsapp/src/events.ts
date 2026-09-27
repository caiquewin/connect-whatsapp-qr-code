// Log de eventos no banco (tabela `events`), para consultar depois o que aconteceu:
//   connection  mudanças de estado do socket (connecting, qr, open, reconnecting, idle + motivo/código)
//   webhook     cada tentativa de entrega (ok, retry, drop) com status HTTP e duração
//   test        execução dos testes (início, passos da IA, envios, respostas, veredito)
//
// Mesma regra dos logs: só metadados. Nunca texto de mensagem, token ou QR.
// Uma falha ao gravar evento nunca derruba quem chamou (só vai para o log).

import type { ChangeBus } from './changes.js'
import type { Db, Row } from './db.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'events' })

export type EventKind = 'connection' | 'webhook' | 'test'

export type EventEntry = {
	id: number
	at: string
	connectionId: string | null
	kind: EventKind
	type: string
	ref: string | null
	data: Record<string, unknown> | null
}

export type EventQuery = {
	connectionId?: string
	kind?: EventKind
	ref?: string
	/** Paginação: só eventos com id menor que este (mais antigos). */
	before?: number
	limit?: number
}

export const EVENT_KINDS: readonly EventKind[] = ['connection', 'webhook', 'test']

const DAY_MS = 24 * 60 * 60 * 1000

export class EventLog {
	private pruneTimer: NodeJS.Timeout | null = null

	constructor(
		private readonly db: Db,
		private readonly retentionDays: number,
		private readonly changes: ChangeBus,
	) {}

	record(connectionId: string | null, kind: EventKind, type: string, data?: Record<string, unknown> | null, ref?: string | null): void {
		try {
			this.db.prepare('INSERT INTO events (at, connection_id, kind, type, ref, data) VALUES (?, ?, ?, ?, ?, ?)')
				.run(new Date().toISOString(), connectionId, kind, type, ref ?? null, data ? JSON.stringify(data) : null)
			this.changes.bump('events')
		} catch (err) {
			// Ex.: conexão acabou de ser excluída (FK). O evento se perde, o fluxo segue.
			log.warn({ err: (err as Error).message, kind, type }, 'falha ao gravar evento')
		}
	}

	list(q: EventQuery = {}): EventEntry[] {
		const where: string[] = []
		const params: (string | number)[] = []
		const add = (clause: string, value: string | number | undefined) => {
			if (!value) return
			where.push(clause)
			params.push(value)
		}
		add('connection_id = ?', q.connectionId)
		add('kind = ?', q.kind)
		add('ref = ?', q.ref)
		add('id < ?', q.before)
		const limit = Math.min(Math.max(q.limit ?? 100, 1), 500)
		const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`
		return this.db.prepare(sql).all(...params).map(fromRow)
	}

	/** Apaga eventos antigos agora e depois uma vez por dia. */
	startPruning(): void {
		if (!this.retentionDays) return
		this.prune()
		this.pruneTimer = setInterval(() => this.prune(), DAY_MS)
		this.pruneTimer.unref()
	}

	stop(): void {
		if (this.pruneTimer) clearInterval(this.pruneTimer)
	}

	private prune(): void {
		const cutoff = new Date(Date.now() - this.retentionDays * DAY_MS).toISOString()
		const { changes } = this.db.prepare('DELETE FROM events WHERE at < ?').run(cutoff)
		if (changes) log.info({ removed: Number(changes), retentionDays: this.retentionDays }, 'eventos antigos apagados')
	}
}

function fromRow(r: Row): EventEntry {
	return {
		id: Number(r.id),
		at: String(r.at),
		connectionId: (r.connection_id as string | null) ?? null,
		kind: r.kind as EventKind,
		type: String(r.type),
		ref: (r.ref as string | null) ?? null,
		data: typeof r.data === 'string' ? (JSON.parse(r.data) as Record<string, unknown>) : null,
	}
}
