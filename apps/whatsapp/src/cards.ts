// "Card" da demanda (o que o fluxo deveria fazer), usado como referência nos
// testes com IA. Três fontes:
//   text   texto colado ou arquivo .txt/.md anexado na interface
//   azure  link de work item do Azure DevOps (…/_workitems/edit/123 ou ?workitem=123)
//   jira   link de issue do Jira (…/browse/ABC-123 ou ?selectedIssue=ABC-123)
//
// SOMENTE LEITURA: só fazemos GET na API. Nada no card é alterado (estado,
// coluna, posição, comentários). Recomenda-se token com escopo só de leitura.
//
// Segurança: o token só é enviado a hosts permitidos (dev.azure.com,
// *.visualstudio.com, *.atlassian.net + os de AZDO_HOSTS/JIRA_HOSTS) — um link
// qualquer colado na interface não consegue receber as credenciais. Respostas
// e anexos têm tamanho máximo; anexos só de texto/JSON.

import type { Config } from './config.js'
import { logger } from './logger.js'
import { type StudioFlow, parseStudioJson } from './studio.js'

const log = logger.child({ module: 'cards' })

export type CardSource = 'text' | 'azure' | 'jira'

/** Como o card fica salvo no fluxo de teste. */
export type CardConfig = { source: CardSource; text: string; url: string }

export type CardAttachment = { name: string; size: number | null; used: 'text' | 'studio' | 'ignored'; reason?: string }

/** Card lido, pronto para virar referência. */
export type Card = {
	source: CardSource
	ref: string | null
	title: string
	type: string | null
	state: string | null
	/** Descrição, critérios de aceite, passos etc., em texto. */
	body: string
	comments: string[]
	attachments: CardAttachment[]
	/** Conteúdo dos anexos de texto (nome → texto). */
	attachmentTexts: { name: string; text: string }[]
	/** Fluxos do Studio encontrados em anexos .json. */
	attachmentFlows: StudioFlow[]
}

const TIMEOUT_MS = 20_000
const MAX_RESPONSE = 3 * 1024 * 1024
const MAX_ATTACHMENT = 12 * 1024 * 1024
const MAX_ATTACHMENT_TEXT = 200 * 1024
const MAX_ATTACHMENTS = 10
const MAX_COMMENTS = 30
const TEXT_EXT = /\.(txt|md|json|csv|log|xml|yml|yaml)$/i

export function parseCardConfig(input: unknown): CardConfig | null {
	const obj = (input ?? {}) as Record<string, unknown>
	const source = String(obj.source ?? '')
	if (!source || source === 'none') return null
	if (source !== 'text' && source !== 'azure' && source !== 'jira') throw new Error('Fonte do card inválida')
	const text = String(obj.text ?? '').trim()
	const url = String(obj.url ?? '').trim()
	if (source === 'text') {
		if (!text) throw new Error('Cole o texto do card (ou anexe o arquivo)')
		if (text.length > 100_000) throw new Error('Texto do card com no máximo 100 mil caracteres')
		return { source, text, url: '' }
	}
	if (!url) throw new Error(`Cole o link do card do ${source === 'azure' ? 'Azure DevOps' : 'Jira'}`)
	source === 'azure' ? parseAzureLink(url) : parseJiraLink(url)
	return { source, text: '', url }
}

export async function fetchCard(cfg: CardConfig, env: Config['cards']): Promise<Card> {
	if (cfg.source === 'text') {
		return {
			source: 'text', ref: null, title: 'Card (texto colado)', type: null, state: null,
			body: cfg.text, comments: [], attachments: [], attachmentTexts: [], attachmentFlows: [],
		}
	}
	return cfg.source === 'azure' ? fetchAzure(cfg.url, env) : fetchJira(cfg.url, env)
}

// ---------- Azure DevOps ----------

type AzureRef = { base: string; project: string; id: number }

/** dev.azure.com/{org}/{proj}/_workitems/edit/{id} · {org}.visualstudio.com/{proj}/… · …?workitem={id} */
function parseAzureLink(raw: string): AzureRef {
	let u: URL
	try {
		u = new URL(raw)
	} catch {
		throw new Error('Link do Azure DevOps inválido')
	}
	const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
	const idText = u.searchParams.get('workitem') ?? /\/_workitems\/edit\/(\d+)/.exec(u.pathname)?.[1]
	const id = Number(idText)
	if (!Number.isInteger(id) || id <= 0) throw new Error('O link não tem o número do work item (…/_workitems/edit/123)')
	const onDevAzure = u.hostname === 'dev.azure.com'
	const org = onDevAzure ? parts[0] : null
	const project = onDevAzure ? parts[1] : parts[0]
	if (!project || (onDevAzure && !org)) throw new Error('O link precisa ter organização e projeto')
	const base = onDevAzure ? `https://dev.azure.com/${encodeURIComponent(org!)}` : `${u.protocol}//${u.host}`
	return { base, project, id }
}

