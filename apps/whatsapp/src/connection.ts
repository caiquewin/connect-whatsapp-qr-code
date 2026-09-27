// Socket Baileys: autenticação persistida, QR (terminal + interface web) e
// reconexão comedida. Expõe o estado para a interface admin.
//
// Estados:
//   connecting → qr (aguardando scan) → open
//   idle: parado esperando ação do usuário na interface ("Conectar").
//
// Regras de reconexão (evitam loop que leva a banimento):
// - restartRequired (515): normal logo após escanear o QR → reconecta na hora.
// - QR expirou sem scan (408 sem sessão registrada): vai para idle. Não gera
//   QR novo sozinho; o usuário pede outro na interface.
// - loggedOut / multideviceMismatch: sessão morta → apaga auth/ e vai para idle.
// - connectionReplaced / forbidden: outra instância assumiu ou a conta foi
//   bloqueada → idle, sem reconectar.
// - Demais (rede, timeout, 5xx) com sessão válida: backoff exponencial, até 5 min.
//
// Contorno de pareamento (Baileys 7.0.0-rc14, issue #2737 / PR #2765 ainda não
// incorporado): desde ~28/07/2026, ao ler o QR o servidor envia
// <notification type="companion_reg_refresh"> e espera que o cliente gere um
// novo advSecretKey e mostre o QR com ele. A rc14 ignora isso, e o celular lê o
// QR sem que o pair-success chegue. Fazemos a rotação aqui e reescrevemos o QR
// com o segredo atual. Remover quando a Baileys incorporar o PR.

