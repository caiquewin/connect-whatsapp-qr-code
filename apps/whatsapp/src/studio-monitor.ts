// Acompanha, durante um teste, a EXECUÇÃO real do fluxo no Twilio Studio.
//
// O Studio manda a mensagem e fica esperando o cliente responder; enquanto
// isso, a cada TESTER_STUDIO_POLL_MS (10 s) consultamos a API de Executions:
//   1. execuções dos fluxos marcados, criadas depois do início do teste, cujo
//      contato é o número que está testando (o nosso);
//   2. os steps novos de cada execução (widget, de onde veio, para onde foi);
//   3. o contexto (log) dos widgets que decidem ou integram — decisões,
//      funções, HTTP, transferência para o Flex, respostas recebidas —
//      resumido e com segredos mascarados.
// Os passos entram na conversa (linha "Studio: …") e no prompt da IA, que
// passa a julgar o caminho REAL, inclusive o que não aparece no WhatsApp.
//
// SOMENTE LEITURA: só GET, só em studio.twilio.com, com API Key do ambiente
// (TWILIO_<DEV|QA|PROD>_API_KEY_SID/SECRET). Prefira uma API Key restrita.

import type { Config } from './config.js'
import { matchesAny } from './filters.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'studio-monitor' })

const API = 'https://studio.twilio.com/v2'
const TIMEOUT_MS = 15_000
const MAX_PAGES = 5
/** Contextos buscados por rodada (cada um é uma requisição). */
const MAX_CONTEXTS_PER_POLL = 25
const MAX_CONTEXT_CHARS = 1_200
const SECRET_KEY = /(token|secret|senha|password|passwd|apikey|api_key|authorization|auth|credential|private)/i
/** Tipos de widget cujo contexto explica o caminho (os outros só registram a transição). */
const CONTEXT_TYPES = new Set(['split-based-on', 'run-function', 'make-http-request', 'send-to-flex', 'run-subflow', 'send-and-wait-for-reply', 'gather-input-on-call', 'enqueue-call', 'connect-call-to'])

export type TwilioEnv = 'dev' | 'qa' | 'prod'
export const TWILIO_ENVS: readonly TwilioEnv[] = ['dev', 'qa', 'prod']

/**
 * Uma transição no Studio: o widget `from` terminou com o evento `event`
 * (incomingMessage, match, noMatch, success, fail…) e o fluxo seguiu para `to`.
 */
export type StudioStep = {
	at: string
	flow: string
	execution: string
	event: string
	from: string | null
	to: string | null
	/** Resumo do contexto do widget (saída da função, entrada da decisão…). */
	context: string | null
}

export type ExecutionInfo = { sid: string; flow: string; status: string; startedAt: string }

type Creds = { user: string; pass: string }

export function twilioCreds(cfg: Config['twilio'], env: TwilioEnv): Creds | null {
	const c = cfg[env]
	if (c.apiKeySid && c.apiKeySecret) return { user: c.apiKeySid, pass: c.apiKeySecret }
	if (c.accountSid && c.authToken) return { user: c.accountSid, pass: c.authToken }
	return null
}

export class StudioMonitor {
	private timer: NodeJS.Timeout | null = null
	/** Leituras em fila: a do intervalo e a forçada (pollNow) nunca rodam juntas. */
	private chain: Promise<void> = Promise.resolve()
	private stopped = false
	private sids = new Map<string, string>() // nome do fluxo → FW…
	private readonly seenSteps = new Set<string>()
	readonly executions = new Map<string, ExecutionInfo>()
	private lastError: string | null = null

	constructor(
		private readonly creds: Creds,
		/** Fluxos a acompanhar: nome, SID (quando o arquivo tem) e tipo de cada widget. */
		private readonly flows: { name: string; sid: string | null; types: Map<string, string> }[],
		/** Só dígitos do número que está testando (o contato da execução). */
		private readonly contactDigits: string,
		private readonly since: Date,
		private readonly pollMs: number,
		/** Chamado com os steps novos de cada rodada. */
		private readonly onSteps: (steps: StudioStep[]) => void,
		/** Erro de acesso à API (uma vez por mensagem diferente). */
		private readonly onError: (message: string) => void,
	) {}

