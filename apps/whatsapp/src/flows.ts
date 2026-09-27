// Fluxos de teste com IA (tabela `flows`). Um fluxo pertence a uma conexão (o
// número que ENVIA) e define o cenário: número sob teste, tarefa, regras de
// negócio e tempos. Cada conexão pode ter vários fluxos, e cada fluxo várias
// execuções (tester.ts / tabela test_runs).
//
// Referência opcional (o que o atendimento DEVERIA fazer):
// - card da demanda: texto colado, Azure DevOps ou Jira (cards.ts, só leitura);
// - fluxo desenvolvido no Twilio Studio: pasta do projeto ou JSON anexado (studio.ts).
// Com referência, a tarefa pode ficar vazia: a IA monta o cenário a partir dela.
//
// Editar um fluxo não altera execuções antigas: cada execução guarda uma cópia
// do cenário (coluna input) e da referência usada no momento em que rodou.

import { randomBytes } from 'node:crypto'
import type { ChangeBus } from './changes.js'
import type { Db, Row } from './db.js'
import { parseJson } from './db.js'
import { type CardConfig, parseCardConfig } from './cards.js'
import { isValidId } from './settings.js'
import { type PathLocation, resolveProjectPath } from './studio.js'
import { TWILIO_ENVS, type TwilioEnv } from './studio-monitor.js'

/** De onde vem o fluxo do Studio usado como referência. */
export type StudioConfig = (
	| { mode: 'project'; projectPath: string; location: PathLocation; file: string }
	| { mode: 'upload'; uploadId: number; fileName: string }
) & {
	flows: string[]
	includeSubflows: boolean
	/** Acompanhar a execução real no Twilio (conta do ambiente) durante o teste. null = não. */
	monitorEnv: TwilioEnv | null
}

export type FlowInput = {
	connectionId: string
	name: string
	/** Telefone sob teste, só dígitos com DDI. */
	to: string
	task: string
	rules: string[]
	maxTurns: number
	/** Quanto esperar pela 1ª resposta a cada mensagem enviada. */
	replyTimeoutSec: number
	/** Silêncio que encerra uma rajada de respostas (bots mandam várias seguidas). */
	quietSec: number
	/** Card da demanda (referência). */
	card: CardConfig | null
	/** Fluxo do Twilio Studio (referência). */
	studio: StudioConfig | null
}

export type Flow = FlowInput & { id: string; createdAt: string; updatedAt: string }

/** Resumo da última execução, para a lista de fluxos. */
export type FlowView = Flow & { runs: number; lastRun: { id: string; status: string; createdAt: string } | null }

const MAX_NAME = 80

