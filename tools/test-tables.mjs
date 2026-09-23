#!/usr/bin/env node
/*
 * Tables and forms (docs/DESIGN_RULES.md UI-12, MP-23): the kit's Table and NumberField, and the three places that
 * use them -- the admin panel's Players and Progress sections, the Records window, the match scoreboard.
 *
 *   npm run test:tables
 *   PZ_SRC=<another checkout>/src node tools/test-tables.mjs    (measures that version)
 *
 * Runs the REAL table.ts / numberField.ts / records.ts / scoreboard.ts / hud.ts / the admin sections / widgets.ts /
 * window.ts / plate.ts / skin.ts / theme.ts under Node, over the counted fake Instance tree of tools/ui-shim.mjs, with
 * the layout pass of tools/ui-layout.mjs, and checks:
 *
 *  1. THE TABLE        rows are a pool: after warm-up, updating, sorting, filtering and selecting create no Instance;
 *                      a header click sorts (the sorted header turns blue) and flips; ties keep a stable order;
 *                      the selection is the blue ring and follows the item; a filtered-out selection is dropped;
 *                      the empty state says why; numbers are right-aligned in the numeric font; sticky / inline /
 *                      no header.
 *  2. THE FORMS        checkNumber's rule; the Stats form is the kit's form rows (window.ts SettingRow with a
 *                      description, Settings' own) and every admin on / off the kit's Switch; a wrong number turns the
 *                      field's edge red, says what is wrong on its row and sends NOTHING; a right one sends exactly the
 *                      op; every destructive admin action asks first (reset, clear, refund, kick, kill all, clear
 *                      bodies) and Cancel sends nothing.
 *  3. PLAYERS (ADMIN)  a Data table of the server's rows: status from the live fields (Alive / AFK / Dead / Lobby /
 *                      Loading), the name filter, header sorting, select-then-act (kick and ban off for admins), no
 *                      churn on the 2 s poll.
 *  4. RECORDS          only what the game keeps (no bosses, CON-03), the server-owned kills and titles, the numbers
 *                      right-aligned; the lobby's Records plate opens this window.
 *  5. SCOREBOARD       opens with Q held / the pad's Back / the chip, and never holds the survivor (UI-06); the
 *                      replicated values (roster + PlayerTally) are what it shows, sorted by life day, re-sorted by
 *                      the sort bar and the headers; opening, closing and 600 live frames create no Instance;
 *                      nothing in it is selectable (the pad stays the survivor's, UI-09).
 *  6. LAYOUT           at 1120 x 630, 1360 x 435, the owner's 1365 x 567 (58 px bar) and a 844 x 390 phone under a
 *                      36 px bar: header cells over their columns, no text below 9 px or cut, the panels on screen
 *                      and clear of the survivor, the day clock (the console's sky; on touch its plate) and the
 *                      thumbs, the chip where Bag and Menu are (the console's row; the touch corner's row), and every
 *                      touch target at least 44 px.
 *
 * Pure Node (>= 18) plus the project's TypeScript.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";
import { layoutGame, paintList, rectOf, shown, textPx, textWidth } from "./ui-layout.mjs";

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, require, flush, service, measure, setViewport, setClock } = ui;

const boot = require(join(SRC, "client/bootstrap.ts"));
const T = require(join(SRC, "client/ui/table.ts"));
const NF = require(join(SRC, "client/ui/numberField.ts"));
const REC = require(join(SRC, "client/ui/records.ts"));
const SB = require(join(SRC, "client/ui/scoreboard.ts"));
const { Hud } = require(join(SRC, "client/ui/hud.ts"));
const W = require(join(SRC, "client/ui/widgets.ts"));
const { THEME, SURFACE, STAT, TEXT } = require(join(SRC, "client/ui/theme.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const TIT = require(join(SRC, "shared/data/titles.ts"));
const { LifeState } = require(join(SRC, "shared/net/protocol.ts"));
const { MAX_PLAYERS } = require(join(SRC, "shared/net/mpConfig.ts"));
const { MIN_TOUCH_PX, computeTouchLayout } = require(join(SRC, "shared/engine/input.ts"));
const OPS = require(join(SRC, "shared/admin/ops.ts"));
const AP = require(join(SRC, "shared/admin/protocol.ts"));
const PLAYERS = require(join(SRC, "client/admin/sectionPlayers.ts"));
const { buildProgress } = require(join(SRC, "client/admin/sectionProgress.ts"));
const { CONTENT_W, CONTENT_H } = require(join(SRC, "client/admin/panelTypes.ts"));
const Kit = require(join(SRC, "client/ui/window.ts"));
const WORLD = require(join(SRC, "client/admin/sectionWorld.ts"));
flush();

// ---------------------------------------------------------------- checks

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) console.log(`  ok    ${name}${tail}`);
	else {
		console.error(`  FALHA ${name}${tail}`);
		failures++;
	}
}
const table = [];
function phase(label, fn) {
	const r = measure(fn);
	table.push({ label, ...r });
	return r;
}
const zero = r => r.created === 0 && r.destroyed === 0;
const cost = r => `${r.created} criadas, ${r.destroyed} destruidas, ${r.writes} escritas`;
const sameColor = (a, b) => a !== undefined && b !== undefined && a.R === b.R && a.G === b.G && a.B === b.B;
const deepAll = (root, name) => (root === undefined ? [] : root.GetDescendants().filter(d => d.Name === name));
const deep = (root, name) => deepAll(root, name)[0];
/** the ring a row wears (plate.ts "outline": the band is the ring's colour) */
const ringOf = host => host?.FindFirstChild("PlateBand")?.BackgroundColor3;
const faceOf = host => host?.FindFirstChild("PlateFace")?.BackgroundColor3;
const visibleRows = t => {
	const out = [];
	for (let i = 0; i < t.poolSize(); i++) {
		const b = t.rowButton(i);
		if (b.Visible) out.push(b);
	}
	return out;
};
const cellText = (row, key) => row.FindFirstChild(`C${key}`)?.Text;
const subText = (row, key) => row.FindFirstChild(`S${key}`)?.Text;

const ctx = boot.getCtx();
const uis = service("UserInputService");
const GuiService = service("GuiService");

/** a fresh frame to build in, in the 1120 x 630 design space, under the game's UI layer */
function stage(name) {
	const f = new Instance("Frame");
	f.Name = name;
	f.Size = UDim2.fromScale(1, 1);
	f.BackgroundTransparency = 1;
	W.setDesign(f, 1120, 630);
	f.Parent = ctx.uiLayer;
	return f;
}

// ================================================================ 1. the Table

console.log("1) a Table: pool de linhas, ordenacao, selecao, estado vazio\n");

const COLS = [
	{ key: "name", header: "Name", flex: 1, sortable: true },
	{ key: "level", header: "Lv", width: 40, numeric: true, sortable: true, descendingFirst: true },
	{ key: "day", header: "Day", width: 50, numeric: true, sortable: true, descendingFirst: true },
	{ key: "kills", header: "Kills", width: 70, numeric: true, sortable: true, descendingFirst: true },
];
const people = [];
for (let i = 0; i < 30; i++) {
	people.push({
		id: `p${String(i).padStart(2, "0")}`,
		name: `Survivor ${i}`,
		level: (i * 7) % 11,
		day: 1 + (i % 5),
		kills: i * 3,
	});
}
let selectedEvents = [];
const tStage = stage("TableStage");
const tbl = T.Table(tStage, "Grid", {
	x: 40,
	y: 40,
	w: 600,
	h: 400,
	columns: COLS,
	keyOf: p => p.id,
	cell: (p, col, out) => {
		out.text = col === "name" ? p.name : String(p[col]);
		if (col === "kills" && p.kills > 60) out.color = STAT.value;
	},
	sortValue: (p, col) => p[col],
	sort: { column: "name", descending: false },
	selectable: true,
	onSelect: key => selectedEvents.push(key),
	empty: "No survivor matches the filter.",
});
const warm = phase("tabela: aquece com 30 linhas", () => tbl.setItems(people));
check(
	"aquecer cria as linhas uma vez (o pool)",
	warm.created > 0 && tbl.poolSize() === 30,
	`${tbl.poolSize()} linhas, ${cost(warm)}`,
);
check(
	"ordem por nome, A-Z (desempate estavel pela chave)",
	tbl.order()[0] === "p00" && tbl.order()[1] === "p01" && tbl.order()[2] === "p10",
	tbl.order().slice(0, 4).join(","),
);

