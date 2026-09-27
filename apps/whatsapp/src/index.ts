// Entrada do serviço whatsapp: abre o banco, carrega as conexões, sobe a
// interface admin e cuida do shutdown gracioso.

import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import { startAdmin } from './admin.js'
import { ChangeBus } from './changes.js'
import { config } from './config.js'
import { openDb } from './db.js'
import { EventLog } from './events.js'
import { defaultFilters } from './filters.js'
import { FlowStore } from './flows.js'
import { logger } from './logger.js'
import { ConnectionManager } from './manager.js'
import { MediaDownloader } from './media.js'
import { MessageStore } from './messages.js'
import { WebhookProxy } from './proxy.js'
import { ConnectionsStore } from './settings.js'
import { TestRunner } from './tester.js'

// O Node tenta IPv6 e IPv4 em paralelo dando só 250 ms a cada endereço. No WSL
// (e em redes com IPv6 quebrado) isso estoura antes do IPv4 responder e o
// fetch falha com ETIMEDOUT mesmo com o destino no ar. 2 s é folga suficiente.
net.setDefaultAutoSelectFamilyAttemptTimeout(2_000)

// Tempo para drenar as filas no shutdown (abaixo do stop_grace_period de 30s do compose).
const DRAIN_MS = 15_000

async function main(): Promise<void> {
	await mkdir(config.authDir, { recursive: true })
	await mkdir(config.queueDir, { recursive: true })
	await mkdir(config.media.dir, { recursive: true })

	const db = openDb(config.db.path)
	logger.info({ path: config.db.path }, 'banco aberto')
	const changes = new ChangeBus()
	const events = new EventLog(db, config.db.eventsRetentionDays, changes)
	events.startPruning()
	const messages = new MessageStore(db, changes)
	const interrupted = messages.failInterruptedMedia()
	if (interrupted) logger.warn({ media: interrupted }, 'downloads de mídia interrompidos pelo reinício')
	const media = new MediaDownloader(messages, config.media)
	const flows = new FlowStore(db, changes)
	const orphanUploads = flows.pruneUploads()
	if (orphanUploads) logger.info({ removed: orphanUploads }, 'JSONs de fluxo anexados e não usados foram apagados')
	const webhookProxy = config.forward.proxyUrl ? new WebhookProxy(config.forward.proxyUrl, config.forward.noProxy) : null
	if (webhookProxy) logger.info({ noProxy: config.forward.noProxy }, 'entregas do webhook via proxy (WEBHOOK_PROXY_URL)')

	// CAPTURE_FROM_ME / CAPTURE_GROUPS viram só o padrão; cada conexão edita os seus na interface.
	const store = new ConnectionsStore(
		db,
		config.settingsDir,
		defaultFilters({ fromMe: config.capture.fromMe, groups: config.capture.groups }),
	)
	await store.load()

	const manager = new ConnectionManager(store, config, { messages, media, events, changes, webhookProxy })
	await manager.init()

	const tester = new TestRunner(manager, config.tester, db, flows, events, changes, config.cards, config.twilio)
	await tester.load()

	const admin = startAdmin({
		...config.admin,
		manager,
		store,
		tester,
		flows,
		messages,
		events,
		changes,
		webhookProxy,
		testerCfg: config.tester,
		cardsCfg: config.cards,
		twilioCfg: config.twilio,
		mediaDir: config.media.dir,
		timeoutMs: config.forward.timeoutMs,
	})

	let shuttingDown = false
	const shutdown = async (reason: string): Promise<void> => {
		if (shuttingDown) return
		shuttingDown = true
		logger.info({ reason }, 'encerrando')
		// Cancela testes, fecha os sockets (para de chegar mensagem) e drena as filas.
		tester.stopAll()
		media.stop()
		await manager.shutdown(DRAIN_MS)
		await admin.close()
		events.stop()
		await webhookProxy?.close().catch(() => undefined)
		// Fecha o banco por último: o shutdown acima ainda grava eventos/execuções.
		db.close()
		process.exit(0)
	}
	process.once('SIGINT', () => void shutdown('SIGINT'))
	process.once('SIGTERM', () => void shutdown('SIGTERM'))

	logger.info(
		{ connections: store.list().map((c) => `${c.friendlyName} (${c.id})`) },
		`pronto — gerencie as conexões em http://localhost:${config.admin.port}`,
	)
}

main().catch((err) => {
	logger.fatal({ err }, 'falha na inicialização')
	process.exit(1)
})
