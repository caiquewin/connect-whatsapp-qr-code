// Download da mídia das mensagens (imagem, áudio, vídeo, documento, figurinha).
//
// O arquivo vai para MEDIA_DIR/<conexão>/<AAAA-MM>/<id da mensagem>.<ext>; o
// banco guarda o caminho relativo, mimetype, tamanho e sha256 (messages.ts).
//
// - Fila única com no máximo 2 downloads simultâneos: não disputa banda com o
//   socket nem abre dezenas de conexões com o CDN quando chega uma rajada.
// - Só mídia de mensagens ao vivo: a URL de mídia do histórico costuma ter
//   expirado e baixá-la em massa pediria reupload ao celular para cada item.
// - Grava em .tmp e renomeia, como o resto do projeto (nunca arquivo pela metade).
// - Mídia com URL expirada (404/410) é pedida de novo ao celular pela própria
//   Baileys (reuploadRequest).
// - Downloads pendentes no shutdown são perdidos: o registro vira 'failed' na
//   próxima inicialização (a WAMessage original não é guardada para retomar).

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { type WAMessage, type WASocket, downloadMediaMessage, normalizeMessageContent } from '@whiskeysockets/baileys'
import type { Dispatcher } from 'undici'
import type { Config } from './config.js'
import { baileysLogger, logger } from './logger.js'
import type { MessageStore } from './messages.js'
import type { NormalizedMessage } from './normalizer.js'

const log = logger.child({ module: 'media' })

const CONCURRENCY = 2
const DOWNLOAD_TIMEOUT_MS = 120_000

type Job = {
	mediaId: number
	connectionId: string
	sock: WASocket
	raw: WAMessage
	msg: NormalizedMessage
	/** Proxy da conexão (undefined = direto). */
	dispatcher: Dispatcher | undefined
}

export class MediaDownloader {
	private queue: Job[] = []
	private active = 0
	private stopped = false

	constructor(
		private readonly store: MessageStore,
		private readonly cfg: Config['media'],
	) {}

	/** Agenda o download. Decide na hora se vai ficar só com os metadados. */
	enqueue(job: Job): void {
		const size = job.msg.media?.fileLength ?? null
		if (!this.cfg.download) return this.store.setMediaResult(job.mediaId, { status: 'skipped', error: 'MEDIA_DOWNLOAD=false' })
		if (job.msg.source !== 'live') return this.store.setMediaResult(job.mediaId, { status: 'skipped', error: 'mídia de histórico não é baixada' })
		if (size !== null && size > this.cfg.maxBytes) {
			return this.store.setMediaResult(job.mediaId, { status: 'skipped', error: 'maior que MEDIA_MAX_MB' })
		}
		if (this.stopped) return
		this.queue.push(job)
		this.pump()
	}

	/** Conexão excluída: descarta o que estava na fila e apaga os arquivos dela. */
	async removeConnection(connectionId: string): Promise<void> {
		this.queue = this.queue.filter((j) => j.connectionId !== connectionId)
		await rm(path.join(this.cfg.dir, connectionId), { recursive: true, force: true })
	}

	/** Shutdown: não começa downloads novos (os em andamento terminam ou morrem com o processo). */
	stop(): void {
		this.stopped = true
		this.queue = []
	}

	private pump(): void {
		while (this.active < CONCURRENCY && this.queue.length && !this.stopped) {
			const job = this.queue.shift()!
			this.active++
			this.download(job).finally(() => {
				this.active--
				this.pump()
			})
		}
	}

	private async download(job: Job): Promise<void> {
		const { msg } = job
		const month = new Date(msg.timestamp * 1000).toISOString().slice(0, 7)
		const rel = path.join(job.connectionId, month, `${safeName(msg.id)}.${extensionOf(msg.media?.mimetype ?? null)}`)
		const file = path.join(this.cfg.dir, rel)
		const tmp = `${file}.tmp`
		try {
			await mkdir(path.dirname(file), { recursive: true })
			const stream = await downloadMediaMessage(
				job.raw,
				'stream',
				{ options: { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...(job.dispatcher ? { dispatcher: job.dispatcher as never } : {}) } as RequestInit },
				{ logger: baileysLogger, reuploadRequest: job.sock.updateMediaMessage },
			)
			// Conta bytes e calcula o hash enquanto grava; aborta se passar do limite
			// (o fileLength do protobuf nem sempre vem).
			const hash = createHash('sha256')
			let size = 0
			const max = this.cfg.maxBytes
			const meter = new Transform({
				transform(chunk: Buffer, _enc, cb) {
					size += chunk.length
					if (size > max) return cb(new Error('maior que MEDIA_MAX_MB'))
					hash.update(chunk)
					cb(null, chunk)
				},
			})
			await pipeline(stream, meter, createWriteStream(tmp))
			await rename(tmp, file)
			this.store.setMediaResult(job.mediaId, { status: 'saved', path: rel, sha256: hash.digest('hex'), fileLength: size })
			log.debug({ connection: job.connectionId, id: msg.id, type: msg.type, bytes: size }, 'mídia salva')
		} catch (err) {
			await rm(tmp, { force: true }).catch(() => undefined)
			const message = (err as Error).message
			this.store.setMediaResult(job.mediaId, { status: 'failed', error: message.slice(0, 300) })
			log.warn({ connection: job.connectionId, id: msg.id, type: msg.type, err: message }, 'falha ao baixar mídia')
		}
	}
}

/** Nome original de documentos (vai para o banco; o arquivo em disco usa o id da mensagem). */
export function documentFileName(raw: WAMessage): string | null {
	const name = normalizeMessageContent(raw.message)?.documentMessage?.fileName
	return name ? name.slice(0, 255) : null
}

/** Ids de mensagem são alfanuméricos, mas viram nome de arquivo: garante isso. */
function safeName(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'sem-id'
}

const EXT_OVERRIDES: Record<string, string> = {
	jpeg: 'jpg',
	'svg+xml': 'svg',
	quicktime: 'mov',
	mpeg: 'mp3',
	'x-m4a': 'm4a',
	plain: 'txt',
	'vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
	msword: 'doc',
	'vnd.ms-excel': 'xls',
}

/** "audio/ogg; codecs=opus" → "ogg". Desconhecido → "bin". */
function extensionOf(mimetype: string | null): string {
	const sub = mimetype?.split(';')[0]?.split('/')[1]?.trim().toLowerCase() ?? ''
	const ext = EXT_OVERRIDES[sub] ?? sub
	return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin'
}
