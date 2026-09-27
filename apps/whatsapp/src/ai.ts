// Ponte com o Claude Code CLI em modo não interativo (`claude -p`).
//
// Cada chamada é isolada e sem poderes: sem ferramentas (--tools ""), sem
// sessão salva, sem configurações/CLAUDE.md locais (--setting-sources "" e
// cwd neutro). O CLI só recebe texto e devolve JSON validado por --json-schema.
// Usa o login do Claude Code da máquina; no Docker o binário não existe e a
// chamada falha com mensagem clara (ENOENT).

import { spawn } from 'node:child_process'
import os from 'node:os'

export type AiOptions = {
	bin: string
	model: string
	timeoutMs: number
	signal?: AbortSignal
	/**
	 * System prompt em arquivo (--system-prompt-file) em vez de argumento:
	 * a referência dos testes pode passar do limite de 128 KB por argumento do
	 * Linux, e sendo igual em todos os turnos aproveita o cache de prompt.
	 */
	systemPromptFile?: string
}

export type AiResult<T> = { output: T; costUsd: number | null; durationMs: number | null }

/**
 * De vez em quando o CLI termina sem a saída estruturada (observado ~1 em 10
 * chamadas). Repetimos a chamada antes de desistir.
 */
const ATTEMPTS = 3

export async function askClaude<T>(
	systemPrompt: string,
	prompt: string,
	schema: object,
	opts: AiOptions,
): Promise<AiResult<T>> {
	let lastError: Error | null = null
	let spent = 0
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		if (opts.signal?.aborted) throw new Error('cancelado')
		try {
			const res = await askOnce<T>(systemPrompt, prompt, schema, opts)
			return { ...res, costUsd: (res.costUsd ?? 0) + spent }
		} catch (err) {
			lastError = err as Error
			spent += (err as { costUsd?: number }).costUsd ?? 0
			// Binário ausente, cancelamento ou timeout: repetir não ajuda.
			if (!(err as { retryable?: boolean }).retryable) throw err
		}
	}
	throw lastError!
}

async function askOnce<T>(systemPrompt: string, prompt: string, schema: object, opts: AiOptions): Promise<AiResult<T>> {
	const args = [
		'-p',
		'--output-format', 'json',
		'--json-schema', JSON.stringify(schema),
		...(opts.systemPromptFile ? ['--system-prompt-file', opts.systemPromptFile] : ['--system-prompt', systemPrompt]),
		'--tools', '',
		'--no-session-persistence',
		'--setting-sources', '',
		'--model', opts.model,
	]

	// O token do webhook não tem por que ir para o processo do CLI.
	const env = { ...process.env }
	delete env.ENDPOINT_TOKEN

	const stdout = await new Promise<string>((resolve, reject) => {
		const child = spawn(opts.bin, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] })
		const out: Buffer[] = []
		const err: Buffer[] = []
		child.stdout.on('data', (c: Buffer) => out.push(c))
		child.stderr.on('data', (c: Buffer) => err.push(c))

		const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
		const onAbort = () => child.kill('SIGTERM')
		opts.signal?.addEventListener('abort', onAbort, { once: true })

		child.on('error', (e: NodeJS.ErrnoException) => {
			clearTimeout(timer)
			reject(
				e.code === 'ENOENT'
					? new Error(`Claude CLI não encontrado ("${opts.bin}"). Instale o Claude Code ou ajuste TESTER_CLAUDE_BIN.`)
					: e,
			)
		})
		child.on('close', (code, signal) => {
			clearTimeout(timer)
			opts.signal?.removeEventListener('abort', onAbort)
			if (opts.signal?.aborted) return reject(new Error('cancelado'))
			if (signal) return reject(new Error(`Claude CLI interrompido (${signal}) — tempo limite de ${opts.timeoutMs} ms?`))
			const text = Buffer.concat(out).toString('utf8')
			if (code !== 0 && !text.trim()) {
				return reject(
					Object.assign(new Error(`Claude CLI saiu com código ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`), {
						retryable: true,
					}),
				)
			}
			resolve(text)
		})

		// Prompt via stdin: transcrições longas não esbarram no limite de argumentos.
		child.stdin.end(prompt)
	})

	let parsed: {
		is_error?: boolean
		subtype?: string
		stop_reason?: string
		result?: string
		structured_output?: T
		total_cost_usd?: number
		duration_ms?: number
	}
	try {
		parsed = JSON.parse(stdout)
	} catch {
		throw Object.assign(new Error(`Resposta inesperada do Claude CLI: ${stdout.slice(0, 300)}`), { retryable: true })
	}
	if (parsed.is_error || parsed.structured_output === undefined) {
		const detail = [parsed.subtype, parsed.stop_reason].filter(Boolean).join('/')
		throw Object.assign(
			new Error(`Claude CLI sem saída estruturada (${detail || 'sem detalhe'}): ${String(parsed.result ?? '').slice(0, 300)}`),
			{ retryable: true, costUsd: parsed.total_cost_usd ?? 0 },
		)
	}
	return {
		output: parsed.structured_output,
		costUsd: parsed.total_cost_usd ?? null,
		durationMs: parsed.duration_ms ?? null,
	}
}