import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import makeWASocket, {
	type AuthenticationCreds,
	type BinaryNode,
	DisconnectReason,
	getBinaryNodeChild,
	type WASocket,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import qrcodeTerminal from 'qrcode-terminal'
import type { Dispatcher } from 'undici'
import { baileysLogger, logger } from './logger.js'
import { type ProxyConfig, fetchDispatcher, maskProxy, wsAgent } from './proxy.js'

const log = logger.child({ module: 'connection' })

const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 300_000

export type ConnectionState =
	| { status: 'connecting' }
	| { status: 'qr'; qr: string }
	| { status: 'open'; user: { id: string; name: string | null } }
	| { status: 'reconnecting'; retryAt: string; attempts: number }
	| { status: 'idle'; reason: IdleReason }

export type IdleReason = 'not_started' | 'qr_expired' | 'logged_out' | 'replaced' | 'forbidden'

export type ConnectionOptions = {
	/** Id da conexão (vai nos logs). */
	id: string
	authDir: string
	/** Pede ao celular o histórico completo (volume alto na 1ª conexão). */
	syncHistory: boolean
	/** Chamado a cada novo socket, para registrar os listeners de mensagens. */
	onSocket: (sock: WASocket) => void
	/**
	 * Mudança de estado (status ou motivo), para o log de eventos. `detail` traz
	 * o código/motivo da desconexão quando houver. Nunca recebe o texto do QR.
	 */
	onStateChange?: (status: ConnectionState['status'], detail: Record<string, unknown>) => void
	/** Qualquer mudança de estado, inclusive QR renovado (invalida o cache da interface). */
	onUpdate?: () => void
	/** Proxy de saída atual (lido a cada start: trocar na UI vale na próxima conexão/restart). */
	getProxy: () => ProxyConfig | null
}

export class WhatsAppConnection {
	private sock: WASocket | null = null
	private state: ConnectionState = { status: 'idle', reason: 'not_started' }
	private attempts = 0
	private closing = false
	private retryTimer: NodeJS.Timeout | null = null
	private version: [number, number, number] | undefined
	/** Último QR emitido pela Baileys (antes de reescrever o advSecretKey). */
	private lastQr: string | null = null
	/** Dispatcher do proxy do socket atual (mídia); fechado ao trocar de socket. */
	private dispatcher: Dispatcher | null = null
	/** Código/motivo da última queda, anexado ao próximo evento de estado. */
	private closeDetail: Record<string, unknown> = {}
	private readonly log: typeof log

	constructor(private readonly opts: ConnectionOptions) {
		this.log = log.child({ connection: opts.id })
	}

	getState(): ConnectionState {
		return this.state
	}

	/** Dispatcher do fetch para baixar mídia pelo mesmo proxy do socket (undefined = direto). */
	getFetchDispatcher(): Dispatcher | undefined {
		return this.dispatcher ?? undefined
	}

	/** Socket aberto, para enviar mensagens (testes com IA). null se não conectado. */
	getSocket(): WASocket | null {
		return this.state.status === 'open' ? this.sock : null
	}

	/** Inicia a conexão. Sem efeito se já estiver conectando/conectado. */
	async start(): Promise<void> {
		if (this.state.status !== 'idle' && this.state.status !== 'reconnecting') return
		if (this.retryTimer) clearTimeout(this.retryTimer)
		this.retryTimer = null
		this.closing = false

		this.version ??= await latestVersion()

		this.setState({ status: 'connecting' })
		const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir)

		// Proxy lido agora: WebSocket e upload de mídia saem pelo mesmo IP.
		await this.releaseDispatcher()
		const proxy = this.opts.getProxy()
		this.dispatcher = proxy ? fetchDispatcher(proxy) : null
		if (proxy) this.log.info({ proxy: maskProxy(proxy) }, 'conectando via proxy')

		const sock = makeWASocket({
			version: this.version,
			logger: baileysLogger,
			agent: proxy ? wsAgent(proxy) : undefined,
			// A Baileys só usa fetchAgent se ele tiver .dispatch (dispatcher do undici).
			fetchAgent: (this.dispatcher ?? undefined) as never,
			auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
			// Não marca "online": o celular continua recebendo notificações.
			markOnlineOnConnect: false,
			// Histórico completo só se pedido. Não bloqueamos a sincronização inicial
			// (shouldSyncHistoryMessage padrão): é por ela que a v7 recebe o mapeamento
			// LID <-> número, e desligá-la causa erros de sessão. O que é *encaminhado*
			// ao endpoint é decidido no listener (CAPTURE_HISTORY).
			syncFullHistory: this.opts.syncHistory,
			// Só capturamos; não precisamos reenviar mensagens em retries.
			getMessage: async () => undefined,
		})
		this.sock = sock

		sock.ev.on('creds.update', saveCreds)

		sock.ws.on('CB:notification,type:companion_reg_refresh', (node: BinaryNode) => {
			if (sock !== this.sock) return
			this.handleCompanionRegRefresh(node, state.creds, saveCreds)
		})

		sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
			// Ignora eventos de um socket antigo (substituído por reconexão).
			if (sock !== this.sock) return

			if (qr) {
				this.lastQr = qr
				this.showQr(withAdvSecret(qr, state.creds.advSecretKey))
			}

			if (connection === 'open') {
				this.attempts = 0
				const user = { id: sock.user?.id ?? '', name: sock.user?.name ?? sock.user?.notify ?? null }
				this.setState({ status: 'open', user })
				this.log.info({ user: user.id }, 'conectado')
			}

			if (connection === 'close') {
				if (this.closing) return
				const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
				const registered = Boolean(state.creds.registered || state.creds.me)
				this.handleClose(code, registered, lastDisconnect?.error?.message).catch((err) =>
					this.log.error({ err }, 'erro ao tratar desconexão'),
				)
			}
		})

		this.opts.onSocket(sock)
	}

	/** Desconecta o aparelho no WhatsApp (some de "Aparelhos conectados") e apaga a sessão. */
	async logout(): Promise<void> {
		const sock = this.sock
		if (!sock || this.state.status !== 'open') return
		this.closing = true
		await sock.logout().catch((err) => this.log.warn({ err }, 'falha no logout remoto'))
		await clearAuthDir(this.opts.authDir)
		this.sock = null
		this.setState({ status: 'idle', reason: 'logged_out' })
		this.log.info('sessão desconectada pela interface')
	}

	/**
	 * Cancela um QR pendente (ou conexão/reconexão em andamento) e volta a idle.
	 * Credenciais de um pareamento não concluído são descartadas; uma sessão
	 * pareada é mantida (use logout para desfazê-la).
	 */
	async cancel(): Promise<void> {
		const { status } = this.state
		if (status !== 'qr' && status !== 'connecting' && status !== 'reconnecting') return
		this.closing = true
		if (this.retryTimer) clearTimeout(this.retryTimer)
		this.retryTimer = null
		const sock = this.sock
		this.sock = null
		await sock?.end(undefined)
		if (!(await hasSavedSession(this.opts.authDir))) await clearAuthDir(this.opts.authDir)
		this.lastQr = null
		this.setState({ status: 'idle', reason: 'not_started' })
		this.log.info('conexão cancelada pela interface')
	}

	/** Fecha o websocket sem invalidar a sessão (shutdown). */
	async close(): Promise<void> {
		this.closing = true
		if (this.retryTimer) clearTimeout(this.retryTimer)
		await this.sock?.end(undefined)
		await this.releaseDispatcher()
	}

	/**
	 * Fecha o socket atual e abre outro com a MESMA sessão (sem logout, sem QR) —
	 * usado ao trocar o proxy. Sem efeito se estiver parado (vale no próximo start).
	 */
	async restart(): Promise<void> {
		if (this.state.status === 'idle') return
		await this.close()
		this.sock = null
		this.setState({ status: 'idle', reason: 'not_started' })
		await this.start()
	}

	private async releaseDispatcher(): Promise<void> {
		const d = this.dispatcher
		this.dispatcher = null
		await d?.close().catch(() => undefined)
	}

	private async handleClose(code: number | undefined, registered: boolean, message: string | undefined): Promise<void> {
		this.sock = null
		// Vai junto no evento de estado que sair daqui.
		this.closeDetail = { code: code ?? null, error: message ?? null }

		if (code === DisconnectReason.restartRequired) {
			this.log.info('reinício solicitado pelo servidor (normal após o QR)')
			this.setState({ status: 'idle', reason: 'not_started' })
			return this.start()
		}

		if (!registered) {
			// Sem sessão, qualquer queda (incl. 408 "QR refs attempts ended") significa
			// que o QR não foi escaneado. Não gera outro sozinho.
			this.log.info({ code }, 'QR expirou sem leitura; aguardando novo pedido na interface')
			return this.setState({ status: 'idle', reason: 'qr_expired' })
		}

		switch (code) {
			case DisconnectReason.loggedOut:
			case DisconnectReason.multideviceMismatch:
				this.log.error({ code }, 'sessão encerrada no celular; apagando credenciais')
				await clearAuthDir(this.opts.authDir)
				return this.setState({ status: 'idle', reason: 'logged_out' })

			case DisconnectReason.connectionReplaced:
				this.log.error('outra instância abriu esta sessão; esta foi parada')
				return this.setState({ status: 'idle', reason: 'replaced' })

			case DisconnectReason.forbidden:
				this.log.error('acesso negado pelo WhatsApp (403); verifique a conta')
				return this.setState({ status: 'idle', reason: 'forbidden' })
		}

		this.attempts++
		const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.attempts - 1))
		const jittered = Math.round(delay / 2 + Math.random() * (delay / 2))
		this.log.warn({ code, reason: message, attempts: this.attempts, retryInMs: jittered }, 'conexão caiu; reconectando')
		this.setState({
			status: 'reconnecting',
			retryAt: new Date(Date.now() + jittered).toISOString(),
			attempts: this.attempts,
		})
		this.retryTimer = setTimeout(() => {
			this.start().catch((err) => this.log.error({ err }, 'falha ao reconectar'))
		}, jittered)
	}

	private showQr(qr: string): void {
		this.setState({ status: 'qr', qr })
		this.log.info('QR disponível na interface admin e abaixo (WhatsApp > Aparelhos conectados)')
		qrcodeTerminal.generate(qr, { small: true })
	}

	/** Ver comentário do topo: rotaciona o advSecretKey e redesenha o QR atual. */
	private handleCompanionRegRefresh(
		node: BinaryNode,
		creds: AuthenticationCreds,
		saveCreds: () => Promise<void>,
	): void {
		const valid = ['companion_reg_refresh', 'pair-device-rotate-qr'].some((tag) => getBinaryNodeChild(node, tag))
		if (!valid) {
			this.log.warn('companion_reg_refresh sem o conteúdo esperado; ignorado')
			return
		}
		// Sessão já pareada: o segredo é o que valida o vínculo; não pode mudar.
		if (creds.me) return

		creds.advSecretKey = randomBytes(32).toString('base64')
		saveCreds().catch((err) => this.log.error({ err }, 'falha ao salvar credenciais'))
		this.log.info('servidor pediu novo segredo de pareamento; QR atualizado')
		if (this.lastQr) this.showQr(withAdvSecret(this.lastQr, creds.advSecretKey))
	}

	private setState(state: ConnectionState): void {
		const prev = this.state
		this.state = state
		this.opts.onUpdate?.()
		const detail = this.closeDetail
		this.closeDetail = {}
		// QR se renova a cada ~20 s: só registra a entrada no estado, não cada renovação.
		const reason = state.status === 'idle' ? state.reason : null
		const prevReason = prev.status === 'idle' ? prev.reason : null
		if (prev.status === state.status && reason === prevReason && state.status !== 'reconnecting') return
		const extra: Record<string, unknown> = { ...detail, from: prev.status }
		if (state.status === 'idle') extra.reason = state.reason
		if (state.status === 'open') extra.user = state.user.id
		if (state.status === 'reconnecting') Object.assign(extra, { attempts: state.attempts, retryAt: state.retryAt })
		try {
			this.opts.onStateChange?.(state.status, extra)
		} catch (err) {
			this.log.warn({ err }, 'falha ao registrar mudança de estado')
		}
	}
}