// 300 live updates: values move, the sort cycles, the filter narrows and widens, the selection moves
const churn = phase("tabela: 300 atualizacoes (valores, ordem, filtro, selecao)", () => {
	for (let f = 0; f < 300; f++) {
		for (const p of people) p.kills += p.id.charCodeAt(2) % 3;
		if (f % 50 === 0)
			tbl.setSort({ column: ["kills", "level", "day", "name"][(f / 50) % 4], descending: f % 100 === 0 });
		const filtered = f % 7 === 0 ? people.filter(p => p.level > 4) : people;
		tbl.setItems(filtered);
		if (f % 13 === 0) tbl.select(filtered[f % filtered.length].id);
	}
	tbl.setItems(people);
});
check("atualizar, ordenar, filtrar e selecionar nao cria nem destroi Instance", zero(churn), cost(churn));
const still = phase("tabela: um refresh sem mudanca", () => tbl.refresh());
check("um refresh sem mudanca nao escreve nada", zero(still) && still.writes === 0, cost(still));

// header click: sorts by that column, biggest first for numbers, and a second click flips it
tbl.setSort({ column: "name", descending: false });
const lvHead = tbl.headerCell("level");
lvHead.Activated.Fire();
flush();
check(
	"clique no cabecalho Lv ordena por nivel, maior primeiro",
	tbl.sort().column === "level" && tbl.sort().descending,
);
const levels = tbl.order().map(k => people.find(p => p.id === k).level);
check(
	"...e a ordem e mesmo decrescente",
	levels.every((v, i) => i === 0 || levels[i - 1] >= v),
	levels.slice(0, 6).join(","),
);
check("o cabecalho ordenado e a chapa AZUL (o escolhido e azul, UI-07)", sameColor(faceOf(lvHead), THEME.tabActive));
check(
	"os outros cabecalhos ficam em ferro escuro (celula de rotulo)",
	sameColor(faceOf(tbl.headerCell("day")), SURFACE.cellLabel),
);
check(
	"a seta aponta a direcao (para baixo = maior primeiro)",
	deep(lvHead, "Down").Visible && !deep(lvHead, "Up").Visible,
);
lvHead.Activated.Fire();
flush();
check("segundo clique inverte", tbl.sort().column === "level" && !tbl.sort().descending && deep(lvHead, "Up").Visible);
// equal values keep one order, frame after frame
const orderA = tbl.order().join(",");
tbl.refresh();
check("valores iguais mantem a mesma ordem entre quadros (desempate pela chave)", tbl.order().join(",") === orderA);

// selection: the blue ring, following the item; a filtered-out selection is dropped
tbl.setSort({ column: "name", descending: false });
tbl.select("p05");
const selRow = visibleRows(tbl).find(b => cellText(b, "name") === "Survivor 5");
check("a linha selecionada usa o anel AZUL", sameColor(ringOf(selRow), THEME.tabActive));
const other = visibleRows(tbl).find(b => cellText(b, "name") === "Survivor 6");
check("as outras, o fio de ferro (SURFACE.line)", sameColor(ringOf(other), SURFACE.line));
tbl.setSort({ column: "kills", descending: true });
const moved = visibleRows(tbl).find(b => cellText(b, "name") === "Survivor 5");
check("reordenar: o anel segue o ITEM, nao a linha", sameColor(ringOf(moved), THEME.tabActive));
selectedEvents = [];
tbl.setItems(people.filter(p => p.id !== "p05"));
check(
	"o item selecionado sumiu do filtro: a selecao cai (nenhuma acao mira linha escondida)",
	tbl.selected() === undefined && selectedEvents[0] === undefined && selectedEvents.length === 1,
);
tbl.setItems(people);
visibleRows(tbl)[3].Activated.Fire();
check("clicar numa linha a seleciona", tbl.selected() === tbl.order()[3]);

// empty state
tbl.setItems([]);
const empty = deep(tbl.frame, "Empty");
check("vazia: diz por que", empty.Visible && empty.Text === "No survivor matches the filter.", empty.Text);
check("vazia: nenhuma linha a mostra", visibleRows(tbl).length === 0);
tbl.setItems(people);
check("com linhas, o aviso some", !empty.Visible);

// numbers: numeric role, right-aligned; text left
const r0 = tbl.rowButton(0);
const lvCell = r0.FindFirstChild("Clevel");
check(
	"numero: fonte numerica (mono) e alinhado a direita",
	String(lvCell.FontFace.Family).toLowerCase().includes("mono") && lvCell.TextXAlignment.Name === "Right",
);
check("texto: alinhado a esquerda", r0.FindFirstChild("Cname").TextXAlignment.Name === "Left");
check(
	"cor pedida pela celula (amarelo dos numeros) chega ao texto",
	visibleRows(tbl).some(b => sameColor(b.FindFirstChild("Ckills").TextColor3, STAT.value)),
);

// header modes
const sticky = tbl.headerCell("name");
check("cabecalho fixo: fora da rolagem (fica no lugar ao rolar)", sticky.Parent === tbl.frame);
const inlineT = T.Table(tStage, "Inline", {
	x: 700,
	y: 40,
	w: 380,
	h: 200,
	columns: COLS,
	header: "inline",
	keyOf: p => p.id,
	cell: (p, c, o) => {
		o.text = String(p[c]);
	},
});
check(
	"cabecalho em linha: dentro da rolagem, antes das linhas",
	inlineT.headerCell("name").Parent.Parent === inlineT.list.frame &&
		inlineT.headerCell("name").Parent.LayoutOrder === -1,
);
const noHead = T.Table(tStage, "NoHead", {
	x: 700,
	y: 260,
	w: 380,
	h: 200,
	columns: COLS,
	header: "none",
	keyOf: p => p.id,
	cell: (p, c, o) => {
		o.text = String(p[c]);
	},
});
check("sem cabecalho: nenhuma celula de cabecalho", noHead.headerCell("name") === undefined);
check(
	"UI-04: nenhum texto da tabela tem contorno",
	tStage
		.GetDescendants()
		.filter(d => d.ClassName === "TextLabel")
		.every(l => (l.TextStrokeTransparency ?? 1) >= 1 && l.FindFirstChildOfClass("UIStroke") === undefined),
);
check(
	"fitText corta num limite de caractere e marca com reticencias",
	T.fitText("Fabricio Damiao da Silva", 10) === "Fabricio…" && T.fitText("Ana", 10) === "Ana",
);
const spans = T.columnLayout(COLS, 500);
check(
	"colunas: as fixas com a largura pedida, a flexivel com o resto",
	spans[1][1] === 40 &&
		Math.abs(spans[0][1] - (500 - 160)) < 1e-9 &&
		Math.abs(spans[3][0] + spans[3][1] - 500) < 1e-9,
);
tStage.Destroy();

// ================================================================ 2. the forms

console.log("\n2) formularios: erro na linha, nada enviado, e confirmacao do que destroi\n");

const C = NF.checkNumber;
check('"" -> Enter a number', C("", 1, 200).error === "Enter a number");
check('"abc" -> Whole numbers only', C("abc", 1, 200).error === "Whole numbers only");
check('"1.5" -> Whole numbers only', C("1.5", 1, 200).error === "Whole numbers only");
check('"0" com minimo 1 -> At least 1', C("0", 1, 200).error === "At least 1");
check('"250" com maximo 200 -> At most 200', C("250", 1, 200).error === "At most 200");
check('"12000000" -> At most 9,999,999 (milhares separados)', C("12000000", 0, 9999999).error === "At most 9,999,999");
check('" 7 " -> 7', C(" 7 ", 1, 200).value === 7);

// the admin panel's context, with a server that records what it is asked
const requests = [];
const notes = [];
let serverSave = defaultSave();
serverSave.level = 7;
serverSave.money = 1234;
function makeRow(over) {
	return {
		userId: 1,
		name: "Tester",
		displayName: "Tester",
		isAdmin: true,
		accountAge: 400,
		loaded: true,
		status: "ok",
		persist: true,
		readOnly: false,
		dirty: false,
		day: 3,
		bestDay: 12,
		level: 7,
		exp: 10,
		skillPoint: 2,
		money: 1234,
		bossKills: 0,
		deathCount: 1,
		runOver: false,
		lastReportAgo: 4,
		sessionAge: 300,
		patchPending: false,
		inWorld: true,
		dead: false,
		hp: 90,
		hpMax: 100,
		idleS: 2,
		pingMs: 60,
		...over,
	};
}
const adminLayer = stage("AdminLayer");
const P = {
	ctx,
	world: {},
	placement: {},
	layer: adminLayer,
	selfUserId: 1,
	target: 1,
	players: [],
	request(req) {
		requests.push(req);
		if (req.kind === "save") return { ok: true, data: { row: makeRow({}), save: serverSave } };
		if (req.kind === "edit") {
			OPS.applyAdminOps(serverSave, req.ops);
			return { ok: true, data: serverSave };
		}
		return { ok: true };
	},
	notify(text, kind) {
		notes.push([text, kind]);
	},
	goTo() {},
	refreshPlayers() {},
	setStatsCard() {},
	statsCard: () => false,
};
// the admin sections run their requests in task.spawn; the shim does not run coroutines, so here they run at once
const realSpawn = globalThis.task.spawn;
globalThis.task.spawn = (fn, ...a) => fn(...a);
const content = new Instance("Frame");
content.Name = "Content";
W.setDesign(content, CONTENT_W, CONTENT_H);
content.Parent = adminLayer;

