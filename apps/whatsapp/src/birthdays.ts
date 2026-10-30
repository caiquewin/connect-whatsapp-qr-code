// Mensagens de aniversário a partir de um CSV (BIRTHDAY_CSV), enviadas pela
// conexão BIRTHDAY_CONNECTION_ID. Verifica ao iniciar e depois uma vez por dia,
// sempre dentro da janela BIRTHDAY_HOURS e até BIRTHDAY_MAX_PER_DAY mensagens.
//
// Formato (separador ; ou , — o do cabeçalho; UTF-8, com BOM para o Excel):
//   tipo;nome;numero;aniversario;sexo;mensagem;enviado
//   modelo;;;;F;Feliz aniversário, {primeiro_nome}!;      ← texto para mulheres
//   modelo;;;;M;Parabéns, {nome}!;                        ← texto para homens
//   pessoa;Maria Silva;11999998888;15/03;F;;               ← mensagem vazia = usa o modelo
// Linhas começando com # e linhas em branco são ignoradas (e preservadas).
//
// Cada envio também vai para `.aniversarios-enviados.json` (ao lado do CSV):
// é ele que impede reenvio após restart ou se o Excel sobrescrever a coluna.
//
// "enviado" recebe a data do envio (AAAA-MM-DD, no fuso BIRTHDAY_TZ). Data do
// ano corrente = já recebeu este ano; no ano seguinte volta a enviar. O CSV é
// relido e regravado (.tmp + rename) logo após CADA envio, para não perder a
// marca se o processo cair no meio da lista e não sobrescrever edições feitas
// no arquivo durante o envio.
//
// Nome, telefone e texto nunca vão para o log — só o número da linha.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Config } from './config.js'
import { matchesAny, phoneOf } from './filters.js'
import { logger } from './logger.js'
import type { ConnectionManager } from './manager.js'
import { isValidId } from './settings.js'

const log = logger.child({ module: 'birthdays' })

/** Primeira verificação: dá tempo de a conexão abrir depois do start. */
const STARTUP_DELAY_MS = 30_000
/** Conexão fechada ou erro no CSV: tenta de novo neste intervalo (dentro da janela). */
const RETRY_MS = 5 * 60 * 1000

const COLUMNS = ['tipo', 'nome', 'numero', 'aniversario', 'sexo', 'mensagem', 'enviado'] as const
type Column = (typeof COLUMNS)[number]
type Sex = 'F' | 'M'

/** Criado quando o arquivo não existe. Exemplos comentados (não disparam envio). */
export const BIRTHDAY_TEMPLATE = [
	'tipo;nome;numero;aniversario;sexo;mensagem;enviado',
	'modelo;;;;F;Feliz aniversário, {primeiro_nome}! 🎉 Desejamos um dia lindo e um novo ano cheio de saúde e conquistas.;',
	'modelo;;;;M;Parabéns, {primeiro_nome}! 🎉 Desejamos muita saúde, sucesso e um ótimo dia.;',
	'# Exemplos: apague o # para ativar. aniversario = DD/MM ou DD/MM/AAAA; sexo = F ou M; mensagem vazia usa o modelo.',
	'# pessoa;Maria Silva;11999998888;15/03;F;;',
	'# pessoa;João Souza;5521988887777;02/11/1990;M;"Mensagem só para o João: parabéns, {nome}!";',
	'',
].join('\r\n')

// ---------------------------------------------------------------- CSV

/** Registro: campos de uma linha de dados, ou texto cru (comentário/linha em branco). */
type CsvRecord = string[] | string
type CsvFile = { records: CsvRecord[]; delimiter: string; bom: boolean; eol: string }

