// Receptor dos POSTs do serviço whatsapp. Valida o token e grava cada
// mensagem como uma linha JSON em DATA_DIR/messages-AAAA-MM-DD.jsonl.
//
// JSONL é o armazenamento mais simples que funciona: append-only, fácil de
// inspecionar e de importar depois num banco. Reentregas (retry após timeout)
// podem gerar linhas repetidas — deduplique pelo campo "id" ao processar.

import { timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import Fastify from 'fastify'

const PORT = Number(process.env.PORT ?? 3000)
// Local: só loopback. No Docker o compose define HOST=0.0.0.0 (rede interna).
const HOST = process.env.HOST ?? '127.0.0.1'
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data')
const TOKEN = process.env.ENDPOINT_TOKEN?.trim()

if (!TOKEN) {
	console.error('ENDPOINT_TOKEN ausente no ambiente')
	process.exit(1)
}
const expected = Buffer.from(`Bearer ${TOKEN}`)

const app = Fastify({
	logger: { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'endpoint' } },
	bodyLimit: 256 * 1024,
})

// Comparação em tempo constante para não vazar o token por timing.
app.addHook('onRequest', async (req, reply) => {
	if (req.url === '/health') return
	const got = Buffer.from(req.headers.authorization ?? '')
	if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
		return reply.code(401).send({ error: 'unauthorized' })
	}
})

// Validação mínima: o resto do formato é responsabilidade do normalizer do app.
const messageSchema = {
	body: {
		type: 'object',
		required: ['id', 'chatId', 'timestamp', 'type'],
		properties: {
			id: { type: 'string', minLength: 1 },
			chatId: { type: 'string', minLength: 1 },
			timestamp: { type: 'number' },
			type: { type: 'string' },
		},
	},
} as const

app.post<{ Body: { id: string; chatId: string; type: string } }>('/messages', { schema: messageSchema }, async (req, reply) => {
	const receivedAt = new Date()
	const file = path.join(DATA_DIR, `messages-${receivedAt.toISOString().slice(0, 10)}.jsonl`)
	await appendFile(file, `${JSON.stringify({ ...req.body, receivedAt: receivedAt.toISOString() })}\n`)
	// Só metadados no log.
	req.log.info({ id: req.body.id, type: req.body.type }, 'mensagem armazenada')
	return reply.code(202).send({ ok: true })
})

app.get('/health', async () => ({ ok: true }))

async function main(): Promise<void> {
	await mkdir(DATA_DIR, { recursive: true })
	await app.listen({ port: PORT, host: HOST })
}

// Desligamento gracioso: termina as requisições em andamento antes de sair.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		app.log.info({ signal }, 'encerrando')
		app.close().then(() => process.exit(0), () => process.exit(1))
	})
}

main().catch((err) => {
	app.log.fatal({ err }, 'falha na inicialização')
	process.exit(1)
})