buildProgress(P, content);
const field = name => deep(content, `${name}Row`)?.FindFirstChild("Value")?.FindFirstChild("Field");
/** a form row's description line: where its field says what is wrong */
const rowLine = name => deep(content, `${name}Row`)?.FindFirstChild("Description");
const press = (root, name) => {
	const b = deep(root, name);
	b.Activated.Fire();
	flush();
	return b;
};
check(
	"Progress > Stats: um campo numerico por valor, com o valor atual",
	field("level")?.FindFirstChild("Box")?.Text === "7" && field("money")?.FindFirstChild("Box")?.Text === "1234",
);
check("a linha diz o limite do SERVIDOR (statRange)", rowLine("level").Text.includes(`1–${OPS.statRange("level")[1]}`));
{
	const statsList = deep(content, "Stats");
	const rowsOf = ["level", "exp", "skillPoint", "money", "day"].map(n => deep(content, `${n}Row`));
	check(
		"as linhas sao as do kit (SettingsList + SettingRow com descricao, as de Settings): 46 de altura, duas celulas",
		statsList !== undefined &&
			rowsOf.every(
				r =>
					r?.GetAttribute("DesignH") === Kit.SETTING_DESC_ROW_H &&
					r.FindFirstChild("Label") !== undefined &&
					r.FindFirstChild("Description") !== undefined &&
					r.Parent?.Name === "List",
			),
	);
	const f = field("level");
	check(
		"o campo fica em SETTING_CONTROL_X da celula de valor",
		f !== undefined &&
			Math.abs(f.Position.X.Scale * f.Parent.GetAttribute("DesignW") - Kit.SETTING_CONTROL_X) < 1e-6,
	);
	check(
		"a descricao e a legenda do kit (cell-muted-foreground)",
		sameColor(rowLine("level").TextColor3, SURFACE.cellCaption),
	);
}
const sent = () => requests.filter(r => r.kind === "edit").length;
const levelMax = OPS.statRange("level")[1];
field("level").FindFirstChild("Box").Text = String(levelMax + 1);
field("money").FindFirstChild("Box").Text = "";
let before = sent();
press(content, "Apply");
check("nivel fora do limite: nada e enviado", sent() === before, `${sent() - before} edicoes`);
check(
	"...e o erro aparece na linha do campo, no lugar da descricao, na voz clara (vermelho nao le na celula)",
	rowLine("level").Text === `At most ${W.fmtInt(levelMax)}` &&
		sameColor(rowLine("level").TextColor3, THEME.foreground),
	rowLine("level").Text,
);
check(
	"...a borda do campo fica vermelha",
	sameColor(
		field("level").FindFirstChild("Skin2")?.ImageColor3 ?? field("level").FindFirstChildOfClass("UIStroke")?.Color,
		THEME.destructive,
	),
);
check("...cada campo errado diz o seu (moedas vazias)", rowLine("money").Text === "Enter a number");
check("...e o erro nao vira toast (so o que aconteceu vira toast)", !notes.some(([, k]) => k === "error"));
field("level").FindFirstChild("Box").Text = "12";
check(
	"corrigir o numero tira o erro na hora (a descricao volta)",
	rowLine("level").Text.startsWith("now ") && sameColor(rowLine("level").TextColor3, SURFACE.cellCaption),
);
field("money").FindFirstChild("Box").Text = "5000";
before = sent();
press(content, "Apply");
const lastEdit = requests.filter(r => r.kind === "edit").at(-1);
check(
	"valores certos: UM edit com exatamente as operacoes mudadas",
	sent() === before + 1 &&
		lastEdit.ops.length === 2 &&
		lastEdit.ops.some(o => o.field === "level" && o.value === 12) &&
		lastEdit.ops.some(o => o.field === "money" && o.value === 5000),
	JSON.stringify(lastEdit?.ops),
);
check(
	"o servidor continua a autoridade: readAdminOps ainda corta o que chegar fora do limite",
	OPS.readAdminOps([{ op: "stat", field: "level", value: 99999 }], 10)[0].value === OPS.statRange("level")[1],
);

// destructive: refund asks first; Cancel sends nothing, the red button sends it
const dialogs = () => adminLayer.GetDescendants().filter(d => d.Name === "ConfirmDialog");
before = requests.length;
press(content, "Refund");
check("Refund: abre a confirmacao e nao envia nada ainda", dialogs().length === 1 && requests.length === before);
check("...o botao que faz e a chapa vermelha", deep(dialogs()[0], "Confirm").GetAttribute("Variant") === "destructive");
press(dialogs()[0], "Cancel");
check("Cancel: fecha e nao envia nada", dialogs().length === 0 && requests.length === before);
press(content, "Refund");
press(dialogs()[0], "Confirm");
check("confirmar envia o resetSkills", requests.at(-1).kind === "edit" && requests.at(-1).ops[0].op === "resetSkills");

// Items: a count past the server's ceiling says so in the row and sends nothing
deep(content, "Tabs").FindFirstChild("Tab1").Activated.Fire();
flush();
const itemRow = deep(content, "Item0");
const countBox = itemRow.FindFirstChild("Count").FindFirstChild("Box");
countBox.Text = String(OPS.itemMax("weapon") + 1);
before = requests.length;
press(itemRow, "Set");
check("Items: contagem acima do teto nao e enviada", requests.length === before);
check(
	"...e a linha diz o que esta errado, em vermelho",
	itemRow.FindFirstChild("Have").Text === `At most ${W.fmtInt(OPS.itemMax("weapon"))}` &&
		sameColor(itemRow.FindFirstChild("Have").TextColor3, THEME.destructive),
	itemRow.FindFirstChild("Have").Text,
);
countBox.Text = "3";
check("...e volta a contagem quando o numero fica certo", itemRow.FindFirstChild("Have").Text.startsWith("×"));
press(itemRow, "Set");
check("contagem certa: envia o item", requests.at(-1).kind === "edit" && requests.at(-1).ops[0].count === 3);
before = requests.length;
press(content, "ClearAll");
check("Clear: confirma antes (nada enviado)", dialogs().length === 1 && requests.length === before);
press(dialogs()[0], "Confirm");
check("...e envia depois do sim", requests.length === before + 1);
// Costumes: every on / off of the panel is the kit's Switch (a SettingCell and the Settings switch)
deep(content, "Tabs").FindFirstChild("Tab2").Activated.Fire();
flush();
{
	const owned = deep(deep(content, "Costume0"), "Owned");
	const sw = owned?.FindFirstChild("Value")?.FindFirstChild("Switch");
	check(
		"Costumes: a chave e a do kit (celula de rotulo | celula de valor com o Switch de Settings)",
		sw?.ClassName === "TextButton" &&
			sw.FindFirstChild("Inner")?.FindFirstChild("Knob") !== undefined &&
			owned.FindFirstChild("Label") !== undefined,
	);
	check("...desligada: a legenda Off", deep(sw, "Legend").Text === "Off");
	before = requests.length;
	sw.Activated.Fire();
	flush();
	check(
		"...e ligar envia o costume",
		requests.length === before + 1 &&
			requests.at(-1).ops[0].op === "costume" &&
			requests.at(-1).ops[0].owned === true,
	);
	const after = deep(deep(content, "Costume0"), "Owned")?.FindFirstChild("Value")?.FindFirstChild("Switch");
	check("...e a resposta do servidor a mostra ligada (On)", deep(after, "Legend")?.Text === "On");
}
// Reset save
deep(content, "Tabs").FindFirstChild("Tab3").Activated.Fire();
flush();
before = requests.length;
press(content, "Reset");
check("Reset save: confirma antes", dialogs().length === 1 && requests.length === before);
press(dialogs()[0], "Cancel");
check("...Cancel nao reseta nada", requests.length === before);
press(content, "Reset");
press(dialogs()[0], "Confirm");
check("...o sim envia o resetSave", requests.at(-1).kind === "resetSave");
content.ClearAllChildren();

