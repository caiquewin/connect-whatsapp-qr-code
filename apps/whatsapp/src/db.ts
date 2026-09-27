// Banco SQLite do serviço (node:sqlite, embutido no Node 22 — sem dependência nova).
//
// Guarda tudo que não é sessão da Baileys nem fila do webhook:
//   connections  cadastro (nome, webhook, filtros)
//   flows        fluxos de teste: cada conexão tem vários
//   test_runs    execuções de um fluxo (transcrição + veredito)
//   chats        conversas por conexão
//   messages     mensagens capturadas (todas, inclusive as que os filtros não encaminham)
//   media        metadados da mídia; o arquivo fica em MEDIA_DIR
//   events       log de eventos: estado da conexão, entregas do webhook, testes
//
// Continuam em arquivo, de propósito: a sessão (AUTH_DIR — formato da Baileys,
// perder = novo QR) e a fila do webhook (QUEUE_DIR — "persistir antes de enviar"
// já é atômico e fácil de inspecionar).
//
// A API é síncrona: cada escrita é curta e o volume é de uso pessoal. WAL
// deixa leituras da interface rodarem sem esperar escritas.

import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { logger } from './logger.js'

const log = logger.child({ module: 'db' })

export type Db = DatabaseSync
export type Row = Record<string, unknown>

// Cada item é uma versão do schema (PRAGMA user_version). Só acrescente no fim.
const MIGRATIONS: string[] = [
	`
	CREATE TABLE connections (
		id            TEXT PRIMARY KEY,
		friendly_name TEXT NOT NULL,
		webhook       TEXT,              -- JSON { url, method, token } ou NULL
		filters       TEXT NOT NULL,     -- JSON Filters
		created_at    TEXT NOT NULL
	);

	CREATE TABLE flows (
		id                TEXT PRIMARY KEY,
		connection_id     TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
		name              TEXT NOT NULL,
		to_phone          TEXT NOT NULL,
		task              TEXT NOT NULL,
		rules             TEXT NOT NULL, -- JSON string[]
		max_turns         INTEGER NOT NULL,
		reply_timeout_sec INTEGER NOT NULL,
		quiet_sec         INTEGER NOT NULL,
		created_at        TEXT NOT NULL,
		updated_at        TEXT NOT NULL
	);
	CREATE INDEX flows_connection ON flows(connection_id, name);

	CREATE TABLE test_runs (
		id              TEXT PRIMARY KEY,
		flow_id         TEXT REFERENCES flows(id) ON DELETE CASCADE, -- NULL = execução antiga, sem fluxo
		connection_id   TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
		connection_name TEXT NOT NULL,
		status          TEXT NOT NULL,
		input           TEXT NOT NULL,   -- JSON TestInput (cópia do fluxo no momento da execução)
		target_jid      TEXT,
		transcript      TEXT NOT NULL,   -- JSON TranscriptEntry[]
		turns           INTEGER NOT NULL,
		summary         TEXT,
		rules           TEXT,            -- JSON RuleResult[] ou NULL
		error           TEXT,
		cost_usd        REAL NOT NULL,
		created_at      TEXT NOT NULL,
		finished_at     TEXT
	);
	CREATE INDEX test_runs_flow ON test_runs(flow_id, created_at);
	CREATE INDEX test_runs_connection ON test_runs(connection_id, created_at);

	CREATE TABLE chats (
		connection_id   TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
		chat_id         TEXT NOT NULL,
		chat_id_alt     TEXT,
		is_group        INTEGER NOT NULL,
		name            TEXT,            -- pushName do contato (1:1)
		last_message_at INTEGER NOT NULL, -- epoch s
		PRIMARY KEY (connection_id, chat_id)
	);
	CREATE INDEX chats_recent ON chats(connection_id, last_message_at DESC);

	CREATE TABLE messages (
		connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
		chat_id       TEXT NOT NULL,
		id            TEXT NOT NULL,
		from_me       INTEGER NOT NULL,
		sender_id     TEXT,
		sender_id_alt TEXT,
		push_name     TEXT,
		timestamp     INTEGER NOT NULL,  -- epoch s
		type          TEXT NOT NULL,
		text          TEXT,
		quoted_id     TEXT,
		source        TEXT NOT NULL,     -- live | history
		forwarded     INTEGER NOT NULL,  -- 1 = passou nos filtros e foi para a fila do webhook
		created_at    TEXT NOT NULL,
		PRIMARY KEY (connection_id, chat_id, id),
		FOREIGN KEY (connection_id, chat_id) REFERENCES chats(connection_id, chat_id) ON DELETE CASCADE
	);
	CREATE INDEX messages_chat_time ON messages(connection_id, chat_id, timestamp);

	CREATE TABLE media (
		id            INTEGER PRIMARY KEY,
		connection_id TEXT NOT NULL,
		chat_id       TEXT NOT NULL,
		message_id    TEXT NOT NULL,
		mimetype      TEXT,
		file_length   INTEGER,
		seconds       INTEGER,
		file_name     TEXT,              -- nome original (documentos)
		path          TEXT,              -- relativo a MEDIA_DIR
		sha256        TEXT,
		status        TEXT NOT NULL,     -- pending | saved | skipped | failed
		error         TEXT,
		updated_at    TEXT NOT NULL,
		UNIQUE (connection_id, chat_id, message_id),
		FOREIGN KEY (connection_id, chat_id, message_id) REFERENCES messages(connection_id, chat_id, id) ON DELETE CASCADE
	);

	CREATE TABLE events (
		id            INTEGER PRIMARY KEY,
		at            TEXT NOT NULL,
		connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
		kind          TEXT NOT NULL,     -- connection | webhook | test
		type          TEXT NOT NULL,
		ref           TEXT,              -- id relacionado (mensagem, execução de teste)
		data          TEXT               -- JSON só com metadados (nunca texto de mensagem, token ou QR)
	);
	CREATE INDEX events_connection ON events(connection_id, id);
	CREATE INDEX events_kind ON events(kind, id);
	CREATE INDEX events_at ON events(at);
	`,
	// v2: proxy de saída do WhatsApp por conexão (JSON ProxyConfig, com credenciais).
	`
	ALTER TABLE connections ADD COLUMN proxy TEXT;
	`,
	// v3: paginação por cursor (keyset) e contador de mensagens por conversa
	// (a lista de conversas não faz mais COUNT(*) por linha).
	`
	ALTER TABLE chats ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
	UPDATE chats SET message_count = (
		SELECT COUNT(*) FROM messages m WHERE m.connection_id = chats.connection_id AND m.chat_id = chats.chat_id
	);
	DROP INDEX chats_recent;
	CREATE INDEX chats_page ON chats(connection_id, last_message_at DESC, chat_id DESC);
	DROP INDEX messages_chat_time;
	CREATE INDEX messages_page ON messages(connection_id, chat_id, timestamp DESC, id DESC);
	`,
	// v4: referência dos testes com IA — card da demanda e fluxo do Twilio Studio
	// (pasta do projeto ou JSON anexado), e o registro completo de cada execução.
	`
	ALTER TABLE flows ADD COLUMN card TEXT;     -- JSON CardConfig ou NULL
	ALTER TABLE flows ADD COLUMN studio TEXT;   -- JSON StudioConfig ou NULL
	CREATE TABLE studio_uploads (
		id         INTEGER PRIMARY KEY,
		file_name  TEXT NOT NULL,
		content    TEXT NOT NULL,             -- JSON do Studio como anexado
		created_at TEXT NOT NULL
	);
	ALTER TABLE test_runs ADD COLUMN reference TEXT;  -- referência exata enviada à IA (card + roteiro)
	ALTER TABLE test_runs ADD COLUMN analysis TEXT;   -- JSON: passos da IA, divergências, requisitos do card
	ALTER TABLE test_runs ADD COLUMN log_path TEXT;   -- arquivo .md do log em TEST_LOGS_DIR
	`,
]

