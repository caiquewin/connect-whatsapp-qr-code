// Configuração lida do ambiente (.env localmente; env_file + environment no compose).
// Os defaults valem para execução local; no Docker o compose sobrescreve URL e caminhos.

import path from 'node:path'

function str(name: string, fallback?: string): string {
	const value = process.env[name]?.trim()
	if (value) return value
	if (fallback !== undefined) return fallback
	throw new Error(`Variável de ambiente obrigatória ausente: ${name}`)
}

function int(name: string, fallback: number): number {
	const raw = process.env[name]?.trim()
	if (!raw) return fallback
	const value = Number(raw)
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} deve ser um inteiro >= 0 (recebido: "${raw}")`)
	}
	return value
}

function bool(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase()
	if (!raw) return fallback
	return raw === 'true' || raw === '1' || raw === 'yes'
}

function list(name: string): string[] {
	return (process.env[name] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
}

function twilioEnv(env: string) {
	return {
		accountSid: str(`TWILIO_${env}_ACCOUNT_SID`, ''),
		apiKeySid: str(`TWILIO_${env}_API_KEY_SID`, ''),
		apiKeySecret: str(`TWILIO_${env}_API_KEY_SECRET`, ''),
		authToken: str(`TWILIO_${env}_AUTH_TOKEN`, ''),
	}
}

export const config = {
	logLevel: str('LOG_LEVEL', 'info'),
	baileysLogLevel: str('BAILEYS_LOG_LEVEL', 'warn'),

	// Caminhos resolvidos a partir do diretório de execução (apps/whatsapp localmente).
	authDir: path.resolve(str('AUTH_DIR', './auth')),
	queueDir: path.resolve(str('QUEUE_DIR', './queue')),
	settingsDir: path.resolve(str('SETTINGS_DIR', './settings')),

	// Banco SQLite: conexões, fluxos, execuções de teste, conversas, mídia (metadados) e eventos.
	db: {
		path: path.resolve(str('DB_PATH', './db/app.db')),
		/** Eventos (estado da conexão, entregas do webhook, testes) mais antigos que isso são apagados. 0 = nunca. */
		eventsRetentionDays: int('EVENTS_RETENTION_DAYS', 90),
	},

	// Mídia das mensagens: arquivo em MEDIA_DIR/<conexão>/, metadados no banco.
	media: {
		dir: path.resolve(str('MEDIA_DIR', './media')),
		download: bool('MEDIA_DOWNLOAD', true),
		/** Arquivos maiores que isso não são baixados (ficam só os metadados). */
		maxBytes: int('MEDIA_MAX_MB', 50) * 1024 * 1024,
	},

	// Interface admin (destino do encaminhamento). Local: só loopback;
	// no Docker o compose usa 0.0.0.0 e publica a porta apenas em 127.0.0.1.
	admin: {
		host: str('ADMIN_HOST', '127.0.0.1'),
		port: int('ADMIN_PORT', 3200),
		/**
		 * Hosts aceitos além de localhost/127.0.0.1/[::1] (vírgula). Só para quem
		 * acessa pelo proxy reverso com domínio próprio; é a proteção contra DNS rebinding.
		 */
		allowedHosts: list('ADMIN_ALLOWED_HOSTS'),
	},

	forward: {
		// URL e token abaixo são só o padrão inicial; o que for salvo na
		// interface admin (SETTINGS_DIR/forward.json) tem prioridade.
		url: str('FORWARD_URL', 'http://localhost:3000/messages'),
		token: str('ENDPOINT_TOKEN', ''),
		timeoutMs: int('FORWARD_TIMEOUT_MS', 10_000),
		backoffBaseMs: int('FORWARD_BACKOFF_BASE_MS', 1_000),
		backoffMaxMs: int('FORWARD_BACKOFF_MAX_MS', 300_000),
		minIntervalMs: int('FORWARD_MIN_INTERVAL_MS', 100),
		/** Proxy HTTP(S) de saída das entregas (vazio = direto). Pode ter usuário:senha. */
		proxyUrl: str('WEBHOOK_PROXY_URL', ''),
		/** Hosts que saem direto mesmo com proxy (vírgula; ".dominio" pega subdomínios). */
		noProxy: str('WEBHOOK_NO_PROXY', 'localhost,127.0.0.1,::1,endpoint'),
	},

	// Testes de fluxo com IA: o backend chama o Claude Code CLI (`claude -p`).
	tester: {
		claudeBin: str('TESTER_CLAUDE_BIN', 'claude'),
		model: str('TESTER_MODEL', 'sonnet'),
		aiTimeoutMs: int('TESTER_AI_TIMEOUT_MS', 120_000),
		/** Log de cada execução em Markdown (conversa, análises, veredito, referência usada). */
		logsDir: path.resolve(str('TEST_LOGS_DIR', './test-logs')),
		/** Tamanho máximo da referência (card + roteiro dos fluxos) enviada à IA. */
		referenceMaxBytes: int('TESTER_REFERENCE_MAX_KB', 400) * 1024,
		/** Se preenchido, a pasta do projeto precisa estar dentro de uma destas (vírgula). */
		studioAllowedRoots: (process.env.STUDIO_ALLOWED_ROOTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
		/** Pasta antiga das execuções em JSON; só lida uma vez para migrar ao banco. */
		legacyRunsDir: path.resolve(str('SETTINGS_DIR', './settings'), 'test-runs'),
	},

	// Leitura (somente GET) de cards do Azure DevOps e do Jira para os testes com IA.
	// Use tokens só de leitura. Os tokens nunca vão para a interface nem para o log.
	cards: {
		azurePat: str('AZDO_PAT', ''),
		/** Hosts extras do Azure DevOps (ex.: servidor próprio). Padrão: dev.azure.com e *.visualstudio.com. */
		azureHosts: list('AZDO_HOSTS'),
		jiraEmail: str('JIRA_EMAIL', ''),
		jiraToken: str('JIRA_API_TOKEN', ''),
		/** Hosts extras do Jira. Padrão: *.atlassian.net. */
		jiraHosts: list('JIRA_HOSTS'),
	},

	// Acompanhamento da execução no Twilio Studio durante os testes (só GET,
	// só studio.twilio.com). Uma conta por ambiente; prefira API Key restrita.
	twilio: {
		dev: twilioEnv('DEV'),
		qa: twilioEnv('QA'),
		prod: twilioEnv('PROD'),
		/** Intervalo de consulta da execução enquanto o teste roda. */
		pollMs: Math.max(int('TESTER_STUDIO_POLL_MS', 10_000), 3_000),
	},

	// Quantas conexões (números) a interface permite criar.
	maxConnections: int('MAX_CONNECTIONS', 10),

	capture: {
		fromMe: bool('CAPTURE_FROM_ME', true),
		groups: bool('CAPTURE_GROUPS', true),
		history: bool('CAPTURE_HISTORY', false),
	},
} as const

export type Config = typeof config