// the world tools that destroy ask too (source guard: they run on the admin's own world, not built here)
const worldSrc = readFileSync(join(SRC, "client/admin/sectionWorld.ts"), "utf8");
const killAt = worldSrc.indexOf("p.world.killAll()");
const clearAt = worldSrc.indexOf("p.world.clearCorpses()");
check(
	"Kill all zombies e Clear bodies passam por confirmAction",
	killAt > 0 &&
		clearAt > 0 &&
		worldSrc.lastIndexOf("confirmAction(", killAt) > worldSrc.lastIndexOf('Button(body, "Kill"', killAt) &&
		worldSrc.lastIndexOf("confirmAction(", clearAt) > worldSrc.lastIndexOf('Button(body, "Clear"', clearAt),
);

// ================================================================ 3. Players (admin)

console.log("\n3) Players (admin): tabela de dados, filtro, ordem, selecionar e agir\n");

const rows = [
	makeRow({}),
	makeRow({
		userId: 20,
		name: "marta_z",
		displayName: "Marta",
		isAdmin: false,
		level: 12,
		day: 9,
		hp: 64,
		pingMs: 140,
		idleS: 4,
	}),
	makeRow({
		userId: 21,
		name: "joao",
		displayName: "Joao",
		isAdmin: false,
		level: 3,
		day: 2,
		dead: true,
		hp: 0,
		pingMs: 90,
	}),
	makeRow({
		userId: 22,
		name: "ana",
		displayName: "Ana",
		isAdmin: false,
		level: 5,
		day: 1,
		inWorld: false,
		hp: 0,
		hpMax: 0,
		idleS: -1,
	}),
	makeRow({
		userId: 23,
		name: "zed",
		displayName: "Zed",
		isAdmin: false,
		level: 8,
		day: 4,
		idleS: AP.ADMIN_AFK_S + 20,
	}),
	makeRow({
		userId: 24,
		name: "newbie",
		displayName: "newbie",
		isAdmin: false,
		loaded: false,
		inWorld: false,
		idleS: -1,
	}),
];
P.players = [];
const section = PLAYERS.buildPlayers(P, content);
const grid = deep(content, "Players");
const gridRows = () =>
	grid.GetDescendants().filter(d => d.ClassName === "TextButton" && /^Row\d+$/.test(d.Name) && d.Visible);
check(
	"antes da primeira lista: o vazio diz que esta carregando",
	deep(grid, "Empty").Visible && deep(grid, "Empty").Text.startsWith("Loading"),
);
P.players = rows;
section.onPlayers();
flush();
const statusOf = name => {
	const r = gridRows().find(b => (cellText(b, "name") ?? "").startsWith(name));
	return r === undefined ? undefined : [cellText(r, "status"), r.FindFirstChild("Cstatus").TextColor3];
};
check("6 jogadores, uma linha cada", gridRows().length === 6);
check("Marta: Alive, em verde", statusOf("Marta")?.[0] === "Alive" && sameColor(statusOf("Marta")[1], STAT.bonus));
check("Joao: Dead, em vermelho", statusOf("Joao")?.[0] === "Dead" && sameColor(statusOf("Joao")[1], THEME.destructive));
check("Ana: Lobby (fora da cidade)", statusOf("Ana")?.[0] === "Lobby");
check(
	`Zed: AFK (sem input real ha mais de ${AP.ADMIN_AFK_S} s, a regra da MP-13)`,
	statusOf("Zed")?.[0] === "AFK" && sameColor(statusOf("Zed")[1], STAT.effect),
);
check("newbie: Loading (save carregando)", statusOf("newbie")?.[0] === "Loading");
const marta = gridRows().find(b => (cellText(b, "name") ?? "").startsWith("Marta"));
check(
	"numeros da linha: nivel, dia, HP e ping",
	cellText(marta, "level") === "12" &&
		cellText(marta, "day") === "9" &&
		cellText(marta, "hp") === "64/100" &&
		cellText(marta, "ping") === "140",
);
check(
	"fora da cidade: HP e um traco, nunca um numero inventado",
	cellText(
		gridRows().find(b => (cellText(b, "name") ?? "").startsWith("Ana")),
		"hp",
	) === "–",
);
const src = readFileSync(join(SRC, "server/sim/progress.ts"), "utf8");
check("ADMIN_AFK_S e o AFK_WINDOW_S do servidor", new RegExp(`AFK_WINDOW_S = ${AP.ADMIN_AFK_S};`).test(src));

// the admin is selected first; kick / ban are off for admins
const kickBtn = deep(content, "Kick");
const banBtn = deep(content, "Ban");
check("a primeira selecao e a propria linha do admin", deep(content, "SelName").Text.startsWith("Tester"));
check(
	"admin selecionado: Kick e Ban desligados",
	kickBtn.GetAttribute("Disabled") === true && banBtn.GetAttribute("Disabled") === true,
);
marta.Activated.Fire();
flush();
check("selecionar a Marta: o anel azul vai para ela", sameColor(ringOf(marta), THEME.tabActive));
check("...Kick e Ban ligam", kickBtn.GetAttribute("Disabled") !== true && banBtn.GetAttribute("Disabled") !== true);
check(
	"...e a faixa de detalhe fala dela (o que o servidor sabe)",
	deep(content, "SelName").Text.startsWith("Marta") && deep(content, "SelSave").Text.includes("Day 9"),
);
before = requests.length;
kickBtn.Activated.Fire();
flush();
const kickDialog = deep(adminLayer, "KickDialog");
check(
	"Kick…: abre o dialogo de confirmacao (com motivo) e nao expulsa ainda",
	kickDialog !== undefined && requests.length === before,
);
press(kickDialog, "Kick");
check(
	"...o botao vermelho do dialogo envia o kick da Marta",
	requests.at(-1).kind === "kick" && requests.at(-1).userId === 20,
);

// sorting by a header
deep(grid, "Headlevel").Activated.Fire();
flush();
const lvCells = gridRows()
	.sort((a, b) => a.LayoutOrder - b.LayoutOrder)
	.map(b => cellText(b, "level"));
const lvNums = lvCells.filter(t => t !== "–").map(Number);
check(
	"clique em Lv: maior nivel primeiro, e o save carregando (–) por ultimo",
	lvNums[0] === 12 && lvNums.every((v, i) => i === 0 || lvNums[i - 1] >= v) && lvCells.at(-1) === "–",
	lvCells.join(","),
);
deep(grid, "Headstatus").Activated.Fire();
flush();
const stOrder = gridRows()
	.sort((a, b) => a.LayoutOrder - b.LayoutOrder)
	.map(b => cellText(b, "status"));
check(
	"clique em Status: quem esta na cidade primeiro",
	stOrder[0] === "Alive" && stOrder.at(-1) === "Loading",
	stOrder.join(","),
);

// the name filter
const filterBox = deep(content, "Filter").FindFirstChild("Box");
filterBox.Text = "MAR";
flush();
check(
	"filtro por nome (sem caixa): so a Marta",
	gridRows().length === 1 && deep(content, "Count").Text === "1 of 6 players",
);
filterBox.Text = "2";
check("...ou pelo UserId", gridRows().length === 5, `${gridRows().length}`);
filterBox.Text = "nobody-here";
check(
	"nenhum casa: o vazio diz o filtro e como ver todos",
	gridRows().length === 0 &&
		deep(grid, "Empty").Text.includes('"nobody-here"') &&
		deep(grid, "Empty").Text.includes("all 6"),
);
check("...e a selecao caiu (os botoes nao miram ninguem escondido)", kickBtn.GetAttribute("Disabled") === true);
filterBox.Text = "";
const poll = phase("Players: 100 atualizacoes da lista (a cada 2 s no jogo)", () => {
	for (let i = 0; i < 100; i++) {
		P.players = rows.map(r => ({ ...r, pingMs: r.pingMs + (i % 7), hp: Math.max(0, r.hp - (i % 3)) }));
		section.onPlayers();
	}
});
check("a lista atualizando nao cria nem destroi Instance", zero(poll), cost(poll));
section.destroy?.();
content.ClearAllChildren();
globalThis.task.spawn = realSpawn;

// ================================================================ 4. Records

console.log("\n4) Records: so o que o jogo guarda, numeros alinhados\n");

