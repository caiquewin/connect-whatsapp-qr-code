// Conversas e mensagens capturadas, por conexão (tabelas chats, messages, media).
//
// Toda mensagem normalizada é gravada — inclusive as que os filtros não mandam
// ao webhook (coluna `forwarded` diz se foi para a fila). Os filtros continuam
// valendo só para o webhook; o banco é o histórico completo do número.
//
// Mídia: aqui só o registro (status pending → saved | skipped | failed). O
// download é do media.ts, que atualiza o registro via setMediaResult().

import type { ChangeBus } from './changes.js'
import type { Db, Row } from './db.js'
import { tx, v } from './db.js'
import type { NormalizedMessage } from './normalizer.js'

export type ChatView = {
	chatId: string
	chatIdAlt: string | null
	isGroup: boolean
	name: string | null
	lastMessageAt: number
	messages: number
}

export type MediaStatus = 'pending' | 'saved' | 'skipped' | 'failed'

export type MediaView = {
	id: number
	mimetype: string | null
	fileLength: number | null
	seconds: number | null
	fileName: string | null
	status: MediaStatus
	error: string | null
}

export type StoredMessage = Omit<NormalizedMessage, 'media' | 'chatIdAlt' | 'isGroup'> & {
	forwarded: boolean
	media: MediaView | null
}

/**
 * Cursor de paginação: posição (tempo, id) do último item da página anterior.
 * Com ele a próxima página é uma busca direta no índice — custo constante,
 * sem OFFSET (que relê e descarta tudo antes) e sem pular/repetir itens com o
 * mesmo segundo na borda da página.
 */
export type Cursor = { t: number; id: string }

export type Page<T> = { items: T[]; nextCursor: string | null }

/** Cursor opaco para a API (base64url de [t, id]). */
export function encodeCursor(c: Cursor): string {
	return Buffer.from(JSON.stringify([c.t, c.id])).toString('base64url')
}

