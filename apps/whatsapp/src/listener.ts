// Escuta os eventos de mensagem do socket, grava toda mensagem no banco
// (onCaptured), aplica os filtros da conexão e passa as aprovadas ao forwarder.
//
// messages.upsert chega com dois tipos:
// - 'notify': mensagem nova em tempo real.
// - 'append': mensagens enviadas por você em outro aparelho, ou recebidas
//   enquanto estava offline. Também interessam.
// O histórico antigo vem em outro evento (messaging-history.set) e só é
// capturado com CAPTURE_HISTORY=true.
//
// Na v7 muitos chats chegam endereçados por LID (@lid). Quando o WhatsApp não
// manda o telefone junto (campo *Alt), consultamos o mapeamento LID→telefone
// da Baileys — sem isso o filtro por telefone não teria com o que comparar.

import { type WAMessage, type WASocket, jidNormalizedUser } from '@whiskeysockets/baileys'
import { type Filters, passesFilters } from './filters.js'
import type { Forwarder } from './forwarder.js'
import { logger } from './logger.js'
import { type NormalizedMessage, normalize } from './normalizer.js'

const log = logger.child({ module: 'listener' })

export type ListenerOptions = {
	/** Encaminhar também o histórico antigo (CAPTURE_HISTORY). */
	history: boolean
	/** Nome amigável atual; vai em cada mensagem no campo "instance". */
	getInstance: () => string
	/** Filtros atuais da conexão (lidos a cada mensagem: edições valem na hora). */
	getFilters: () => Filters
	/** Há webhook configurado agora? Sem ele nada é enfileirado (a mensagem fica só no banco). */
	hasWebhook: () => boolean
	/** Toda mensagem normalizada, antes dos filtros (usado pelos testes com IA). */
	onMessage?: (msg: NormalizedMessage) => void
	/**
	 * Toda mensagem normalizada (ao vivo e histórico), com a original da Baileys
	 * (necessária para baixar mídia) e se passou nos filtros. Grava no banco.
	 */
	onCaptured?: (msg: NormalizedMessage, raw: WAMessage, forwarded: boolean) => void
}

export function attachListener(sock: WASocket, forwarder: Forwarder, opts: ListenerOptions): void {
	const handle = async (messages: WAMessage[], source: NormalizedMessage['source']) => {
		const self = {
			pn: sock.user?.id ? jidNormalizedUser(sock.user.id) : null,
			lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null,
		}
		const filters = opts.getFilters()
		const hasWebhook = opts.hasWebhook()
		let queued = 0
		let filtered = 0

		for (const msg of messages) {
			const normalized = normalize(msg, source, { self })
			if (!normalized) continue
			await fillPhones(sock, normalized)
			if (source === 'live') opts.onMessage?.(normalized)

			const forwarded = hasWebhook && passesFilters(normalized, filters)
			try {
				opts.onCaptured?.(normalized, msg, forwarded)
			} catch (err) {
				// Falha no banco não pode impedir o encaminhamento ao webhook.
				log.error({ err, id: normalized.id }, 'falha ao gravar mensagem no banco')
			}
			if (!forwarded) {
				filtered++
				continue
			}
			await forwarder.enqueue({ ...normalized, instance: opts.getInstance() || null })
			queued++
			// Só metadados no log; o texto nunca é registrado.
			log.debug({ id: normalized.id, type: normalized.type, fromMe: normalized.fromMe, source }, 'mensagem enfileirada')
		}
		if (queued || filtered) log.info({ queued, filtered, source }, 'mensagens processadas')
	}

	sock.ev.on('messages.upsert', ({ messages }) => {
		handle(messages, 'live').catch((err) => log.error({ err }, 'falha ao processar mensagens'))
	})

	if (opts.history) {
		sock.ev.on('messaging-history.set', ({ messages, syncType, progress }) => {
			log.info({ count: messages.length, syncType, progress }, 'lote de histórico recebido')
			handle(messages, 'history').catch((err) => log.error({ err }, 'falha ao processar histórico'))
		})
	}
}

/** Preenche chatIdAlt/senderIdAlt com o telefone quando só veio o LID. */
async function fillPhones(sock: WASocket, msg: NormalizedMessage): Promise<void> {
	const lookup = async (lid: string): Promise<string | null> => {
		try {
			const pn = await sock.signalRepository.lidMapping.getPNForLID(lid)
			return pn ? jidNormalizedUser(pn) : null
		} catch {
			return null
		}
	}
	if (msg.chatId.endsWith('@lid') && !msg.chatIdAlt) msg.chatIdAlt = await lookup(msg.chatId)
	if (msg.senderId?.endsWith('@lid') && !msg.senderIdAlt) msg.senderIdAlt = await lookup(msg.senderId)
}