const rs = defaultSave();
rs.bestDay = 12;
rs.level = 7;
rs.day = 3;
rs.zombieKills = 137;
rs.lifeNights = 2;
rs.deathCount = 1;
rs.titles[TIT.TitleId.Survivor] = 1;
rs.titles[TIT.TitleId.HordeBreaker] = 1;
const recs = REC.recordRows(rs);
check(
	"as linhas sao exatamente as que o jogo guarda",
	recs.map(r => r.key).join(",") === "bestDay,level,zombieKills,titles,lifeDay,lifeNights,rebirths",
	recs.map(r => r.key).join(","),
);
check(
	"nenhuma linha de chefe (o Nucleo 1 nao tem, CON-03)",
	recs.every(r => !/boss/i.test(r.key + r.label)),
);
check(
	"zumbis postos no chao = zombieKills (o contador do servidor, MON-05)",
	recs.find(r => r.key === "zombieKills").value === "137",
);
check(
	"titulos ganhos = os que o servidor deu, de quantos existem",
	recs.find(r => r.key === "titles").value === `2 / ${TIT.TITLES.length}`,
);
check(
	"melhor dia, nivel, dia da vida, noites e rebirths do save",
	["12", "7", "3", "2", "1"].join() ===
		["bestDay", "level", "lifeDay", "lifeNights", "rebirths"].map(k => recs.find(r => r.key === k).value).join(),
);
const lang = readFileSync(join(SRC, "shared/data/lang.ts"), "utf8");
check(
	"cada rotulo passa pelo lang.ts",
	recs.every(r => lang.includes(`"${r.label}"`)) && lang.includes('"All time"') && lang.includes('"This life"'),
);
const saved = ctx.save;
ctx.save = rs;
const closeRecords = REC.showRecords(ctx);
flush();
const recRoot = deep(ctx.uiLayer, "Records");
const recTexts = recRoot
	.GetDescendants()
	.filter(d => d.ClassName === "TextLabel" && shown(d))
	.map(d => d.Text);
check(
	"a janela mostra cada rotulo e cada valor",
	recs.every(r => recTexts.includes(r.label) && recTexts.includes(r.value)),
);
check(
	"nenhum texto fala de chefe",
	recTexts.every(t => !/boss/i.test(t)),
);
const valueCells = recRoot.GetDescendants().filter(d => d.Name === "Cvalue" && shown(d));
check(
	"valores: fonte numerica, alinhados a direita (a coluna se alinha)",
	valueCells.length === recs.length &&
		valueCells.every(
			c => c.TextXAlignment.Name === "Right" && String(c.FontFace.Family).toLowerCase().includes("mono"),
		),
);
check(
	"e a janela da UI-07: titulo Records e o X vermelho",
	deep(recRoot, "Title")?.Text === "Records" && deep(recRoot, "Close")?.GetAttribute("Variant") === "destructive",
);
const lobbySrc = readFileSync(join(SRC, "client/ui/lobby.ts"), "utf8");
check(
	"a chapa Records do lobby abre esta janela (e o popup antigo saiu)",
	/showRecords\(ctx\)/.test(lobbySrc) && /from "\.\/records"/.test(lobbySrc) && !lobbySrc.includes("Personal bests"),
);

// ================================================================ 5. the scoreboard

console.log("\n5) placar da partida: segurar Q, Back, o chip; nada pausa; valores replicados\n");

const input = ctx.input;
const roster = [
	{
		slot: 0,
		userId: 1,
		displayName: "Tester",
		level: 7,
		title: TIT.titleToWire(TIT.TitleId.Survivor),
		lifeDay: 3,
		kills: 40,
		life: LifeState.Up,
		you: true,
	},
	{
		slot: 1,
		userId: 20,
		displayName: "Marta",
		level: 12,
		title: TIT.titleToWire(TIT.TitleId.HordeBreaker),
		lifeDay: 9,
		kills: 137,
		life: LifeState.Up,
		you: false,
	},
	{
		slot: 2,
		userId: 21,
		displayName: "Joao",
		level: 3,
		title: 0,
		lifeDay: 2,
		kills: 5,
		life: LifeState.Downed,
		you: false,
	},
	{
		slot: 3,
		userId: 22,
		displayName: "Ana",
		level: 5,
		title: 0,
		lifeDay: 5,
		kills: 12,
		life: LifeState.Dead,
		you: false,
	},
	{
		slot: 4,
		userId: 23,
		displayName: "NewOne",
		level: 1,
		title: 0,
		lifeDay: 0,
		kills: -1,
		life: LifeState.Up,
		you: false,
	},
];
let hosted = true;
const hud = new Hud(ctx);
hud.scoreSource = out => SB.rosterToEntries(roster, hosted, out);
ctx.phase = "playing";
setClock(5000);
const hudState = {
	hp: 88,
	hpMax: 100,
	hunger: 58,
	hungerMax: 100,
	level: 7,
	exp: 30,
	expMax: 120,
	day: 9,
	lifeDay: 3,
	dayTime: 14,
	isNight: false,
	showClock: false,
	weaponId: 0,
	weaponName: "Dagger",
	mag: 0,
	magSize: 0,
	reloading: false,
	reloadRatio: 0,
	ammoPool: 0,
	hitFlash: 0,
};
const mount = phase("HUD com o placar: monta", () => {
	hud.mount();
	hud.update(hudState);
});
const board = hud.scoreboard();
// the chip goes where Bag and Menu go (the day plate it stood beside moved into the console, UI-09): on desktop the
// third plate of the console's button row
check(
	"montar a HUD monta o placar escondido e o chip na fileira do console, depois de Bag e Menu",
	board !== undefined &&
		!board.frame.Visible &&
		board.chip.Parent.Name === "ChipSlot" &&
		board.chip.Parent.Parent === deep(board.frame.Parent, "Bag")?.Parent &&
		deep(board.frame.Parent, "DayPlate") === undefined,
	cost(mount),
);
check("o chip conta quem esta na cidade", deep(board.chip, "Count").Text === "5");
check(
	"...e a tecla do dispositivo (teclado: Q; Tab e da lista de jogadores do Roblox, UI-02)",
	deep(board.chip, "Key").Text === "Q",
);
const bootSrc = readFileSync(join(SRC, "client/bootstrap.ts"), "utf8");
check(
	"bootstrap: Q segurado e o placar; Tab continua so no Bag",
	/KeyCode\.Q\)[^]*?keyScoreboard = true/.test(bootSrc) && /KeyCode\.Q\) input\.keyScoreboard = false/.test(bootSrc),
);
check(
	"bootstrap: Back/Select do controle abre e fecha, e o Select do engine nao pega mais GUI",
	/ButtonSelect\)[^]*?scoreboardPressed = true/.test(bootSrc) && /AutoSelectGuiEnabled = false/.test(bootSrc),
);
const mainSrc = readFileSync(join(SRC, "client/main.client.ts"), "utf8");
check(
	"main.client: o Back vira toggle antes de o loop limpar o quadro",
	/if \(input\.scoreboardPressed\) hud\.toggleScoreboard\(\);/.test(mainSrc) &&
		mainSrc.indexOf("scoreboardPressed") < mainSrc.indexOf("loop.update(dt)"),
);
const menuOpenLine = (mainSrc.match(/const menuOpen = [^;]+;/) ?? [""])[0];
check(
	"UI-06: o placar nao entra no menuOpen (nao segura o sobrevivente)",
	menuOpenLine !== "" && !/board|score/i.test(menuOpenLine),
	menuOpenLine,
);