export function openDb(file: string): Db {
	mkdirSync(path.dirname(file), { recursive: true })
	const db = new DatabaseSync(file)
	// Tem tokens de webhook e conversas: só o dono lê. O SQLite cria -wal/-shm
	// com a mesma permissão do arquivo principal.
	chmodSync(file, 0o600)
	db.exec('PRAGMA journal_mode = WAL')
	db.exec('PRAGMA synchronous = NORMAL')
	db.exec('PRAGMA foreign_keys = ON')
	db.exec('PRAGMA busy_timeout = 5000')
	migrate(db)
	return db
}

function migrate(db: Db): void {
	const current = Number((db.prepare('PRAGMA user_version').get() as Row).user_version)
	for (let v = current; v < MIGRATIONS.length; v++) {
		tx(db, () => {
			db.exec(MIGRATIONS[v]!)
			db.exec(`PRAGMA user_version = ${v + 1}`)
		})
		log.info({ version: v + 1 }, 'schema do banco atualizado')
	}
}

/** Executa `fn` numa transação (tudo ou nada). Não aninhe. */
export function tx<T>(db: Db, fn: () => T): T {
	db.exec('BEGIN IMMEDIATE')
	try {
		const out = fn()
		db.exec('COMMIT')
		return out
	} catch (err) {
		db.exec('ROLLBACK')
		throw err
	}
}

/** node:sqlite não aceita boolean/undefined: converte para 0/1 e NULL. */
export function v(value: string | number | boolean | null | undefined): SQLInputValue {
	if (value === undefined) return null
	if (typeof value === 'boolean') return value ? 1 : 0
	return value
}

/** JSON de coluna TEXT; `fallback` se vier NULL. */
export function parseJson<T>(value: unknown, fallback: T): T {
	return typeof value === 'string' ? (JSON.parse(value) as T) : fallback
}
