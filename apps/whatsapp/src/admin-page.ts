// HTML da interface admin. Fica num módulo TS (e não num .html) para ir junto
// no build do tsc sem etapa extra de cópia no Dockerfile. Sem recursos externos.
//
// Aba Conexões: uma lista (uma por número). Cada card: status + QR, nome,
// filtros, webhook, proxy e fila. Aba Testes: conexão → fluxos → execuções.
// A página recebe avisos por SSE (/api/stream), busca só o que mudou
// (respostas com ETag) e atualiza só as partes que mudaram, para não
// atrapalhar quem está digitando.

export const ADMIN_PAGE = /* html */ `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conexões WhatsApp</title>
<style>
	:root {
		--bg: #f6f7f9; --card: #fff; --text: #1a1d21; --muted: #5f6b7a; --border: #dde1e6; --soft: #f1f3f5;
		--accent: #1f7a4d; --accent-text: #fff; --ok: #1f7a4d; --err: #b42318; --warn: #a15c07;
		--field: #fff; --seg-bg: #eef0f3; --ok-bg: #e7f5ee; --warn-bg: #fdf3e2; --err-bg: #fdecea; --idle-bg: #eef0f3;
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--bg: #111418; --card: #1a1e24; --text: #e6e9ee; --muted: #98a2b3; --border: #2c323b; --soft: #20252c;
			--accent: #3fb27a; --accent-text: #0b1a12; --ok: #3fb27a; --err: #f97066; --warn: #fdb022;
			--field: #13161b; --seg-bg: #22272e; --ok-bg: #16301f; --warn-bg: #33270f; --err-bg: #3a1a17; --idle-bg: #22272e;
		}
	}
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
	main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
	[hidden] { display: none !important; }
	code { font-size: 13px; }

	/* Cabeçalho */
	.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
	h1 { font-size: 22px; margin: 0 0 2px; }
	.sub { color: var(--muted); margin: 0; }
	.summary { color: var(--muted); font-size: 13px; margin-top: 4px; }

	/* Botões e campos */
	button {
		font: inherit; font-weight: 600; font-size: 14px; padding: 8px 16px; border-radius: 8px; cursor: pointer;
		border: 1px solid var(--border); background: var(--card); color: var(--text); white-space: nowrap;
	}
	button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
	button.danger { color: var(--err); }
	button.link { border: none; background: none; padding: 4px 6px; color: var(--muted); font-weight: 500; }
	button.link:hover { color: var(--text); }
	button.link.danger:hover { color: var(--err); }
	button:disabled { opacity: .6; cursor: default; }
	input[type=url], input[type=password], input[type=text] {
		width: 100%; padding: 9px 12px; font: inherit; color: var(--text);
		background: var(--field); border: 1px solid var(--border); border-radius: 8px;
	}
	input:focus-visible, button:focus-visible, summary:focus-visible, .seg input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
	label.lbl { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; }
	.hint { color: var(--muted); font-size: 13px; margin-top: 6px; }
	.row { display: flex; gap: 8px; flex-wrap: wrap; }
	.row > input { flex: 1 1 200px; min-width: 0; }
	.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
	.result { font-size: 13px; min-height: 20px; margin-top: 8px; }
	.result.ok { color: var(--ok); } .result.err { color: var(--err); }

	/* Cards */
	.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 16px; overflow: hidden; }
	.pad { padding: 18px 20px; }
	.new-card h2 { font-size: 16px; margin: 0 0 12px; }
	.empty { text-align: center; padding: 40px 20px; color: var(--muted); }
	.empty p { margin: 0 0 16px; }

	.conn-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
	.conn-title { flex: 1; min-width: 0; }
	.conn-title h2 { font-size: 17px; margin: 0; overflow-wrap: anywhere; }
	.conn-meta { color: var(--muted); font-size: 13px; }
	.rename { display: flex; gap: 8px; flex: 1; min-width: 220px; }
	.rename input { flex: 1; min-width: 0; }
	.pill { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
	.pill.ok { background: var(--ok-bg); color: var(--ok); }
	.pill.warn { background: var(--warn-bg); color: var(--warn); }
	.pill.err { background: var(--err-bg); color: var(--err); }
	.pill.idle { background: var(--idle-bg); color: var(--muted); }

	/* Sessão */
	.session { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; padding: 18px 20px; }
	/* QR sempre em fundo branco: leitores falham com QR invertido no tema escuro. */
	.qr { background: #fff; padding: 8px; border-radius: 10px; width: 216px; height: 216px; flex: none; border: 1px solid var(--border); }
	.qr svg { display: block; width: 100%; height: 100%; }
	.session-info { flex: 1; min-width: 220px; }
	.session-info p { margin: 0 0 12px; }
	.steps { margin: 0 0 12px; padding-left: 20px; color: var(--muted); font-size: 14px; }
	.steps li { margin-bottom: 3px; }
	.steps b { color: var(--text); font-weight: 600; }
	.who { font-size: 16px; font-weight: 600; }
	.muted { color: var(--muted); font-size: 14px; }

	/* Seções recolhíveis (filtros, webhook) */
	textarea {
		width: 100%; min-height: 72px; padding: 9px 12px; font: 13px/1.5 ui-monospace, monospace; color: var(--text);
		background: var(--field); border: 1px solid var(--border); border-radius: 8px; resize: vertical;
	}
	textarea:disabled { opacity: .5; }
	textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.filter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 14px; }
	.filter-box { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
	.filter-box .check { margin: 0 0 10px; font-weight: 600; font-size: 14px; }
	.filter-box .lbl { font-weight: 500; color: var(--muted); }
	@media (max-width: 600px) { .filter-grid { grid-template-columns: 1fr; } }
	details.hook { border-top: 1px solid var(--border); }
	details.hook > summary {
		list-style: none; cursor: pointer; padding: 12px 20px; display: flex; gap: 10px; align-items: center; font-size: 14px;
	}
	details.hook > summary::-webkit-details-marker { display: none; }
	details.hook > summary::before { content: '▸'; color: var(--muted); transition: transform .15s; }
	details.hook[open] > summary::before { transform: rotate(90deg); }
	.hook-label { font-weight: 600; }
	.hook-target { color: var(--muted); font-family: ui-monospace, monospace; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
	.hook-body { padding: 4px 20px 18px; }
	.field { margin-bottom: 14px; }
	.seg { display: inline-flex; background: var(--seg-bg); border-radius: 8px; padding: 3px; gap: 2px; }
	.seg label { cursor: pointer; }
	.seg input { position: absolute; opacity: 0; pointer-events: none; }
	.seg span { display: block; padding: 5px 14px; border-radius: 6px; font-size: 13px; font-family: ui-monospace, monospace; }
	.seg input:checked + span { background: var(--card); box-shadow: 0 1px 2px rgb(0 0 0 / .15); font-weight: 600; }
	.check { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-top: 8px; }

	/* Fila */
	.queue { display: flex; gap: 6px 20px; flex-wrap: wrap; padding: 10px 20px; background: var(--soft); border-top: 1px solid var(--border); font-size: 13px; color: var(--muted); }
	.queue b { color: var(--text); font-variant-numeric: tabular-nums; }
	.queue .warn b { color: var(--warn); } .queue .err b { color: var(--err); }
	/* Fila: ver e excluir */
	.qtabs { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
	.qtabs button[aria-selected=true] { background: var(--seg-bg); border-color: var(--accent); }
	.qbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; font-size: 13px; }
	.qbar .check { margin-top: 0; }
	.qitems { list-style: none; margin: 0 0 12px; padding: 0; border: 1px solid var(--border); border-radius: 8px; max-height: 360px; overflow-y: auto; }
	.qitems li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 12px; border-top: 1px solid var(--border); }
	.qitems li:first-child { border-top: none; }
	.qitems input { margin-top: 3px; }
	.qmain { flex: 1; min-width: 0; }
	.qwho { font-size: 13px; font-weight: 600; }
	.qtext { font-size: 13px; overflow-wrap: anywhere; white-space: pre-wrap; }
	.qmeta { color: var(--muted); font-size: 12px; }

	/* Abas */
	.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
	.tabs button { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--muted); padding: 10px 14px; margin-bottom: -1px; }
	.tabs button[aria-selected=true] { color: var(--text); border-bottom-color: var(--accent); }

	/* Testes com IA */
	select {
		width: 100%; padding: 9px 12px; font: inherit; color: var(--text);
		background: var(--field); border: 1px solid var(--border); border-radius: 8px;
	}
	.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
	.grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
	input[type=number], input[type=tel] {
		width: 100%; padding: 9px 12px; font: inherit; color: var(--text);
		background: var(--field); border: 1px solid var(--border); border-radius: 8px;
	}
	textarea.prose { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; min-height: 90px; }
	details.adv > summary { cursor: pointer; color: var(--muted); font-size: 13px; margin-bottom: 10px; }
	.runs { list-style: none; margin: 0; padding: 0; }
	.runs li { border-top: 1px solid var(--border); }
	.runs li:first-child { border-top: none; }
	.run-row { display: flex; gap: 12px; align-items: center; width: 100%; text-align: left; border: none; border-radius: 0; background: none; padding: 12px 20px; font-weight: 400; white-space: normal; }
	.run-row:hover, .run-row[aria-current=true] { background: var(--soft); }
	.run-main { flex: 1; min-width: 0; }
	.run-task { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.run-meta { color: var(--muted); font-size: 12px; }
	.flow-row { display: flex; gap: 8px; align-items: center; padding-right: 16px; }
	.flow-row .run-row { flex: 1; min-width: 0; }
	.flow-row[aria-current=true] .run-row { background: var(--soft); }
	input[type=text]#t-name { width: 100%; }
	.chat { display: flex; flex-direction: column; gap: 8px; padding: 16px 20px; background: var(--soft); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); max-height: 520px; overflow-y: auto; }
	.bubble { max-width: 80%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
	.bubble .t { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; text-align: right; }
	.bubble.target { align-self: flex-start; background: var(--card); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
	.bubble.tester { align-self: flex-end; background: var(--ok-bg); border-bottom-right-radius: 4px; }
	.bubble.system { align-self: center; background: none; color: var(--muted); font-size: 12px; font-style: italic; padding: 2px 8px; }
	.refbox { border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px 14px; margin: 0 0 16px; }
	.refbox legend { font-weight: 600; font-size: 14px; padding: 0 6px; }
	.radios { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 14px; margin: 2px 0 10px; }
	.radios label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
	.filebtn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--accent); cursor: pointer; margin-top: 6px; }
	.flowpick { border: 1px solid var(--border); border-radius: 8px; margin-top: 8px; }
	.flowpick input[type=search] { width: 100%; border: none; border-bottom: 1px solid var(--border); border-radius: 8px 8px 0 0; padding: 8px 12px; font: inherit; background: var(--field); color: var(--text); }
	.flowpick ul { list-style: none; margin: 0; padding: 4px 0; max-height: 240px; overflow-y: auto; }
	.flowpick li label { display: flex; gap: 8px; align-items: center; padding: 4px 12px; font-size: 13px; cursor: pointer; }
	.flowpick li label span { color: var(--muted); font-size: 12px; margin-left: auto; }
	.refpreview { max-height: 360px; overflow: auto; background: var(--soft); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
	.bubble.analysis { align-self: center; max-width: 92%; background: none; border: 1px dashed var(--border); color: var(--muted); font-size: 12px; font-style: italic; padding: 4px 10px; }
	.bubble.analysis.divergente { border-color: var(--err); color: var(--err); }
	.bubble.analysis.parcial { border-color: var(--warn); color: var(--warn); }
	.bubble.studio { align-self: stretch; max-width: 100%; background: none; color: var(--muted); font: 11px/1.4 ui-monospace, monospace; padding: 2px 8px; border-left: 3px solid var(--accent); border-radius: 0; }
	.refinfo { font-size: 13px; color: var(--muted); margin: 0 0 8px; }
	a.button-link { display: inline-flex; align-items: center; padding: 7px 12px; border: 1px solid var(--border); border-radius: 8px; color: var(--text); text-decoration: none; font-size: 14px; font-weight: 500; }
	a.button-link:hover { background: var(--soft); }
	.rules { width: 100%; border-collapse: collapse; font-size: 14px; }
	.rules th, .rules td { text-align: left; padding: 8px 10px; border-top: 1px solid var(--border); vertical-align: top; }
	.rules th { font-size: 12px; color: var(--muted); font-weight: 600; border-top: none; }
	.rules td.st { white-space: nowrap; }
	.verdict { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
	.verdict strong { font-size: 16px; }
	@media (max-width: 600px) { .grid2, .grid3 { grid-template-columns: 1fr; } .bubble { max-width: 92%; } }

	@media (max-width: 480px) {
		.qr { width: 100%; height: auto; aspect-ratio: 1; max-width: 260px; margin: 0 auto; }
		.top > .actions { width: 100%; }
		.top > .actions > button { flex: 1 1 auto; }
	}
</style>
</head>
<body>
<main>
	<nav class="tabs" role="tablist">
		<button type="button" role="tab" id="tab-btn-conn" aria-selected="true" aria-controls="tab-conn">Conexões</button>
		<button type="button" role="tab" id="tab-btn-tests" aria-selected="false" aria-controls="tab-tests">Testes com IA</button>
	</nav>

	<section id="tab-conn" role="tabpanel" aria-labelledby="tab-btn-conn">
	<div class="top">
		<div>
			<h1>Conexões WhatsApp</h1>
			<p class="sub">Cada conexão é um número: leia o QR, dê um nome e defina o webhook.</p>
			<div class="summary" id="summary" aria-live="polite"></div>
		</div>
		<div class="actions">
			<button type="button" id="bday-run" title="Envia agora os parabéns de quem faz aniversário hoje (planilha do BIRTHDAY_CSV)">🎂 Enviar aniversários</button>
			<button type="button" class="primary" id="new-open">+ Nova conexão</button>
		</div>
	</div>
	<div class="result" id="bday-result" role="status"></div>

	<form class="card pad new-card" id="new-form" hidden novalidate>
		<h2>Nova conexão</h2>
		<label class="lbl" for="new-name">Nome da conexão</label>
		<div class="row">
			<input id="new-name" type="text" maxlength="60" placeholder="Ex.: Comercial – Loja Centro" autocomplete="off">
			<button type="submit" class="primary" id="new-submit">Criar e gerar QR</button>
			<button type="button" id="new-cancel">Cancelar</button>
		</div>
		<div class="hint">O nome vai em cada mensagem no campo <code>instance</code>, para o webhook saber de qual número ela veio.</div>
		<div class="result" id="new-result" role="status"></div>
	</form>

	<div class="card empty" id="empty" hidden>
		<p>Nenhuma conexão ainda.</p>
		<button type="button" class="primary" id="empty-new">Criar a primeira conexão</button>
	</div>

	<div id="list"></div>
	<div class="result err" id="global-error" role="alert"></div>
	</section>

	<section id="tab-tests" role="tabpanel" aria-labelledby="tab-btn-tests" hidden>
		<div class="top">
			<div>
				<h1>Fluxos de teste com IA</h1>
				<p class="sub">Cada conexão tem seus fluxos. Ao executar, a IA conversa pelo WhatsApp como um cliente, seguindo a tarefa, e avalia as regras de negócio.</p>
			</div>
			<button type="button" class="primary" id="flow-new">+ Novo fluxo</button>
		</div>

		<div class="card pad">
			<label class="lbl" for="t-conn">Conexão (número que envia)</label>
			<select id="t-conn"></select>
		</div>

		<form class="card pad" id="flow-form" hidden novalidate>
			<h2 id="flow-form-title">Novo fluxo</h2>
			<div class="grid2 field">
				<div>
					<label class="lbl" for="t-name">Nome do fluxo</label>
					<input id="t-name" type="text" maxlength="80" placeholder="Ex.: Agendamento de visita" autocomplete="off">
				</div>
				<div>
					<label class="lbl" for="t-to">Número que recebe (sob teste)</label>
					<input id="t-to" type="tel" placeholder="Ex.: 11 98888-7777" autocomplete="off">
				</div>
			</div>
			<div class="field">
				<label class="lbl" for="t-task">Tarefa (o que o "cliente" quer fazer) — opcional se houver card/fluxo abaixo</label>
				<textarea id="t-task" class="prose" placeholder="Ex.: Você quer saber o preço do apartamento de 2 dormitórios do empreendimento Jardim Sul e agendar uma visita ao decorado no sábado de manhã."></textarea>
			</div>
			<div class="field">
				<label class="lbl" for="t-rules">Regras de negócio (uma por linha)</label>
				<textarea id="t-rules" class="prose" placeholder="Ex.:&#10;Deve se apresentar e pedir o nome do cliente&#10;Não pode informar preço sem antes pedir o e-mail&#10;Deve oferecer ao menos dois horários de visita"></textarea>
			</div>
			<fieldset class="refbox">
				<legend>Referência para a IA comparar (opcional)</legend>
				<div class="field">
					<div class="lbl">Demanda (card)</div>
					<div class="radios" role="radiogroup" aria-label="Fonte do card">
						<label><input type="radio" name="card-src" value="none" checked> Nenhum</label>
						<label><input type="radio" name="card-src" value="text"> Colar / anexar</label>
						<label><input type="radio" name="card-src" value="azure"> Azure DevOps</label>
						<label><input type="radio" name="card-src" value="jira"> Jira</label>
					</div>
					<div id="card-text-box" hidden>
						<textarea id="card-text" class="prose" placeholder="Cole aqui a descrição do card: o problema e o que precisa ser feito."></textarea>
						<label class="filebtn">📎 Anexar arquivo .txt / .md <input type="file" id="card-file" accept=".txt,.md,.markdown,text/plain" hidden></label>
					</div>
					<div id="card-url-box" hidden>
						<input type="url" id="card-url" placeholder="Cole o link do card aberto no navegador" autocomplete="off" spellcheck="false">
						<div class="hint" id="card-url-hint"></div>
					</div>
					<div class="actions" id="card-preview-wrap" hidden><button type="button" id="card-preview-btn">Ler card</button></div>
					<div class="result" id="card-preview" role="status"></div>
				</div>
				<div class="field">
					<div class="lbl">Fluxo desenvolvido (Twilio Studio)</div>
					<div class="radios" role="radiogroup" aria-label="Origem do fluxo">
						<label><input type="radio" name="studio-src" value="none" checked> Nenhum</label>
						<label><input type="radio" name="studio-src" value="project"> Pasta do projeto</label>
						<label><input type="radio" name="studio-src" value="upload"> Anexar JSON exportado</label>
					</div>
					<div id="studio-project-box" hidden>
						<div class="grid2 field">
							<div>
								<label class="lbl" for="studio-path">Caminho do projeto</label>
								<input type="text" id="studio-path" placeholder="/home/voce/twilio-project  ou  C:\\projetos\\twilio-project" autocomplete="off" spellcheck="false">
							</div>
							<div>
								<div class="lbl">Onde está o projeto?</div>
								<div class="radios" role="radiogroup" aria-label="Onde está o projeto">
									<label><input type="radio" name="studio-loc" value="wsl" checked> No WSL / Linux</label>
									<label><input type="radio" name="studio-loc" value="windows"> No Windows</label>
								</div>
							</div>
						</div>
						<div class="actions"><button type="button" id="studio-scan">Procurar fluxos</button></div>
						<select id="studio-file" hidden aria-label="Arquivo de fluxos"></select>
					</div>
					<div id="studio-upload-box" hidden>
						<input type="file" id="studio-upload" accept=".json,application/json">
						<div class="hint" id="studio-upload-info"></div>
					</div>
					<div class="flowpick" id="studio-pick" hidden>
						<input type="search" id="studio-filter" placeholder="Filtrar fluxos…" aria-label="Filtrar fluxos">
						<ul id="studio-list"></ul>
					</div>
					<label class="check" id="studio-sub-wrap" hidden><input type="checkbox" id="studio-sub" checked> Incluir os subfluxos chamados pelos fluxos marcados</label>
					<div class="field" id="studio-monitor-wrap" hidden style="margin-top:10px">
						<label class="lbl" for="studio-monitor">Acompanhar a execução real no Twilio durante o teste</label>
						<select id="studio-monitor">
							<option value="">Não acompanhar</option>
							<option value="dev">Conta dev</option>
							<option value="qa">Conta qa</option>
							<option value="prod">Conta prod</option>
						</select>
						<div class="hint" id="studio-monitor-hint"></div>
					</div>
					<div class="result" id="studio-result" role="status"></div>
				</div>
				<div class="actions"><button type="button" id="ref-preview-btn">Ver o que a IA vai receber</button></div>
				<div class="result" id="ref-preview-result" role="status"></div>
				<pre class="refpreview" id="ref-preview" hidden></pre>
				<div class="hint">O card é só lido (nada nele é alterado). O fluxo é relido a cada execução, então o teste usa sempre a versão atual. A IA compara cada resposta do bot com o que o fluxo prevê e com o que a demanda pede.</div>
			</fieldset>
			<details class="adv">
				<summary>Opções avançadas</summary>
				<div class="grid3 field">
					<div><label class="lbl" for="t-max">Máx. de mensagens da IA</label><input id="t-max" type="number" min="1" max="30" value="8"></div>
					<div><label class="lbl" for="t-wait">Esperar resposta (s)</label><input id="t-wait" type="number" min="10" max="600" value="60"></div>
					<div><label class="lbl" for="t-quiet">Silêncio que fecha a rajada (s)</label><input id="t-quiet" type="number" min="2" max="60" value="6"></div>
				</div>
			</details>
			<div class="actions">
				<button type="submit" class="primary" id="t-save">Salvar fluxo</button>
				<button type="button" id="t-save-run">Salvar e executar</button>
				<button type="button" id="t-cancel">Cancelar</button>
			</div>
			<div class="hint">As mensagens são enviadas de verdade pelo WhatsApp da conexão escolhida. Use um número de teste.</div>
			<div class="result" id="t-result" role="status"></div>
		</form>

		<div class="card">
			<div class="conn-head"><div class="conn-title"><h2>Fluxos</h2><div class="conn-meta">Clique num fluxo para ver só as execuções dele.</div></div></div>
			<ul class="runs" id="flows"></ul>
			<p class="empty" id="flows-empty" hidden style="margin:0">Nenhum fluxo nesta conexão. Crie o primeiro em "+ Novo fluxo".</p>
			<div class="result" id="flows-result" role="status" style="margin:0 20px 12px"></div>
		</div>

		<div class="card" id="run-detail" hidden></div>

		<div class="card">
			<div class="conn-head">
				<div class="conn-title"><h2 id="runs-title">Execuções</h2></div>
				<button type="button" class="link" id="runs-all" hidden>Ver todas da conexão</button>
			</div>
			<ul class="runs" id="runs"></ul>
			<p class="empty" id="runs-empty" hidden style="margin:0">Nenhuma execução ainda.</p>
		</div>
	</section>
</main>

<template id="tpl-conn">
	<article class="card conn">
		<header class="conn-head">
			<div class="conn-title">
				<h2 data-name></h2>
				<div class="conn-meta" data-meta></div>
			</div>
			<form class="rename" data-rename hidden novalidate>
				<input type="text" maxlength="60" aria-label="Novo nome" data-rename-input>
				<button type="submit" class="primary">Salvar</button>
				<button type="button" data-rename-cancel>Cancelar</button>
			</form>
			<span class="pill idle" data-pill></span>
			<div>
				<button type="button" class="link" data-rename-open>Renomear</button>
				<button type="button" class="link danger" data-delete>Excluir</button>
			</div>
		</header>

		<div class="session" data-session aria-live="polite"></div>
		<div class="result err" data-session-result role="status" style="padding: 0 20px"></div>

		<details class="hook" data-filters>
			<summary><span class="hook-label">Filtros</span><span class="hook-target" data-filters-summary></span></summary>
			<form class="hook-body" data-filters-form novalidate>
				<div class="filter-grid">
					<div class="filter-box">
						<label class="check"><input type="checkbox" data-f-received> Mensagens recebidas</label>
						<label class="lbl" data-for="f-received-phones">Só destes remetentes</label>
						<textarea data-f-received-phones placeholder="Vazio = todos&#10;Ex.: 11 98888-7777"></textarea>
					</div>
					<div class="filter-box">
						<label class="check"><input type="checkbox" data-f-sent> Mensagens enviadas por mim</label>
						<label class="lbl" data-for="f-sent-phones">Só para estes destinatários</label>
						<textarea data-f-sent-phones placeholder="Vazio = todos&#10;Ex.: 11 94064-3009"></textarea>
					</div>
				</div>
				<label class="check" style="margin-bottom: 6px"><input type="checkbox" data-f-groups> Incluir mensagens de grupos</label>
				<div class="hint" style="margin-bottom: 14px">Um telefone por linha, com ou sem DDI/DDD e em qualquer formato. Em grupos, o filtro de recebidas vale para quem enviou; enviadas em grupo só passam quando a lista de destinatários está vazia.</div>
				<div class="actions"><button type="submit" class="primary" data-filters-save>Salvar filtros</button></div>
				<div class="result" data-filters-result role="status"></div>
			</form>
		</details>

		<details class="hook" data-hook>
			<summary><span class="hook-label">Webhook</span><span class="hook-target" data-hook-target></span></summary>
			<form class="hook-body" data-hook-form novalidate>
				<div class="field">
					<label class="lbl" data-for="url">URL do webhook</label>
					<input type="url" placeholder="https://exemplo.com/webhook" autocomplete="off" spellcheck="false" data-url>
				</div>
				<div class="field">
					<div class="lbl">Método</div>
					<div class="seg" role="radiogroup" aria-label="Método HTTP">
						<label><input type="radio" value="POST" checked><span>POST</span></label>
						<label><input type="radio" value="GET"><span>GET</span></label>
						<label><input type="radio" value="OPTIONS"><span>OPTIONS</span></label>
					</div>
					<div class="hint" data-method-hint></div>
				</div>
				<div class="field">
					<label class="lbl" data-for="token">Token (opcional)</label>
					<input type="password" autocomplete="off" spellcheck="false" data-token>
					<div class="hint">Enviado como <code>Authorization: Bearer &lt;token&gt;</code>.</div>
					<label class="check" data-clear-wrap hidden><input type="checkbox" data-clear-token> Remover o token salvo</label>
				</div>
				<div class="actions">
					<button type="submit" class="primary" data-hook-save>Salvar webhook</button>
					<button type="button" data-hook-test>Enviar teste</button>
					<button type="button" class="link danger" data-hook-remove>Remover webhook</button>
				</div>
				<div class="result" data-hook-result role="status"></div>
			</form>
		</details>

		<details class="hook" data-proxy>
			<summary><span class="hook-label">Proxy de saída</span><span class="hook-target" data-proxy-target></span></summary>
			<form class="hook-body" data-proxy-form novalidate>
				<div class="field">
					<label class="lbl" data-for="proxy-url">Proxy (http, https ou socks5)</label>
					<input type="text" placeholder="socks5://host:1080 ou http://host:3128" autocomplete="off" spellcheck="false" data-proxy-url>
					<div class="hint">O WhatsApp desta conexão (mensagens e mídia) sai por este proxy. Use um proxy estável, de preferência um por número: trocar de IP com frequência também chama atenção.</div>
				</div>
				<div class="grid2 field">
					<div>
						<label class="lbl" data-for="proxy-user">Usuário (opcional)</label>
						<input type="text" autocomplete="off" spellcheck="false" data-proxy-user>
					</div>
					<div>
						<label class="lbl" data-for="proxy-pass">Senha (opcional)</label>
						<input type="password" autocomplete="new-password" spellcheck="false" data-proxy-pass>
					</div>
				</div>
				<div class="actions">
					<button type="submit" class="primary" data-proxy-save>Salvar proxy</button>
					<button type="button" data-proxy-test>Testar</button>
					<button type="button" class="link danger" data-proxy-remove>Remover proxy</button>
				</div>
				<div class="hint">Salvar ou remover com o WhatsApp conectado reconecta na hora pela mesma sessão (sem QR).</div>
				<div class="result" data-proxy-result role="status"></div>
			</form>
		</details>

		<details class="hook" data-qview>
			<summary><span class="hook-label">Mensagens na fila</span><span class="hook-target" data-qview-summary></span></summary>
			<div class="hook-body">
				<div class="qtabs">
					<button type="button" data-qkind="pending" aria-selected="true">Pendentes</button>
					<button type="button" data-qkind="failed" aria-selected="false">Rejeitadas</button>
				</div>
				<div class="qbar">
					<label class="check"><input type="checkbox" data-qall-page> Selecionar esta página</label>
					<span class="muted" data-qcount></span>
				</div>
				<ul class="qitems" data-qlist></ul>
				<p class="empty" data-qempty hidden style="margin:0 0 12px">Nenhuma mensagem aqui.</p>
				<div class="actions">
					<button type="button" class="danger" data-qdel-sel disabled>Excluir selecionadas</button>
					<button type="button" class="link danger" data-qdel-all>Excluir tudo</button>
					<span style="flex:1"></span>
					<button type="button" data-qprev>Anterior</button>
					<button type="button" data-qnext>Próxima</button>
				</div>
				<div class="hint">Excluir tira a mensagem da fila sem enviá-la ao webhook (não dá para desfazer). Ela continua salva no banco. Rejeitadas = o webhook respondeu 4xx e ela não será reenviada.</div>
				<div class="result" data-qresult role="status"></div>
			</div>
		</details>

		<div class="queue" data-queue></div>
	</article>
</template>

<script>
	const $ = (id) => document.getElementById(id)
	const el = (tag, props = {}, ...children) => {
		const n = Object.assign(document.createElement(tag), props)
		n.append(...children)
		return n
	}

	async function api(path, init = {}) {
		const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } })
		const data = await res.json().catch(() => ({}))
		if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
		return data
	}
	const send = (method, path, body = {}) => api(path, { method, body: JSON.stringify(body) })

	function setResult(node, text, kind) {
		node.textContent = text
		node.className = 'result' + (kind ? ' ' + kind : '')
	}

	async function busy(button, resultNode, fn) {
		button.disabled = true
		try { await fn() } catch (e) { setResult(resultNode, e.message, 'err') } finally { button.disabled = false }
	}

	const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '–'
	const phoneFromJid = (jid) => { const n = (jid || '').split(/[:@]/)[0]; return n ? '+' + n : '' }

	// ---------- Nova conexão ----------
	function openNew() {
		$('new-form').hidden = false
		setResult($('new-result'), '')
		$('new-name').focus()
	}
	$('new-open').addEventListener('click', openNew)
	$('empty-new').addEventListener('click', openNew)
	$('new-cancel').addEventListener('click', () => { $('new-form').hidden = true; $('new-name').value = '' })
	$('new-form').addEventListener('submit', (ev) => {
		ev.preventDefault()
		busy($('new-submit'), $('new-result'), async () => {
			const { id } = await send('POST', '/api/connections', { friendlyName: $('new-name').value })
			$('new-form').hidden = true
			$('new-name').value = ''
			await refresh()
			cards.get(id)?.root.scrollIntoView({ behavior: 'smooth', block: 'start' })
		})
	})

	// ---------- Aniversários ----------
	$('bday-run').addEventListener('click', () => {
		if (!confirm('Enviar agora os parabéns de quem faz aniversário hoje? As mensagens saem de verdade.')) return
		setResult($('bday-result'), 'Verificando e enviando… (há uma pausa entre as mensagens)')
		busy($('bday-run'), $('bday-result'), async () => {
			const r = await send('POST', '/api/birthdays/run')
			if (r.note) return setResult($('bday-result'), r.note, 'err')
			const text = r.people + ' pessoa(s) na planilha, ' + r.due + ' aniversariante(s) pendente(s) hoje, ' + r.sent + ' mensagem(ns) enviada(s).'
			setResult($('bday-result'), r.open ? text : text + ' A conexão não está aberta.', r.open ? 'ok' : 'err')
		})
	})

	// ---------- Cards ----------
	const METHOD_HINTS = {
		POST: 'JSON da mensagem no corpo da requisição. Recomendado.',
		GET: 'Sem corpo: cada campo vai na query string (?id=...&text=...). Textos longos podem passar do limite de URL.',
		OPTIONS: 'JSON no corpo, como no POST. Pouco comum — use só se o seu endpoint espera OPTIONS.',
	}
	const IDLE_TEXT = {
		not_started: 'Nenhum WhatsApp conectado.',
		qr_expired: 'O QR code expirou antes de ser lido.',
		logged_out: 'Desconectado. Gere um novo QR para conectar de novo.',
		replaced: 'Esta sessão foi aberta em outro lugar e parou aqui.',
		forbidden: 'O WhatsApp recusou a conexão (403). Verifique o número no celular.',
	}

	/** id -> { root, q(sel), sessionKey, hookFilled, tokenSet, data } */
	const cards = new Map()

	function createCard(c) {
		const root = $('tpl-conn').content.firstElementChild.cloneNode(true)
		const q = (sel) => root.querySelector('[' + sel + ']')
		const card = { root, q, sessionKey: '', hookFilled: false, filtersFilled: false, proxyFilled: false, tokenSet: false, data: c }

		// ids únicos por card para os <label for>
		const url = q('data-url'), token = q('data-token')
		url.id = 'url-' + c.id; token.id = 'token-' + c.id
		root.querySelector('[data-for=url]').htmlFor = url.id
		root.querySelector('[data-for=token]').htmlFor = token.id
		root.querySelectorAll('.seg input').forEach((r) => {
			r.name = 'method-' + c.id
			r.addEventListener('change', () => { q('data-method-hint').textContent = METHOD_HINTS[r.value] })
		})

		// Renomear
		const renameForm = q('data-rename'), renameInput = q('data-rename-input')
		const toggleRename = (on) => {
			renameForm.hidden = !on
			root.querySelector('.conn-title').hidden = on
			q('data-rename-open').hidden = on
			if (on) { renameInput.value = card.data.friendlyName; renameInput.focus(); renameInput.select() }
		}
		q('data-rename-open').addEventListener('click', () => toggleRename(true))
		q('data-rename-cancel').addEventListener('click', () => toggleRename(false))
		renameForm.addEventListener('submit', (ev) => {
			ev.preventDefault()
			busy(renameForm.querySelector('button[type=submit]'), q('data-session-result'), async () => {
				await send('PUT', '/api/connections/' + c.id + '/name', { friendlyName: renameInput.value })
				toggleRename(false)
				await refresh()
			})
		})

		// Excluir
		q('data-delete').addEventListener('click', () => {
			const connected = card.data.state.status === 'open'
			const msg = 'Excluir a conexão "' + card.data.friendlyName + '"?\\n\\n' +
				(connected ? 'O aparelho será desconectado do WhatsApp. ' : '') +
				'A sessão e as mensagens ainda não enviadas desta conexão serão apagadas.'
			if (!confirm(msg)) return
			busy(q('data-delete'), q('data-session-result'), async () => {
				await send('DELETE', '/api/connections/' + c.id)
				await refresh()
			})
		})

		// Webhook
		const hookResult = q('data-hook-result')
		const method = () => root.querySelector('.seg input:checked').value
		const hookPayload = () => {
			const body = { url: url.value.trim(), method: method() }
			if (q('data-clear-token').checked) body.token = ''
			else if (token.value) body.token = token.value
			return body
		}
		// Remover (botão ou salvar com a URL vazia): para de enviar na hora. As
		// pendentes podem ser excluídas junto ou ficar na fila para um webhook futuro.
		const removeWebhook = (button) => {
			if (!card.data.webhook) { setResult(hookResult, 'Nenhum webhook configurado.', 'ok'); return }
			if (!confirm('Remover o webhook?\\n\\nNenhuma mensagem será mais enviada por esta conexão (elas continuam salvas no banco).')) return
			const pending = card.data.queue.pending
			const discardPending = pending > 0 && confirm('Há ' + pending + ' mensagem(ns) pendente(s) na fila.\\n\\nOK = excluir da fila também.\\nCancelar = manter na fila (serão enviadas se você salvar um webhook de novo).')
			busy(button, hookResult, async () => {
				const r = await send('PUT', '/api/connections/' + c.id + '/webhook', { url: '', discardPending })
				card.hookFilled = false
				await refresh()
				setResult(hookResult, 'Webhook removido. Nada mais será enviado' + (r.discarded ? '; ' + r.discarded + ' pendente(s) excluída(s) da fila.' : '.'), 'ok')
			})
		}
		q('data-hook-form').addEventListener('submit', (ev) => {
			ev.preventDefault()
			const body = hookPayload()
			// URL apagada = remover (não é obrigatória).
			if (!body.url) return removeWebhook(q('data-hook-save'))
			busy(q('data-hook-save'), hookResult, async () => {
				await send('PUT', '/api/connections/' + c.id + '/webhook', body)
				card.hookFilled = false
				await refresh()
				setResult(hookResult, 'Salvo. As próximas mensagens vão para ' + body.method + ' ' + body.url, 'ok')
			})
		})
		q('data-hook-test').addEventListener('click', () => {
			busy(q('data-hook-test'), hookResult, async () => {
				const body = hookPayload()
				if (!body.url) throw new Error('Informe a URL do webhook')
				setResult(hookResult, 'Enviando teste…')
				const r = await send('POST', '/api/connections/' + c.id + '/test', body)
				if (r.ok) setResult(hookResult, 'Sucesso: HTTP ' + r.status + ' em ' + r.ms + ' ms', 'ok')
				else setResult(hookResult, 'Falhou: ' + (r.status ? 'HTTP ' + r.status : r.error) + ' (' + r.ms + ' ms)', 'err')
			})
		})
		q('data-hook-remove').addEventListener('click', () => removeWebhook(q('data-hook-remove')))

		// Filtros
		const fr = q('data-f-received'), fs = q('data-f-sent')
		const frPhones = q('data-f-received-phones'), fsPhones = q('data-f-sent-phones')
		frPhones.id = 'frp-' + c.id; fsPhones.id = 'fsp-' + c.id
		root.querySelector('[data-for=f-received-phones]').htmlFor = frPhones.id
		root.querySelector('[data-for=f-sent-phones]').htmlFor = fsPhones.id
		const syncDisabled = () => { frPhones.disabled = !fr.checked; fsPhones.disabled = !fs.checked }
		fr.addEventListener('change', syncDisabled)
		fs.addEventListener('change', syncDisabled)
		card.syncFilterInputs = syncDisabled
		const lines = (t) => t.value.split(/[\\n,;]+/).map((x) => x.trim()).filter(Boolean)
		q('data-filters-form').addEventListener('submit', (ev) => {
			ev.preventDefault()
			const out = q('data-filters-result')
			busy(q('data-filters-save'), out, async () => {
				await send('PUT', '/api/connections/' + c.id + '/filters', {
					received: { enabled: fr.checked, phones: lines(frPhones) },
					sent: { enabled: fs.checked, phones: lines(fsPhones) },
					groups: q('data-f-groups').checked,
				})
				card.filtersFilled = false
				await refresh()
				setResult(out, 'Filtros salvos. Valem para as próximas mensagens.', 'ok')
			})
		})

		// Fila: ver e excluir mensagens
		const qv = { kind: 'pending', offset: 0, limit: 50, selected: new Set(), data: null }
		card.qv = qv
		const qResult = q('data-qresult')
		root.querySelectorAll('[data-qkind]').forEach((b) => b.addEventListener('click', () => {
			qv.kind = b.dataset.qkind; qv.offset = 0; qv.selected.clear(); setResult(qResult, '')
			loadQueue(card)
		}))
		q('data-qview').addEventListener('toggle', () => { if (q('data-qview').open) loadQueue(card) })
		q('data-qall-page').addEventListener('change', (ev) => {
			for (const it of (qv.data ? qv.data.items : [])) ev.target.checked ? qv.selected.add(it.file) : qv.selected.delete(it.file)
			renderQueue(card)
		})
		q('data-qprev').addEventListener('click', () => { qv.offset = Math.max(0, qv.offset - qv.limit); loadQueue(card) })
		q('data-qnext').addEventListener('click', () => { qv.offset += qv.limit; loadQueue(card) })
		const afterDelete = async (removed) => {
			setResult(qResult, removed + ' mensagem(ns) excluída(s) da fila.', 'ok')
			await loadQueue(card)
			await refresh()
		}
		q('data-qdel-sel').addEventListener('click', () => {
			const files = [...qv.selected]
			if (!files.length) return
			if (!confirm('Excluir ' + files.length + ' mensagem(ns) da fila sem enviar ao webhook?\\n\\nElas continuam salvas no banco. Não dá para desfazer.')) return
			busy(q('data-qdel-sel'), qResult, async () => {
				let removed = 0
				// Lotes de até 400 (limite por requisição).
				for (let i = 0; i < files.length; i += 400) {
					const r = await send('DELETE', '/api/connections/' + c.id + '/queue', { kind: qv.kind, files: files.slice(i, i + 400) })
					removed += r.removed
				}
				qv.selected.clear()
				await afterDelete(removed)
			})
		})
		q('data-qdel-all').addEventListener('click', () => {
			const total = qv.data ? qv.data.total : 0
			const label = qv.kind === 'pending' ? 'pendentes' : 'rejeitadas'
			if (!confirm('Excluir TODAS as ' + total + ' mensagens ' + label + ' desta conexão, sem enviar ao webhook?\\n\\nElas continuam salvas no banco. Não dá para desfazer.')) return
			busy(q('data-qdel-all'), qResult, async () => {
				const r = await send('DELETE', '/api/connections/' + c.id + '/queue', { kind: qv.kind, all: true })
				qv.selected.clear()
				qv.offset = 0
				await afterDelete(r.removed)
			})
		})

		// Proxy de saída
		const pUrl = q('data-proxy-url'), pUser = q('data-proxy-user'), pPass = q('data-proxy-pass')
		const proxyResult = q('data-proxy-result')
		pUrl.id = 'purl-' + c.id; pUser.id = 'puser-' + c.id; pPass.id = 'ppass-' + c.id
		root.querySelector('[data-for=proxy-url]').htmlFor = pUrl.id
		root.querySelector('[data-for=proxy-user]').htmlFor = pUser.id
		root.querySelector('[data-for=proxy-pass]').htmlFor = pPass.id
		// Senha vazia = mantém a salva (o servidor nunca devolve a senha).
		const proxyPayload = () => {
			const body = { url: pUrl.value.trim(), username: pUser.value.trim() }
			if (pPass.value) body.password = pPass.value
			return body
		}
		const reconnectWarning = () => card.data.state.status !== 'idle'
			? confirm('O WhatsApp desta conexão vai reconectar agora pelo novo caminho (mesma sessão, sem QR). Continuar?')
			: true
		q('data-proxy-form').addEventListener('submit', (ev) => {
			ev.preventDefault()
			busy(q('data-proxy-save'), proxyResult, async () => {
				const body = proxyPayload()
				if (!body.url) throw new Error('Informe o proxy')
				if (!reconnectWarning()) return
				await send('PUT', '/api/connections/' + c.id + '/proxy', body)
				card.proxyFilled = false
				await refresh()
				setResult(proxyResult, 'Proxy salvo.', 'ok')
			})
		})
		q('data-proxy-test').addEventListener('click', () => {
			busy(q('data-proxy-test'), proxyResult, async () => {
				const body = proxyPayload()
				if (!body.url) throw new Error('Informe o proxy')
				setResult(proxyResult, 'Testando…')
				const r = await send('POST', '/api/connections/' + c.id + '/proxytest', body)
				if (r.ok) setResult(proxyResult, 'Funcionando: WhatsApp Web respondeu HTTP ' + r.status + ' pelo proxy em ' + r.ms + ' ms', 'ok')
				else setResult(proxyResult, 'Falhou: ' + r.error + ' (' + r.ms + ' ms)', 'err')
			})
		})
		q('data-proxy-remove').addEventListener('click', () => {
			if (!confirm('Remover o proxy? O WhatsApp desta conexão passa a sair direto pela sua internet.')) return
			busy(q('data-proxy-remove'), proxyResult, async () => {
				await send('PUT', '/api/connections/' + c.id + '/proxy', { url: '' })
				card.proxyFilled = false
				await refresh()
				setResult(proxyResult, 'Proxy removido.', 'ok')
			})
		})

		return card
	}

	function filtersSummary(f) {
		const dir = (d, label) => !d.enabled ? label + ': não'
			: label + ': ' + (d.phones.length ? d.phones.length + (d.phones.length === 1 ? ' telefone' : ' telefones') : 'todas')
		return [dir(f.received, 'Recebidas'), dir(f.sent, 'Enviadas'), 'Grupos: ' + (f.groups ? 'sim' : 'não')].join(' · ')
	}

	/** Mostra os dígitos salvos de forma legível: 5511988887777 -> +55 11 98888-7777 */
	function fmtPhone(d) {
		const m = /^55(\\d{2})(\\d{4,5})(\\d{4})$/.exec(d)
		return m ? '+55 ' + m[1] + ' ' + m[2] + '-' + m[3] : '+' + d
	}

	// ----- Fila (ver e excluir) -----
	/** Quem é o outro lado da mensagem, para a lista da fila. */
	function queueWho(it) {
		if (it.isGroup) return 'Grupo' + (it.pushName && !it.fromMe ? ' · ' + it.pushName : '')
		const jid = [it.chatId, it.chatIdAlt].find((j) => j && j.endsWith('@s.whatsapp.net'))
		const phone = jid ? phoneFromJid(jid) : (it.chatId || '?')
		return (it.fromMe ? 'Para ' : 'De ') + (it.pushName && !it.fromMe ? it.pushName + ' · ' : '') + phone
	}

	async function loadQueue(card) {
		const qv = card.qv
		if (!card.q('data-qview').open) return
		// Uma busca por vez; mudanças durante ela geram só mais uma no fim.
		if (qv.loading) { qv.again = true; return }
		qv.loading = true
		try { await fetchQueue(card) } finally { qv.loading = false }
		if (qv.again) { qv.again = false; return loadQueue(card) }
	}

	async function fetchQueue(card) {
		const qv = card.qv
		let data
		try {
			data = await api('/api/connections/' + card.data.id + '/queue?kind=' + qv.kind + '&offset=' + qv.offset + '&limit=' + qv.limit)
		} catch (e) { setResult(card.q('data-qresult'), e.message, 'err'); return }
		// Página ficou vazia (itens entregues/excluídos): volta para a última com itens.
		if (qv.offset > 0 && qv.offset >= data.total) {
			qv.offset = Math.max(0, Math.floor((data.total - 1) / qv.limit) * qv.limit)
			return fetchQueue(card)
		}
		qv.data = data
		renderQueue(card)
	}

	function renderQueue(card) {
		const qv = card.qv, q = card.q, data = qv.data
		if (!data) return
		card.root.querySelectorAll('[data-qkind]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.qkind === qv.kind)))
		const list = q('data-qlist')
		const scroll = list.scrollTop
		list.replaceChildren(...data.items.map((it) => {
			const box = el('input', { type: 'checkbox', checked: qv.selected.has(it.file), ariaLabel: 'Selecionar' })
			box.addEventListener('change', () => { box.checked ? qv.selected.add(it.file) : qv.selected.delete(it.file); renderQueue(card) })
			const kind = it.type ? it.type.replace(/Message$/, '') : '?'
			return el('li', {}, box, el('div', { className: 'qmain' },
				el('div', { className: 'qwho', textContent: it.unreadable ? 'Item ilegível (arquivo corrompido)' : queueWho(it) }),
				it.unreadable ? '' : el('div', { className: 'qtext', textContent: it.preview || '[' + kind + ' sem texto]' }),
				el('div', { className: 'qmeta', textContent: 'na fila desde ' + fmtDate(it.queuedAt) +
					(it.timestamp ? ' · enviada em ' + fmtDate(new Date(it.timestamp * 1000).toISOString()) : '') + ' · ' + kind }),
			))
		}))
		list.scrollTop = scroll
		list.hidden = data.items.length === 0
		q('data-qempty').hidden = data.items.length > 0
		const pageSelected = data.items.length > 0 && data.items.every((it) => qv.selected.has(it.file))
		q('data-qall-page').checked = pageSelected
		q('data-qall-page').disabled = data.items.length === 0
		const from = data.total ? qv.offset + 1 : 0, to = qv.offset + data.items.length
		q('data-qcount').textContent = from + '–' + to + ' de ' + data.total + (qv.selected.size ? ' · ' + qv.selected.size + ' selecionada(s)' : '')
		q('data-qdel-sel').disabled = qv.selected.size === 0
		q('data-qdel-all').disabled = data.total === 0
		q('data-qprev').disabled = qv.offset === 0
		q('data-qnext').disabled = to >= data.total
	}

	function sessionAction(card, label, action, kind, confirmText) {
		const b = el('button', { type: 'button', className: kind || '', textContent: label })
		b.addEventListener('click', () => {
			if (confirmText && !confirm(confirmText)) return
			busy(b, card.q('data-session-result'), async () => {
				setResult(card.q('data-session-result'), '')
				await send('POST', '/api/connections/' + card.data.id + '/' + action)
				await refresh()
			})
		})
		return b
	}

	function renderSession(card) {
		const s = card.data.state
		const key = JSON.stringify(s)
		if (key === card.sessionKey) return
		card.sessionKey = key
		const pill = card.q('data-pill'), box = card.q('data-session')
		const setPill = (text, kind) => { pill.textContent = text; pill.className = 'pill ' + kind }
		box.replaceChildren()

		if (s.status === 'qr') {
			setPill('Aguardando leitura', 'warn')
			const qr = el('div', { className: 'qr', role: 'img', ariaLabel: 'QR code para conectar o WhatsApp' })
			qr.innerHTML = s.qrSvg // SVG gerado no servidor pela lib qrcode
			box.append(qr, el('div', { className: 'session-info' },
				el('ol', { className: 'steps' },
					el('li', {}, 'Abra o ', el('b', {}, 'WhatsApp'), ' no celular'),
					el('li', {}, el('b', {}, 'Configurações'), ' (ou ⋮) → ', el('b', {}, 'Aparelhos conectados')),
					el('li', {}, el('b', {}, 'Conectar aparelho'), ' e aponte para o código'),
				),
				el('p', { className: 'muted', textContent: 'O código se renova sozinho por cerca de 1 minuto.' }),
				el('div', { className: 'actions' }, sessionAction(card, 'Cancelar QR', 'cancel')),
			))
		} else if (s.status === 'open') {
			setPill('Conectado', 'ok')
			const phone = phoneFromJid(s.user.id)
			box.append(el('div', { className: 'session-info' },
				el('p', {}, el('span', { className: 'who', textContent: s.user.name || phone }),
					s.user.name ? el('span', { className: 'muted', textContent: ' · ' + phone }) : ''),
				el('div', { className: 'actions' }, sessionAction(card, 'Desconectar', 'logout', 'danger',
					'Desconectar este WhatsApp? O aparelho sai de "Aparelhos conectados" e será preciso ler um novo QR. O nome e o webhook são mantidos.')),
			))
		} else if (s.status === 'connecting' || s.status === 'reconnecting') {
			setPill(s.status === 'connecting' ? 'Conectando…' : 'Reconectando', s.status === 'connecting' ? 'idle' : 'warn')
			const text = s.status === 'connecting' ? 'Conectando ao WhatsApp…'
				: 'Conexão caiu. Nova tentativa às ' + new Date(s.retryAt).toLocaleTimeString('pt-BR') + ' (tentativa ' + s.attempts + ').'
			box.append(el('div', { className: 'session-info' },
				el('p', { className: 'muted', textContent: text }),
				el('div', { className: 'actions' }, sessionAction(card, 'Cancelar', 'cancel')),
			))
		} else {
			setPill('Desconectado', s.reason === 'not_started' ? 'idle' : 'err')
			box.append(el('div', { className: 'session-info' },
				el('p', { textContent: IDLE_TEXT[s.reason] || '' }),
				el('div', { className: 'actions' }, sessionAction(card, s.reason === 'qr_expired' ? 'Gerar novo QR' : 'Gerar QR code', 'connect', 'primary')),
			))
		}
	}

	function renderCard(card) {
		const c = card.data, q = card.q
		q('data-name').textContent = c.friendlyName
		const phone = c.state.status === 'open' ? phoneFromJid(c.state.user.id) + ' · ' : ''
		q('data-meta').textContent = phone + 'criada em ' + fmtDate(c.createdAt) + ' · id ' + c.id
		renderSession(card)

		// Resumo do webhook (sempre) e campos (só na 1ª vez / após salvar, para não apagar o que se digita)
		const w = c.webhook
		q('data-hook-target').textContent = w ? w.method + ' ' + w.url : 'não configurado — nada é enviado'
		const hook = q('data-hook')
		if (!card.hookFilled) {
			card.hookFilled = true
			q('data-url').value = w ? w.url : ''
			const m = w ? w.method : 'POST'
			card.root.querySelectorAll('.seg input').forEach((r) => { r.checked = r.value === m })
			q('data-method-hint').textContent = METHOD_HINTS[m]
			card.tokenSet = Boolean(w && w.tokenSet)
			q('data-token').value = ''
			q('data-token').placeholder = card.tokenSet ? '•••••• (salvo — deixe vazio para manter)' : 'nenhum'
			q('data-clear-wrap').hidden = !card.tokenSet
			q('data-clear-token').checked = false
			q('data-hook-remove').hidden = !w
			// Sem webhook: já deixa o formulário aberto como próximo passo.
			if (!w) hook.open = true
		}

		// Filtros (resumo sempre; campos só na 1ª vez / após salvar)
		q('data-filters-summary').textContent = filtersSummary(c.filters)
		if (!card.filtersFilled) {
			card.filtersFilled = true
			q('data-f-received').checked = c.filters.received.enabled
			q('data-f-sent').checked = c.filters.sent.enabled
			q('data-f-groups').checked = c.filters.groups
			q('data-f-received-phones').value = c.filters.received.phones.map(fmtPhone).join('\\n')
			q('data-f-sent-phones').value = c.filters.sent.phones.map(fmtPhone).join('\\n')
			card.syncFilterInputs()
		}

		// Proxy (resumo sempre; campos só na 1ª vez / após salvar)
		const p = c.proxy
		q('data-proxy-target').textContent = p ? p.url + (p.username ? ' (usuário ' + p.username + ')' : '') : 'direto (sem proxy)'
		if (!card.proxyFilled) {
			card.proxyFilled = true
			q('data-proxy-url').value = p ? p.url : ''
			q('data-proxy-user').value = p ? p.username : ''
			q('data-proxy-pass').value = ''
			q('data-proxy-pass').placeholder = p && p.passwordSet ? '•••••• (salva — deixe vazio para manter)' : ''
			q('data-proxy-remove').hidden = !p
		}

		// Fila (lista aberta: recarrega; a resposta vem do cache se nada mudou)
		q('data-qview-summary').textContent = c.queue.pending + ' pendente(s) · ' + c.queue.failed + ' rejeitada(s)'
		card.root.querySelector('[data-qkind=pending]').textContent = 'Pendentes (' + c.queue.pending + ')'
		card.root.querySelector('[data-qkind=failed]').textContent = 'Rejeitadas (' + c.queue.failed + ')'
		// Fila aberta: recarrega a página da lista só se a fila mudou (contagens ou cabeça).
		const qKey = c.queue.pending + '|' + c.queue.failed + '|' + c.queue.head
		if (q('data-qview').open && qKey !== card.qv.key) loadQueue(card)
		card.qv.key = qKey

		// Fila
		const s = c.queue
		const item = (label, value, kind) => el('span', { className: kind || '' }, label + ': ', el('b', { textContent: String(value) }))
		q('data-queue').replaceChildren(
			item('Pendentes', s.pending, s.pending && (s.backingOff || !w) ? 'warn' : ''),
			item('Rejeitadas', s.failed, s.failed ? 'err' : ''),
			item('Último envio', fmtDate(s.lastSuccessAt)),
			...(s.lastError ? [item('Último erro', s.lastError.message + ' (' + fmtDate(s.lastError.at) + ')', 'err')] : []),
		)
	}

	async function refresh() {
		let data
		try {
			data = await api('/api/connections')
			setResult($('global-error'), '')
		} catch (e) {
			setResult($('global-error'), 'App fora do ar ou reiniciando… (' + e.message + ')', 'err')
			return
		}
		applyConnections(data.connections)
	}

	/** Estado completo (snapshot do SSE ou resposta do GET): sincroniza todos os cards. */
	function applyConnections(conns) {
		lastConnections = conns
		const list = $('list')
		const seen = new Set()
		conns.forEach((c, i) => {
			seen.add(c.id)
			let card = cards.get(c.id)
			if (!card) { card = createCard(c); cards.set(c.id, card) }
			card.data = c
			renderCard(card)
			if (list.children[i] !== card.root) list.insertBefore(card.root, list.children[i] || null)
		})
		for (const [id, card] of cards) if (!seen.has(id)) { card.root.remove(); cards.delete(id) }
		connectionsChanged()
	}

	/** Uma conexão mudou (evento "connection" do SSE): só o card dela é redesenhado. */
	function upsertConnection(c) {
		const i = lastConnections.findIndex((x) => x.id === c.id)
		if (i >= 0) lastConnections[i] = c
		else lastConnections = [...lastConnections, c]
		let card = cards.get(c.id)
		if (!card) { card = createCard(c); cards.set(c.id, card); $('list').append(card.root) }
		card.data = c
		renderCard(card)
		connectionsChanged()
	}

	function removeConnectionView(id) {
		lastConnections = lastConnections.filter((c) => c.id !== id)
		const card = cards.get(id)
		if (card) { card.root.remove(); cards.delete(id) }
		connectionsChanged()
	}

	function connectionsChanged() {
		$('empty').hidden = lastConnections.length > 0 || !$('new-form').hidden
		const open = lastConnections.filter((c) => c.state.status === 'open').length
		$('summary').textContent = lastConnections.length
			? lastConnections.length + ' conexão(ões) · ' + open + ' conectada(s)'
			: ''
		// Aba de testes aberta: atualiza o seletor de conexão (sem buscar nada).
		if (!$('tab-tests').hidden && fillConnectionSelect(lastConnections)) refreshTests()
	}

	// ---------- Abas ----------
	function showTab(name) {
		for (const t of ['conn', 'tests']) {
			$('tab-' + t).hidden = t !== name
			$('tab-btn-' + t).setAttribute('aria-selected', String(t === name))
		}
		try { localStorage.setItem('tab', name) } catch {}
		if (name === 'tests') refreshTests()
	}
	$('tab-btn-conn').addEventListener('click', () => showTab('conn'))
	$('tab-btn-tests').addEventListener('click', () => showTab('tests'))

	// ---------- Testes com IA ----------
	const RUN_STATUS = {
		running: ['Em andamento', 'warn'], passed: ['Passou', 'ok'], failed: ['Falhou', 'err'],
		inconclusive: ['Inconclusivo', 'idle'], error: ['Erro', 'err'], cancelled: ['Cancelado', 'idle'], interrupted: ['Interrompido', 'idle'],
	}
	const RULE_STATUS = { ok: ['Cumprida', 'ok'], violated: ['Violada', 'err'], not_tested: ['Não verificada', 'idle'] }
	const pillEl = (pair) => el('span', { className: 'pill ' + pair[1], textContent: pair[0] })
	let selectedRun = null
	let lastConnections = []

	let selectedFlow = null
	let editingFlow = null
	let flowsKey = ''

	function fillConnectionSelect(conns) {
		const sel = $('t-conn')
		const key = JSON.stringify(conns.map((c) => [c.id, c.friendlyName, c.state.status]))
		if (sel.dataset.key === key) return false
		sel.dataset.key = key
		const prev = sel.value
		// Todas aparecem (fluxos podem ser vistos/editados com a conexão caída); executar exige conectada.
		sel.replaceChildren(...conns.map((c) => {
			const open = c.state.status === 'open'
			const phone = open ? ' · ' + phoneFromJid(c.state.user.id) : ' (desconectada)'
			return el('option', { value: c.id, textContent: c.friendlyName + phone })
		}))
		const firstOpen = conns.find((c) => c.state.status === 'open')
		sel.value = conns.some((c) => c.id === prev) ? prev : (firstOpen ? firstOpen.id : (conns[0] ? conns[0].id : ''))
		if (sel.value !== prev) { selectedFlow = null; flowsKey = '' }
		return true
	}
	$('t-conn').addEventListener('change', () => { selectedFlow = null; selectedRun = null; flowsKey = ''; closeFlowForm(); refreshTests() })

	// ----- Referência: card + fluxo do Studio -----
	const radioValue = (name) => { const r = document.querySelector('input[name=' + name + ']:checked'); return r ? r.value : 'none' }
	const setRadio = (name, value) => document.querySelectorAll('input[name=' + name + ']').forEach((r) => { r.checked = r.value === value })
	/** { mode, sources, flows: [{name, states}], selected: Set, uploadId, fileName } */
	const studio = { sources: [], flows: [], selected: new Set(), uploadId: null, fileName: '' }
	let testerInfo = null

	async function loadTesterInfo() {
		if (testerInfo) return testerInfo
		try { testerInfo = await api('/api/tester/info') } catch { testerInfo = { wsl: true } }
		return testerInfo
	}

	function syncRefUi() {
		const card = radioValue('card-src'), st = radioValue('studio-src')
		$('card-text-box').hidden = card !== 'text'
		$('card-url-box').hidden = card !== 'azure' && card !== 'jira'
		$('card-preview-wrap').hidden = card === 'none'
		const info = testerInfo || {}
		$('card-url-hint').textContent = card === 'azure'
			? 'Ex.: https://dev.azure.com/org/projeto/_workitems/edit/123' + (info.azureConfigured === false ? ' — falta AZDO_PAT no .env.' : '')
			: card === 'jira' ? 'Ex.: https://empresa.atlassian.net/browse/ABC-123' + (info.jiraConfigured === false ? ' — faltam JIRA_EMAIL e JIRA_API_TOKEN no .env.' : '') : ''
		$('studio-project-box').hidden = st !== 'project'
		$('studio-upload-box').hidden = st !== 'upload'
		const hasFlows = st !== 'none' && studio.flows.length > 0
		$('studio-pick').hidden = !hasFlows
		$('studio-sub-wrap').hidden = !hasFlows
		$('studio-monitor-wrap').hidden = !hasFlows
		const envs = info.twilioEnvs || {}
		for (const opt of $('studio-monitor').options) {
			if (opt.value) opt.textContent = 'Conta ' + opt.value + (envs[opt.value] ? '' : ' (faltam credenciais no .env)')
		}
		const env = $('studio-monitor').value
		$('studio-monitor-hint').textContent = env
			? 'A cada ' + (info.studioPollSec || 10) + ' s o teste lê os widgets executados e as saídas (decisões, funções, transferência) da execução do seu número, só leitura, e a IA usa esse caminho real na análise.' +
				(envs[env] ? '' : ' Configure TWILIO_' + env.toUpperCase() + '_API_KEY_SID e _SECRET no .env.')
			: ''
	}
	document.querySelectorAll('input[name=card-src], input[name=studio-src]').forEach((r) => r.addEventListener('change', () => {
		if (r.name === 'studio-src') { studio.flows = []; studio.sources = []; $('studio-file').hidden = true; setResult($('studio-result'), '') }
		setResult($('card-preview'), '')
		syncRefUi()
	}))

	$('card-file').addEventListener('change', async (ev) => {
		const file = ev.target.files[0]
		ev.target.value = ''
		if (!file) return
		if (file.size > 100000) { setResult($('card-preview'), 'Arquivo grande demais (máx. 100 KB de texto).', 'err'); return }
		const text = await file.text()
		const box = $('card-text')
		box.value = (box.value.trim() ? box.value.trim() + '\\n\\n' : '') + '--- ' + file.name + ' ---\\n' + text
		setResult($('card-preview'), 'Arquivo ' + file.name + ' anexado ao texto do card.', 'ok')
	})

	function cardPayload() {
		const source = radioValue('card-src')
		if (source === 'none') return null
		return { source, text: $('card-text').value, url: $('card-url').value.trim() }
	}

	$('card-preview-btn').addEventListener('click', () => {
		busy($('card-preview-btn'), $('card-preview'), async () => {
			const body = cardPayload()
			if (!body) return
			setResult($('card-preview'), 'Lendo o card (somente leitura)…')
			const c = await send('POST', '/api/cards/preview', body)
			const att = c.attachments.length ? ' · anexos: ' + c.attachments.map((a) => a.name + (a.used === 'ignored' ? ' (não lido)' : a.used === 'studio' ? ' (fluxo Studio)' : '')).join(', ') : ''
			setResult($('card-preview'), '✔ ' + c.title + (c.ref ? ' (' + c.ref + ')' : '') + (c.state ? ' · ' + c.state : '') + ' · ' + c.bodyChars + ' caracteres' +
				(c.comments ? ' · ' + c.comments + ' comentário(s)' : '') + att + '\\n\\n' + c.body.slice(0, 400) + (c.bodyChars > 400 ? '…' : ''), 'ok')
		})
	})

	// Fluxos do Studio
	function renderStudioPick() {
		const filter = $('studio-filter').value.trim().toLowerCase()
		$('studio-list').replaceChildren(...studio.flows.filter((f) => !filter || f.name.toLowerCase().includes(filter)).map((f) => {
			const box = el('input', { type: 'checkbox', checked: studio.selected.has(f.name) })
			box.addEventListener('change', () => { box.checked ? studio.selected.add(f.name) : studio.selected.delete(f.name) })
			return el('li', {}, el('label', {}, box, f.name, el('span', { textContent: f.states + ' widgets' })))
		}))
		syncRefUi()
	}
	$('studio-filter').addEventListener('input', renderStudioPick)

	function showSource(file) {
		const src = studio.sources.find((s) => s.file === file) || studio.sources[0]
		if (!src) return
		$('studio-file').value = src.file
		suggestEnv(src.file)
		studio.flows = src.flows
		for (const n of [...studio.selected]) if (!src.flows.some((f) => f.name === n)) studio.selected.delete(n)
		renderStudioPick()
	}
	$('studio-file').addEventListener('change', () => showSource($('studio-file').value))
	$('studio-monitor').addEventListener('change', syncRefUi)
	/** Sugere o ambiente pelo arquivo escolhido (…/dev/state/…, …/prod/…). */
	function suggestEnv(file) {
		const m = /(^|\\/)(dev|qa|prod)(\\/|$)/.exec(file || '')
		if (m && !$('studio-monitor').value) { $('studio-monitor').value = m[2]; syncRefUi() }
	}

	async function scanStudio(preferFile) {
		setResult($('studio-result'), 'Procurando fluxos…')
		const r = await send('POST', '/api/studio/scan', { path: $('studio-path').value, location: radioValue('studio-loc') })
		studio.sources = r.sources
		$('studio-file').replaceChildren(...r.sources.map((s) => el('option', { value: s.file, textContent: s.file + ' — ' + s.flows.length + ' fluxo(s)' })))
		$('studio-file').hidden = false
		showSource(preferFile || (r.sources.find((s) => /dev\\/state/.test(s.file)) || r.sources[0]).file)
		setResult($('studio-result'), r.sources.length + ' arquivo(s) com fluxos em ' + r.resolvedPath + '. Escolha o arquivo e marque os fluxos.', 'ok')
	}
	$('studio-scan').addEventListener('click', () => busy($('studio-scan'), $('studio-result'), () => scanStudio(null)))

	$('studio-upload').addEventListener('change', (ev) => {
		const file = ev.target.files[0]
		if (!file) return
		busy($('studio-upload'), $('studio-result'), async () => {
			if (file.size > 12 * 1024 * 1024) throw new Error('JSON grande demais (máx. 12 MB)')
			setResult($('studio-result'), 'Enviando ' + file.name + '…')
			const r = await send('POST', '/api/studio/uploads', { fileName: file.name, content: await file.text() })
			studio.uploadId = r.id
			studio.fileName = r.fileName
			studio.flows = r.flows
			studio.selected = new Set(r.flows.length === 1 ? [r.flows[0].name] : [])
			$('studio-upload-info').textContent = 'Anexado: ' + r.fileName
			renderStudioPick()
			setResult($('studio-result'), r.flows.length + ' fluxo(s) no arquivo. Marque os que o teste deve usar.', 'ok')
		})
	})

	function studioPayload() {
		const mode = radioValue('studio-src')
		if (mode === 'none') return null
		const common = { mode, flows: [...studio.selected], includeSubflows: $('studio-sub').checked, monitorEnv: $('studio-monitor').value || null }
		return mode === 'project'
			? { ...common, projectPath: $('studio-path').value, location: radioValue('studio-loc'), file: $('studio-file').value }
			: { ...common, uploadId: studio.uploadId, fileName: studio.fileName }
	}

	$('ref-preview-btn').addEventListener('click', () => {
		busy($('ref-preview-btn'), $('ref-preview-result'), async () => {
			setResult($('ref-preview-result'), 'Montando a referência (lê o card e o fluxo)…')
			const r = await send('POST', '/api/reference/preview', { card: cardPayload(), studio: studioPayload() })
			const sm = r.summary
			setResult($('ref-preview-result'), Math.round(sm.bytes / 1024) + ' KB · ' +
				(sm.card ? 'card: ' + sm.card.title : 'sem card') + ' · ' +
				(sm.studio ? sm.studio.flows.length + ' fluxo(s): ' + sm.studio.flows.join(', ') : 'sem fluxo'), 'ok')
			$('ref-preview').textContent = r.preview + (r.truncated ? '\\n\\n… (prévia cortada; a IA recebe tudo)' : '')
			$('ref-preview').hidden = false
		})
	})

	async function fillReference(flow) {
		const info = await loadTesterInfo()
		const card = flow && flow.card
		setRadio('card-src', card ? card.source : 'none')
		$('card-text').value = card ? card.text || '' : ''
		$('card-url').value = card ? card.url || '' : ''
		setResult($('card-preview'), '')
		const st = flow && flow.studio
		setRadio('studio-src', st ? st.mode : 'none')
		studio.flows = []; studio.sources = []; studio.selected = new Set(st ? st.flows : []); studio.uploadId = null; studio.fileName = ''
		$('studio-sub').checked = st ? st.includeSubflows !== false : true
		$('studio-monitor').value = st && st.monitorEnv ? st.monitorEnv : ''
		$('studio-path').value = st && st.mode === 'project' ? st.projectPath : ''
		setRadio('studio-loc', st && st.mode === 'project' ? st.location : (info.wsl ? 'wsl' : 'windows'))
		$('studio-file').hidden = true
		$('studio-upload').value = ''
		$('studio-upload-info').textContent = ''
		$('ref-preview').hidden = true
		setResult($('ref-preview-result'), '')
		setResult($('studio-result'), '')
		syncRefUi()
		if (st && st.mode === 'project') await scanStudio(st.file).catch((e) => setResult($('studio-result'), e.message, 'err'))
		if (st && st.mode === 'upload') {
			try {
				const u = await api('/api/studio/uploads/' + st.uploadId)
				studio.uploadId = st.uploadId; studio.fileName = u.fileName; studio.flows = u.flows
				$('studio-upload-info').textContent = 'Anexado: ' + u.fileName + ' (escolha outro arquivo para trocar)'
				renderStudioPick()
			} catch (e) { setResult($('studio-result'), 'O JSON anexado não existe mais; anexe de novo.', 'err') }
		}
	}

	// ----- Formulário de fluxo (novo / editar) -----
	function openFlowForm(flow) {
		if (!$('t-conn').value) { setResult($('flows-result'), 'Crie uma conexão primeiro, na aba Conexões.', 'err'); return }
		editingFlow = flow || null
		$('flow-form-title').textContent = flow ? 'Editar fluxo' : 'Novo fluxo'
		$('t-name').value = flow ? flow.name : ''
		$('t-to').value = flow ? flow.to : ''
		$('t-task').value = flow ? flow.task : ''
		$('t-rules').value = flow ? flow.rules.join('\\n') : ''
		$('t-max').value = flow ? flow.maxTurns : 8
		$('t-wait').value = flow ? flow.replyTimeoutSec : 60
		$('t-quiet').value = flow ? flow.quietSec : 6
		setResult($('t-result'), '')
		fillReference(flow || null)
		$('flow-form').hidden = false
		$('flow-form').scrollIntoView({ behavior: 'smooth', block: 'start' })
		$('t-name').focus()
	}
	function closeFlowForm() { $('flow-form').hidden = true; editingFlow = null }
	$('flow-new').addEventListener('click', () => openFlowForm(null))
	$('t-cancel').addEventListener('click', closeFlowForm)

	async function saveFlow() {
		const body = {
			connectionId: $('t-conn').value,
			name: $('t-name').value,
			to: $('t-to').value,
			task: $('t-task').value,
			rules: $('t-rules').value.split('\\n'),
			maxTurns: $('t-max').value, replyTimeoutSec: $('t-wait').value, quietSec: $('t-quiet').value,
			card: cardPayload(),
			studio: studioPayload(),
		}
		const flow = editingFlow
			? await send('PUT', '/api/flows/' + editingFlow.id, body)
			: await send('POST', '/api/flows', body)
		selectedFlow = flow.id
		flowsKey = ''
		return flow
	}

	async function runFlow(flowId, resultNode) {
		const { id } = await send('POST', '/api/flows/' + flowId + '/run')
		selectedFlow = flowId
		selectedRun = id
		setResult(resultNode, 'Teste iniciado. Acompanhe a conversa abaixo.', 'ok')
		flowsKey = ''
		await refreshTests()
		$('run-detail').scrollIntoView({ behavior: 'smooth', block: 'start' })
	}

	$('flow-form').addEventListener('submit', (ev) => {
		ev.preventDefault()
		busy($('t-save'), $('t-result'), async () => {
			await saveFlow()
			closeFlowForm()
			setResult($('flows-result'), 'Fluxo salvo.', 'ok')
			await refreshTests()
		})
	})
	$('t-save-run').addEventListener('click', () => {
		busy($('t-save-run'), $('t-result'), async () => {
			const flow = await saveFlow()
			closeFlowForm()
			await runFlow(flow.id, $('flows-result'))
		})
	})
	$('runs-all').addEventListener('click', () => { selectedFlow = null; flowsKey = ''; refreshTests() })

	// ----- Lista de fluxos -----
	function renderFlows(flows) {
		const key = JSON.stringify([selectedFlow, flows])
		if (key === flowsKey) return
		flowsKey = key
		$('flows-empty').hidden = flows.length > 0
		$('flows').replaceChildren(...flows.map((f) => {
			const last = f.lastRun
			const pick = el('button', { type: 'button', className: 'run-row' },
				last ? pillEl(RUN_STATUS[last.status] || [last.status, 'idle']) : el('span', { className: 'pill idle', textContent: 'Nunca executado' }),
				el('div', { className: 'run-main' },
					el('div', { className: 'run-task', textContent: f.name }),
					el('div', { className: 'run-meta', textContent: '→ +' + f.to + ' · ' + f.rules.length + ' regra(s) · ' + f.runs + ' execução(ões)' +
						(last ? ' · última ' + fmtDate(last.createdAt) : '') }),
				),
			)
			pick.addEventListener('click', () => { selectedFlow = selectedFlow === f.id ? null : f.id; flowsKey = ''; refreshTests() })
			const run = el('button', { type: 'button', className: 'primary', textContent: 'Executar' })
			run.addEventListener('click', () => busy(run, $('flows-result'), () => runFlow(f.id, $('flows-result'))))
			const edit = el('button', { type: 'button', textContent: 'Editar' })
			edit.addEventListener('click', () => openFlowForm(f))
			const del = el('button', { type: 'button', className: 'link danger', textContent: 'Excluir' })
			del.addEventListener('click', () => {
				if (!confirm('Excluir o fluxo "' + f.name + '" e todas as ' + f.runs + ' execução(ões) dele?')) return
				busy(del, $('flows-result'), async () => {
					await send('DELETE', '/api/flows/' + f.id)
					if (selectedFlow === f.id) selectedFlow = null
					flowsKey = ''
					await refreshTests()
				})
			})
			const li = el('li', { className: 'flow-row' }, pick, run, edit, del)
			if (f.id === selectedFlow) li.setAttribute('aria-current', 'true')
			return li
		}))
	}

	async function refreshTests() {
		if ($('tab-tests').hidden) return
		fillConnectionSelect(lastConnections)
		const conn = $('t-conn').value
		if (!conn) { renderFlows([]); $('runs').replaceChildren(); $('runs-empty').hidden = false; return }
		let flows, data
		try {
			[flows, data] = await Promise.all([
				api('/api/flows?connectionId=' + conn),
				api('/api/tests?connectionId=' + conn + (selectedFlow ? '&flowId=' + selectedFlow : '')),
			])
		} catch { return }
		if (selectedFlow && !flows.flows.some((f) => f.id === selectedFlow)) selectedFlow = null
		renderFlows(flows.flows)

		const flowName = selectedFlow ? (flows.flows.find((f) => f.id === selectedFlow) || {}).name : null
		$('runs-title').textContent = flowName ? 'Execuções de "' + flowName + '"' : 'Execuções'
		$('runs-all').hidden = !selectedFlow
		const ul = $('runs')
		$('runs-empty').hidden = data.runs.length > 0
		ul.replaceChildren(...data.runs.map((r) => {
			const b = el('button', { type: 'button', className: 'run-row' },
				pillEl(RUN_STATUS[r.status] || [r.status, 'idle']),
				el('div', { className: 'run-main' },
					el('div', { className: 'run-task', textContent: r.input.name || r.input.task }),
					el('div', { className: 'run-meta', textContent:
						r.connectionName + ' → +' + r.input.to + ' · ' + fmtDate(r.createdAt) + ' · ' + r.turns + ' msg' +
						(r.costUsd ? ' · US$ ' + r.costUsd.toFixed(3) : '') }),
				),
			)
			if (r.id === selectedRun) b.setAttribute('aria-current', 'true')
			b.addEventListener('click', () => { selectedRun = r.id; refreshTests() })
			return el('li', {}, b)
		}))
		await renderRunDetail()
	}

	let detailKey = ''
	async function renderRunDetail() {
		const box = $('run-detail')
		if (!selectedRun) { box.hidden = true; return }
		let run
		try { run = await api('/api/tests/' + selectedRun) } catch { box.hidden = true; selectedRun = null; return }
		const key = run.status + '|' + run.transcript.length + '|' + (run.analysis ? run.analysis.steps.length : 0)
		if (key === detailKey && !box.hidden) return
		detailKey = key
		box.hidden = false

		const actions = el('div', { className: 'actions' })
		if (run.status === 'running') {
			const cancel = el('button', { type: 'button', className: 'danger', textContent: 'Cancelar teste' })
			cancel.addEventListener('click', () => busy(cancel, $('t-result'), async () => { await send('POST', '/api/tests/' + run.id + '/cancel'); await refreshTests() }))
			actions.append(cancel)
		}
		// Log completo (conversa, análises, veredito, referência) em Markdown.
		actions.append(el('a', { href: '/api/tests/' + run.id + '/log', className: 'button-link', textContent: 'Baixar log', download: '' }))
		if (run.status !== 'running') {
			const del = el('button', { type: 'button', className: 'link danger', textContent: 'Apagar execução' })
			del.addEventListener('click', () => {
				if (!confirm('Apagar esta execução e a transcrição?')) return
				busy(del, $('t-result'), async () => { await send('DELETE', '/api/tests/' + run.id); selectedRun = null; await refreshTests() })
			})
			actions.append(del)
		}

		const head = el('header', { className: 'conn-head' },
			el('div', { className: 'conn-title' },
				el('h2', { textContent: (run.input.name ? run.input.name + ' · ' : '') + run.connectionName + ' → +' + run.input.to }),
				el('div', { className: 'conn-meta', textContent: fmtDate(run.createdAt) + ' · ' + run.turns + ' de ' + run.input.maxTurns + ' mensagens' +
					(run.costUsd ? ' · custo IA US$ ' + run.costUsd.toFixed(3) : '') }),
			),
			pillEl(RUN_STATUS[run.status] || [run.status, 'idle']),
			actions,
		)

		const refSum = run.analysis && run.analysis.reference
		const task = el('div', { className: 'pad' },
			...(refSum ? [el('p', { className: 'refinfo' },
				'Referência: ',
				refSum.card ? 'card “' + refSum.card.title + '”' + (refSum.card.ref ? ' (' + refSum.card.ref + ')' : '') : 'sem card',
				' · ',
				refSum.studio ? refSum.studio.flows.length + ' fluxo(s) Studio: ' + refSum.studio.flows.join(', ') : 'sem fluxo',
				run.analysis.studio ? ' · execução acompanhada na conta ' + run.analysis.studio.env + ' (' + run.analysis.studio.steps.length + ' passos, ' + run.analysis.studio.executions.length + ' execução(ões))' : '',
				' · ',
				el('a', { href: '/api/tests/' + run.id + '/reference', target: '_blank', rel: 'noopener', textContent: 'ver o que a IA recebeu' }),
				run.logFile ? ' · log salvo em ' + run.logFile : '',
			)] : []),
			el('div', { className: 'lbl', textContent: 'Tarefa' }), el('p', { style: 'margin:0 0 8px', textContent: run.input.task || '(montada pela IA a partir da demanda)' }),
			...(run.input.rules.length ? [el('div', { className: 'lbl', textContent: 'Regras' }),
				el('ol', { className: 'steps', style: 'margin:0' }, ...run.input.rules.map((r) => el('li', { textContent: r })))] : []),
		)

		const chat = el('div', { className: 'chat', ariaLive: 'polite' })
		for (const e of run.transcript) {
			const extra = e.from === 'analysis' ? ' ' + e.text.split(' ')[0] : ''
			chat.append(el('div', { className: 'bubble ' + e.from + extra }, e.from === 'analysis' ? 'Análise: ' + e.text : e.text,
				e.from === 'system' || e.from === 'analysis' || e.from === 'studio' ? '' : el('span', { className: 't', textContent: new Date(e.at).toLocaleTimeString('pt-BR') })))
		}
		if (run.status === 'running') chat.append(el('div', { className: 'bubble system', textContent: 'IA pensando ou aguardando resposta…' }))
		if (!run.transcript.length && run.status !== 'running') chat.append(el('div', { className: 'bubble system', textContent: 'Sem mensagens.' }))

		const result = el('div', { className: 'pad' })
		if (run.error) result.append(el('p', { className: 'result err', textContent: 'Erro: ' + run.error }))
		if (run.summary) {
			result.append(el('div', { className: 'verdict' }, el('strong', { textContent: 'Veredito' }), pillEl(RUN_STATUS[run.status] || [run.status, 'idle'])),
				el('p', { style: 'margin:0 0 12px', textContent: run.summary }))
		}
		if (run.rules && run.rules.length) {
			result.append(el('table', { className: 'rules' },
				el('thead', {}, el('tr', {}, el('th', { textContent: 'Regra' }), el('th', { textContent: 'Resultado' }), el('th', { textContent: 'Evidência' }))),
				el('tbody', {}, ...run.rules.map((r) => el('tr', {},
					el('td', { textContent: r.rule }),
					el('td', { className: 'st' }, pillEl(RULE_STATUS[r.status] || [r.status, 'idle'])),
					el('td', { className: 'muted', textContent: r.evidence }),
				))),
			))
		}

		const an = run.analysis
		if (an && an.deviations) {
			result.append(el('div', { className: 'lbl', style: 'margin-top:12px', textContent: 'Divergências em relação ao fluxo' }))
			result.append(an.deviations.length
				? el('table', { className: 'rules' },
					el('thead', {}, el('tr', {}, ...['Turno', 'Widget', 'Esperado', 'Recebido', 'Severidade'].map((h) => el('th', { textContent: h })))),
					el('tbody', {}, ...an.deviations.map((d) => el('tr', {},
						el('td', { textContent: String(d.turn) }),
						el('td', { textContent: d.flowState }),
						el('td', { className: 'muted', textContent: d.expected }),
						el('td', { textContent: d.actual }),
						el('td', { className: 'st' }, pillEl(d.severity === 'alta' ? ['Alta', 'err'] : d.severity === 'media' ? ['Média', 'warn'] : ['Baixa', 'idle'])),
					))))
				: el('p', { className: 'muted', style: 'margin:0', textContent: 'Nenhuma divergência: o atendimento seguiu o fluxo no caminho testado.' }))
		}
		if (an && an.requirements && an.requirements.length) {
			result.append(el('div', { className: 'lbl', style: 'margin-top:12px', textContent: 'Requisitos da demanda' }),
				el('table', { className: 'rules' },
					el('thead', {}, el('tr', {}, el('th', { textContent: 'Requisito' }), el('th', { textContent: 'Resultado' }), el('th', { textContent: 'Evidência' }))),
					el('tbody', {}, ...an.requirements.map((q) => el('tr', {},
						el('td', { textContent: q.requirement }),
						el('td', { className: 'st' }, pillEl(RULE_STATUS[q.status] || [q.status, 'idle'])),
						el('td', { className: 'muted', textContent: q.evidence }),
					)))))
		}

		box.replaceChildren(head, task, chat, ...(result.childNodes.length ? [result] : []))
		chat.scrollTop = chat.scrollHeight
	}

	// ---------- Tempo real: push (SSE), sem polling ----------
	// Conexões chegam prontas pelo SSE: "snapshot" ao abrir e "connection" a
	// cada mudança — a página não consulta a API para se atualizar. Para
	// testes, o SSE só avisa; a lista é buscada se a aba estiver visível (senão,
	// quando ela voltar a aparecer). Se o app cair, o navegador reconecta sozinho
	// e o snapshot novo repõe tudo.
	let testsDirty = false
	function testsChanged() {
		if (document.hidden || $('tab-tests').hidden) { testsDirty = true; return }
		testsDirty = false
		refreshTests()
	}
	document.addEventListener('visibilitychange', () => { if (!document.hidden && testsDirty) testsChanged() })
	const read = (ev) => { try { return JSON.parse(ev.data) } catch { return null } }
	const stream = new EventSource('/api/stream')
	stream.addEventListener('snapshot', (ev) => {
		const data = read(ev)
		if (!data) return
		setResult($('global-error'), '')
		applyConnections(data.connections)
		testsChanged()
	})
	stream.addEventListener('connection', (ev) => { const c = read(ev); if (c) upsertConnection(c) })
	stream.addEventListener('connection-removed', (ev) => { const d = read(ev); if (d) removeConnectionView(d.id) })
	stream.addEventListener('change', (ev) => { const topics = read(ev) || []; if (topics.includes('tests')) testsChanged() })
	stream.addEventListener('error', () => setResult($('global-error'), 'Sem contato com o app (reiniciando?) — reconectando sozinho…', 'err'))

	try { if (localStorage.getItem('tab') === 'tests') showTab('tests') } catch {}
</script>
</body>
</html>
`