// hold Q
const openQ = phase("segurar Q abre o placar", () => {
	input.keyScoreboard = true;
	setClock(5001);
	hud.update(hudState);
});
check("segurar Q abre o placar", board.isOpen() && board.frame.Visible);
check("abrir nao cria Instance (tudo montado com a HUD)", zero(openQ), cost(openQ));
check("o sobrevivente nao e segurado: input.held continua falso", input.held === false);
check(
	"sem cortina: nenhuma tela cheia opaca, nenhum bloqueio de clique",
	board.frame.BackgroundTransparency === 1 &&
		board.frame.Active === false &&
		deep(board.frame, "InputBlocker") === undefined,
);
const rowsNow = () => visibleRows(board.table).sort((a, b) => a.LayoutOrder - b.LayoutOrder);
check(
	"ordem padrao: dia desta vida, o maior primeiro",
	rowsNow()
		.map(b => cellText(b, "name"))
		.join(",") === "Marta,Ana,Tester,Joao,NewOne",
	rowsNow()
		.map(b => cellText(b, "name"))
		.join(","),
);
const mRow = rowsNow()[0];
check(
	"valores replicados: nome, titulo (na cor dele), nivel, dia da vida, abates",
	cellText(mRow, "name") === "Marta" &&
		subText(mRow, "name") === "[Horde Breaker]" &&
		sameColor(mRow.FindFirstChild("Sname").TextColor3, STAT.effect) &&
		cellText(mRow, "level") === "12" &&
		cellText(mRow, "lifeDay") === "9" &&
		cellText(mRow, "kills") === "137",
);
const byName = n => rowsNow().find(b => cellText(b, "name") === n);
check(
	"[Survivor] em verde sob o seu nome",
	subText(byName("Tester"), "name") === "[Survivor]" &&
		sameColor(byName("Tester").FindFirstChild("Sname").TextColor3, STAT.bonus),
);
check(
	"status: Alive (verde), Down (laranja), Dead ate o amanhecer (MP-21)",
	cellText(byName("Marta"), "status") === "Alive" &&
		sameColor(byName("Marta").FindFirstChild("Cstatus").TextColor3, STAT.bonus) &&
		cellText(byName("Joao"), "status") === "Down" &&
		sameColor(byName("Joao").FindFirstChild("Cstatus").TextColor3, STAT.effect) &&
		cellText(byName("Ana"), "status") === "Dead" &&
		subText(byName("Ana"), "status") === "until dawn",
);
check(
	"o titulo da janela conta quem esta na cidade",
	deep(board.panel, "Title").Text === `Survivors · 5 / ${MAX_PLAYERS}`,
	deep(board.panel, "Title").Text,
);
check(
	"sem PlayerTally ainda: um traco, nunca 0",
	cellText(byName("NewOne"), "lifeDay") === "–" && cellText(byName("NewOne"), "kills") === "–",
);
check(
	"a sua linha usa o anel claro (marcada), as outras o fio",
	sameColor(ringOf(byName("Tester")), THEME.foreground) && sameColor(ringOf(byName("Marta")), SURFACE.line),
);
// a two-line column: with a second line the main one sits above it; without, it is centred in the row like the rest
{
	const one = byName("Joao").FindFirstChild("Cname");
	const two = byName("Marta").FindFirstChild("Cname");
	const status = byName("Marta").FindFirstChild("Cstatus");
	check(
		"sem titulo, o nome fica no meio da linha; com titulo, em cima dele (e Alive, sem 2a linha, no meio)",
		one.Position.Y.Scale === 0 &&
			one.Size.Y.Scale === 1 &&
			one.TextYAlignment === Enum.TextYAlignment.Center &&
			two.Size.Y.Scale < 1 &&
			two.TextYAlignment === Enum.TextYAlignment.Bottom &&
			status.Size.Y.Scale === 1,
		`Joao ${one.Position.Y.Scale}/${one.Size.Y.Scale}, Marta ${two.Position.Y.Scale.toFixed(2)}/${two.Size.Y.Scale.toFixed(2)}`,
	);
}
input.keyScoreboard = false;
setClock(5002);
hud.update(hudState);
check("soltar Q fecha", !board.isOpen() && !board.frame.Visible);

// the pad's Back / Select and the chip toggle
hud.toggleScoreboard();
setClock(5003);
hud.update(hudState);
check("Back/Select (toggle) abre e fica aberto sem segurar", board.isOpen());
hud.toggleScoreboard();
check("...e de novo fecha", !board.isOpen());
deep(board.chip, "Hit").Activated.Fire();
check("tocar / clicar no chip abre", board.isOpen() && sameColor(faceOf(board.chip), THEME.tabActive));
deep(board.panel, "Close").Activated.Fire();
check(
	"o X fecha, e o chip volta ao ferro de Bag e Menu (a chapa secundaria do kit)",
	!board.isOpen() && sameColor(faceOf(board.chip), THEME.secondary),
);

// sorting: the sort bar (pad / touch) and the headers (mouse), kept in agreement
uis.GetLastInputType = () => Enum.UserInputType.Gamepad1;
board.toggle();
setClock(5004);
hud.update(hudState);
check("com controle, a barra 'ordenar por' aparece", board.sortBar.bar.frame.Visible);
check(
	"o controle nunca pousa no placar (nada selecionavel, UI-09)",
	board.frame
		.GetDescendants()
		.concat(board.chip.GetDescendants())
		.filter(d => d.IsA("GuiObject") && d.Selectable === true).length === 0,
);
// the real D-pad: a menu that has the pad (processed, or a GUI selected) keeps it; otherwise it steps the sort
const dpad = (key, processed) =>
	uis.InputBegan.Fire({ KeyCode: key, UserInputType: Enum.UserInputType.Gamepad1 }, processed);
// in a run no menu is open (the stages this file built in the UI layer would wake the pad's menu navigation)
const hiddenStages = ctx.uiLayer.GetChildren().filter(c => c.Visible !== false);
for (const c of hiddenStages) c.Visible = false;
GuiService.SelectedObject = undefined;
dpad(Enum.KeyCode.DPadRight, true);
GuiService.SelectedObject = board.chip;
dpad(Enum.KeyCode.DPadRight, false);
GuiService.SelectedObject = undefined;
check("D-pad de um menu por cima (processado / GUI selecionada) nao mexe na ordem", board.sortBar.index() === 0);
dpad(Enum.KeyCode.DPadRight, false);
const afterRight = board.sortBar.index();
dpad(Enum.KeyCode.DPadLeft, false);
check(
	"D-pad direita / esquerda anda e volta na barra",
	afterRight === 1 && board.sortBar.index() === 0 && board.table.sort().column === "lifeDay",
	`direita -> ${afterRight}, esquerda -> ${board.sortBar.index()}`,
);
dpad(Enum.KeyCode.DPadRight, false);
for (const c of hiddenStages) c.Visible = true;
check(
	"D-pad -> ordena por nivel",
	board.table.sort().column === "level" &&
		rowsNow()[0].FindFirstChild("Cname").Text === "Marta" &&
		rowsNow().at(-1).FindFirstChild("Cname").Text === "NewOne",
);
deep(board.table.frame, "Headkills").Activated.Fire();
flush();
check(
	"clique no cabecalho Put down: mais abates primeiro, e a barra acompanha",
	board.table.sort().column === "kills" && cellText(rowsNow()[0], "name") === "Marta" && board.sortBar.index() === 2,
);
board.close();
uis.GetLastInputType = () => Enum.UserInputType.MouseMovement;

// no churn: opening and closing, and 600 frames of a live roster changing under an open board
const cycles = phase("placar: 50 aberturas e fechamentos", () => {
	for (let i = 0; i < 50; i++) {
		input.keyScoreboard = i % 2 === 0;
		setClock(6000 + i);
		hud.update(hudState);
	}
	input.keyScoreboard = false;
	hud.update(hudState);
});
check("abrir e fechar nao cria nem destroi Instance", zero(cycles), cost(cycles));
input.keyScoreboard = true;
const live = phase("placar aberto: 600 quadros com o roster mudando (abates, vidas, entradas e saidas)", () => {
	for (let f = 0; f < 600; f++) {
		setClock(7000 + f / 60);
		roster[1].kills += f % 2;
		roster[2].life = f % 120 < 60 ? LifeState.Downed : LifeState.Up;
		if (f === 200)
			roster.push({
				slot: 5,
				userId: 25,
				displayName: "Late",
				level: 2,
				title: 0,
				lifeDay: 1,
				kills: 0,
				life: LifeState.Up,
				you: false,
			});
		if (f === 400) roster.pop();
		hud.update(hudState);
	}
});
check("600 quadros ao vivo nao criam nem destroem Instance (pool aquecido com a cidade cheia)", zero(live), cost(live));
check(`o pool tem ${MAX_PLAYERS} linhas (MAX_PLAYERS), nem mais nem menos`, board.table.poolSize() === MAX_PLAYERS);
board.refresh();
check("o numero replicado mais recente e o mostrado", cellText(byName("Marta"), "kills") === W.fmtInt(roster[1].kills));
input.keyScoreboard = false;
hud.update(hudState);