// Uma consulta de versão para todas as conexões do processo.
let versionPromise: Promise<[number, number, number]> | null = null
function latestVersion(): Promise<[number, number, number]> {
	versionPromise ??= fetchLatestBaileysVersion().then(({ version, isLatest }) => {
		log.info({ version: version.join('.'), isLatest }, 'versão do WhatsApp Web')
		return version
	})
	return versionPromise
}

/**
 * O QR é "https://wa.me/settings/linked_devices#ref,noise,identity,adv,plataforma".
 * A rc14 fixa o adv no início do fluxo; aqui ele é trocado pelo valor atual.
 */
function withAdvSecret(qr: string, advSecretKey: string): string {
	const hash = qr.indexOf('#')
	const parts = qr.slice(hash + 1).split(',')
	if (hash < 0 || parts.length < 4) return qr
	parts[3] = advSecretKey
	return `${qr.slice(0, hash + 1)}${parts.join(',')}`
}

/**
 * Há uma sessão pareada salva? Decide se o app reconecta sozinho ao iniciar.
 * creds.json existe já na primeira tentativa de QR; só `me` indica pareamento.
 */
export async function hasSavedSession(authDir: string): Promise<boolean> {
	try {
		const creds = JSON.parse(await readFile(path.join(authDir, 'creds.json'), 'utf8')) as { me?: unknown }
		return Boolean(creds.me)
	} catch {
		return false
	}
}

/** Esvazia a pasta (sem removê-la: no Docker ela é o ponto de montagem do volume). */
export async function clearAuthDir(dir: string): Promise<void> {
	const entries = await readdir(dir).catch(() => [] as string[])
	await Promise.all(entries.map((e) => rm(path.join(dir, e), { recursive: true, force: true })))
}