/** Parser mínimo RFC 4180 (aspas, "" escapado, quebra de linha dentro de aspas). */
export function parseCsv(input: string): CsvFile {
	const bom = input.startsWith('﻿')
	const text = bom ? input.slice(1) : input
	const eol = text.includes('\r\n') ? '\r\n' : '\n'
	const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
	const delimiter = firstLine.split(';').length >= firstLine.split(',').length ? ';' : ','
	const records: CsvRecord[] = []
	let i = 0
	while (i < text.length) {
		const c0 = text[i]
		if (c0 === '#' || c0 === '\n' || c0 === '\r') {
			let end = text.indexOf('\n', i)
			if (end === -1) end = text.length
			records.push(text.slice(i, end).replace(/\r$/, ''))
			i = end + 1
			continue
		}
		const fields: string[] = []
		let field = ''
		let quoted = false
		let started = false // aspas só abrem campo no início dele
		for (;;) {
			const c = text[i]
			if (c === undefined) {
				fields.push(field)
				break
			}
			if (quoted) {
				if (c === '"') {
					if (text[i + 1] === '"') {
						field += '"'
						i += 2
					} else {
						quoted = false
						i++
					}
				} else {
					field += c
					i++
				}
			} else if (c === '"' && !started) {
				quoted = true
				started = true
				i++
			} else if (c === delimiter) {
				fields.push(field)
				field = ''
				started = false
				i++
			} else if (c === '\n' || c === '\r') {
				fields.push(field)
				i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
				break
			} else {
				field += c
				started = true
				i++
			}
		}
		records.push(fields)
	}
	return { records, delimiter, bom, eol }
}

export function serializeCsv(file: CsvFile): string {
	const needsQuotes = (f: string) => f.includes(file.delimiter) || /["\r\n]/.test(f) || f.startsWith('#')
	const line = (r: CsvRecord) =>
		typeof r === 'string' ? r : r.map((f) => (needsQuotes(f) ? `"${f.replaceAll('"', '""')}"` : f)).join(file.delimiter)
	return (file.bom ? '﻿' : '') + file.records.map(line).join(file.eol) + file.eol
}

/** Cabeçalho sem acento/caixa: "Número" → "numero". */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

type Sheet = {
	file: CsvFile
	/** Índice do registro de cabeçalho em file.records. */
	headerAt: number
	col: Record<Column, number>
}

function toSheet(file: CsvFile): Sheet {
	const headerAt = file.records.findIndex((r) => typeof r !== 'string')
	const header = file.records[headerAt]
	if (headerAt === -1 || typeof header === 'string' || !header) throw new Error('CSV sem cabeçalho')
	const names = header.map(norm)
	const col = {} as Record<Column, number>
	for (const name of COLUMNS) {
		const idx = names.indexOf(name)
		if (idx === -1) throw new Error(`CSV sem a coluna "${name}" (cabeçalho: ${COLUMNS.join(';')})`)
		col[name] = idx
	}
	return { file, headerAt, col }
}

// ---------------------------------------------------------------- linhas

type Person = {
	/** Linha no arquivo (1 = primeira), só para log. */
	line: number
	name: string
	phone: string
	day: number
	month: number
	sex: Sex | null
	message: string
	sent: string
}

function parseSex(value: string): Sex | null {
	const v = norm(value)
	if (['f', 'feminino', 'mulher'].includes(v)) return 'F'
	if (['m', 'masculino', 'homem'].includes(v)) return 'M'
	return null
}

/** DD/MM, DD/MM/AAAA, DD-MM-AAAA ou AAAA-MM-DD → dia e mês. */
function parseBirthday(value: string): { day: number; month: number } | null {
	const v = value.trim()
	const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v)
	const br = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?$/.exec(v)
	const [day, month] = iso ? [Number(iso[3]), Number(iso[2])] : br ? [Number(br[1]), Number(br[2])] : [0, 0]
	const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
	return day >= 1 && day <= maxDay ? { day, month } : null
}

/** Só dígitos com DDI; 10/11 dígitos (sem DDI) recebem 55, como nos fluxos de teste. */
function parsePhone(value: string): string | null {
	let digits = value.replace(/\D/g, '')
	if (digits.length === 10 || digits.length === 11) digits = `55${digits}`
	return digits.length >= 12 && digits.length <= 15 ? digits : null
}