// the roster -> rows mapping, and the offline source
const views = [roster[3]];
check("sem servidor que reviva: um morto e so Dead", SB.rosterToEntries(views, false, [])[0].status === "dead");
check("com servidor: Dead ate o amanhecer (MP-21)", SB.rosterToEntries(views, true, [])[0].status === "dawn");
check(
	"titulo: do byte do fio para o id (0 = nenhum)",
	SB.rosterToEntries([roster[0], roster[2]], true, [])
		.map(e => e.title)
		.join() === `${TIT.TitleId.Survivor},-1`,
);
const offline = SB.scoreSourceOf(ctx)([]);
check(
	"offline: so voce, do seu save",
	offline.length === 1 &&
		offline[0].you &&
		offline[0].lifeDay === ctx.save.day &&
		offline[0].kills === ctx.save.zombieKills,
);
check(
	"UI-04: nenhum texto do placar tem contorno",
	board.frame
		.GetDescendants()
		.filter(d => d.ClassName === "TextLabel")
		.every(l => (l.TextStrokeTransparency ?? 1) >= 1),
);
check(
	"cada texto do placar passa pelo lang.ts",
	[
		"Survivors",
		"Sort by",
		"Click a column to sort",
		"Lv",
		"Life day",
		"Put down",
		"Status",
		"Alive",
		"Down",
		"Dead",
		"until dawn",
		"Survivors in town",
	].every(k => lang.includes(`"${k}"`)),
);

// ================================================================ 6. layout

console.log("\n6) layout a 1120x630, 1360x435 e 844x390: cabecalhos alinhados, texto legivel, nada cobrindo nada\n");

const MIN_PX = 9;
const overlapR = (a, b) =>
	Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.75 &&
	Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.75;
const insideR = (c, p) =>
	c.x >= p.x - 0.75 && c.y >= p.y - 0.75 && c.x + c.w <= p.x + p.w + 0.75 && c.y + c.h <= p.y + p.h + 0.75;