async function fetchAzure(url: string, env: Config['cards']): Promise<Card> {
	if (!env.azurePat) throw new Error('Configure AZDO_PAT no .env (token do Azure DevOps com escopo Work Items: Read)')
	const ref = parseAzureLink(url)
	const host = new URL(ref.base).hostname
	if (!hostAllowed(host, ['dev.azure.com', '.visualstudio.com', ...env.azureHosts])) throw new Error(`Host ${host} não permitido (AZDO_HOSTS)`)
	const auth = `Basic ${Buffer.from(`:${env.azurePat}`).toString('base64')}`
	const api = `${ref.base}/${encodeURIComponent(ref.project)}/_apis/wit`

	const item = await getJson(`${api}/workitems/${ref.id}?$expand=relations&api-version=7.1`, auth, host) as {
		fields?: Record<string, unknown>
		relations?: { rel: string; url: string; attributes?: { name?: string; resourceSize?: number } }[]
	}
	const f = item.fields ?? {}
	const sections: [string, unknown][] = [
		['Descrição', f['System.Description']],
		['Critérios de aceite', f['Microsoft.VSTS.Common.AcceptanceCriteria']],
		['Passos para reproduzir', f['Microsoft.VSTS.TCM.ReproSteps']],
		['Resultado esperado', f['Microsoft.VSTS.TCM.SystemInfo']],
	]
	const body = sections.filter(([, v]) => typeof v === 'string' && v.trim())
		.map(([k, v]) => `### ${k}\n${htmlToText(v as string)}`).join('\n\n')

	let comments: string[] = []
	try {
		const c = await getJson(`${api}/workItems/${ref.id}/comments?$top=${MAX_COMMENTS}&api-version=7.1-preview.4`, auth, host) as {
			comments?: { text?: string; createdBy?: { displayName?: string } }[]
		}
		comments = (c.comments ?? []).map((x) => `${x.createdBy?.displayName ?? '?'}: ${htmlToText(x.text ?? '')}`)
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'comentários do work item indisponíveis')
	}

	const files = (item.relations ?? []).filter((r) => r.rel === 'AttachedFile')
		.map((r) => ({ name: r.attributes?.name ?? 'anexo', size: r.attributes?.resourceSize ?? null, url: r.url }))
	const att = await readAttachments(files, auth, host)

	return {
		source: 'azure',
		ref: `#${ref.id}`,
		title: String(f['System.Title'] ?? `Work item ${ref.id}`),
		type: typeof f['System.WorkItemType'] === 'string' ? f['System.WorkItemType'] : null,
		state: typeof f['System.State'] === 'string' ? f['System.State'] : null,
		body: body || '(sem descrição)',
		comments,
		...att,
	}
}

// ---------- Jira ----------

function parseJiraLink(raw: string): { base: string; key: string } {
	let u: URL
	try {
		u = new URL(raw)
	} catch {
		throw new Error('Link do Jira inválido')
	}
	const key = u.searchParams.get('selectedIssue') ?? /\/browse\/([A-Z][A-Z0-9_]+-\d+)/i.exec(u.pathname)?.[1]
	if (!key || !/^[A-Z][A-Z0-9_]+-\d+$/i.test(key)) throw new Error('O link não tem a chave da issue (…/browse/ABC-123)')
	return { base: `${u.protocol}//${u.host}`, key: key.toUpperCase() }
}

async function fetchJira(url: string, env: Config['cards']): Promise<Card> {
	if (!env.jiraEmail || !env.jiraToken) throw new Error('Configure JIRA_EMAIL e JIRA_API_TOKEN no .env')
	const ref = parseJiraLink(url)
	const host = new URL(ref.base).hostname
	if (!hostAllowed(host, ['.atlassian.net', ...env.jiraHosts])) throw new Error(`Host ${host} não permitido (JIRA_HOSTS)`)
	const auth = `Basic ${Buffer.from(`${env.jiraEmail}:${env.jiraToken}`).toString('base64')}`

	const issue = await getJson(
		`${ref.base}/rest/api/3/issue/${encodeURIComponent(ref.key)}?fields=summary,status,issuetype,attachment,comment,description&expand=renderedFields`,
		auth,
		host,
	) as {
		fields?: {
			summary?: string
			status?: { name?: string }
			issuetype?: { name?: string }
			attachment?: { filename?: string; size?: number; content?: string }[]
		}
		renderedFields?: { description?: string; comment?: { comments?: { body?: string; author?: { displayName?: string } }[] } }
	}
	const f = issue.fields ?? {}
	const comments = (issue.renderedFields?.comment?.comments ?? []).slice(-MAX_COMMENTS)
		.map((c) => `${c.author?.displayName ?? '?'}: ${htmlToText(c.body ?? '')}`)
	const files = (f.attachment ?? []).filter((a) => a.content).map((a) => ({ name: a.filename ?? 'anexo', size: a.size ?? null, url: a.content! }))
	const att = await readAttachments(files, auth, host)
	return {
		source: 'jira',
		ref: ref.key,
		title: f.summary ?? ref.key,
		type: f.issuetype?.name ?? null,
		state: f.status?.name ?? null,
		body: `### Descrição\n${htmlToText(issue.renderedFields?.description ?? '') || '(sem descrição)'}`,
		comments,
		...att,
	}
}

