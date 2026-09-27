// Fluxos do Twilio Studio como referência para os testes com IA.
//
// De onde vêm:
// - Pasta do projeto: o usuário informa o caminho e se ele está no WSL/Linux
//   ou no Windows (C:\... vira /mnt/c/...). Procuramos `studioFlows.json`
//   (estado exportado por ambiente, ex.: twilio-infra/dev/state/) e JSONs de
//   fluxo em pastas `exports`/`flows`/`studio`. Sempre relido na execução:
//   o teste usa a versão atual do fluxo.
// - JSON anexado na interface (export do Studio), guardado no banco.
//
// O JSON bruto é grande demais para a IA (um fluxo passa de 500 KB) e cheio de
// ruído (posições, SIDs). `condenseFlow` gera um roteiro legível: mensagens,
// menus, condições e para onde cada resposta leva. Valores que parecem
// segredo (token, senha, chave) são mascarados antes de sair daqui.
//
// Segurança da leitura de disco: só arquivos .json, tamanho máximo, busca com
// profundidade e quantidade limitadas, sem seguir para node_modules/.git, e
// (opcional) só dentro de STUDIO_ALLOWED_ROOTS. A interface recebe apenas
// nomes e contagens, nunca o conteúdo dos arquivos.

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export type PathLocation = 'wsl' | 'windows'

export type StudioDefinition = { initial_state?: string; states: StudioState[] }
type StudioState = {
	name: string
	type: string
	properties?: Record<string, unknown>
	transitions?: { event: string; next?: string; conditions?: StudioCondition[] }[]
}
type StudioCondition = { friendly_name?: string; type?: string; value?: string; arguments?: string[] }

export type StudioFlow = { name: string; sid: string | null; definition: StudioDefinition }

/** Um arquivo com fluxos, como a interface mostra (sem conteúdo). */
export type StudioSource = {
	/** Caminho relativo à pasta do projeto. */
	file: string
	kind: 'state' | 'export'
	flows: { name: string; states: number }[]
}

const MAX_FILE_BYTES = 12 * 1024 * 1024
const MAX_DEPTH = 7
const MAX_DIRS = 3000
const SKIP_DIRS = new Set(['node_modules', '.git', 'backups', 'migrations', 'dist', 'build', '.next', 'coverage'])
const EXPORT_DIRS = /^(exports?|flows?|studio|fluxos?)$/i
const SECRET_KEY = /(token|secret|senha|password|passwd|apikey|api_key|authorization|auth|credential|private)/i
const MAX_TEXT = 600

/**
 * Converte o caminho informado para o caminho que este processo enxerga.
 * Windows: C:\x\y → /mnt/c/x/y ; \\wsl$\Distro\home\x (ou \\wsl.localhost\…) → /home/x.
 */