const fmtR = r => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`;

/** the header cell of each column sits over the same column of the first row (within 1.5 px) */
function headerAligned(t, cols) {
	const row = t.rowButton(0);
	if (row === undefined || !row.Visible) return true;
	return cols.every(c => {
		const h = rectOf(t.headerCell(c.key));
		const cell = rectOf(row.FindFirstChild(`C${c.key}`));
		const pad = 8 + 1.5;
		// the cell's text box is inset by the table's cell padding (<= 8) from the column the header spans
		return (
			h.x <= cell.x + 1.5 &&
			h.x >= cell.x - pad &&
			h.x + h.w >= cell.x + cell.w - 1.5 &&
			h.x + h.w <= cell.x + cell.w + pad
		);
	});
}

/** labels under `root` whose text is below MIN_PX or does not fit its box at the size TextScaled can reach */
function textProblems(root) {
	const out = [];
	for (const l of root.GetDescendants()) {
		if (l.ClassName !== "TextLabel" || !shown(l) || String(l.Text ?? "") === "") continue;
		if (l.FindFirstChildOfClass("UITextSizeConstraint") === undefined) continue;
		const r = rectOf(l);
		const c = l.FindFirstChildOfClass("UITextSizeConstraint");
		const px = Math.max(c.MinTextSize, Math.min(textPx(l, r), c.MaxTextSize));
		const bold = /Bold|SemiBold|ExtraBold/.test(l.FontFace?.Weight?.Name ?? "");
		const mono = String(l.FontFace?.Family ?? "")
			.toLowerCase()
			.includes("mono");
		const need = textWidth(l.Text, c.MinTextSize, bold, mono);
		if (px < MIN_PX - 1e-6) out.push(`${l.Name} "${l.Text}" ${px.toFixed(1)} px`);
		else if (!l.TextWrapped && need > r.w + 1)
			out.push(`${l.Name} "${l.Text}" precisa ${need.toFixed(0)} px, tem ${r.w.toFixed(0)}`);
	}
	return out;
}

const SCREENS = [
	[1120, 630, 0, "1120x630"],
	[1360, 435, 0, "1360x435"],
	// the owner's Studio playtest window (test:screens): a 58 px bar, the Roblox buttons over its left 160 px
	[1365, 567, 58, "1365x567 (barra 58 px)", 160],
	[844, 390, 36, "844x390 (celular, barra 36 px)"],
];
for (const [w, h, bar, label, buttons] of SCREENS) {
	setViewport(w, h, bar, buttons);
	for (const touch of [false, true]) {
		if (touch && w === 1120) continue;
		hud.unmount();
		uis.TouchEnabled = touch;
		uis.MouseEnabled = !touch;
		hud.mount();
		const b = hud.scoreboard();
		b.toggle();
		setClock(9000 + w + (touch ? 1 : 0));
		hud.update(hudState);
		layoutGame(ui, boot.getCtx());
		const tag = `${label}${touch ? " toque" : ""}`;
		const panel = rectOf(b.panel);
		check(
			`${tag}: o placar cabe na tela, abaixo da barra`,
			panel.x >= 0 && panel.y >= bar - 0.5 && panel.x + panel.w <= w && panel.y + panel.h <= h,
			fmtR(panel),
		);
		// the survivor stands in the middle of the screen under the camera: the board stays left of them
		check(
			`${tag}: nao cobre o sobrevivente (centro da tela)`,
			panel.x + panel.w < w / 2 - 8,
			`${Math.round(panel.x + panel.w)} < ${w / 2 - 8}`,
		);
		// the day clock: the console's sky on desktop (the console check below), its own plate on touch
		const hudRoot = b.frame.Parent;
		const sky = rectOf(deep(hudRoot, touch ? "SkyPlate" : "Sky"));
		check(`${tag}: nem o relogio do dia (o ceu)`, !overlapR(panel, sky), `${fmtR(panel)} / ${fmtR(sky)}`);
		// the console owns the bottom of the screen (UI-09): the board never lies over the bars or the hotbar
		const hudConsole = rectOf(deep(hudRoot, "Console"));
		check(`${tag}: nem o console da HUD`, !overlapR(panel, hudConsole), `${fmtR(panel)} / ${fmtR(hudConsole)}`);
		// the chip: in the console's row on desktop (inside it), in the touch corner's row on touch -- never under the panel
		const chipRect = rectOf(b.chip);
		check(
			`${tag}: o chip fica ${touch ? "no canto de toque, fora do console" : "dentro do console"} e o placar aberto nao o cobre`,
			(touch ? !overlapR(chipRect, hudConsole) : insideR(chipRect, hudConsole)) && !overlapR(panel, chipRect),
			`${fmtR(chipRect)} / ${fmtR(hudConsole)}`,
		);
		check(`${tag}: cabecalhos sobre as suas colunas`, headerAligned(b.table, SB.SCORE_COLUMNS));
		const tp = textProblems(b.frame);
		check(`${tag}: nenhum texto abaixo de ${MIN_PX} px ou cortado`, tp.length === 0, tp.slice(0, 3).join(" | "));
		const chipHit = rectOf(deep(b.chip, "Hit"));
		if (touch) {
			const L = computeTouchLayout(
				{ leftSize: 0.5, leftPos: 0.5, leftRelative: true, rightSize: 0.5, rightPos: 0.5, mirror: false },
				w,
				h,
				bar,
			);
			const circle = (x, y, r) => ({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
			const thumbs = [
				circle(L.bag.x, L.bag.y, Math.max(L.bag.r, MIN_TOUCH_PX / 2)),
				circle(L.pause.x, L.pause.y, Math.max(L.pause.r, MIN_TOUCH_PX / 2)),
				circle(L.move.homeX, L.move.homeY, L.move.baseR),
				circle(L.aim.homeX, L.aim.homeY, L.aim.baseR),
				circle(L.reload.x, L.reload.y, Math.max(L.reload.r, MIN_TOUCH_PX / 2)),
				circle(L.use.x, L.use.y, Math.max(L.use.r, MIN_TOUCH_PX / 2)),
			];
			check(
				`${tag}: o chip e um alvo de polegar (>= ${MIN_TOUCH_PX} px)`,
				chipHit.w >= MIN_TOUCH_PX - 0.5 && chipHit.h >= MIN_TOUCH_PX - 0.5,
				fmtR(chipHit),
			);
			check(
				`${tag}: o chip nao cobre nenhum controle de toque (Bag, Menu, analogico, tiro)`,
				thumbs.every(t => !overlapR(chipHit, t)),
				fmtR(chipHit),
			);
			// the board may LIE under a thumb's control on a small phone (it is most of the screen's height there), but
			// it never takes that thumb: nothing of it that sinks input (an Active frame, a button that fires) meets a
			// stick or a fire button, and the touch layer draws above it (a sibling with a higher ZIndex)
			// (a button counts unless it is not Interactable -- the engine's buttons are Active by default)
			const isButton = d =>
				d.ClassName === "TextButton" || d.ClassName === "ImageButton" || d.ClassName === "TextBox";
			const sinks = [b.frame, ...b.frame.GetDescendants()].filter(
				d => d.IsA?.("GuiObject") && shown(d) && (isButton(d) ? d.Interactable !== false : d.Active === true),
			);
			const hits = sinks.filter(d => thumbs.slice(2).some(t => overlapR(rectOf(d), t)));
			check(
				`${tag}: o placar aberto nao toma o polegar: nada nele que prenda o toque encosta no analogico ou no tiro`,
				hits.length === 0,
				hits
					.map(d => `${d.Name} ${fmtR(rectOf(d))}`)
					.slice(0, 3)
					.join(" | "),
			);
			const touchLayer = b.frame.Parent.FindFirstChild("Touch");
			check(
				`${tag}: ...e os controles de toque ficam por cima dele`,
				touchLayer !== undefined && touchLayer.Parent === b.frame.Parent && touchLayer.ZIndex > b.frame.ZIndex,
				`${touchLayer?.ZIndex} > ${b.frame.ZIndex}`,
			);
			const segHits = b.sortBar.bar.triggers.map(t => rectOf(t.FindFirstChild("Hit")));
			check(
				`${tag}: cada opcao de 'ordenar por' e um alvo de polegar`,
				segHits.every(r => r.w >= MIN_TOUCH_PX - 0.5 && r.h >= MIN_TOUCH_PX - 0.5),
				segHits.map(fmtR).join(" "),
			);
		}
		b.close();
	}
	// the Records window over the lobby
	const recW = rectOf(deep(recRoot, "Window"));
	layoutGame(ui, boot.getCtx());
	const recWin = rectOf(deep(recRoot, "Window"));
	void recW;
	// a UI-07 window is centred on the FULL screen and only keeps clear of the Roblox BUTTONS (UI-02), not the bar
	const robloxButtons = { x: 0, y: 0, w: buttons ?? w, h: bar };
	check(
		`${label}: Records na tela, fora dos botoes do Roblox`,
		recWin.x >= 0 &&
			recWin.y >= 0 &&
			recWin.x + recWin.w <= w + 0.5 &&
			recWin.y + recWin.h <= h + 0.5 &&
			(bar === 0 || !overlapR(recWin, robloxButtons)),
		fmtR(recWin),
	);
	const recProblems = textProblems(recRoot);
	check(
		`${label}: Records sem texto cortado ou pequeno demais`,
		recProblems.length === 0,
		recProblems.slice(0, 3).join(" | "),
	);
	const recTables = recRoot.GetDescendants().filter(d => d.Name === "Table");
	check(`${label}: Records, as secoes nao se sobrepoem`, !overlapR(rectOf(recTables[0]), rectOf(recTables[1])));
}
uis.TouchEnabled = false;
uis.MouseEnabled = true;
setViewport(1120, 630, 0);
closeRecords();
ctx.save = saved;
hud.unmount();

// the admin panel at the admin's screens (a desktop tool: F2): the Players table's headers over their columns, and in
// EVERY section and tab -- the kit's form rows and switches included -- no label or description cut or too small, and
// nothing laid over anything else
{
	/** direct children of `parent` that are drawn over one another */
	const overlapsAmong = parent => {
		// (a Dialog's title is drawn ON its title strip, by the kit)
		const kids = parent
			.GetChildren()
			.filter(d => d.IsA?.("GuiObject") && shown(d) && (d.ZIndex ?? 1) >= 0 && d.Name !== "TitleStrip");
		const out = [];
		for (let i = 0; i < kids.length; i++) {
			for (let j = i + 1; j < kids.length; j++) {
				const ra = rectOf(kids[i]);
				const rb = rectOf(kids[j]);
				if (ra.w < 1 || rb.w < 1 || ra.h < 1 || rb.h < 1) continue;
				if (overlapR(ra, rb)) out.push(`${kids[i].Name} x ${kids[j].Name}`);
			}
		}
		return out;
	};
	const worldStub = new Proxy(
		{},
		{
			get: (_, k) => {
				if (k === "clock") return () => ({ day: 3, hour: 14, night: false, wave: 0, raining: false });
				if (k === "ready") return () => true;
				if (k === "zoom") return () => 1;
				if (k === "buildingCount") return () => 2;
				return () => false;
			},
		},
	);
	const P2 = {
		...P,
		world: worldStub,
		players: rows,
		request: req =>
			req.kind === "save" ? { ok: true, data: { row: makeRow({}), save: defaultSave() } } : { ok: true },
	};
	globalThis.task.spawn = (fn, ...a) => fn(...a);
	const SECTIONS = [
		["Players", c => PLAYERS.buildPlayers(P2, c)],
		["Progress", c => buildProgress(P2, c)],
		["World", c => WORLD.buildWorld(P2, c)],
		["Camera", c => WORLD.buildCamera(P2, c)],
		["Debug", c => WORLD.buildDebug(P2, c)],
	];
	// the admin's desktop screens (F2 is a keyboard tool): not the phone
	for (const [w, h, bar, label, buttons] of SCREENS.slice(0, 3)) {
		setViewport(w, h, bar, buttons);
		const k = W.uiScale();
		for (const [name, build] of SECTIONS) {
			const holder = stage(`AdminAt${w}`);
			// the panel's content region at the panel's one scale (uniform, as makeAnchored keeps it)
			const c2 = new Instance("Frame");
			c2.Name = "Content";
			c2.Position = UDim2.fromOffset(20, 20);
			c2.Size = UDim2.fromOffset(CONTENT_W * k, CONTENT_H * k);
			W.setDesign(c2, CONTENT_W, CONTENT_H);
			c2.Parent = holder;
			const sec = build(c2);
			sec.onPlayers?.();
			sec.update?.();
			const tabs = deep(c2, "Tabs");
			const tabCount = tabs === undefined ? 1 : tabs.GetChildren().filter(d => /^Tab\d+$/.test(d.Name)).length;
			for (let t = 0; t < tabCount; t++) {
				if (tabs !== undefined) {
					tabs.FindFirstChild(`Tab${t}`).Activated.Fire();
					flush();
					sec.onPlayers?.();
					sec.update?.();
				}
				layoutGame(ui, boot.getCtx());
				const tag = `admin ${label}, ${name}${tabs !== undefined ? ` > aba ${t}` : ""}`;
				if (name === "Players" && t === 0) {
					const g2 = deep(c2, "Players");
					const t2 = {
						rowButton: i => g2.GetDescendants().filter(d => d.Name === `Row${i}`)[0],
						headerCell: key => deep(g2, `Head${key}`),
					};
					check(`${tag}: cabecalhos sobre as suas colunas`, headerAligned(t2, PLAYERS.PLAYER_COLUMNS));
				}
				const tp = textProblems(c2);
				check(
					`${tag}: nenhum texto abaixo de ${MIN_PX} px ou cortado`,
					tp.length === 0,
					tp.slice(0, 3).join(" | "),
				);
				const body = c2.FindFirstChild("Body") ?? c2;
				const ov = overlapsAmong(body);
				check(`${tag}: nada desenhado sobre outra coisa`, ov.length === 0, ov.slice(0, 4).join(" | "));
			}
			sec.destroy?.();
			holder.Destroy();
		}
		// the kick and ban forms (their switches are the kit's too)
		const dl = stage(`AdminDialogs${w}`);
		const P3 = { ...P2, layer: dl };
		PLAYERS.openKickDialog(P3, rows[1]);
		PLAYERS.openBanDialog(P3, "20", "Marta (20)");
		flush();
		layoutGame(ui, boot.getCtx());
		for (const dname of ["KickDialog", "BanDialog"]) {
			const d = deep(dl, dname);
			const tp = textProblems(d);
			check(
				`admin ${label}, ${dname}: nenhum texto cortado ou pequeno demais`,
				tp.length === 0,
				tp.slice(0, 3).join(" | "),
			);
			const card = deep(d, "DialogContent") ?? d;
			const ov = overlapsAmong(card);
			check(
				`admin ${label}, ${dname}: nada desenhado sobre outra coisa`,
				ov.length === 0,
				ov.slice(0, 4).join(" | "),
			);
		}
		dl.Destroy();
	}
	globalThis.task.spawn = realSpawn;
	setViewport(1120, 630, 0);
}
void paintList;
void TEXT;

// ---------------------------------------------------------------- report

console.log(
	"\nPasso                                                                     criadas  destruidas  escritas",
);
for (const x of table) {
	console.log(
		`${x.label.padEnd(72)} ${String(x.created).padStart(7)} ${String(x.destroyed).padStart(11)} ${String(x.writes).padStart(9)}`,
	);
}
console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	"OK: a Table e os formularios no vocabulario da UI-07, o admin, o Records e o placar da partida (UI-12, MP-23)",
);
