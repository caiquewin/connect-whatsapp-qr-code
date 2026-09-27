import pino from 'pino'
import { config } from './config.js'

// Logger da aplicação. Em produção só metadados (ids, tipos, contagens) —
// nunca o texto das mensagens.
export const logger = pino({ level: config.logLevel, base: { service: 'whatsapp' } })

// A Baileys é extremamente verbosa em debug/trace; tem nível próprio.
export const baileysLogger = logger.child({ module: 'baileys' }, { level: config.baileysLogLevel })