// ---------- Comum ----------

/** Baixa anexos de texto; JSON do Studio vira fluxo. Outros tipos só aparecem na lista. */
async function readAttachments(files: { name: string; size: number | null; url: string }[], auth: string, host: string) {
	const attachments: CardAttachment[] = []
	const attachmentTexts: { name: string; text: string }[] = []
	const attachmentFlows: StudioFlow[] = []
	for (const [i, file] of files.entries()) {
		const entry: CardAttachment = { name: file.name, size: file.size, used: 'ignored' }
		attachments.push(entry)
		if (i >= MAX_ATTACHMENTS) { entry.reason = 'limite de anexos'; continue }
		if (!TEXT_EXT.test(file.name)) { entry.reason = 'tipo não lido (só texto/JSON)'; continue }
		if (file.size && file.size > MAX_ATTACHMENT) { entry.reason = 'grande demais'; continue }
		try {
			const content = await getText(file.url, auth, host, MAX_ATTACHMENT)
			if (file.name.toLowerCase().endsWith('.json')) {
				try {
					attachmentFlows.push(...parseStudioJson(content, file.name.replace(/\.json$/i, '')))
					entry.used = 'studio'
					continue
				} catch {
					// JSON que não é fluxo do Studio: entra como texto.
				}
			}
			attachmentTexts.push({ name: file.name, text: content.slice(0, MAX_ATTACHMENT_TEXT) })
			entry.used = 'text'
		} catch (err) {
			entry.reason = (err as Error).message.slice(0, 120)
		}
	}
	return { attachments, attachmentTexts, attachmentFlows }
}

function hostAllowed(host: string, allowed: string[]): boolean {
	const h = host.toLowerCase()
	return allowed.some((a) => (a.startsWith('.') ? h.endsWith(a) : h === a))
}

async function getJson(url: string, auth: string, host: string): Promise<unknown> {
	const text = await getText(url, auth, host, MAX_RESPONSE, 'application/json')
	try {
		return JSON.parse(text)
	} catch {
		throw new Error('Resposta inesperada da API (não é JSON) — o token tem acesso a este card?')
	}
}

/**
 * GET com o token só para o host permitido. Redirecionamento para outro host
 * (ex.: CDN de anexos do Jira) segue SEM o Authorization (o fetch remove em
 * mudança de origem). Nunca usa outro método além de GET.
 */
async function getText(url: string, auth: string, host: string, max: number, accept = '*/*'): Promise<string> {
	const u = new URL(url)
	if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== host.toLowerCase()) throw new Error('URL de anexo fora do host do card')
	const res = await fetch(u, { method: 'GET', headers: { authorization: auth, accept }, signal: AbortSignal.timeout(TIMEOUT_MS) })
	if (res.status === 401 || res.status === 403) throw new Error(`Sem permissão para ler o card (HTTP ${res.status}) — confira o token`)
	// Azure DevOps responde 203 com a página de login quando o PAT é inválido/expirou.
	if (res.status === 203) throw new Error('Token recusado (a API devolveu a página de login) — confira se o token é válido e não expirou')
	if (res.status === 404) throw new Error('Card não encontrado (HTTP 404) — confira o link e o acesso do token')
	if (!res.ok) throw new Error(`API respondeu HTTP ${res.status}`)
	const length = Number(res.headers.get('content-length') ?? 0)
	if (length > max) throw new Error('resposta grande demais')
	const buf = Buffer.from(await res.arrayBuffer())
	if (buf.length > max) throw new Error('resposta grande demais')
	return buf.toString('utf8')
}

/** HTML simples (descrição do Azure/Jira) → texto com quebras e listas. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<li[^>]*>/gi, '\n- ')
		.replace(/<\/(p|div|h[1-6]|tr|ul|ol|table)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}
