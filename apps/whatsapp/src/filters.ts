// Filtros por conexão: o que é encaminhado ao webhook.
//
// - received: mensagens recebidas; `phones` limita a quem ENVIOU.
// - sent:     mensagens enviadas por mim (de qualquer aparelho); `phones`
//             limita a quem RECEBEU (o chat 1:1).
// - groups:   inclui mensagens de grupo. Em grupos o filtro de telefone de
//             recebidas vale para o participante que enviou; enviadas em
//             grupo não têm um telefone de destino, então são descartadas
//             quando `sent.phones` não está vazio.
//
// Lista de telefones vazia = todos.

import type { NormalizedMessage } from './normalizer.js'

export type DirectionFilter = { enabled: boolean; phones: string[] }

export type Filters = {
	received: DirectionFilter
	sent: DirectionFilter
	groups: boolean
}

const MAX_PHONES = 200

export function defaultFilters(opts: { fromMe: boolean; groups: boolean }): Filters {
	return {
		received: { enabled: true, phones: [] },
		sent: { enabled: opts.fromMe, phones: [] },
		groups: opts.groups,
	}
}

/** Valida o que vem da UI/arquivo. Telefones são guardados só com dígitos. */
export function parseFilters(input: unknown): Filters {
	const obj = (input ?? {}) as Record<string, unknown>
	const dir = (v: unknown, label: string): DirectionFilter => {
		const d = (v ?? {}) as Record<string, unknown>
		const raw = Array.isArray(d.phones) ? d.phones : typeof d.phones === 'string' ? d.phones.split(/[\n,;]+/) : []
		// Só dígitos; sem DDI (10/11 dígitos) assume Brasil, para "11 9..." e "+55 11 9..." virarem um só.
		const digits = raw.map((p) => String(p).replace(/\D/g, '')).filter(Boolean)
		const phones = [...new Set(digits.map((p) => (p.length === 10 || p.length === 11 ? `55${p}` : p)))]
		for (const p of phones) {
			if (p.length < 8 || p.length > 15) throw new Error(`Telefone inválido em ${label}: ${p}`)
		}
		if (phones.length > MAX_PHONES) throw new Error(`Máximo de ${MAX_PHONES} telefones em ${label}`)
		return { enabled: d.enabled !== false, phones }
	}
	return {
		received: dir(obj.received, 'recebidas'),
		sent: dir(obj.sent, 'enviadas'),
		groups: obj.groups !== false,
	}
}

/** true = encaminhar. */
export function passesFilters(msg: NormalizedMessage, f: Filters): boolean {
	if (msg.isGroup && !f.groups) return false

	if (msg.fromMe) {
		if (!f.sent.enabled) return false
		if (!f.sent.phones.length) return true
		if (msg.isGroup) return false
		return matchesAny(phoneOf(msg.chatId, msg.chatIdAlt), f.sent.phones)
	}

	if (!f.received.enabled) return false
	if (!f.received.phones.length) return true
	return matchesAny(phoneOf(msg.senderId, msg.senderIdAlt), f.received.phones)
}

/** Telefone (só dígitos) de um par JID/JID alternativo; o que for @s.whatsapp.net. */
export function phoneOf(...jids: (string | null)[]): string | null {
	const pn = jids.find((j) => j?.endsWith('@s.whatsapp.net'))
	return pn ? pn.split(/[:@]/)[0]!.replace(/\D/g, '') : null
}

/** O telefone (dígitos) é algum da lista, tolerando DDI ausente e 9º dígito? */
export function matchesAny(phone: string | null, list: string[]): boolean {
	if (!phone) return false
	const variants = phoneVariants(phone)
	return list.some((entry) => phoneVariants(entry).some((v) => variants.includes(v)))
}

/**
 * Formas equivalentes de um número, para comparar sem exigir formato exato:
 * - sem DDI (10/11 dígitos) assume Brasil (55);
 * - celular BR com e sem o 9º dígito (o WhatsApp às vezes usa a forma antiga).
 */
function phoneVariants(digits: string): string[] {
	let full = digits
	if (full.length === 10 || full.length === 11) full = `55${full}`
	const out = new Set([full])
	if (full.startsWith('55')) {
		const ddd = full.slice(2, 4)
		const rest = full.slice(4)
		if (rest.length === 9 && rest.startsWith('9')) out.add(`55${ddd}${rest.slice(1)}`)
		if (rest.length === 8) out.add(`55${ddd}9${rest}`)
	}
	return [...out]
}
