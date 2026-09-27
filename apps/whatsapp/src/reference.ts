// Monta a REFERÊNCIA de um teste com IA: o card da demanda + o roteiro do
// fluxo desenvolvido no Twilio Studio. É relida a cada execução (card pela
// API, fluxo do disco/anexo) e guardada na execução exatamente como foi
// enviada à IA — o log mostra contra o que a conversa foi comparada.

import type { Config } from './config.js'
import { type Card, fetchCard } from './cards.js'
import type { FlowInput, FlowStore } from './flows.js'
import { type StudioFlow, condenseFlow, loadProjectFlows, parseStudioJson, resolveProjectPath, selectFlows } from './studio.js'

/** O que foi usado, para a interface e o log (sem o conteúdo). */
export type ReferenceSummary = {
	card: { source: Card['source']; ref: string | null; title: string; type: string | null; state: string | null; attachments: Card['attachments'] } | null
	studio: { origin: string; flows: string[] } | null
	bytes: number
}

export type Reference = {
	text: string
	summary: ReferenceSummary
	/** Fluxos usados, com SID e tipo de cada widget (para acompanhar a execução no Twilio). */
	flows: { name: string; sid: string | null; types: Map<string, string> }[]
}

export type ReferenceDeps = {
	cards: Config['cards']
	flows: FlowStore
	allowedRoots: string[]
	maxBytes: number
}

const LEGEND = `Como ler o roteiro: cada linha é um widget [nome]. ENVIA = mensagem enviada; PERGUNTA = mensagem que espera resposta do cliente; DECIDE = condição sobre a resposta/variável ("se equal_to \\"1\\" → próximo"); define = variáveis; executa função / HTTP = integração (o resultado não aparece no WhatsApp); TRANSFERE = vai para atendimento humano (Flex); chama subfluxo = continua em outro fluxo. "→ evento → widget" mostra para onde cada resultado leva. Valores *** foram ocultados.`

/** null quando o fluxo de teste não tem card nem fluxo do Studio. */
export async function buildReference(input: FlowInput, deps: ReferenceDeps): Promise<Reference | null> {
	const cardCfg = input.card ?? null
	const studioCfg = input.studio ?? null
	if (!cardCfg && !studioCfg) return null

	const parts: string[] = []
	let card: Card | null = null
	if (cardCfg) {
		card = await fetchCard(cardCfg, deps.cards)
		const head = [card.ref && `referência ${card.ref}`, card.type, card.state && `estado: ${card.state}`].filter(Boolean).join(' · ')
		parts.push(`# DEMANDA (card${card.source === 'text' ? '' : ` do ${card.source === 'azure' ? 'Azure DevOps' : 'Jira'}`})`)
		parts.push(`## ${card.title}${head ? `\n(${head})` : ''}`, card.body)
		if (card.comments.length) parts.push(`### Comentários\n${card.comments.map((c) => `- ${c}`).join('\n')}`)
		for (const a of card.attachmentTexts) parts.push(`### Anexo: ${a.name}\n${a.text}`)
	}

	let flows: StudioFlow[] = []
	let origin = ''
	if (studioCfg) {
		let all: StudioFlow[]
		if (studioCfg.mode === 'project') {
			const dir = resolveProjectPath(studioCfg.projectPath, studioCfg.location)
			all = await loadProjectFlows(dir, studioCfg.file, deps.allowedRoots)
			origin = `${studioCfg.projectPath} (${studioCfg.location === 'windows' ? 'Windows' : 'WSL'}) → ${studioCfg.file}`
		} else {
			const upload = deps.flows.getUpload(studioCfg.uploadId)
			if (!upload) throw new Error('O JSON do fluxo anexado não existe mais; anexe de novo')
			all = parseStudioJson(upload.content, upload.fileName.replace(/\.json$/i, ''))
			origin = `anexo ${upload.fileName}`
		}
		flows = selectFlows(all, studioCfg.flows, studioCfg.includeSubflows)
	}
	if (card?.attachmentFlows.length) {
		flows = [...flows, ...card.attachmentFlows.filter((f) => !flows.some((x) => x.name === f.name))]
		origin = [origin, 'anexos do card'].filter(Boolean).join(' + ')
	}
	if (flows.length) {
		const names = new Map(flows.filter((f) => f.sid).map((f) => [f.sid!, f.name]))
		parts.push(`# FLUXO DESENVOLVIDO (Twilio Studio — ${origin})`, LEGEND, ...flows.map((f) => condenseFlow(f, names)))
	}

	const text = parts.join('\n\n')
	const bytes = Buffer.byteLength(text)
	if (bytes > deps.maxBytes) {
		throw new Error(
			`A referência ficou com ${Math.round(bytes / 1024)} KB, acima do limite de ${Math.round(deps.maxBytes / 1024)} KB ` +
			'(TESTER_REFERENCE_MAX_KB). Escolha menos fluxos ou desmarque "incluir subfluxos".',
		)
	}
	return {
		text,
		summary: {
			card: card && { source: card.source, ref: card.ref, title: card.title, type: card.type, state: card.state, attachments: card.attachments },
			studio: flows.length ? { origin, flows: flows.map((f) => f.name) } : null,
			bytes,
		},
		flows: flows.map((f) => ({ name: f.name, sid: f.sid, types: new Map(f.definition.states.map((st) => [st.name, st.type])) })),
	}
}