/** Valida o corpo vindo da interface. Lança com mensagem legível. */
export function parseFlowInput(body: Record<string, unknown>): FlowInput {
	const connectionId = String(body.connectionId ?? '')
	if (!isValidId(connectionId)) throw new Error('Escolha a conexão que vai enviar')
	const name = String(body.name ?? '').trim()
	if (!name) throw new Error('Dê um nome ao fluxo')
	if (name.length > MAX_NAME) throw new Error(`Nome com no máximo ${MAX_NAME} caracteres`)
	let to = String(body.to ?? '').replace(/\D/g, '')
	if (to.length === 10 || to.length === 11) to = `55${to}`
	if (to.length < 10 || to.length > 15) throw new Error('Telefone de destino inválido')
	const card = parseCardConfig(body.card)
	const studio = parseStudioConfig(body.studio)
	const task = String(body.task ?? '').trim()
	if (!task && !card && !studio) throw new Error('Descreva a tarefa do teste (ou informe o card / o fluxo do Studio)')
	if (task.length > 4000) throw new Error('Tarefa com no máximo 4000 caracteres')
	const rawRules = Array.isArray(body.rules) ? body.rules : String(body.rules ?? '').split('\n')
	const rules = rawRules.map((r) => String(r).trim()).filter(Boolean)
	if (rules.length > 30) throw new Error('No máximo 30 regras')
	if (rules.some((r) => r.length > 500)) throw new Error('Cada regra com no máximo 500 caracteres')
	const num = (value: unknown, def: number, min: number, max: number, label: string) => {
		if (value === undefined || value === null || value === '') return def
		const n = Number(value)
		if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} deve estar entre ${min} e ${max}`)
		return n
	}
	return {
		connectionId,
		name,
		to,
		task,
		rules,
		maxTurns: num(body.maxTurns, 8, 1, 30, 'Máximo de mensagens'),
		replyTimeoutSec: num(body.replyTimeoutSec, 60, 10, 600, 'Espera por resposta'),
		quietSec: num(body.quietSec, 6, 2, 60, 'Silêncio entre respostas'),
		card,
		studio,
	}
}

export function parseStudioConfig(input: unknown): StudioConfig | null {
	const obj = (input ?? {}) as Record<string, unknown>
	const mode = String(obj.mode ?? '')
	if (!mode || mode === 'none') return null
	const flows = (Array.isArray(obj.flows) ? obj.flows : []).map((f) => String(f).trim()).filter(Boolean)
	if (!flows.length) throw new Error('Escolha ao menos um fluxo do Studio')
	if (flows.length > 30) throw new Error('No máximo 30 fluxos do Studio')
	const includeSubflows = obj.includeSubflows !== false
	const monitorEnv = TWILIO_ENVS.includes(obj.monitorEnv as TwilioEnv) ? (obj.monitorEnv as TwilioEnv) : null
	if (mode === 'project') {
		const location: PathLocation = obj.location === 'windows' ? 'windows' : 'wsl'
		const projectPath = String(obj.projectPath ?? '').trim()
		resolveProjectPath(projectPath, location) // só valida o formato; a leitura é na execução
		const file = String(obj.file ?? '').trim()
		if (!file || file.length > 500 || !file.endsWith('.json')) throw new Error('Escolha o arquivo de fluxos do projeto')
		return { mode, projectPath, location, file, flows, includeSubflows, monitorEnv }
	}
	if (mode === 'upload') {
		const uploadId = Number(obj.uploadId)
		if (!Number.isSafeInteger(uploadId) || uploadId <= 0) throw new Error('Anexe o JSON do fluxo')
		return { mode, uploadId, fileName: String(obj.fileName ?? 'fluxo.json').slice(0, 200), flows, includeSubflows, monitorEnv }
	}
	throw new Error('Origem do fluxo do Studio inválida')
}

export class FlowStore {
	constructor(
		private readonly db: Db,
		private readonly changes: ChangeBus,
	) {}

	/** Fluxos de uma conexão (ou de todas), com contagem e última execução. */
	list(connectionId?: string): FlowView[] {
		const rows = this.db.prepare(`
			SELECT f.*,
				(SELECT COUNT(*) FROM test_runs r WHERE r.flow_id = f.id) AS runs,
				(SELECT json_object('id', r.id, 'status', r.status, 'createdAt', r.created_at)
					FROM test_runs r WHERE r.flow_id = f.id ORDER BY r.created_at DESC LIMIT 1) AS last_run
			FROM flows f
			${connectionId ? 'WHERE f.connection_id = ?' : ''}
			ORDER BY f.name COLLATE NOCASE
		`).all(...(connectionId ? [connectionId] : []))
		return rows.map((r) => ({ ...fromRow(r), runs: Number(r.runs), lastRun: parseJson(r.last_run, null) }))
	}

	get(id: string): Flow | undefined {
		const r = this.db.prepare('SELECT * FROM flows WHERE id = ?').get(id)
		return r ? fromRow(r) : undefined
	}

	create(input: FlowInput): Flow {
		let id: string
		do id = randomBytes(4).toString('hex')
		while (this.get(id))
		const now = new Date().toISOString()
		const flow: Flow = { ...input, id, createdAt: now, updatedAt: now }
		this.db.prepare(`
			INSERT INTO flows (id, connection_id, name, to_phone, task, rules, max_turns, reply_timeout_sec, quiet_sec, card, studio, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(id, input.connectionId, input.name, input.to, input.task, JSON.stringify(input.rules),
			input.maxTurns, input.replyTimeoutSec, input.quietSec, json(input.card), json(input.studio), now, now)
		this.changes.bump('tests')
		return flow
	}

	/** A conexão do fluxo não muda na edição (as execuções antigas pertencem a ela). */
	update(id: string, input: Omit<FlowInput, 'connectionId'>): Flow | undefined {
		const now = new Date().toISOString()
		this.db.prepare(`
			UPDATE flows SET name = ?, to_phone = ?, task = ?, rules = ?, max_turns = ?, reply_timeout_sec = ?, quiet_sec = ?,
				card = ?, studio = ?, updated_at = ?
			WHERE id = ?
		`).run(input.name, input.to, input.task, JSON.stringify(input.rules), input.maxTurns, input.replyTimeoutSec, input.quietSec,
			json(input.card), json(input.studio), now, id)
		this.changes.bump('tests')
		return this.get(id)
	}

	/** Apaga o fluxo e, em cascata, as execuções dele. */
	remove(id: string): void {
		this.db.prepare('DELETE FROM flows WHERE id = ?').run(id)
		this.changes.bump('tests')
	}

	/** Guarda um JSON do Studio anexado na interface (já validado). */
	saveUpload(fileName: string, content: string): number {
		const r = this.db.prepare('INSERT INTO studio_uploads (file_name, content, created_at) VALUES (?, ?, ?)')
			.run(fileName, content, new Date().toISOString())
		return Number(r.lastInsertRowid)
	}

	getUpload(id: number): { fileName: string; content: string } | undefined {
		const r = this.db.prepare('SELECT file_name, content FROM studio_uploads WHERE id = ?').get(id)
		return r ? { fileName: String(r.file_name), content: String(r.content) } : undefined
	}

	/** Anexos que nenhum fluxo usa (anexou e não salvou, ou trocou) e têm mais de 1 dia. */
	pruneUploads(): number {
		const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
		const { changes } = this.db.prepare(`
			DELETE FROM studio_uploads
			WHERE created_at < ?
				AND id NOT IN (SELECT json_extract(studio, '$.uploadId') FROM flows WHERE json_extract(studio, '$.mode') = 'upload')
		`).run(cutoff)
		return Number(changes)
	}
}

const json = (value: object | null): string | null => (value ? JSON.stringify(value) : null)

function fromRow(r: Row): Flow {
	return {
		id: String(r.id),
		connectionId: String(r.connection_id),
		name: String(r.name),
		to: String(r.to_phone),
		task: String(r.task),
		rules: parseJson<string[]>(r.rules, []),
		maxTurns: Number(r.max_turns),
		replyTimeoutSec: Number(r.reply_timeout_sec),
		quietSec: Number(r.quiet_sec),
		card: parseJson<CardConfig | null>(r.card, null),
		studio: parseJson<StudioConfig | null>(r.studio, null),
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
	}
}
