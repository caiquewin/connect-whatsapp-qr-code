// Barramento de mudanças: cada escrita relevante incrementa a versão de um
// tópico. Serve para duas coisas, que juntas substituem o polling de 2 s da
// interface (e as leituras repetidas no banco/disco que ele causava):
//
// - Cache de leitura da API (admin.ts): uma resposta GET fica guardada com as
//   versões dos tópicos de que depende; enquanto nenhuma mudar, é servida da
//   memória (ou 304) sem consultar banco nem disco.
// - Push para a página (SSE /api/stream): para conexões, o próprio estado
//   atualizado de cada conexão que mudou vai no evento (a página não busca
//   nada); para os outros tópicos, avisa quais mudaram.
//
// É in-process de propósito: um processo só (invariante 1) e SQLite local não
// justificam um Redis — seria mais um serviço, mais latência e o mesmo problema
// de invalidação.

import { EventEmitter } from 'node:events'

export type Topic = 'connections' | 'tests' | 'messages' | 'events'

/** O que mudou num intervalo de agrupamento. */
export type ChangeSet = {
	topics: Topic[]
	/** Ids das conexões cujo estado/cadastro/fila mudou (tópico 'connections'). */
	connections: string[]
}

/** Rajadas (ex.: histórico, fila drenando) viram uma notificação a cada 300 ms. */
const THROTTLE_MS = 300

export class ChangeBus {
	private readonly versions = new Map<Topic, number>()
	private readonly pending = new Set<Topic>()
	private readonly pendingConnections = new Set<string>()
	private timer: NodeJS.Timeout | null = null
	private readonly emitter = new EventEmitter<{ change: [ChangeSet] }>()

	constructor() {
		// Uma conexão SSE por aba aberta; o limite real fica no admin.ts.
		this.emitter.setMaxListeners(0)
	}

	/**
	 * Marca o tópico como alterado. Barato: pode chamar a cada escrita.
	 * Para 'connections', informe o id da conexão (o SSE manda só ela).
	 */
	bump(topic: Topic, connectionId?: string): void {
		this.versions.set(topic, this.version(topic) + 1)
		this.pending.add(topic)
		if (connectionId) this.pendingConnections.add(connectionId)
		if (this.timer) return
		this.timer = setTimeout(() => {
			this.timer = null
			const change: ChangeSet = { topics: [...this.pending], connections: [...this.pendingConnections] }
			this.pending.clear()
			this.pendingConnections.clear()
			this.emitter.emit('change', change)
		}, THROTTLE_MS)
		this.timer.unref()
	}

	version(topic: Topic): number {
		return this.versions.get(topic) ?? 0
	}

	/** Assina as notificações; devolve a função que cancela. */
	subscribe(fn: (change: ChangeSet) => void): () => void {
		this.emitter.on('change', fn)
		return () => this.emitter.off('change', fn)
	}
}