type Parsed = { people: Person[]; templates: Partial<Record<Sex, string>> }

/** Linhas inválidas são puladas com aviso (sem dado pessoal no log); não travam as outras. */
function readRows(sheet: Sheet): Parsed {
	const { file, headerAt, col } = sheet
	const people: Person[] = []
	const templates: Partial<Record<Sex, string>> = {}
	let line = 0
	for (const [idx, r] of file.records.entries()) {
		// Número da linha física (campos com quebra de linha ocupam mais de uma).
		line += 1
		if (typeof r === 'string' || idx <= headerAt) {
			continue
		}
		const get = (c: Column) => (r[col[c]] ?? '').trim()
		const recordLine = line
		line += r.reduce((n, f) => n + (f.match(/\n/g)?.length ?? 0), 0)
		if (r.every((f) => !f.trim())) continue
		const kind = norm(get('tipo')) || 'pessoa'
		if (kind === 'modelo') {
			const sex = parseSex(get('sexo'))
			if (!sex || !get('mensagem')) log.warn({ line: recordLine }, 'modelo sem sexo (F/M) ou sem mensagem — ignorado')
			else templates[sex] = get('mensagem')
			continue
		}
		if (kind !== 'pessoa') {
			log.warn({ line: recordLine }, 'tipo deve ser "modelo" ou "pessoa" — linha ignorada')
			continue
		}
		const phone = parsePhone(get('numero'))
		const birthday = parseBirthday(get('aniversario'))
		if (!get('nome') || !phone || !birthday) {
			log.warn({ line: recordLine, name: !!get('nome'), phone: !!phone, birthday: !!birthday }, 'pessoa com nome, número ou aniversário inválido — ignorada')
			continue
		}
		people.push({
			line: recordLine,
			name: get('nome'),
			phone,
			...birthday,
			sex: parseSex(get('sexo')),
			message: get('mensagem'),
			sent: get('enviado'),
		})
	}
	return { people, templates }
}

// ---------------------------------------------------------------- datas e texto

type Today = { iso: string; year: number; month: number; day: number }

