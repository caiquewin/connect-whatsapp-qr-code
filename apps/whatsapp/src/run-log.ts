// Log de uma execução de teste com IA em Markdown: o que foi testado, contra
// qual referência (card + fluxo), a conversa inteira com a análise de cada
// resposta, as divergências, os requisitos da demanda e o veredito.
//
// Gravado em TEST_LOGS_DIR ao fim de cada execução (arquivo 0600, .tmp +
// rename) e disponível para download na interface. Contém o texto da conversa:
// trate como dado sensível (fica fora do git e da imagem Docker).

import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TestRun } from './tester.js'

const STATUS: Record<string, string> = {
	running: 'Em andamento', passed: 'Passou', failed: 'Falhou', inconclusive: 'Inconclusivo',
	error: 'Erro', cancelled: 'Cancelado', interrupted: 'Interrompido',
}
const RULE: Record<string, string> = { ok: 'Cumprida', violated: 'Violada', not_tested: 'Não verificada' }
const WHO: Record<string, string> = { tester: 'Cliente (IA)', target: 'Atendimento', system: 'Sistema', analysis: 'Análise', studio: 'Twilio Studio' }

export function renderRunLog(run: TestRun): string {
	const { input } = run
	const a = run.analysis
	const time = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
	const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
	const out: string[] = []

	out.push(`# Teste com IA — ${input.name ?? 'sem nome'}`)
	out.push([
		`- **Execução:** ${run.id}${run.flowId ? ` (fluxo ${run.flowId})` : ''}`,
		`- **Status:** ${STATUS[run.status] ?? run.status}`,
		`- **Conexão que enviou:** ${run.connectionName} → **número testado:** +${input.to}`,
		`- **Início:** ${time(run.createdAt)}${run.finishedAt ? ` · **fim:** ${time(run.finishedAt)}` : ''}`,
		`- **Mensagens enviadas:** ${run.turns} de ${input.maxTurns} · **custo da IA:** US$ ${run.costUsd.toFixed(4)}`,
	].join('\n'))
	if (run.error) out.push(`> **Erro:** ${run.error}`)

	out.push('## Cenário', input.task || '_(sem tarefa: cenário montado pela IA a partir da demanda)_')
	if (input.rules.length) out.push('### Regras de negócio', input.rules.map((r, i) => `${i + 1}. ${r}`).join('\n'))

	const ref = a?.reference
	if (ref) {
		const items: string[] = []
		if (ref.card) {
			const c = ref.card
			items.push(`- **Card:** ${c.title}${c.ref ? ` (${c.ref})` : ''} · fonte: ${c.source}${c.state ? ` · estado: ${c.state}` : ''}`)
			for (const at of c.attachments) items.push(`  - anexo ${at.name}: ${at.used === 'ignored' ? `não usado (${at.reason ?? '—'})` : at.used === 'studio' ? 'fluxo do Studio' : 'lido como texto'}`)
		}
		if (ref.studio) items.push(`- **Fluxos do Studio:** ${ref.studio.flows.join(', ')} — ${ref.studio.origin}`)
		items.push(`- Tamanho enviado à IA: ${Math.round(ref.bytes / 1024)} KB (conteúdo completo no fim deste arquivo)`)
		out.push('## Referência usada', items.join('\n'))
	}

	if (run.summary) out.push('## Veredito', `**${STATUS[run.status] ?? run.status}** — ${run.summary}`)
	if (a?.deviations?.length) {
		out.push('### Divergências em relação ao fluxo', table(['Turno', 'Widget', 'Esperado', 'Recebido', 'Severidade'],
			a.deviations.map((d) => [String(d.turn), cell(d.flowState), cell(d.expected), cell(d.actual), d.severity])))
	} else if (a?.deviations) {
		out.push('_Nenhuma divergência em relação ao fluxo._')
	}
	if (a?.requirements?.length) {
		out.push('### Requisitos da demanda', table(['Requisito', 'Resultado', 'Evidência'],
			a.requirements.map((r) => [cell(r.requirement), RULE[r.status] ?? r.status, cell(r.evidence)])))
	}
	if (run.rules?.length) {
		out.push('### Regras de negócio', table(['Regra', 'Resultado', 'Evidência'],
			run.rules.map((r) => [cell(r.rule), RULE[r.status] ?? r.status, cell(r.evidence)])))
	}

	out.push('## Conversa')
	out.push(run.transcript.length
		? run.transcript.map((e) => `**[${new Date(e.at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] ${WHO[e.from] ?? e.from}:** ${e.from === 'analysis' ? `_${e.text}_` : e.text}`).join('\n\n')
		: '_Sem mensagens._')

	if (a?.steps.length) {
		out.push('## Passos da IA', table(['#', 'Hora', 'Ação', 'Análise', 'Custo', 'Tempo'],
			a.steps.map((s, i) => [
				String(i + 1),
				new Date(s.at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
				`${s.action}${s.forceFinish ? ' (veredito)' : ''}`,
				s.analysis ? cell(`${s.analysis.status} · ${s.analysis.flowState} — ${s.analysis.note}`) : '—',
				`US$ ${s.costUsd.toFixed(4)}`,
				`${(s.ms / 1000).toFixed(1)} s`,
			])))
	}
	const st = a?.studio
	if (st) {
		out.push(`## Execução no Twilio Studio (${st.env})`)
		out.push(st.executions.length
			? st.executions.map((e) => `- ${e.flow}: execução ${e.sid} · ${e.status} · início ${time(e.startedAt)}`).join('\n')
			: '_Nenhuma execução encontrada para o número que testou (confira o ambiente e as credenciais)._')
		if (st.steps.length) {
			out.push(table(['Hora', 'Fluxo', 'Widget que terminou', 'Evento', 'Próximo', 'Saída (resumo)'],
				st.steps.map((s) => [
					new Date(s.at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
					cell(s.flow), cell(s.from ?? 'INÍCIO'), cell(s.event), cell(s.to ?? '(fim)'), s.context ? cell(s.context.slice(0, 300)) : '',
				])))
		}
	}
	if (run.reference) out.push('## Referência completa enviada à IA', '```text', run.reference.replace(/```/g, "'''"), '```')
	return `${out.join('\n\n')}\n`
}

/** Tabela Markdown num bloco só. */
function table(head: string[], rows: string[][]): string {
	return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

/** Grava o log (atômico, só o dono lê) e devolve o caminho. */
export async function writeRunLog(run: TestRun, dir: string): Promise<string> {
	await mkdir(dir, { recursive: true })
	const day = run.createdAt.slice(0, 10)
	const slug = (run.input.name ?? 'teste').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'teste'
	const file = path.join(dir, `${day}_${slug}_${run.id}.md`)
	await writeFile(`${file}.tmp`, renderRunLog(run), { mode: 0o600 })
	await rename(`${file}.tmp`, file)
	return file
}
