// Cache das respostas GET da API admin, invalidado por versão (changes.ts).
//
// Cada entrada guarda o JSON pronto + o "carimbo" (versões dos tópicos de que
// a rota depende). Enquanto o carimbo não muda, a resposta sai da memória —
// sem consultar SQLite, sem readdir da fila, sem gerar SVG de QR — e, se o
// navegador mandar If-None-Match igual, nem o corpo trafega (304).
//
// Correção antes de economia: o carimbo é lido ANTES de calcular. Se algo mudar
// durante o cálculo, a entrada nasce com carimbo velho e a próxima leitura
// recalcula; nunca serve dado velho como novo.

import { randomBytes } from 'node:crypto'
import type { ChangeBus, Topic } from './changes.js'

type Entry = { stamp: string; etag: string; body: string }

const MAX_ENTRIES = 300
/** Teto de memória: listas de mensagens podem ser grandes. */
const MAX_BYTES = 16 * 1024 * 1024

export class ReadCache {
	private readonly entries = new Map<string, Entry>()
	private bytes = 0
	/** ETag muda a cada boot: versões recomeçam do zero ao reiniciar. */
	private readonly boot = randomBytes(4).toString('hex')

	constructor(private readonly changes: ChangeBus) {}

	async get(key: string, topics: readonly Topic[], compute: () => unknown | Promise<unknown>): Promise<Entry> {
		const stamp = topics.map((t) => this.changes.version(t)).join('.')
		const hit = this.entries.get(key)
		if (hit && hit.stamp === stamp) {
			// Reinsere para manter a ordem de uso (Map preserva inserção → LRU simples).
			this.entries.delete(key)
			this.entries.set(key, hit)
			return hit
		}
		const body = JSON.stringify(await compute())
		const entry: Entry = { stamp, etag: `W/"${this.boot}.${stamp}"`, body }
		this.store(key, entry)
		return entry
	}

	private store(key: string, entry: Entry): void {
		const old = this.entries.get(key)
		if (old) {
			this.bytes -= old.body.length
			this.entries.delete(key)
		}
		if (entry.body.length > MAX_BYTES / 4) return // grande demais para valer a pena guardar
		this.entries.set(key, entry)
		this.bytes += entry.body.length
		for (const [k, e] of this.entries) {
			if (this.entries.size <= MAX_ENTRIES && this.bytes <= MAX_BYTES) break
			this.entries.delete(k)
			this.bytes -= e.body.length
		}
	}
}