function todayIn(timeZone: string): Today {
	// en-CA formata como AAAA-MM-DD.
	const iso = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
	const [year, month, day] = iso.split('-').map(Number) as [number, number, number]
	return { iso, year, month, day }
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Nascido em 29/02 recebe em 28/02 nos anos não bissextos. */
function isBirthday(p: Person, t: Today): boolean {
	if (p.month === t.month && p.day === t.day) return true
	return p.month === 2 && p.day === 29 && !isLeap(t.year) && t.month === 2 && t.day === 28
}

function fillTemplate(template: string, name: string): string {
	const first = name.split(/\s+/)[0] ?? name
	return template.replace(/\{\s*primeiro_nome\s*\}/gi, first).replace(/\{\s*nome\s*\}/gi, name)
}

// ---------------------------------------------------------------- arquivo

async function readSheet(file: string): Promise<Sheet> {
	return toSheet(parseCsv(await readFile(file, 'utf8')))
}

/** Gravação atômica (.tmp + rename): o Excel/leitor nunca vê arquivo pela metade. */
async function writeSheet(file: string, sheet: Sheet): Promise<void> {
	const tmp = `${file}.tmp`
	await writeFile(tmp, serializeCsv(sheet.file), { mode: 0o600 })
	await rename(tmp, file)
}

/**
 * Marca "enviado" relendo o arquivo agora (pode ter sido editado durante o
 * envio). Casa por telefone + nome; marca todas as linhas iguais.
 */
async function markSent(file: string, person: Person, date: string): Promise<void> {
	const sheet = await readSheet(file)
	const { col } = sheet
	let marked = 0
	for (const [idx, r] of sheet.file.records.entries()) {
		if (typeof r === 'string' || idx <= sheet.headerAt) continue
		const get = (c: Column) => (r[col[c]] ?? '').trim()
		if ((norm(get('tipo')) || 'pessoa') !== 'pessoa') continue
		if (parsePhone(get('numero')) !== person.phone || get('nome') !== person.name) continue
		while (r.length <= col.enviado) r.push('')
		r[col.enviado] = date
		marked++
	}
	if (!marked) throw new Error('linha da pessoa não encontrada ao marcar (o CSV mudou durante o envio?)')
	await writeSheet(file, sheet)
}

// ---------------------------------------------------------------- registro de envios

/**
 * Registro dos envios fora do CSV (`.aniversarios-enviados.json`, ao lado dele):
 * "telefone|ano" → data. Sobrevive a restart (no `npm run dev`, a cada edição)
 * e a o Excel salvar por cima da coluna "enviado". A chave usa o telefone
 * devolvido pelo servidor (onWhatsApp), então grafias diferentes do mesmo
 * número (com/sem 9º dígito, com/sem DDI) contam como um só.
 */
class SentLog {
	private entries: Record<string, string> = {}

	constructor(private readonly file: string) {}

	async load(): Promise<void> {
		try {
			const data: unknown = JSON.parse(await readFile(this.file, 'utf8'))
			this.entries = data && typeof data === 'object' ? (data as Record<string, string>) : {}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn({ err }, 'registro de envios ilegível; usando só a coluna "enviado"')
			this.entries = {}
		}
	}

	has(phone: string, year: number): boolean {
		return `${phone}|${year}` in this.entries
	}

	countOn(date: string): number {
		return Object.values(this.entries).filter((d) => d === date).length
	}

	/** Grava (.tmp + rename) e descarta anos anteriores. */
	async add(phone: string, today: Today): Promise<void> {
		this.entries[`${phone}|${today.year}`] = today.iso
		for (const key of Object.keys(this.entries)) if (!key.endsWith(`|${today.year}`)) delete this.entries[key]
		const tmp = `${this.file}.tmp`
		await writeFile(tmp, JSON.stringify(this.entries), { mode: 0o600 })
		await rename(tmp, this.file)
	}
}

// ---------------------------------------------------------------- agendador

/** Minutos desde a meia-noite no fuso informado. */
function minutesIn(timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
	return get('hour') * 60 + get('minute')
}

/** Resumo de uma verificação (devolvido ao botão da interface). */
export type BirthdayRun = {
	/** false = conexão fechada (a verificação agendada tenta de novo em 5 min). */
	open: boolean
	people: number
	due: number
	sent: number
	/** Motivo quando nada foi verificado (conexão inexistente, CSV recém-criado). */
	note?: string
}

export class BirthdaySender {
	private timer: NodeJS.Timeout | null = null
	/** start() validou a configuração. */
	private enabled = false
	/** Verificação em andamento (agendada ou pelo botão): nunca duas ao mesmo tempo. */
	private running = false
	private readonly abort = new AbortController()
	private readonly sentLog: SentLog

	constructor(
		private readonly manager: ConnectionManager,
		private readonly cfg: Config['birthdays'],
	) {
		this.sentLog = new SentLog(path.join(path.dirname(cfg.csvPath), '.aniversarios-enviados.json'))
	}

	start(): void {
		const { connectionId, csvPath, timeZone, startHour, endHour, maxPerDay } = this.cfg
		if (!connectionId) {
			log.info('mensagens de aniversário desligadas (BIRTHDAY_CONNECTION_ID vazio)')
			return
		}
		if (!isValidId(connectionId)) {
			log.error('BIRTHDAY_CONNECTION_ID inválido (8 caracteres hex, o id da conexão na interface) — aniversários desligados')
			return
		}
		try {
			todayIn(timeZone)
		} catch {
			log.error({ timeZone }, 'BIRTHDAY_TZ inválido (ex.: America/Sao_Paulo) — aniversários desligados')
			return
		}
		this.enabled = true
		log.info({ connectionId, csv: csvPath, timeZone, hours: `${startHour}h-${endHour}h`, maxPerDay },
			'mensagens de aniversário ligadas: verificação ao iniciar e uma vez por dia, dentro do horário')
		this.schedule(STARTUP_DELAY_MS)
	}

	/**
	 * Botão "Enviar aniversários" da interface: verifica agora, fora da janela
	 * BIRTHDAY_HOURS. Continua valendo o teto diário e o registro (não repete).
	 */
	async runNow(): Promise<BirthdayRun> {
		if (!this.enabled) throw new Error('Aniversários desligados: defina BIRTHDAY_CONNECTION_ID no .env e reinicie')
		if (this.running) throw new Error('Já há uma verificação de aniversários em andamento')
		log.info('verificação de aniversários acionada pela interface')
		return this.exclusive()
	}

	private async exclusive(): Promise<BirthdayRun> {
		this.running = true
		try {
			return await this.check()
		} finally {
			this.running = false
		}
	}

	/** Shutdown: cancela o próximo agendamento e interrompe a espera entre envios. */
	stop(): void {
		this.abort.abort()
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
	}

	private schedule(ms: number): void {
		if (this.abort.signal.aborted) return
		this.timer = setTimeout(() => void this.tick(), ms)
	}

	/** Até o próximo início da janela (hoje, se ainda não chegou; senão amanhã). */
	private untilWindowStart(): number {
		const diff = (this.cfg.startHour * 60 - minutesIn(this.cfg.timeZone) + 1440) % 1440
		return (diff || 1440) * 60_000 + 30_000
	}

	private async tick(): Promise<void> {
		// Fora do horário (ex.: restart de madrugada): ninguém recebe parabéns à 00h10.
		const now = minutesIn(this.cfg.timeZone)
		if (now < this.cfg.startHour * 60 || now >= this.cfg.endHour * 60) {
			const ms = this.untilWindowStart()
			log.info({ inMinutes: Math.round(ms / 60_000) }, 'fora do horário de envio de aniversários; próxima verificação no início da janela')
			this.schedule(ms)
			return
		}
		// Botão da interface rodando agora: tenta de novo em 5 min.
		if (this.running) {
			this.schedule(RETRY_MS)
			return
		}
		// Sucesso → amanhã no início da janela (~24 h); conexão fechada/erro → 5 min.
		let next: number
		try {
			next = (await this.exclusive()).open ? this.untilWindowStart() : RETRY_MS
		} catch (err) {
			log.error({ err }, 'falha na verificação de aniversários; nova tentativa em 5 min')
			next = RETRY_MS
		}
		this.schedule(next)
	}

	/** Uma verificação completa. open: false = conexão fechada (tentar de novo em breve). */
	private async check(): Promise<BirthdayRun> {
		const { csvPath, connectionId, timeZone, sendGapMs, maxPerDay } = this.cfg
		if (!this.manager.has(connectionId)) {
			// Configuração errada não se resolve sozinha: avisa e volta só amanhã.
			log.warn({ connectionId }, 'BIRTHDAY_CONNECTION_ID não corresponde a nenhuma conexão cadastrada')
			return { open: true, people: 0, due: 0, sent: 0, note: `BIRTHDAY_CONNECTION_ID (${connectionId}) não corresponde a nenhuma conexão` }
		}
		const sheet = await this.loadOrCreate(csvPath)
		if (!sheet) return { open: true, people: 0, due: 0, sent: 0, note: 'CSV de aniversários não existia: modelo criado, preencha as pessoas' }
		await this.sentLog.load()
		const today = todayIn(timeZone)
		const { people, templates } = readRows(sheet)
		const due = people.filter(
			(p) => isBirthday(p, today) && !p.sent.startsWith(String(today.year)) && !this.sentLog.has(p.phone, today.year),
		)
		log.info({ people: people.length, due: due.length, date: today.iso }, 'aniversários verificados')
		let sent = 0
		const result = (open: boolean): BirthdayRun => ({ open, people: people.length, due: due.length, sent })
		if (!due.length) return result(true)

		for (const [i, person] of due.entries()) {
			if (this.abort.signal.aborted) break
			// Teto diário (conta também envios de verificações anteriores do mesmo dia).
			if (this.sentLog.countOn(today.iso) >= maxPerDay) {
				log.warn({ maxPerDay, notSent: due.length - i }, 'limite diário de parabéns atingido (BIRTHDAY_MAX_PER_DAY) — o restante não é enviado hoje')
				break
			}
			const sock = this.manager.getSocket(connectionId)
			if (!sock) {
				log.warn({ connectionId, pending: due.length - i }, 'conexão não está aberta; aniversários de hoje ficam para a próxima tentativa')
				return result(false)
			}
			const template = person.message || (person.sex ? templates[person.sex] : undefined)
			if (!template) {
				log.warn({ line: person.line }, person.sex ? `sem modelo para o sexo ${person.sex} — não enviado` : 'sexo vazio/inválido (use F ou M) e sem mensagem própria — não enviado')
				continue
			}
			const ownPhone = phoneOf(sock.user?.id ?? null)
			if (ownPhone && matchesAny(ownPhone, [person.phone])) {
				log.warn({ line: person.line }, 'número igual ao da conexão que envia — ignorado')
				continue
			}
			// Repetido na planilha (já enviado nesta rodada): só marca a linha.
			if (this.sentLog.has(person.phone, today.year)) {
				await this.mark(person, today)
				continue
			}
			let phone: string
			try {
				const found = (await sock.onWhatsApp(person.phone))?.[0]
				if (!found?.exists) {
					log.warn({ line: person.line }, 'número sem WhatsApp — não enviado')
					continue
				}
				// Telefone segundo o servidor: outra grafia do mesmo número já enviada → não repete.
				phone = phoneOf(found.jid) ?? person.phone
				if (this.sentLog.has(phone, today.year)) {
					await this.mark(person, today)
					continue
				}
				// Espaçamento entre envios (com jitter): volume baixo e ritmo humano.
				if (sent > 0) await sleep(sendGapMs * (0.75 + Math.random() * 0.5), undefined, { signal: this.abort.signal })
				const text = fillTemplate(template, person.name)
				await sock.sendPresenceUpdate('composing', found.jid).catch(() => undefined)
				await sleep(Math.min(4_000, 1_200 + text.length * 35), undefined, { signal: this.abort.signal })
				await sock.sendMessage(found.jid, { text })
				await sock.sendPresenceUpdate('paused', found.jid).catch(() => undefined)
			} catch (err) {
				if (this.abort.signal.aborted) break
				log.error({ err, line: person.line }, 'falha ao enviar parabéns; nova tentativa na próxima verificação')
				continue
			}
			sent++
			// Registro primeiro (é ele que impede reenvio), depois a coluna do CSV.
			await this.sentLog.add(phone, today).catch((err) => log.error({ err }, 'falha ao gravar o registro de envios'))
			if (phone !== person.phone) await this.sentLog.add(person.phone, today).catch(() => undefined)
			await this.mark(person, today)
		}
		log.info({ sent, due: due.length }, 'envio de aniversários concluído')
		return result(true)
	}

	private async mark(person: Person, today: Today): Promise<void> {
		try {
			await markSent(this.cfg.csvPath, person, today.iso)
		} catch (err) {
			// Mensagem já saiu e está no registro: não será reenviada; só a planilha fica sem a data.
			log.error({ err, line: person.line }, 'não foi possível marcar "enviado" no CSV (arquivo aberto no Excel?) — o envio está registrado')
		}
	}

	/** Lê o CSV; se não existe, cria o modelo (com exemplos comentados) e não envia nada. */
	private async loadOrCreate(file: string): Promise<Sheet | null> {
		try {
			return await readSheet(file)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
		}
		await mkdir(path.dirname(file), { recursive: true })
		await writeFile(file, `﻿${BIRTHDAY_TEMPLATE}`, { mode: 0o600, flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
			if (err.code !== 'EEXIST') throw err
		})
		log.warn({ csv: file }, 'CSV de aniversários não existia: modelo criado — preencha as pessoas')
		return null
	}
}
