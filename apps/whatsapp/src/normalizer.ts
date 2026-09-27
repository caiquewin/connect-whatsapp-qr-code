// Converte uma WAMessage da Baileys no payload mínimo enviado ao endpoint.
// Mídia não é baixada: vão só os metadados (tipo, mimetype, tamanho, legenda).

import {
	type WAMessage,
	getContentType,
	isJidBroadcast,
	isJidGroup,
	isJidNewsletter,
	normalizeMessageContent,
} from '@whiskeysockets/baileys'

export type NormalizedMessage = {
	id: string
	chatId: string
	/** JID alternativo do chat (PN <-> LID). No v7 muitos chats chegam como @lid. */
	chatIdAlt: string | null
	isGroup: boolean
	fromMe: boolean
	/** Autor da mensagem: participante em grupos, o próprio chat em conversas 1:1. */
	senderId: string | null
	senderIdAlt: string | null
	pushName: string | null
	/** Epoch em segundos, como o WhatsApp envia. */
	timestamp: number
	/** Chave do conteúdo, ex.: conversation, imageMessage, audioMessage. */
	type: string
	text: string | null
	media: { mimetype: string | null; fileLength: number | null; seconds: number | null } | null
	quotedId: string | null
	source: 'live' | 'history'
}

// Tipos de conteúdo que são sinalização interna, não mensagens de usuário.
const IGNORED_TYPES = new Set([
	'protocolMessage',
	'senderKeyDistributionMessage',
	'messageContextInfo',
	'reactionMessage',
	'pollUpdateMessage',
	'keepInChatMessage',
])

export type NormalizeOptions = {
	/** Meus JIDs (telefone e LID), para preencher o remetente das mensagens que eu enviei. */
	self: { pn: string | null; lid: string | null }
}

/**
 * Retorna null quando a mensagem não é de usuário (sistema, status, canais).
 * O que é encaminhado ou não (enviadas/recebidas, telefones, grupos) é decidido
 * depois, pelos filtros da conexão (filters.ts).
 */
export function normalize(
	msg: WAMessage,
	source: NormalizedMessage['source'],
	opts: NormalizeOptions,
): NormalizedMessage | null {
	const { key } = msg
	const chatId = key.remoteJid
	if (!key.id || !chatId) return null

	// Status, listas de transmissão e canais ficam de fora.
	if (isJidBroadcast(chatId) || isJidNewsletter(chatId)) return null

	const isGroup = Boolean(isJidGroup(chatId))
	const fromMe = Boolean(key.fromMe)

	// Desembrulha ephemeral/viewOnce/documentWithCaption etc.
	const content = normalizeMessageContent(msg.message)
	const type = getContentType(content)
	if (!content || !type || IGNORED_TYPES.has(type)) return null

	const inner = (content as Record<string, any>)[type]
	const media = type.endsWith('Message') && inner && typeof inner === 'object' && 'mimetype' in inner
		? {
			mimetype: inner.mimetype ?? null,
			fileLength: inner.fileLength != null ? Number(inner.fileLength) : null,
			seconds: inner.seconds ?? null,
		}
		: null

	// Remetente: em grupo, o participante; em 1:1, o outro lado — exceto quando
	// fui eu que enviei. Uso o mesmo tipo de endereço do chat (LID ou telefone).
	let senderId: string | null
	let senderIdAlt: string | null
	if (isGroup && key.participant) {
		senderId = key.participant
		senderIdAlt = key.participantAlt ?? null
	} else if (fromMe) {
		const { pn, lid } = opts.self
		;[senderId, senderIdAlt] = chatId.endsWith('@lid') ? [lid ?? pn, pn] : [pn ?? lid, lid]
	} else {
		senderId = isGroup ? null : chatId
		senderIdAlt = isGroup ? null : (key.remoteJidAlt ?? null)
	}

	return {
		id: key.id,
		chatId,
		chatIdAlt: key.remoteJidAlt ?? null,
		isGroup,
		fromMe,
		senderId,
		senderIdAlt,
		pushName: msg.pushName ?? null,
		// messageTimestamp pode ser number ou Long (protobuf).
		timestamp: Number(msg.messageTimestamp ?? 0),
		type,
		text: extractText(content),
		media,
		quotedId: inner?.contextInfo?.stanzaId ?? null,
		source,
	}
}

function extractText(content: NonNullable<ReturnType<typeof normalizeMessageContent>>): string | null {
	return (
		content.conversation
		?? content.extendedTextMessage?.text
		?? content.imageMessage?.caption
		?? content.videoMessage?.caption
		?? content.documentMessage?.caption
		?? content.buttonsResponseMessage?.selectedDisplayText
		?? content.listResponseMessage?.title
		?? null
	)
}