	start(): void {
		const tick = () => {
			if (this.stopped) return
			void this.enqueue().finally(() => {
				if (!this.stopped) this.timer = setTimeout(tick, this.pollMs)
			})
		}
		// Primeira rodada logo: resolve os SIDs e já confere o acesso.
		tick()
	}

	/** Leitura imediata (antes de a IA decidir), depois da que estiver em andamento. */
	pollNow(): Promise<void> {
		return this.stopped ? Promise.resolve() : this.enqueue()
	}

	/** Para o intervalo e faz uma última leitura (pega os passos finais). */
	async stop(): Promise<void> {
		this.stopped = true
		if (this.timer) clearTimeout(this.timer)
		await this.enqueue()
	}

	private enqueue(): Promise<void> {
		this.chain = this.chain.then(() => this.poll())
		return this.chain
	}

	private async poll(): Promise<void> {
		try {
			await this.resolveSids()
			const fresh: StudioStep[] = []
			for (const [name, sid] of this.sids) {
				const execs = await this.list<{ sid: string; status: string; contact_channel_address?: string; date_created: string }>(
					`${API}/Flows/${sid}/Executions?DateCreatedFrom=${encodeURIComponent(new Date(this.since.getTime() - 60_000).toISOString())}&PageSize=50`,
					'executions',
				)
				for (const e of execs) {
					const contact = (e.contact_channel_address ?? '').replace(/\D/g, '')
					if (!contact || !matchesAny(contact, [this.contactDigits])) continue
					this.executions.set(e.sid, { sid: e.sid, flow: name, status: e.status, startedAt: e.date_created })
					fresh.push(...await this.newSteps(sid, name, e.sid))
				}
			}
			fresh.sort((a, b) => a.at.localeCompare(b.at))
			if (fresh.length) this.onSteps(fresh)
		} catch (err) {
			const message = (err as Error).message
			if (message !== this.lastError) {
				this.lastError = message
				log.warn({ err: message }, 'falha ao consultar a execução no Studio')
				this.onError(message)
			}
		}
	}

	private async newSteps(flowSid: string, flowName: string, execSid: string): Promise<StudioStep[]> {
		const steps = await this.list<{ sid: string; name: string; transitioned_from?: string; transitioned_to?: string; date_created: string }>(
			`${API}/Flows/${flowSid}/Executions/${execSid}/Steps?PageSize=100`,
			'steps',
		)
		const types = this.flows.find((f) => f.name === flowName)?.types
		const out: StudioStep[] = []
		let contexts = 0
		for (const s of steps.sort((a, b) => a.date_created.localeCompare(b.date_created))) {
			if (this.seenSteps.has(s.sid)) continue
			this.seenSteps.add(s.sid)
			const from = s.transitioned_from ?? null
			let context: string | null = null
			// Contexto (saída) do widget que acabou de rodar, se for dos que decidem/integram.
			if (from && contexts < MAX_CONTEXTS_PER_POLL && CONTEXT_TYPES.has(types?.get(from) ?? '')) {
				contexts++
				context = await this.stepContext(flowSid, execSid, s.sid, from).catch(() => null)
			}
			out.push({ at: s.date_created, flow: flowName, execution: execSid, event: s.name, from, to: s.transitioned_to ?? null, context })
		}
		return out
	}