/** Lança com mensagem legível se o cursor não for um que nós geramos. */
export function decodeCursor(raw: string): Cursor {
	try {
		const [t, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown[]
		if (Number.isSafeInteger(t) && typeof id === 'string' && id.length <= 256) return { t: t as number, id }
	} catch {}
	throw new Error('cursor inválido')
}

export type MediaFile = { path: string | null; mimetype: string | null; fileName: string | null; status: MediaStatus }

export class MessageStore {
	constructor(
		private readonly db: Db,
		private readonly changes: ChangeBus,
	) {}

	/**
	 * Grava a mensagem (e a conversa). Devolve o id do registro de mídia quando
	 * a mensagem é nova e tem mídia — sinal para o media.ts baixar. Mensagem
	 * repetida (ex.: 'append' depois de 'notify') não duplica nem baixa de novo.
	 */
	save(connectionId: string, m: NormalizedMessage, forwarded: boolean, fileName: string | null): number | null {
		this.changes.bump('messages')
		return tx(this.db, () => {
			// Nome do chat = pushName de quem escreveu numa conversa 1:1 (grupos ficam sem nome).
			const name = !m.isGroup && !m.fromMe ? m.pushName : null
			this.db.prepare(`
				INSERT INTO chats (connection_id, chat_id, chat_id_alt, is_group, name, last_message_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (connection_id, chat_id) DO UPDATE SET
					chat_id_alt = COALESCE(excluded.chat_id_alt, chat_id_alt),
					name = COALESCE(excluded.name, name),
					last_message_at = MAX(last_message_at, excluded.last_message_at)
			`).run(connectionId, m.chatId, m.chatIdAlt, v(m.isGroup), name, m.timestamp)

			const { changes } = this.db.prepare(`
				INSERT INTO messages (connection_id, chat_id, id, from_me, sender_id, sender_id_alt, push_name,
					timestamp, type, text, quoted_id, source, forwarded, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (connection_id, chat_id, id) DO NOTHING
			`).run(
				connectionId, m.chatId, m.id, v(m.fromMe), m.senderId, m.senderIdAlt, m.pushName,
				m.timestamp, m.type, m.text, m.quotedId, m.source, v(forwarded), new Date().toISOString(),
			)
			if (changes) {
				// Mensagem nova: conta na conversa (evita COUNT(*) ao listar).
				this.db.prepare('UPDATE chats SET message_count = message_count + 1 WHERE connection_id = ? AND chat_id = ?')
					.run(connectionId, m.chatId)
			} else if (forwarded) {
				// Repetida ('append' depois de 'notify'): só marca que foi ao webhook.
				this.db.prepare('UPDATE messages SET forwarded = 1 WHERE connection_id = ? AND chat_id = ? AND id = ? AND forwarded = 0')
					.run(connectionId, m.chatId, m.id)
			}
			if (!m.media) return null

			const media = this.db.prepare(`
				INSERT INTO media (connection_id, chat_id, message_id, mimetype, file_length, seconds, file_name, status, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
				ON CONFLICT (connection_id, chat_id, message_id) DO NOTHING
			`).run(connectionId, m.chatId, m.id, m.media.mimetype, m.media.fileLength, m.media.seconds, fileName, new Date().toISOString())
			return changes && media.changes ? Number(media.lastInsertRowid) : null
		})
	}

	setMediaResult(id: number, r: { status: MediaStatus; path?: string; sha256?: string; fileLength?: number; error?: string }): void {
		this.db.prepare(`
			UPDATE media SET status = ?, path = ?, sha256 = ?, file_length = COALESCE(?, file_length), error = ?, updated_at = ?
			WHERE id = ?
		`).run(r.status, v(r.path), v(r.sha256), v(r.fileLength), v(r.error), new Date().toISOString(), id)
		this.changes.bump('messages')
	}

	/** Downloads que estavam em andamento quando o processo parou não podem ser retomados. */
	failInterruptedMedia(): number {
		const { changes } = this.db.prepare(`UPDATE media SET status = 'failed', error = 'interrompido (o app reiniciou)', updated_at = ? WHERE status = 'pending'`)
			.run(new Date().toISOString())
		return Number(changes)
	}

	/** Conversas, mais recentes primeiro, paginadas por cursor. */
	listChats(connectionId: string, limit = 100, cursor?: Cursor): Page<ChatView> {
		const n = clamp(limit)
		// Pede um a mais só para saber se existe próxima página.
		const rows = this.db.prepare(`
			SELECT chat_id, chat_id_alt, is_group, name, last_message_at, message_count
			FROM chats
			WHERE connection_id = ?
				${cursor ? 'AND (last_message_at < ? OR (last_message_at = ? AND chat_id < ?))' : ''}
			ORDER BY last_message_at DESC, chat_id DESC
			LIMIT ?
		`).all(connectionId, ...(cursor ? [cursor.t, cursor.t, cursor.id] : []), n + 1)
		const items = rows.slice(0, n).map((r) => ({
			chatId: String(r.chat_id),
			chatIdAlt: (r.chat_id_alt as string | null) ?? null,
			isGroup: r.is_group === 1,
			name: (r.name as string | null) ?? null,
			lastMessageAt: Number(r.last_message_at),
			messages: Number(r.message_count),
		}))
		const last = items[items.length - 1]
		return { items, nextCursor: rows.length > n && last ? encodeCursor({ t: last.lastMessageAt, id: last.chatId }) : null }
	}

	/** Mensagens de uma conversa, mais recentes primeiro, paginadas por cursor. */
	listMessages(connectionId: string, chatId: string, limit = 100, cursor?: Cursor): Page<StoredMessage> {
		const n = clamp(limit)
		const rows = this.db.prepare(`
			SELECT m.*, md.id AS media_id, md.mimetype, md.file_length, md.seconds, md.file_name, md.status AS media_status, md.error AS media_error
			FROM messages m
			LEFT JOIN media md ON md.connection_id = m.connection_id AND md.chat_id = m.chat_id AND md.message_id = m.id
			WHERE m.connection_id = ? AND m.chat_id = ?
				${cursor ? 'AND (m.timestamp < ? OR (m.timestamp = ? AND m.id < ?))' : ''}
			ORDER BY m.timestamp DESC, m.id DESC
			LIMIT ?
		`).all(connectionId, chatId, ...(cursor ? [cursor.t, cursor.t, cursor.id] : []), n + 1)
		const items = rows.slice(0, n).map(toMessage)
		const last = items[items.length - 1]
		return { items, nextCursor: rows.length > n && last ? encodeCursor({ t: last.timestamp, id: last.id }) : null }
	}

	getMediaFile(id: number): MediaFile | null {
		const r = this.db.prepare('SELECT path, mimetype, file_name, status FROM media WHERE id = ?').get(id)
		if (!r) return null
		return {
			path: (r.path as string | null) ?? null,
			mimetype: (r.mimetype as string | null) ?? null,
			fileName: (r.file_name as string | null) ?? null,
			status: r.status as MediaStatus,
		}
	}
}

const clamp = (n: number) => Math.min(Math.max(Math.trunc(n) || 100, 1), 200)

function toMessage(r: Row): StoredMessage {
	return {
		id: String(r.id),
		chatId: String(r.chat_id),
		fromMe: r.from_me === 1,
		senderId: (r.sender_id as string | null) ?? null,
		senderIdAlt: (r.sender_id_alt as string | null) ?? null,
		pushName: (r.push_name as string | null) ?? null,
		timestamp: Number(r.timestamp),
		type: String(r.type),
		text: (r.text as string | null) ?? null,
		quotedId: (r.quoted_id as string | null) ?? null,
		source: r.source as NormalizedMessage['source'],
		forwarded: r.forwarded === 1,
		media: r.media_id == null ? null : {
			id: Number(r.media_id),
			mimetype: (r.mimetype as string | null) ?? null,
			fileLength: r.file_length == null ? null : Number(r.file_length),
			seconds: r.seconds == null ? null : Number(r.seconds),
			fileName: (r.file_name as string | null) ?? null,
			status: r.media_status as MediaStatus,
			error: (r.media_error as string | null) ?? null,
		},
	}
}
