// Proxies de SAÍDA.
//
// 1) WhatsApp, por conexão: cada número pode sair por um proxy próprio
//    (http, https ou socks5). Vale para o WebSocket (agent) e para
//    upload/download de mídia (dispatcher do undici — o fetch nativo não aceita
//    https.Agent). Números diferentes no mesmo IP são um sinal a menos de
//    automação; mas TROCAR o IP de uma sessão com frequência também é: escolha
//    um proxy estável (residencial/fixo) por número.
//
// 2) Webhook, global (WEBHOOK_PROXY_URL): proxy corporativo/de egress para as
//    entregas. Hosts em WEBHOOK_NO_PROXY (ex.: o serviço endpoint na rede do
//    compose) saem direto.
//
// Credenciais do proxy são segredo: nunca vão para log, eventos nem para a
// interface (só `maskProxy`).

import type { Agent as HttpsAgent } from 'node:https'
import tls from 'node:tls'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksClient } from 'socks'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { Agent as UndiciAgent, type Dispatcher, ProxyAgent } from 'undici'

export const PROXY_PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:'] as const

/** Proxy salvo por conexão. `url` = esquema://host:porta (sem credenciais). */
export type ProxyConfig = {
	url: string
	username: string
	password: string
}

const MAX_FIELD = 256
const SOCKS_TIMEOUT_MS = 15_000

/** Valida o proxy vindo da interface/banco. Lança com mensagem legível. */
export function parseProxy(input: unknown): ProxyConfig {
	const obj = (input ?? {}) as Record<string, unknown>
	const raw = String(obj.url ?? '').trim()
	let u: URL
	try {
		u = new URL(raw)
	} catch {
		throw new Error('URL do proxy inválida (ex.: socks5://host:1080 ou http://host:3128)')
	}
	if (!PROXY_PROTOCOLS.includes(u.protocol as (typeof PROXY_PROTOCOLS)[number])) {
		throw new Error('O proxy precisa ser http://, https:// ou socks5://')
	}
	if (!u.hostname || !u.port) throw new Error('Informe host e porta do proxy (ex.: socks5://host:1080)')
	if (u.username || u.password) throw new Error('Informe usuário e senha nos campos próprios, não na URL')
	if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new Error('A URL do proxy não deve ter caminho nem parâmetros')
	const username = String(obj.username ?? '').trim()
	const password = String(obj.password ?? '')
	if (username.length > MAX_FIELD || password.length > MAX_FIELD) throw new Error('Usuário/senha do proxy muito longos')
	if (password && !username) throw new Error('Senha do proxy sem usuário')
	return { url: `${u.protocol}//${u.host}`, username, password }
}

/** Para exibir/logar: só esquema, host e porta. */
export function maskProxy(p: ProxyConfig): string {
	return p.url
}

function withAuth(p: ProxyConfig): URL {
	const u = new URL(p.url)
	if (p.username) {
		u.username = encodeURIComponent(p.username)
		u.password = encodeURIComponent(p.password)
	}
	return u
}

const isSocks = (p: ProxyConfig) => p.url.startsWith('socks5')

/** Agent do WebSocket da Baileys (opção `agent` do socket). */
export function wsAgent(p: ProxyConfig): HttpsAgent {
	const url = withAuth(p)
	// socks5h: o proxy resolve o DNS (não vaza o domínio pelo DNS local).
	if (isSocks(p)) url.protocol = 'socks5h:'
	return (isSocks(p) ? new SocksProxyAgent(url) : new HttpsProxyAgent(url)) as unknown as HttpsAgent
}

/** Dispatcher do undici para o fetch nativo (mídia, teste de proxy, webhook). */
export function fetchDispatcher(p: ProxyConfig): Dispatcher {
	if (!isSocks(p)) {
		const url = withAuth(p)
		const token = p.username
			? `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}`
			: undefined
		url.username = ''
		url.password = ''
		return new ProxyAgent({ uri: url.toString(), token })
	}
	// undici não fala SOCKS: abre o túnel com a lib `socks` e, se o destino for
	// https, faz o TLS por cima (com SNI e verificação de certificado normais).
	const { hostname, port } = new URL(p.url)
	return new UndiciAgent({
		connect: (opts, callback) => {
			const destPort = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80)
			SocksClient.createConnection({
				proxy: { host: hostname, port: Number(port), type: 5, userId: p.username || undefined, password: p.password || undefined },
				command: 'connect',
				destination: { host: opts.hostname, port: destPort },
				timeout: SOCKS_TIMEOUT_MS,
			}).then(({ socket }) => {
				if (opts.protocol !== 'https:') return callback(null, socket)
				const secure = tls.connect({ socket, servername: opts.servername || opts.hostname, ALPNProtocols: ['http/1.1'] })
				secure.once('secureConnect', () => callback(null, secure))
				secure.once('error', (err) => callback(err, null))
			}, (err: Error) => callback(err, null))
		},
	})
}

/** Testa o proxy abrindo HTTPS até o WhatsApp Web. Não envia nada da conta. */
export async function testProxy(p: ProxyConfig, timeoutMs: number): Promise<{ status: number }> {
	const dispatcher = fetchDispatcher(p)
	try {
		const res = await fetch('https://web.whatsapp.com/', {
			method: 'HEAD',
			// undici (npm) e o fetch nativo compartilham a interface de Dispatcher.
			dispatcher: dispatcher as never,
			signal: AbortSignal.timeout(timeoutMs),
		} as RequestInit)
		return { status: res.status }
	} finally {
		await dispatcher.close().catch(() => undefined)
	}
}

/**
 * Proxy global das entregas ao webhook. `noProxy`: hosts (ou sufixos com ".")
 * que saem direto — por padrão o serviço endpoint e o loopback.
 */
export class WebhookProxy {
	private readonly dispatcher: Dispatcher
	private readonly noProxy: string[]

	constructor(
		proxyUrl: string,
		noProxy: string,
	) {
		const u = new URL(proxyUrl)
		if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('WEBHOOK_PROXY_URL precisa ser http:// ou https://')
		const creds = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : { username: '', password: '' }
		this.dispatcher = fetchDispatcher({ url: `${u.protocol}//${u.host}`, ...creds })
		this.noProxy = noProxy.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
	}

	/** Dispatcher para este destino, ou undefined para sair direto. */
	for(targetUrl: string): Dispatcher | undefined {
		const host = new URL(targetUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
		const bypass = this.noProxy.some((h) => h === '*' || host === h || (h.startsWith('.') && host.endsWith(h)))
		return bypass ? undefined : this.dispatcher
	}

	close(): Promise<void> {
		return this.dispatcher.close()
	}
}