	/** Contexto do widget que acabou de rodar (saída), resumido e mascarado. */
	private async stepContext(flowSid: string, execSid: string, stepSid: string, widget: string): Promise<string | null> {
		const data = await this.get(`${API}/Flows/${flowSid}/Executions/${execSid}/Steps/${stepSid}/Context`) as { context?: Record<string, unknown> }
		const ctx = data.context ?? {}
		const widgets = ctx.widgets as Record<string, unknown> | undefined
		const own = widgets?.[widget] ?? ctx
		const text = JSON.stringify(mask(own))
		return text && text !== '{}' ? (text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}…` : text) : null
	}

	/** SID de cada fluxo: do arquivo, ou pelo nome na API (exports não têm SID). */
	private async resolveSids(): Promise<void> {
		if (this.sids.size) return
		const missing = this.flows.filter((f) => !f.sid)
		let byName = new Map<string, string>()
		if (missing.length) {
			const all = await this.list<{ sid: string; friendly_name: string }>(`${API}/Flows?PageSize=200`, 'flows')
			byName = new Map(all.map((f) => [f.friendly_name, f.sid]))
		}
		for (const f of this.flows) {
			const sid = f.sid ?? byName.get(f.name)
			if (sid) this.sids.set(f.name, sid)
		}
		if (!this.sids.size) throw new Error('Nenhum dos fluxos marcados existe nesta conta Twilio (confira o ambiente)')
	}

	private async list<T>(url: string, key: string): Promise<T[]> {
		const out: T[] = []
		let next: string | null = url
		for (let page = 0; next && page < MAX_PAGES; page++) {
			const data = await this.get(next) as Record<string, unknown> & { meta?: { next_page_url?: string | null } }
			out.push(...((data[key] as T[] | undefined) ?? []))
			next = data.meta?.next_page_url ?? null
		}
		return out
	}

	/** Só GET e só em studio.twilio.com: a credencial nunca vai para outro host. */
	private async get(url: string): Promise<unknown> {
		const u = new URL(url)
		if (u.protocol !== 'https:' || u.hostname !== 'studio.twilio.com') throw new Error('URL fora da API do Studio')
		const res = await fetch(u, {
			method: 'GET',
			headers: { authorization: `Basic ${Buffer.from(`${this.creds.user}:${this.creds.pass}`).toString('base64')}`, accept: 'application/json' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		})
		if (res.status === 401 || res.status === 403) throw new Error(`Twilio recusou as credenciais (HTTP ${res.status}) — confira a API Key do ambiente`)
		if (res.status === 429) throw new Error('Twilio limitou as consultas (429); tentando de novo na próxima rodada')
		if (!res.ok) throw new Error(`API do Studio respondeu HTTP ${res.status}`)
		return res.json()
	}
}

/** Mascara valores de chaves que parecem segredo (recursivo). */
function mask(value: unknown, depth = 0): unknown {
	if (depth > 8 || value === null || typeof value !== 'object') return value
	if (Array.isArray(value)) return value.slice(0, 50).map((v) => mask(v, depth + 1))
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? '***' : mask(v, depth + 1)
	return out
}

/** Linha compacta para a conversa ao vivo: "Studio (Fluxo): A → B → C". */
export function describeSteps(steps: StudioStep[]): string {
	const byFlow = new Map<string, string[]>()
	for (const s of steps) if (s.to) byFlow.set(s.flow, [...(byFlow.get(s.flow) ?? []), s.to])
	return [...byFlow].map(([flow, ws]) => `Studio (${flow}): ${ws.length > 12 ? `${ws.slice(0, 5).join(' → ')} → … (${ws.length - 10}) → ${ws.slice(-5).join(' → ')}` : ws.join(' → ')}`).join('\n')
}

/** Passos para o prompt da IA (os mais recentes, limitados). */
export function stepsForPrompt(steps: StudioStep[], max = 150): string {
	const recent = steps.slice(-max)
	const lines = recent.map((s) => `- [${s.flow}] ${s.from ?? 'INÍCIO'} --${s.event}--> ${s.to ?? '(fim)'}${s.context ? ` · saída de ${s.from}: ${s.context}` : ''}`)
	return (steps.length > max ? `(${steps.length - max} passos anteriores omitidos)\n` : '') + lines.join('\n')
}