export function resolveProjectPath(input: string, location: PathLocation): string {
	const raw = input.trim().replace(/^["']|["']$/g, '')
	if (!raw) throw new Error('Informe o caminho do projeto')
	if (raw.length > 1000) throw new Error('Caminho longo demais')
	if (location === 'windows') {
		const unc = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+\\(.*)$/i.exec(raw)
		if (unc) return path.posix.normalize(`/${unc[1]!.replace(/\\/g, '/')}`)
		const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(raw)
		if (!drive) throw new Error('Caminho do Windows deve começar com a letra do disco (ex.: C:\\projetos\\twilio)')
		return path.posix.normalize(`/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`)
	}
	if (!raw.startsWith('/')) throw new Error('Caminho do WSL/Linux deve ser absoluto (começar com /)')
	return path.posix.normalize(raw)
}

/** Resolve symlinks e confere a lista de pastas permitidas (se configurada). */
async function safeRoot(dir: string, allowedRoots: string[]): Promise<string> {
	let real: string
	try {
		real = await realpath(dir)
	} catch {
		throw new Error(`Pasta não encontrada: ${dir}`)
	}
	if (allowedRoots.length) {
		const ok = await Promise.all(allowedRoots.map(async (r) => {
			const root = await realpath(r).catch(() => null)
			return root !== null && (real === root || real.startsWith(root + path.sep))
		}))
		if (!ok.some(Boolean)) throw new Error('Pasta fora de STUDIO_ALLOWED_ROOTS')
	}
	return real
}

/** Procura fluxos do Studio na pasta do projeto (ou aceita o caminho de um .json). */
export async function scanProject(projectPath: string, allowedRoots: string[]): Promise<{ root: string; sources: StudioSource[] }> {
	const root = await safeRoot(projectPath, allowedRoots)
	const info = await stat(root)
	const candidates: string[] = []
	if (info.isFile()) {
		if (!root.endsWith('.json')) throw new Error('Informe uma pasta ou um arquivo .json')
		candidates.push(root)
	} else {
		let visited = 0
		const walk = async (dir: string, depth: number): Promise<void> => {
			if (depth > MAX_DEPTH || ++visited > MAX_DIRS) return
			const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
			const inExportDir = EXPORT_DIRS.test(path.basename(dir))
			for (const e of entries) {
				const full = path.join(dir, e.name)
				if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(full, depth + 1)
				else if (e.isFile() && e.name.endsWith('.json') && (e.name === 'studioFlows.json' || inExportDir)) candidates.push(full)
			}
		}
		await walk(root, 0)
	}
	const base = info.isFile() ? path.dirname(root) : root
	const sources: StudioSource[] = []
	for (const file of candidates.sort()) {
		const flows = await readStudioFile(file).catch(() => null)
		if (!flows?.length) continue
		sources.push({
			file: path.relative(base, file) || path.basename(file),
			kind: path.basename(file) === 'studioFlows.json' ? 'state' : 'export',
			flows: flows.map((f) => ({ name: f.name, states: f.definition.states.length })),
		})
	}
	return { root: base, sources }
}

/** Lê um arquivo da pasta do projeto (caminho relativo vindo da interface), com as mesmas travas. */
export async function loadProjectFlows(projectPath: string, relFile: string, allowedRoots: string[]): Promise<StudioFlow[]> {
	const root = await safeRoot(projectPath, allowedRoots)
	const base = (await stat(root)).isFile() ? path.dirname(root) : root
	const file = await realpath(path.resolve(base, relFile)).catch(() => null)
	if (!file || !(file === base || file.startsWith(base + path.sep)) || !file.endsWith('.json')) {
		throw new Error(`Arquivo de fluxo não encontrado no projeto: ${relFile}`)
	}
	return readStudioFile(file)
}

async function readStudioFile(file: string): Promise<StudioFlow[]> {
	const info = await stat(file)
	if (info.size > MAX_FILE_BYTES) throw new Error(`Arquivo grande demais (${Math.round(info.size / 1e6)} MB)`)
	return parseStudioJson(await readFile(file, 'utf8'), path.basename(file, '.json'))
}

/**
 * Aceita: studioFlows.json ({ resources: [{ friendlyName, sid, definition }] }),
 * export de um fluxo ({ states, initial_state } ou { definition: {...} }) ou
 * lista de fluxos. Lança se não achar nenhum.
 */
export function parseStudioJson(content: string, fallbackName: string): StudioFlow[] {
	let data: unknown
	try {
		data = JSON.parse(content)
	} catch {
		throw new Error('JSON inválido')
	}
	const out: StudioFlow[] = []
	const push = (item: Record<string, unknown>, name: string) => {
		const def = (Array.isArray(item.states) ? item : item.definition) as StudioDefinition | undefined
		if (def && Array.isArray(def.states) && def.states.length) {
			out.push({ name, sid: typeof item.sid === 'string' ? item.sid : null, definition: def })
		}
	}
	const obj = data as Record<string, unknown>
	const list = Array.isArray(data) ? data : Array.isArray(obj?.resources) ? obj.resources : [data]
	for (const raw of list as Record<string, unknown>[]) {
		if (!raw || typeof raw !== 'object') continue
		const name = String(raw.friendlyName ?? raw.friendly_name ?? raw.name ?? (raw.description as string | undefined) ?? fallbackName)
		push(raw, name)
	}
	if (!out.length) throw new Error('Nenhum fluxo do Twilio Studio encontrado no JSON')
	return out
}

/** Escolhe os fluxos pelo nome e, se pedido, acrescenta os subfluxos que eles chamam (recursivo). */
export function selectFlows(all: StudioFlow[], names: string[], includeSubflows: boolean): StudioFlow[] {
	const byName = new Map(all.map((f) => [f.name, f]))
	const bySid = new Map(all.filter((f) => f.sid).map((f) => [f.sid!, f]))
	const chosen = new Map<string, StudioFlow>()
	const add = (f: StudioFlow) => {
		if (chosen.has(f.name)) return
		chosen.set(f.name, f)
		if (!includeSubflows) return
		for (const s of f.definition.states) {
			const sid = s.type === 'run-subflow' ? s.properties?.flow_sid : null
			const sub = typeof sid === 'string' ? bySid.get(sid) : undefined
			if (sub) add(sub)
		}
	}
	for (const n of names) {
		const f = byName.get(n)
		if (!f) throw new Error(`Fluxo "${n}" não existe mais no arquivo`)
		add(f)
	}
	return [...chosen.values()]
}

/** Roteiro legível de um fluxo (o que vai para a IA). */
export function condenseFlow(flow: StudioFlow, flowNamesBySid: Map<string, string>): string {
	const { states, initial_state: initial } = flow.definition
	const lines = [`## Fluxo Studio: ${flow.name} (${states.length} widgets${initial ? `, início: ${initial}` : ''})`]
	for (const s of states) {
		const p = s.properties ?? {}
		const next = (s.transitions ?? []).filter((t) => t.next)
		const go = (event: string) => next.find((t) => t.event === event)?.next
		const routes = () => next.filter((t) => t.event !== 'match').map((t) => `${t.event} → ${t.next}`).join(' | ')
		let line: string
		switch (s.type) {
			case 'trigger':
				line = `[${s.name}] INÍCIO: ${routes()}`
				break
			case 'send-message':
				line = `[${s.name}] ENVIA: "${text(p.body)}"${go('sent') ? ` → ${go('sent')}` : ''}`
				break
			case 'send-and-wait-for-reply':
				line = `[${s.name}] PERGUNTA e espera resposta: "${text(p.body)}" → ${routes()}`
				break
			case 'split-based-on': {
				const conds = (s.transitions ?? []).filter((t) => t.event === 'match').map((t) => {
					const c = (t.conditions ?? []).map((x) => `${x.type ?? '?'} ${JSON.stringify(text(x.value, 120))}`).join(' e ')
					return `se ${c} → ${t.next ?? '(fim)'}`
				})
				const other = go('noMatch')
				line = `[${s.name}] DECIDE por ${text(p.input, 120)}: ${[...conds, other ? `senão → ${other}` : 'senão → (fim)'].join('; ')}`
				break
			}
			case 'set-variables': {
				const vars = ((p.variables ?? []) as { key: string; value?: unknown }[])
					.map((v) => `${v.key}=${SECRET_KEY.test(v.key) ? '***' : text(v.value, 80)}`)
				line = `[${s.name}] define ${vars.join(', ')}${go('next') ? ` → ${go('next')}` : ''}`
				break
			}
			case 'run-function':
				line = `[${s.name}] executa função ${safeUrl(p.url)} → ${routes()}`
				break
			case 'make-http-request':
				line = `[${s.name}] HTTP ${String(p.method ?? '')} ${safeUrl(p.url)} → ${routes()}`
				break
			case 'run-subflow': {
				const sid = String(p.flow_sid ?? '')
				line = `[${s.name}] chama subfluxo ${flowNamesBySid.get(sid) ?? sid} → ${routes()}`
				break
			}
			case 'send-to-flex':
				line = `[${s.name}] TRANSFERE para atendimento humano (Flex, workflow ${String(p.workflow ?? '?')}${p.attributes ? `, atributos ${text(p.attributes, 200)}` : ''}) → ${routes() || '(fim)'}`
				break
			case 'say-play':
			case 'gather-input-on-call':
				line = `[${s.name}] (voz) ${p.say ? `fala "${text(p.say)}"` : `toca áudio ${safeUrl(p.play)}`} → ${routes()}`
				break
			default:
				line = `[${s.name}] ${s.type} → ${routes() || '(fim)'}`
		}
		lines.push(line)
	}
	return lines.join('\n')
}

/** Texto de uma propriedade, em uma linha e curto; mascara o que parece segredo. */
function text(value: unknown, max = MAX_TEXT): string {
	let s = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
	s = s.replace(/\s+/g, ' ').trim()
	s = s.replace(/("?(?:token|secret|senha|password|apikey|api_key|authToken|authorization)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi, '$1***')
	return s.length > max ? `${s.slice(0, max)}…` : s
}

/** URL sem query string (pode carregar credenciais). */
function safeUrl(value: unknown): string {
	const s = typeof value === 'string' ? value : ''
	return s.split('?')[0] ?? ''
}
