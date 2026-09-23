# Pesquisa: Desempenho

Confronto entre a documentação oficial da Roblox e o nosso código. Escopo: o tick do servidor
(`src/server/sim/*`, `src/shared/sim/*`, `src/server/net/*`), o caminho de desenho do cliente
(`src/shared/engine/renderer.ts`, `src/client/gameLoop.ts`, `src/client/ui/*`, `src/client/view/*`) e a
instrumentação existente.

Fontes:

- Visão geral: https://create.roblox.com/docs/performance-optimization
- Projetar / melhorar / identificar: https://create.roblox.com/docs/performance-optimization/design ·
  https://create.roblox.com/docs/performance-optimization/improve ·
  https://create.roblox.com/docs/performance-optimization/identify
- **Tabela de tags do MicroProfiler** (a fonte mais útil de todas para nós):
  https://create.roblox.com/docs/performance-optimization/microprofiler/tag-table
- MicroProfiler: https://create.roblox.com/docs/studio/microprofiler ·
  https://create.roblox.com/docs/studio/microprofiler/use-microprofiler ·
  https://create.roblox.com/docs/studio/microprofiler/modes
- Script Profiler: https://create.roblox.com/docs/studio/optimization/scriptprofiler
- Luau paralelo: https://create.roblox.com/docs/scripting/multithreading ·
  `Actor`: https://create.roblox.com/docs/reference/engine/classes/Actor ·
  `SharedTable`: https://create.roblox.com/docs/reference/engine/datatypes/SharedTable
- `LayerCollector`: https://create.roblox.com/docs/reference/engine/classes/LayerCollector ·
  `ScreenGui`: https://create.roblox.com/docs/reference/engine/classes/ScreenGui ·
  `CanvasGroup`: https://create.roblox.com/docs/reference/engine/classes/CanvasGroup ·
  `ZIndexBehavior`: https://create.roblox.com/docs/reference/engine/enums/ZIndexBehavior ·
  modificadores de tamanho: https://create.roblox.com/docs/ui/size-modifiers
- `Stats`: https://create.roblox.com/docs/reference/engine/classes/Stats ·
  `Enum.DeveloperMemoryTag`: https://create.roblox.com/docs/reference/engine/enums/DeveloperMemoryTag ·
  `debug`: https://create.roblox.com/docs/reference/engine/libraries/debug
- Código nativo: https://create.roblox.com/docs/luau/native-code-gen
- Streaming: https://create.roblox.com/docs/workspace/streaming ·
  `ContentProvider`: https://create.roblox.com/docs/reference/engine/classes/ContentProvider
- `UnreliableRemoteEvent`: https://create.roblox.com/docs/reference/engine/classes/UnreliableRemoteEvent
- Suplementar (doc oficial do Luau, não do create.roblox.com): https://luau.org/performance

Auditoria irmã, com a qual este documento não se sobrepõe de propósito: `docs/research/engine-apis.md`
(cobre `task`, `buffer`, `table.*`, `debug.*` e os tipos nativos como **adoção de API**; aqui o recorte é
**custo**).

> **Sobre os `arquivo:linha`:** são um instantâneo da árvore no momento desta pesquisa. Outras frentes estavam
> editando `src/` em paralelo (entre elas `client/ui/skin.ts`, `server/net/{interest,mpHost,replication}.ts`,
> `server/sim/simulation.ts`, `shared/net/{mpConfig,protocol}.ts`), então algumas linhas podem ter deslizado.
> Os nomes de símbolo citados ao lado de cada linha são o que vale para reencontrar o trecho.

---

## Contexto: quatro fatos que mudam a leitura de todo o resto

**1. O tick de 60 Hz que roda hoje tem zero zumbis.**
`src/server/sim/simulation.ts:129` (`if (!(options.zombies ?? MP_PHASE >= 2)) return;`) só constrói a horda em
`:130-131`, e o host vivo não passa `zombies` (`src/server/net/mpHost.ts:143`, `new ServerSimulation({ world })`).
Com `MP_PHASE = 1` (`src/shared/net/mpConfig.ts:13`), `sim.horde` (`simulation.ts:92`) é `undefined` em
produção, e `buildSnapshot` emite `zombies: []` / `bosses: []` incondicionalmente
(`src/server/net/replication.ts:196-197`). `server/sim/combat.ts`, `history.ts` e `progress.ts` **não têm um
único call site em `src/`** — só nos harnesses. Toda a horda existe, completa, e é alcançada apenas passando
`zombies: true`, que é o que `tools/test-ai.mjs:936` faz.

**2. Quem paga a horda hoje é o cliente, a FPS livre.**
`src/client/systems/zombieAI.ts:146-154` chama `Brain.updateZombies` direto do laço de render, uma vez por
frame, com `dt` variável — **a 120/144/240 Hz se o monitor for bom**, e seis vezes, uma por jogador. O custo de
IA que `docs/MULTIPLAYER.md` §3.2 dimensiona para 60 Hz no servidor existe; só não está onde o orçamento olha.

**3. Metade do `src/shared` roda em dois runtimes.**
Dez harnesses `tools/test-*.mjs` transpilam o TypeScript para JS e rodam sob Node, declarando à mão os globals
que os módulos usam. Isso já está documentado em `docs/research/engine-apis.md`, e é a restrição mais cara
deste relatório: qualquer API do motor (`debug.profilebegin`, `Vector3`, `table.create`, `LuaTuple`) dentro de
um módulo puro de `shared/` ou `server/sim/` exige um shim novo em dez arquivos. Toda recomendação abaixo diz
se paga esse preço.

**4. roblox-ts emite Luau sem anotações de tipo.**
Verificado em `out/shared/game/physics.luau`: `local function moveActor(world, x, y, radius, dx, dy)`. Importa
para a estimativa de `--!native` (item 1.6).

---

## 1. Luau paralelo (`Actor` / `task.desynchronize`)

### Veredito: **não faça.** Não é "último recurso" — é arquiteturalmente incompatível com o código de hoje

`docs/MULTIPLAYER.md:274` lista "flow field em Actor (Parallel Luau)" como a última alavanca se o tick p95
passar de 6 ms. A ordem está certa, mas a opção é muito pior do que "última" sugere. São **seis bloqueios
mecânicos**, cada um verificável, e nenhum deles se resolve com esforço razoável.

#### 1.1 `querySolids` **escreve** no mundo — o bloqueio absoluto

`src/shared/game/world.ts:300` (`g.stamp++`) e `:310` (`s.gridStamp = stamp`). Confirmado no Luau compilado
(`out/shared/game/world.luau:222`). É uma *consulta* que muta estado global da grade e de cada `Solid`
visitado, e há **~300–500 chamadas por tick** (`moveActor`, `findTrap`, `steer`, `probeFree`, `sweepAround`,
`flowField.ensureGrid`, `raycast`).

Qualquer fase que toque física ou o mundo, rodando num `Actor` contra um mundo compartilhado, corrompe esse
carimbo. E como a doc de Parallel Luau diz que "scripts running in parallel generally can't write to the data
model", o problema aqui nem é o DataModel — é o **nosso próprio** estado global.

#### 1.2 A passada principal é Gauss-Seidel, não Jacobi

`src/shared/sim/ai/zombieBrain.ts:1372-1379` itera de `N-1` a `0` e escreve `z.x`/`z.y` **in place**
(`:1269-1270`, `:1310-1311`). Um zumbi lê e escreve o estado **já atualizado** dos outros na mesma passada:

- `zombieBrain.ts:691` chama `Alert.hearers(refs.zombies, z.x, z.y, …)`, e `src/shared/sim/ai/alert.ts:266-268`
  lê `u.x - x` ao vivo — índices acima de `i` já se moveram, abaixo não.
- A mesma chamada **escreve** nos outros: `zombieBrain.ts:693-697` (`o.alertCd`, `o.detectShow`,
  `Mind.report(o, …)`), consumido pelo `updateOne(j)` do mesmo tick.
- `explode` lê e escreve `o.hp` de todos (`zombieBrain.ts:295-302`).
- `damageStructure` chama `removeSolid` no meio da passada (`zombieBrain.ts:1278` → `:341`): **um zumbi mais
  tarde na passada colide contra um mundo diferente** do de um mais cedo.

Isso não é um detalhe de implementação — é o comportamento do jogo. Paralelizar muda a horda.

#### 1.3 Dois orçamentos globais consumidos em ordem de índice

`losBudget` (reset em `zombieBrain.ts:1344`, consumo em `:674-675`) e `shoutsLeft` (reset `:1345`, consumo
`:687-688`). Os zumbis de índice mais alto ficam com os 24 raios primeiro. Qualquer sharding muda quem enxerga
o quê.

#### 1.4 `math.random` é consumido em ordem estrita de índice

`src/shared/engine/rng.ts` inteiro é wrapper fino sobre o global `math.random()` (`:1-28`); não existe gerador
por mundo (`Random.new`/`randomseed`: zero ocorrências em `src/`). O consumidor dominante é
`zombieBrain.ts:1324` — **uma rolagem por zumbi por tick** quando há armadilha —, dentro do laço decrescente
de `:1372`, e o número de saques depende de quantos zumbis foram removidos antes na mesma passada (`:1377`).

Qualquer reordenação, sharding ou paralelização muda **todos** os saques subsequentes de **todos** os
consumidores de `math.random` do jogo — incluindo loot, chuva e tipo de zumbi especial. E o autoteste de
determinismo de §12.2 ("a mesma sequência de 300 comandos → hash do estado final") existe justamente para
pegar isso.

> Nota fina: `syncWorld` (`zombieBrain.ts:437-450`) zera `frameNo` de propósito para um mundo jogar igual duas
> vezes (comentário em `:440-443`), mas **não resemeia o RNG** — essa garantia cobre só o pseudo-aleatório
> derivado de `id`/`frameNo`, não `math.random`.

#### 1.5 Estado mutável de escopo de módulo, e a cópia de módulo por `Actor`

São **catorze** locais mutáveis de módulo em `zombieBrain.ts` (`:43-52`, `:70-71`, `:88-89`, `:467-468`), mais
`physics.ts:42` (`scratch`) e `:178` (`rayScratch`), mais os singletons de `NetWriter` em `protocol.ts:251`,
`:669`, `:1132`, `:1614` com `reset()` no topo de cada encode (`:694`). São seguros só porque `updateZombies`
nunca é reentrada e nunca cede. Vale notar que `refs.ai` **já foi** deliberadamente movido para os refs por
esse motivo exato (`src/shared/sim/ai/context.ts:107-111`) — estes catorze não foram.

Isso encontra o segundo problema: a doc de Parallel Luau diz que atores são "units of execution isolation" e
que não se pode usar `require()` na fase paralela — e, pelo que se discute no DevForum, **cada `Actor` recebe
a própria cópia de cada `ModuleScript` requerido**. Se for verdade, um `Actor` não enxerga nada do nosso
estado: nem `refs.zombies`, nem `refs.world`, nem os catorze.
*Procedência:* isso **não** está afirmado literalmente na doc oficial. É a primeira coisa a confirmar
empiricamente antes de qualquer aposta (um `print` de identidade de tabela em dois atores resolve em cinco
minutos). Mas 1.1–1.4 já bastam sozinhos.

#### 1.6 Mesmo se nada disso existisse, a fronteira de dados não fecha

A doc de `SharedTable` é explícita: "Values must have one of the following types: Boolean, Number, Vector,
String, SharedTable, or a serializable data type", e uma tabela aninhada "is converted into a new
SharedTable". Nossos `Solid`, `ZombieState` e `WorldData` não passam sem serem reconstruídos elemento a
elemento.

E o candidato óbvio — o flow field — tem saída grande. Medido no harness (§6 abaixo): **47 tiles / 10 655
células** com 6 jogadores juntos, **179 tiles / 40 031 células** com 6 espalhados, cada célula com `dist` e
`owner`. Copiar ~80 mil números para dentro/fora de um `SharedTable` a cada rebuild custa muito mais que os
2 ms que o rebuild inteiro tem de orçamento (`FLOW_CELL_BUDGET = 1000` células/tick,
`src/server/sim/zombies.ts:68`).

**A armadilha de design, para quem tentar mesmo assim:** `heading(x, y)` e `targetOf(x, y)` são consultados
uma vez por zumbi, na thread principal. "O `Actor` calcula o campo e a main consulta" é inviável pelo volume.
O único desenho que fecharia é o inverso — **o `Actor` é dono do campo E responde as consultas**: entram 150
posições (300 números), saem 150 rumos + 150 donos. Interface pequena, latência de um tick (aceitável: o campo
já tem 0,15–0,75 s de idade). Mas exige que o `Actor` tenha a própria cópia do mundo estático para rasterizar,
um fluxo de eventos de tile sujo, e **nada disso é testável pelos harnesses de Node** — perderíamos
`test-ai.mjs --tick` e `test-server-sim.mjs` justamente na parte mais delicada.

### O que poderia sair da thread principal, e o que não

| Fase | Sai? | Por quê |
|---|---|---|
| Percepção (`src/shared/sim/ai/perception.ts`) | Em teoria | É literalmente "numbers in, numbers out" (cabeçalho, `:17-19`). Mas o raycast de linha de visão é do chamador, e esse cai em 1.1. |
| Separação por hash espacial (`spatialHash.ts`) | Em teoria | 150 posições entram, 150 deslocamentos saem. É uma das duas fases genuinamente Jacobi (`zombieBrain.ts:1371`, lida só em `:1264-1265`). **Mas custa 0,3 ms de um orçamento de 3,5 ms** — não paga a fronteira. |
| `updateCrowd` (`flank.ts`) | Em teoria | A outra fase Jacobi (`zombieBrain.ts:1370`, lida em `:513`). Mesma objeção: pequena demais. |
| Flow field (`server/sim/flowField.ts`) | Só no desenho de 1.6 | `ensureGrid` chama `querySolids` (`flowField.ts:188`, `:205`) → cai em 1.1. |
| Passada principal (`zombieBrain.ts:1372-1379`) | **Não** | 1.1, 1.2, 1.3, 1.4, 1.5 — todos. |
| `moveActor` (`physics.ts:90`) | **Não** | 1.1 + `scratch` de módulo. |
| Chefes (`bossBrain.ts`) | **Não** | Escreve `p.hp` (`:67`, `:124`, `:149`) e o Map global `fanCounters` (`:16`). |
| Replicação (`remotes.ts:125,142,146`) | **Não** | `FireClient`/`FireAllClients` é DataModel — proibido na fase paralela. |

### Prioridade: **baixa (não fazer).** Esforço se fosse feito: **alto** (semanas), com regressão de comportamento garantida

**Quando reabrir:** só se, depois de `--!native` + as alavancas de §3.2, uma medição **no Studio** (não no
Node) mostrar o flow field sozinho acima do orçamento — e então o desenho é o de 1.6, com um plano explícito
para 1.1 e 1.4.

### `--!native` — esta sim, e com uma correção à nossa própria estimativa

A doc de código nativo é clara: compila "server-side scripts" para máquina, beneficia "functions called
repeatedly (especially per-frame)" e "mathematical operations on tables" — exatamente o Dijkstra de
`flowField.ts:389-474` e o laço de `moveActor`.

**Como fazer aqui:** `rbxtsc` não emite `--!native`, e `out/` é gerado e ignorado pelo git (`.gitignore:6`).
Então é um passo pós-build que injeta a diretiva no topo dos arquivos escolhidos de `out/server/sim/` e
`out/shared/sim/`. O repositório já tem exatamente esse padrão: `tools/check-registers.mjs` lê `out/` depois
do build e está ligado no CI (`.github/workflows/ci.yml`, passo "Luau register budget").

**Contradição com o que já estimamos:** `docs/MULTIPLAYER.md` §3.3 estima "~2 µs/célula interpretado (~0,7–1 µs
com `--!native`)", ou seja, 2–3× de ganho. A doc de código nativo diz que "untyped function parameters" causam
desotimização — e roblox-ts **apaga todos os tipos** (fato 4 do contexto). O ganho real deve ficar bem abaixo
de 2–3×. A estimativa de §3.3 não está errada por preguiça: está escrita para Luau idiomático, e para a nossa
saída de transpiler ela é otimista. **Medir antes de contar com ela** — o Script Profiler marca funções
nativas com `<native>`, que é a confirmação de que a diretiva pegou.

- **Prioridade:** média (alta assim que a horda migrar para o servidor na F2). **Esforço:** baixo.
- **Alvos:** `out/server/sim/flowField.luau`, `out/shared/game/physics.luau`,
  `out/shared/sim/ai/zombieBrain.luau`.
- **Link:** https://create.roblox.com/docs/luau/native-code-gen

---

## 2. Custo de desenho com milhares de `Frame`s

### Veredito: o renderer está certo. O problema é o *tamanho do `LayerCollector`* e quatro descuidos pontuais

O achado central da doc não está em nenhuma página de "performance", e sim na referência de classe:

> "For performance improvements, the appearance of a LayerCollector is cached until one of the following
> events occurs: A descendant is added to or removed from it. A property of a descendant changes. A property
> of the LayerCollector itself changes."
> — https://create.roblox.com/docs/reference/engine/classes/LayerCollector

A página de `ScreenGui` completa: "The appearance recomputes on the next rendered frame." E a tabela de tags
do MicroProfiler dá o conselho operacional:

> `Render/PreRender/UpdateUILayouts` → **Rebuild Z-order list**: "Minimize LayerCollector size and avoid
> frequent parent/ZIndex modifications." · **Layout**: "Reduce resizing operations on UI elements."
> `Perform/fillGuiVertices`: "Decrease UI density and element count; reduce UIGradient and UICorner usage."

**O que isso significa para nós:** temos **um** `ScreenGui` de jogo (`src/client/bootstrap.ts:55`, `GameGui`,
`DisplayOrder 100`) e dentro dele convive tudo — o mundo (1.500–3.000+ `Frame`s que mudam de posição todo
frame) e o HUD inteiro. Como qualquer escrita de propriedade num descendente invalida o cache do
`LayerCollector`, **o HUD é reprocessado todo frame junto com o mundo**, ainda que nenhum pixel dele tenha
mudado. E o HUD tem justamente as coisas caras: `TextScaled`, `AutomaticSize`, `UIListLayout`.

> **Isto é o que a doc diz, não o que medimos.** A doc não detalha se a invalidação é do coletor inteiro ou
> incremental por subárvore. O experimento que resolve está em 3.6.

### O que já está certo (e não deve ser mexido)

| Prática | Onde | Por que a doc concorda |
|---|---|---|
| Cache de propriedade por sprite: 13 comparações antes de qualquer escrita | `src/shared/engine/renderer.ts:296-392` | É a única defesa real contra a invalidação do coletor. Não há uma escrita redundante vinda do renderer. |
| Posição arredondada a pixel inteiro antes do cache | `renderer.ts:182-185` | Um sprite que não andou um pixel inteiro nem chega a escrever `Position`. |
| Pool com cursor, `acquire` O(1), sem `Destroy` no laço | `renderer.ts:243-251`, `:102-108` | "A descendant is added to or removed from it" é gatilho de invalidação; o pool nunca adiciona/remove no frame. |
| `ZIndexBehavior.Sibling` nos três `ScreenGui` | `bootstrap.ts:60`, `admin/adminClient.ts:62`, `admin/patches.ts:116` | É o default e o certo. `Global` forçaria ordenar todos os descendentes por `ZIndex`. |
| `ZIndex` por camada constante, não por entidade por frame | `src/shared/engine/colors.ts:94-117` | Evita o "Rebuild Z-order list" que a tag manda evitar. |
| Culling em ~22 granularidades + recorte geométrico `drawClipped` | `gameLoop.ts:751-769` e as ~20 checagens de `overlaps`/`circleInView` | "Decrease UI density and element count". |
| Zero sprite sheet, zero `ImageRectOffset`: o mundo é `Frame` + `BackgroundColor3` | `renderer.ts` inteiro | Não há `LoadImage` nem textura de mundo para pagar. |

### Os quatro custos que estamos pagando sem saber

**2.1 `TextScaled` + `UITextSizeConstraint` em todo label e todo botão do kit — dentro do coletor quente.**
`src/client/ui/skin.ts:107` (`scaleText`) escreve `TextScaled = true` (`:108`) e cria um `UITextSizeConstraint`
(`:111`); chamado por `widgets.ts:372`, `:388`, `:693`. Resultado: os ~21 objetos de texto permanentes do
HUD de PC são todos auto-dimensionados. `TextScaled` é exatamente a "resizing operation on UI elements" que a
tag `UpdateUILayouts/Layout` manda reduzir, e ela roda toda vez que o coletor é invalidado — isto é, todo
frame, por causa do mundo.
- **Prioridade:** média. **Esforço:** médio. O padrão certo já existe no próprio código: cinco lugares usam
  `TextSize` fixo recalculado só em mudança de layout (`nameplate.ts:169-171`, `allyPlate.ts:147`,
  `chatBubbles.ts:348`). É uniformizar, não inventar.

**2.2 `AutomaticSize` em objetos que existem durante a partida.**
`nameplate.ts:91` (a pílula) e `:53` (até 3 `TextLabel`), `chatBubbles.ts:265`, `:301`, `:320`. Com 6
jogadores: até 24 objetos nas plaquetas e até 42 nos balões. De novo, trabalho de layout dentro do coletor que
o mundo invalida todo frame.
- **Prioridade:** média. **Esforço:** médio-baixo.

**2.3 O light map: 105 a 360 `Frame`s, cada um com um `UIGradient`.**
`renderer.ts:517` calcula `rows = ceil(viewH / STRIP_H)` com `STRIP_H = 6` (`:416`): **105 faixas a 630 px,
120 a 720p, 180 a 1080p, 240 a 1440p, 360 a 4K**, cada uma com um `UIGradient` (`:538`) de até 20 keypoints
(`MAX_KEYS`, `:424`). A tag `Perform/fillGuiVertices` diz, com todas as letras, "reduce UIGradient and
UICorner usage". É o maior consumidor isolado de `UIGradient` do projeto, e **cresce linearmente com a
resolução** — degrada exatamente onde não queremos.
  Atenuantes já implementados: a faixa só é reescrita se o gradiente divergir mais que `WRITE_EPS = 2/64`
  (`:433`, `:795`), e de dia a camada inteira some (`:572-575`).
- **Prioridade:** média. **Esforço:** baixo para a mitigação óbvia (subir `STRIP_H` de 6 para 8–10 corta 25–40%
  das faixas; medir a perda visual), alto para trocar a técnica.

**2.4 Escritas incondicionais por frame — invalidam o coletor de graça.**
- `src/client/gameLoop.ts:2053`: `ctx.darkLayer.BackgroundTransparency = 1;` roda **todo frame**, sem
  comparação, com valor constante. Pela regra do `LayerCollector`, isso sozinho basta para invalidar o
  `GameGui` inteiro todo frame, mesmo com o jogo parado. Mesma linha em `:2103`.
- `src/client/ui/hud.ts:932` e `:961`: `Position = new UDim2(...)` todo frame quando a camada touch existe,
  sem comparação (e alocando um `UDim2` a cada vez).
- **Prioridade: alta** para `gameLoop.ts:2053` (é uma linha e um `if`). Média para as de `hud.ts`.
  **Esforço:** trivial.

### O lever estrutural: separar o HUD em outro `ScreenGui`

A doc manda "minimize LayerCollector size". Hoje mundo e HUD estão no mesmo coletor (`bootstrap.ts:55-101`:
`GameGui` → `Root` → {`World`, `Dark`, `Hud`, `Ui`}). Mover `Hud` e `Ui` para um `ScreenGui` próprio
(`DisplayOrder` 101/102) faz a invalidação por movimento do mundo **não** arrastar o layout do HUD — e o HUD,
que só muda por evento, ficaria em cache de verdade.

Custos e riscos a checar antes: (a) plaquetas, balões e nameplates são filhos de `Root` e ficam *entre* o
mundo e o HUD por ordem de irmão (`allyPlate.ts:5-7`, `gameLoop.ts:2025`, `:2010`) — a estratificação
precisaria virar `DisplayOrder` entre coletores; (b) `bootstrap.ts:63` tem um `Root` opaco de fundo; (c) o
`uiAudio` observa a `ScreenGui` para ligar sons de botão (`src/client/audio/uiAudio.ts:4-6`) e passaria a
precisar observar duas.

- **Prioridade:** alta — **mas depois de medir** (3.6). É a mudança com o maior ganho potencial e o maior risco
  de regressão visual deste documento; fazer às cegas seria trocar um custo desconhecido por um bug conhecido.
- **Esforço:** médio.

### `CanvasGroup`: **não faça**

Zero ocorrências, e deve continuar assim. A doc diz que ele "renders its descendants as a flattened group",
"consumes extra texture memory", limitado pelo "QualityLevel of the client", que "when exceeding the memory
cap, CanvasGroup will render as a blank texture", e recomenda usá-lo "with static sizes, otherwise a new
texture would need to be created". Um mundo que muda todo frame achatado numa textura significa redesenhar a
textura todo frame — o pior caso do recurso. E "blank texture" num celular seria a tela do jogo sumindo. A tag
`Perform/Scene/UI` sugere "consider CanvasGroups", mas esse conselho é para UI estática e densa.

---

## 3. Medição em Luau: o que ligar e o que ler pelo MCP

### Veredito: os encaixes já existem; faltam ligar. Quase tudo aqui é **prioridade alta, esforço baixo**

#### 3.1 O viés no nosso p95 de tick — **prioridade alta, esforço baixo**

`src/server/net/mpHost.ts:396-398`:

```ts
const started = os.clock();
const ran = sim.advance(dt);
if (ran > 0) sim.sample(((os.clock() - started) * 1000) / ran);
```

Três defeitos precisos:

1. **`/ ran` tira a média dos ticks de catch-up.** `advance` roda de 0 a `MAX_CATCHUP_TICKS = 2` ticks
   (`simulation.ts:179-196`). Num heartbeat de 2 ticks, um tick de 10 ms e outro de 2 ms viram **uma** amostra
   de 6 ms — embora `sample()` se documente como "records one tick's simulation time" (`simulation.ts:227`).
   O `pz_tick_p95_ms` publicado em `mpHost.ts:403` é o p95 das **médias por heartbeat**, e **subestima**
   exatamente a métrica contra a qual o orçamento de §3.2 está escrito e que decide se `SIM_HZ` cai para 30.
2. **A janela inclui a replicação**, porque `onTick` dispara dentro de `step()` (`simulation.ts:216`,
   `mpHost.ts:166`). Não é errado, mas a linha de §3.2 que separa "replicação: 1,0 ms" não é observável.
3. **A janela exclui a admissão** (`mpHost.ts:392-395`, que roda `findSpawnPoint`) e o bloco de métricas
   (`:399-412`).

Correção: cronometrar dentro de `Simulation.advance`, chamando `sample()` uma vez por `step()`. `os.clock` não
pode entrar em `simulation.ts` (módulo puro sob Node) — a saída limpa é a mesma que a horda já usa: um encaixe
`nowMs?: () => number` injetado pelo host (3.2).

#### 3.2 O breakdown por fase já existe e está desligado — **prioridade alta, esforço trivial**

`src/server/sim/zombies.ts:96-98` declara `nowMs?: () => number` e
`readonly cost = { clock, population, field, zombies, bosses, book }`, e `step()` cronometra cada fase com um
`lap()` (`:248-255`). O comentário da linha 97 é honesto: "all zero while `nowMs` is undefined".

**`nowMs` é atribuído em exatamente um lugar do repositório: `tools/test-ai.mjs:1101`.** No servidor vivo os
seis contadores são sempre zero. (E hoje nem existiriam: `sim.horde` é `undefined` — fato 1 do contexto. A
fiação tem que ser condicional e entra em vigor na F2.)

Concretamente, é uma linha em `mpHost.ts` (server-only, onde `os.clock` já é usado):

```ts
if (sim.horde !== undefined) sim.horde.nowMs = () => os.clock() * 1000;
```

mais seis atributos junto dos quatro já publicados em `mpHost.ts:402-405`
(`pz_cost_clock`, `pz_cost_population`, `pz_cost_field`, `pz_cost_zombies`, `pz_cost_bosses`, `pz_cost_book`).
Isso entrega, sem nenhum shim novo e sem tocar em módulo puro, a repartição que §3.2 pede
("`os.clock()` por etapa") e que §12.2 promete.

#### 3.3 Duas métricas que já são calculadas e ninguém lê

- `ReplicationStats` (`src/server/net/replication.ts:209-216`) é mantido e **nunca publicado nem logado**.
- `CombatStats` (`src/server/sim/combat.ts:180-195`) idem (e o módulo ainda não tem call site).
Publicar como atributos custa três linhas e fecha a linha "métricas do servidor" de §12.2.

#### 3.4 `debug.profilebegin` / `profileend` — **prioridade média, com um pedágio**

Zero ocorrências em todo o `src/`. Nada nosso é visível por nome no MicroProfiler. A doc mostra o uso exato
(https://create.roblox.com/docs/studio/microprofiler/use-microprofiler) e os rótulos aparecem direto na
timeline.

O pedágio: `debug` é global do motor, e `simulation.ts`, `zombies.ts`, `flowField.ts` e `zombieBrain.ts` são
módulos puros que rodam sob Node. Duas saídas:

- **(a) Rótulos só em arquivos server-only/client-only.** `mpHost.ts` (o tick inteiro) e
  `src/client/main.client.ts:514-546` (separar `loop.update(dt)` de `loop.render()` de `pushHud()`). Custo
  zero, e responde de imediato "o frame do cliente é simulação ou desenho?", que hoje nada responde.
- **(b) Para as fases internas, um shim único nos dez `tools/test-*.mjs`:**
  `globalThis.debug = { profilebegin() {}, profileend() {} }` — uma linha por arquivo, e daí `debug.*` fica
  livre em qualquer módulo puro.

Recomendo (a) agora e (b) só quando 3.2 apontar uma fase suspeita e for preciso abrir dentro dela.

#### 3.5 `Stats` — a métrica que falta e é feita sob medida para este jogo — **prioridade alta, esforço baixo**

Zero uso do serviço `Stats` no projeto. E ele tem contadores que são exatamente a pergunta "quanto custam
milhares de `Frame`s":

| Propriedade / método | Por que importa aqui |
|---|---|
| `Stats.UI2DDrawcallCount` | **A métrica principal deste jogo.** Quantas draw calls os nossos 1.500–3.000 `Frame`s viram de fato. A doc de "design for performance" usa "below 1,000 draw calls" como exemplo de alvo para aparelho fraco. |
| `Stats.UI2DTriangleCount` | A geometria que `fillGuiVertices` produz. Sobe com `UIGradient`, `UICorner` e `UIStroke` — mede 2.3 e o custo por sprite diretamente. |
| `Stats.RenderCPUFrameTime` / `RenderGPUFrameTime` | Separa "presos na CPU de render" de "presos na GPU". |
| `Stats.FrameTime` / `HeartbeatTime` | FPS e heartbeat reais, em vez da EMA caseira de `src/client/admin/world.ts:811`. |
| `Stats:GetMemoryUsageMbForTag(Enum.DeveloperMemoryTag.Gui)` | O pool de `Frame`s nunca encolhe (4.5). Este é o número que mostra isso crescendo. |
| `…(.Instances)` / `…(.LuaHeap)` | Instâncias vivas e o heap do Luau — o segundo é o termômetro do churn da seção 4. |

**Onde ligar:** o card de debug já existe e já mostra `sprites` e `GameGui inst`
(`src/client/admin/adminClient.ts:250-264`, alimentado por `src/client/admin/world.ts:733-751`, refresh de
0,25 s em `adminClient.ts:29`). São ~6 linhas em cada um dos dois arquivos.

#### 3.6 O experimento que decide a seção 2

Um roteiro, não uma opinião:

1. Playtest com horda cheia. MicroProfiler pausado (Ctrl+P), modo detalhado.
2. Anotar `Render/PreRender/UpdateUILayouts` (e dentro dele "Rebuild Z-order list" e "Layout"),
   `Perform/fillGuiVertices` e `Perform/Scene/UI`.
3. Repetir com `ctx.hudLayer.Visible = false` (o HUD continua na árvore).
4. Repetir com `ctx.hudLayer.Parent` apontando para um `ScreenGui` novo.

Se (4) derrubar `UpdateUILayouts` e (3) não, a invalidação é por coletor e a separação vale. Se (3) já
derrubar, o problema é só volume de elementos e a separação não é necessária.

#### 3.7 Como ler tudo isso pelo MCP do Roblox Studio

Atributos são o canal certo (e já é o padrão do projeto, `mpHost.ts:401-405`), porque `execute_luau` lê estado
sem abrir janelas:

```lua
-- servidor
local w = workspace
return {
  avg = w:GetAttribute("pz_tick_avg_ms"),
  p95 = w:GetAttribute("pz_tick_p95_ms"),
  dropped = w:GetAttribute("pz_dropped_ticks"),
  clock = w:GetAttribute("pz_cost_clock"),
  population = w:GetAttribute("pz_cost_population"),
  field = w:GetAttribute("pz_cost_field"),
  zombies = w:GetAttribute("pz_cost_zombies"),
  bosses = w:GetAttribute("pz_cost_bosses"),
  book = w:GetAttribute("pz_cost_book"),
}
```

```lua
-- cliente
local Stats = game:GetService("Stats")
return {
  fps = 1 / math.max(Stats.FrameTime, 1e-6),
  renderCpuMs = Stats.RenderCPUFrameTime * 1000,
  renderGpuMs = Stats.RenderGPUFrameTime * 1000,
  ui2dDrawcalls = Stats.UI2DDrawcallCount,
  ui2dTriangles = Stats.UI2DTriangleCount,
  guiMb = Stats:GetMemoryUsageMbForTag(Enum.DeveloperMemoryTag.Gui),
  luaMb = Stats:GetMemoryUsageMbForTag(Enum.DeveloperMemoryTag.LuaHeap),
  instances = Stats.InstanceCount,
}
```

MicroProfiler e Script Profiler continuam sendo tarefa manual no Studio (Ctrl+Alt+F6 / F9 → Script Profiler),
mas com esses atributos o MCP já responde "regrediu ou não" sem abrir nada.

---

## 4. Memória e GC

### Veredito: o `moveActor` **é** a maior fonte do tick — mas o caminho de desenho do cliente é 10× maior

A doc dá o alvo (tag `GC`): "Luau garbage collection cycle. **Pool tables and minimize temporary object
creation.**" E https://luau.org/performance confirma o que aloca e o que não: vetores nativos e números não vão
para o heap; tabelas e closures vão.

#### 4.1 `moveActor` — confirmado, e é pior que "uma tabela por chamada"

`src/shared/game/physics.ts:81` (`resolveCircle` → `return { x, y, hit }`) e `:116` (`moveActor` → idem).
Confirmado no Luau compilado (`out/shared/game/physics.luau:80-84`, `:134`). `moveActor` chama `resolveCircle`
`steps` vezes (`physics.ts:103-108`) **mais uma vez** quando `len < 1e-6` (`:111`):

| Caso | Tabelas por chamada |
|---|---|
| Ator andando, `steps = 1` (típico: zumbi a 90 px/s move 1,5 u/tick, `maxStep = 8`) | **2** |
| Ator **parado** (`len < 1e-6`) | **3** |
| Charger a `RUSH_SPEED_MAX` | 3 |

Sítios por zumbi por tick: `zombieBrain.ts:1266` (movimento), `:1307` (empurrão fora do corpo do jogador),
`:1168` (saltador no ar). Jogadores: `playerMove.ts:70`.
**Total ~300–400 tabelas efêmeras por tick = 18 000–24 000/s.** É a maior fonte do tick, e é pura sobrecarga —
o próprio arquivo já usa buffers de módulo (`physics.ts:42`, `:178`) para tudo o mais.

#### 4.2 O resto do servidor, por volume

| # | O que aloca | `arquivo:linha` | Por tick (N=150, P=6) |
|---|---|---|---|
| 1 | `MoveResult` de `resolveCircle`/`moveActor` | `physics.ts:81`, `:116` | **300–400** |
| 2 | Caminho do snapshot (14 sítios, ver 4.3) | `replication.ts` / `interest.ts` / `protocol.ts` | ~134 por rodada ÷ 3 ticks ≈ **45** |
| 3 | `RayHit` de `raycast` | `physics.ts:215` | 1 por raio |
| 4 | `senseRanges`: literal de condições + retorno | `zombieBrain.ts:1353-1355`, `perception.ts:167` | **12** |
| 5 | `structureBuild.push({x,y,r,kind,angle})` — **não poolado**, ao contrário do pool `lights` ao lado | `zombieBrain.ts:380` | 1 por estrutura acesa na janela |
| 6 | `normalizeClock` → `{day, dayTime}` | `src/shared/sim/clock.ts:106` | 1 |
| 7 | `encodeWorld` literal + `packets` + closure `flush` | `replication.ts:294`, `:309`; `protocol.ts:804`, `:811` | por flush (todo tick com eventos) |
| 8 | `pcall(() => {...})` closure | `mpHost.ts:391` | 1 por heartbeat |
| 9 | `randomRingPoint` → `v2()` | `world.ts:2103` → `vec2.ts:7` | até 12 por tentativa de spawn |
| 10 | `rebuildClusters`: `parent`, closure `find`, Map `byRoot`, 1 Cluster + `members:[]` por cluster | `population.ts:211, 214, 238, 246, 254` | a cada 60 ticks |
| 11 | `hearers`: `const dists: Array<number> = []` | `alert.ts:261` | ≤2 |
| 12 | `p95Ms()`: cópia de 300 + `sort` | `simulation.ts:245-248` | 1 por segundo (irrelevante) |

#### 4.3 O caminho do snapshot em detalhe (~134 tabelas por rodada, 20 rodadas/s)

`replication.ts:324` (`sim.players()` → array novo, `simulation.ts:159-166`), `:326` (array `interestPoints`),
`:167` (`interestPoint` ×6), `:186` (**`interestPoint(viewer)` construído uma segunda vez** apesar de já estar
em `points`), `interest.ts:108` (array `out` ×6), **`interest.ts:117` (closure comparadora nova a cada
`classify`, ×6)**, `interest.ts:115` (`InterestEntry` ×30), `replication.ts:185` (`others` ×6), `:148-159`
(`playerBlockOf` ×30), `:107-127` (`selfBlockOf` ×6), `:192-198` (`Snapshot` ×6), **`:196`+`:197`
(`zombies: []` e `bosses: []` — tabelas vazias alocadas mesmo assim, ×12)**, `protocol.ts:679` (`parts` ×6),
`codec.ts:220` (`buffer.create` por parte ×6), `protocol.ts:726` (literal de resultado ×6).
Além disso, `replication.ts:300` chama `this.sim.players()` **dentro** do laço de pacotes, e
`replication.ts:306` faz `this.directed.size() === 0`, que compila para varredura completa do Map, 60×/s.

#### 4.4 O cliente — onde o churn é 10× maior

| Fonte | Alocações | Onde |
|---|---|---|
| **`Camera.worldToScreen` devolve uma tabela nova por sprite desenhado** | ~1.500–3.000 por frame → **90 mil–720 mil/s** conforme o FPS | `src/shared/engine/camera.ts:88-105`, chamado em `renderer.ts:160` |
| **Literal de opções por chamada de desenho** (`{w, h, color, zIndex, …}`) | outras ~1.500–3.000 por frame | os ~47+ sítios em `gameLoop.ts`, `survivorView.ts`, `drawKit.ts` |
| `Color3.Lerp` dentro do laço de desenho | ~300–600 por frame | `gameLoop.ts:1512`, `:1513`, `:1550`, `:1551`, `:1585`; `survivorView.ts:132`, `:140`, `:258` |
| `LightMap.writeStrip`: `Array<NumberSequenceKeypoint>` + `NumberSequence` por faixa reescrita | até 360 por frame | `renderer.ts:801-810` |
| `GameLoop.shadowOffset` devolve `{x, y}` novo | 1 por ator | `gameLoop.ts:739-748` (compare com o scratch de `drawKit.ts:85-105`) |
| `UDim2.fromOffset` ao escrever `Position`/`Size` | 2 por sprite **que se moveu** | `renderer.ts:318`, `:323` — **piso inevitável**, a API exige `UDim2` |

**A conclusão que reordena a pergunta:** o caminho de desenho do cliente gera algo como **10 a 20 vezes** mais
tabelas por segundo que o `moveActor` do servidor. E como hoje o cliente também roda a IA inteira (fato 2 do
contexto), ele paga os dois. O `moveActor` continua valendo corrigir — mas se a escolha for uma só, é o
`worldToScreen`.

#### 4.5 Evidência de que GC importa aqui, medida

Rodando `node tools/test-ai.mjs --tick` nesta máquina, as fases com média de 0,004–0,04 ms registram "piores
passos" de 2 a **37 ms**, em fases *diferentes* a cada execução. `node --trace-gc` confirma a causa:
**67 scavenges na execução, com pausas de 1,08 a 22,82 ms**. São pausas de GC caindo dentro da janela `lap()`
que por acaso estava aberta, não custo da fase.

Isso é V8, não Luau — mas é a demonstração empírica do mecanismo que a tag `GC` do MicroProfiler descreve, num
código cuja taxa de alocação é a nossa. O GC do Luau é mark-and-sweep incremental e não amortiza objetos
efêmeros tão bem quanto o scavenger geracional do V8; se o churn causa pausas visíveis lá, não vai ser melhor
aqui.

#### 4.6 O pool de `Frame`s nunca encolhe

`hide()` (`renderer.ts:288-293`) escreve `Visible = false` e nada mais: `Parent` não muda, nada é destruído, e
`Destroy` não aparece uma única vez em `renderer.ts`. O array só cresce (`:243-251`, sem teto). **O pico de
sprites de uma sessão vira a contagem permanente de `Frame`s**, e cada sprite pode carregar um `UICorner` e um
`UIStroke` (`:348`, `:359`) — até 3 Instances por sprite, também nunca destruídas. Idem as faixas do light map
(`:552`).

Isto não é errado — é o preço normal de um pool, e destruir/recriar seria pior (add/remove de descendente é
gatilho de invalidação, e "Rebuild Z-order list" manda evitar mudança de parent). Mas precisa ser **medido**:
um `GetMemoryUsageMbForTag(Gui)` subindo e nunca descendo numa sessão longa é o sinal de que falta um `trim()`
fora de combate. Hoje ninguém olha.

#### 4.7 O que já está certo, e é bastante

Confirmado por leitura do TypeScript **e** do Luau compilado: **nenhum** `.map`/`.filter`/`.forEach`, nenhum
spread `...`, nenhum `table.create`, nenhum `Vector2`/`Vector3`, nenhum varargs, nenhuma concatenação de
string em caminho quente, em `zombieBrain.ts`, `combat.ts`, `replication.ts` e `codec.ts`. Todo `for...of`
sobre array compila para `for _, x in tbl do` **sem alocar iterador**.

Buffers reusados (todos verificados): `zombieBrain.ts:43-49`, `:70-71` (pool `lights`), `:88-89` (double
buffer `structureLights`), `:467-470` (`probeFree` içado para o módulo, com o comentário "no closure per
call"); `spatialHash.ts:23-26` (pool de buckets); `flowField.ts:114` (pool de arrays de tile) e `:126`
(`solidsBuf`); `physics.ts:42`, `:178`; `combat.ts:286-294`; `simulation.ts:145-152` (`roster` em cache,
reconstruído só em join/leave); `replication.ts:316-334` (membros pré-alocados); `flank.ts:58` (grade zerada
in-place); `vec2.ts` inteiro com `out` mutável.

**A simulação foi escrita com consciência de alocação. O renderer não.**

#### 4.8 Vazamentos de conexão — o risco que a doc mais enfatiza, e que não auditamos

A doc de "improve performance" é enfática: "The engine never garbage collects events connected to an instance
and any values referenced inside the connected callback", com alerta específico para `Player` e personagem
depois que o jogador sai. Temos 74 `.Connect(` no `src/`. Não auditei desconexão caso a caso — está fora do
escopo desta pesquisa, mas é o único item desta lista que causa **crash**, não lentidão.
**Sugestão:** auditoria dedicada de ciclo de vida de conexões.

---

## 5. Streaming e instâncias num jogo sem mundo 3D

### Veredito: streaming **não se aplica**. Três coisas adjacentes se aplicam

**5.1 Instance streaming: não faça, e a doc diz por quê.** "Streaming logic and features apply exclusively to
instances that are descendants of Workspace", e a doc lista explicitamente GUI/ScreenGui e `ReplicatedStorage`
entre o que **não** é elegível. Nosso `Workspace` tem apenas `FilteringEnabled` (`default.project.json`) —
nenhuma `Part`. `StreamingEnabled` não faria absolutamente nada.

**5.2 O princípio por trás do streaming, esse sim, já é o nosso.** Culling e LOD são as ideias que sobrevivem
à ausência de mundo 3D, e estão em duas camadas: culling de desenho (~22 testes de viewport, seção 2) e LOD de
frequência da IA (30 / 15 / 7,5 Hz por anel, `src/shared/sim/ai/perception.ts:84-100`) com anéis de interesse
na replicação (`src/server/net/interest.ts`). A conclusão aqui é "já fazemos" — **mas ver C4 e C5 abaixo: o
LOD rende muito menos do que o orçamento supõe, e seus números estão duplicados em dois arquivos.**

**5.3 `ContentProvider:PreloadAsync` — em uso, e do jeito certo.** `src/client/ui/skin.ts:449` pré-carrega os
13 asset IDs de skin (`skinAssets.ts:32-56`) e `src/client/audio/audio.ts:287` os sons. A doc de "design for
performance" diz para pré-carregar apenas "loading screen images, important menu assets, and starting area
assets" — 13 texturas 9-slice de UI é exatamente esse escopo. `skin.ts:439` usa `holder.Parent =
ContentProvider` e destrói as probes em `:453`. Nada a mudar.

**5.4 A contagem de instâncias a vigiar não é de `Part`, é de `Frame`.** A doc trata contagem de instâncias no
contexto de `FastCluster` e modelos 3D, que não nos atinge; mas `Stats.InstanceCount` e
`Enum.DeveloperMemoryTag.Instances` valem igual, e no nosso caso o que os move é o pool de sprites (4.6). Já
existe um contador caseiro (`ctx.screen.GetDescendants().size()` a 1 Hz, `world.ts:737-740`);
`Stats.InstanceCount` é mais barato e cobre a árvore inteira.

---

## 6. O que as medições atuais realmente dizem (e o que não dizem)

Números medidos **nesta máquina, sob Node**, com `node tools/test-ai.mjs --tick` (duas execuções):

| Cenário | avg | p95 | p99 | clock | population | field | zombies | bosses | book |
|---|---|---|---|---|---|---|---|---|---|
| 6 juntos | 1,99 / 1,81 ms | 3,65 / 3,20 | 6,26 / 6,80 | 0,014 | 0,028 | 0,325 | **1,567** | 0,006 | 0,031 |
| 6 espalhados | 1,88 / 2,14 ms | 3,66 / 4,37 | 6,18 / 8,91 | 0,011 | 0,039 | **0,453** | 1,330 | 0,003 | 0,031 |

Campo: 47 tiles / 10 655 células (juntos); 179 tiles / 40 031 células (espalhados) — bate com a tabela de
`docs/MULTIPLAYER.md:295-297`.

`node tools/test-server-sim.mjs` (o outro bench: **com** replicação real, **sem** zumbis): avg 0,029 ms,
p95 0,067 ms, p99 0,204 ms, downstream 1,18 KB/s por cliente.

**O que `--tick` NÃO mede** (e por que nenhum destes números é um veredito):

1. **Roda em Node/V8 sobre TypeScript transpilado, nunca em Luau.** O loader (`tools/test-ai.mjs:298-314`) usa
   `ts.transpileModule` — **o `out/` compilado nunca é tocado**, então nenhum codegen do roblox-ts é
   exercitado (arrays 1-based, semântica de `table`, runtime `TS.array_*`).
2. **O runtime Roblox é shimado** (`:60-89`, `:122-174`, `:185-274`): `Array.prototype.remove/insert` viram
   `splice` (aloca em JS, não em Luau), `buffer` é `Uint8Array` com checagem de faixa (mais estrito e lento
   que o `buffer` Luau), `math.random` vira mulberry32 semeado.
3. **Zero replicação.** `serverScene` nunca atribui `sim.onTick`, então `simulation.ts:216` é no-op. Interesse,
   `encodeSnapshot`, codec, lote World, `FireClient` e contabilidade de bytes ficam todos de fora — e §3.2
   orça **1,0 ms (0,33 amortizado)** exatamente para essa linha (`docs/MULTIPLAYER.md:270`).
4. **Zero combate, zero anel de histórico, zero anti-cheat** — as linhas de 0,3 / 0,05 / 0,05 ms de §3.2.
5. **Zero custo de DataModel:** nada de `SetAttribute`, nada de serialização de RemoteEvent, nada de
   `ScreenGui`/`Frame`.
6. **JIT e GC geracional do V8 distorcem tudo que envolve alocação** (ver 4.5). O aquecimento de 120 ticks
   (`:1102`) existe para o TurboFan subir de tier; Luau não tem equivalente.
7. **O cenário diverge de §3.2:** os 6 sobreviventes **nunca recebem comando** — `takeCommand` devolve o
   `STANDING` de módulo porque `sp.started` é sempre falso (`players.ts:387-390`) —, então ficam parados os
   1800 ticks. Zero chefes, contra os "150 zumbis + 2 chefes" de `docs/MULTIPLAYER.md:19`. Hora 18,2 h em vez
   das 22 h do cenário (2).
8. **O alvo de 6 ms nunca é verificado em lugar nenhum.** A única asserção é `p95 < 16.7`
   (`tools/test-ai.mjs:1149`), e o CI roda `npm run test:ai` sem `--tick`. `--tick` também não está no
   `package.json` nem no bloco de uso do próprio arquivo (`:5-9`).
9. **Se um módulo falhar ao resolver, `optional()` engole o erro em silêncio** (`:326-333`) e o comando sai 0
   tendo medido nada.

**Os dois benches são complementares e nenhum cobre o tick de §3.2 inteiro:** `test-ai --tick` é horda sem
rede; `test-server-sim` é rede sem horda. Nada no repositório mede os dois juntos, e nada mede Luau. O próprio
harness diz isso (`:1147-1148`): "a regression guard, not the Luau verdict... The real number comes from a
Studio playtest".

---

## 7. Hot loops que ainda não doem porque o código não está ligado

Estes não estão no caminho crítico de hoje (fato 1 do contexto), mas entram inteiros na F2. Registrados aqui
para não serem descobertos sob carga.

**7.1 `combat.ts` não tem broad phase, e a ferramenta existe sem uso.**
Seis varreduras lineares completas da lista de zumbis: `:423` (history, O(N)/tick), `:736` (`fireStun`,
**O(3·N)** com `segmentClear` *dentro* da varredura → até 450 raycasts por tiro), `:892` (`sweep`), `:953`
(`updateChainsaw`, **O(N) todo tick, sem gate de cadência** — `:382` retorna antes da cadência), `:1039`
(`prepareTargets`, O(N) **por tiro** e **cego a alcance**: rebobina todo zumbi do mapa mesmo para uma pistola
de 600 u), `:1078` (`trace`, O(N) **por pellet**). Seis escopetas no mesmo tick = ~4 560 `rayCircle` +
912 iterações de rewind.
  **E `ZombieWorld.zombiesNear` — a única consulta por hash espacial do lado do servidor — está definida em
  `src/server/sim/zombies.ts:344` com zero chamadores.** A correção de `prepareTargets` e `trace` é usar o que
  já está escrito. **Prioridade: alta na F2. Esforço: baixo.**

**7.2 O flow field tem trabalho fora do orçamento.**
`startRebuild` (`flowField.ts:277-352`) faz ativação de tiles, tabela de vizinhos, `ensureGrid`/rasterização e
`acquire` de dois buffers por tile **tudo de uma vez**, fora do `step(budget)`. E `zombies.ts:234` faz
`this.field.step(1e9)` — um Dijkstra inteiro num tick — sempre que o campo ainda não é válido. São duas fontes
de pico de p95 que o orçamento de 2 ms não cobre.

**7.3 `startJump` estoura o orçamento de LOS.**
`zombieBrain.ts:928` dispara **até 15 raycasts + 15 `circleBlocked` num único tick** (3 comprimentos ×
5 ângulos, `:900-901`), fora do `LOS_BUDGET = 24`. Outros três raycasts também escapam do orçamento:
`chaseHeading:532`, `thinkSpitter:769`, `thinkCharger:879`.

**7.4 `zombieRadius` é varredura linear, chamada por par candidato.**
`src/shared/game/entities.ts:129-131` chama `zombieDef`, que varre 5 definições (`shared/data/zombies.ts:93-98`).
`computeSeparation` chama em `:589` (por zumbi) **e `:595` (por par candidato)** → ~750–1 500 varreduras por
tick. Memoizar o raio por tipo é trivial.

**7.5 `population.update` roda O(N·P) todo tick.**
`cleanup` (`population.ts:434-466`, via `nearAnyPlayer` `:416-421`) e `spawnBoss` (`:472-494`, com `sqrt` por
par) rodam **todo tick**; `rebuildClusters` (`:209-271`) é O(P²) + **O(N·P)** a cada 1 s; `updateDirector`
(`:369-413`) é O(N × membros) = 900 a cada 0,25 s.

**7.6 Duas bombas-relógio de correção (não de desempenho) na tabela de interesse.**
`InterestTable.key(viewer, target) = viewer * MAX_PLAYERS + target` (`interest.ts:67`) só é livre de colisão
para `target < 6`; netIds de zumbi são 1..65535 (`mpConfig.ts:93-94`). E `forget` (`interest.ts:84-89`) itera
só `0..MAX_PLAYERS`, então nunca conseguiria despejar um alvo zumbi. **Fora do escopo desta pesquisa, mas
encontrado nela** — vale um item próprio antes da F2-2D.

---

## Faça agora

| # | O quê | Arquivo:linha | Esforço |
|---|---|---|---|
| 1 | `if` antes de `darkLayer.BackgroundTransparency = 1` — invalida o `ScreenGui` inteiro todo frame, de graça | `src/client/gameLoop.ts:2053`, `:2103` | trivial |
| 2 | `worldToScreenInto(out, …)`: mata ~1.500–3.000 tabelas por frame | `src/shared/engine/camera.ts:88-105` → `src/shared/engine/renderer.ts:160` | baixo |
| 3 | Linhas de `Stats` no card de debug (`UI2DDrawcallCount`, `UI2DTriangleCount`, `RenderCPU/GPUFrameTime`, memória `Gui`/`LuaHeap`) | `src/client/admin/world.ts:733-751` + `src/client/admin/adminClient.ts:250-264` | baixo |
| 4 | `debug.profilebegin` separando `update` / `render` / `pushHud` (arquivo client-only: sem shim) | `src/client/main.client.ts:514-546` | trivial |
| 5 | Corrigir o p95: amostrar por tick, não a média por heartbeat | `src/server/net/mpHost.ts:398` + `src/server/sim/simulation.ts:179-196`, `:227` | baixo |
| 6 | Ligar `horde.nowMs` no host e publicar as 6 fases como atributos (condicional a `sim.horde !== undefined`) | `src/server/net/mpHost.ts:396-405`; encaixe em `src/server/sim/zombies.ts:96-98`, `:248-255` | trivial |
| 7 | Colocar `--tick` no `package.json` e asserir o alvo real de §3.2, não só `p95 < 16.7` | `package.json:15`, `tools/test-ai.mjs:1149` | trivial |
| 7b | Unificar os seis números do LOD: `perception.ts` deve importar de `mpConfig.ts`, ou `mpConfig.ts` deve parar de declará-los (hoje são duplicados e a cópia do `mpConfig` não tem consumidor — C5) | `src/shared/net/mpConfig.ts:51-57` ↔ `src/shared/sim/ai/perception.ts:84-100` | trivial |
| 8 | Rodar o experimento 3.6 no MicroProfiler **antes** de mexer em qualquer coisa da seção 2 | — | 1 playtest |

## Faça quando doer

| O quê | Gatilho | Arquivo:linha |
|---|---|---|
| Usar `zombiesNear` em `prepareTargets`/`trace`/`fireStun` — broad phase que já existe sem uso | F2 ligar o combate no servidor | `src/server/sim/zombies.ts:344`; `combat.ts:736`, `:1039`, `:1078` |
| Gate de cadência no `updateChainsaw` | idem | `combat.ts:382`, `:953` |
| Separar HUD/UI num `ScreenGui` próprio | O experimento 3.6 mostrar `UpdateUILayouts` caindo com a separação | `src/client/bootstrap.ts:55-101` |
| Trocar `TextScaled` por `TextSize` calculado no resize | `UpdateUILayouts/Layout` aparecer alto | `src/client/ui/skin.ts:107-111`; padrão certo em `nameplate.ts:169-171` |
| Tirar `AutomaticSize` de plaquetas e balões | idem | `nameplate.ts:53`, `:91`; `chatBubbles.ts:265`, `:301`, `:320` |
| Subir `STRIP_H` do light map de 6 para 8–10 | `fillGuiVertices` alto, ou queixa em 1440p/4K | `src/shared/engine/renderer.ts:416` |
| `--!native` via passo pós-build em `out/` | A horda migrar para o servidor e o tick p95 real encostar em 6 ms | novo `tools/`, molde de `tools/check-registers.mjs` |
| `moveActorInto` + out-param em `resolveCircle` | `pz_cost_zombies` dominar o tick | `src/shared/game/physics.ts:81`, `:116` |
| Memoizar `zombieRadius` por tipo | idem | `src/shared/game/entities.ts:129-131`; chamadores `zombieBrain.ts:589`, `:595` |
| Pôr `startRebuild` e o `step(1e9)` dentro do orçamento | Picos de p95 no campo | `flowField.ts:277-352`; `zombies.ts:234` |
| Trazer os raios de `startJump` para o `LOS_BUDGET` | idem | `zombieBrain.ts:900-901`, `:928` |
| Memoizar os `Color3.Lerp` do laço de desenho | `LuaHeap` subindo / picos de `GC` no MicroProfiler | `gameLoop.ts:1512-1513`, `:1550-1551`, `:1585`; `survivorView.ts:132`, `:140`, `:258` |
| Tirar `sim.players()` e o `directed.size()` de dentro do laço de pacotes | `pz_out_Bps` ou o tick subirem com 6 clientes | `replication.ts:300`, `:306` |
| Objetos de opção constantes por sítio de desenho (~47 sítios) | Depois de 2 e da memoização, se o `GC` ainda aparecer | `gameLoop.ts`, `survivorView.ts` |
| `trim()` do pool de sprites fora de combate | `GetMemoryUsageMbForTag(Gui)` subir e nunca descer | `renderer.ts:288-293` |
| Shim de `debug` nos 10 `tools/test-*.mjs`, liberando rótulos nos módulos puros | O item 6 apontar uma fase suspeita | `tools/test-*.mjs` |

## Não faça, e por quê

| O quê | Por quê |
|---|---|
| **`Actor` / `task.desynchronize` na horda** | Seis bloqueios mecânicos, todos verificáveis: `querySolids` muta o mundo (`world.ts:300`, `:310`, ~300–500×/tick); a passada é Gauss-Seidel e zumbis leem/escrevem uns aos outros (`zombieBrain.ts:691-697`, `:295-302`, `:341`); dois orçamentos globais são consumidos em ordem de índice (`:1344-1345`); `math.random` é consumido em ordem estrita de índice e qualquer sharding muda todo saque do jogo; catorze locais mutáveis de módulo; e `SharedTable` não carrega `Solid`/`ZombieState`. Detalhe na seção 1. |
| **`CanvasGroup` no mundo** | "Consumes extra texture memory", limitado pelo `QualityLevel`, e "when exceeding the memory cap, CanvasGroup will render as a blank texture". Um mundo que muda todo frame refaria a textura todo frame. Risco de tela em branco no celular. |
| **`ZIndexBehavior.Global`** | `Sibling` (o default, e o que usamos) evita ordenar todos os descendentes por `ZIndex`. `Global` é a versão cara do que já funciona. |
| **`StreamingEnabled`** | A doc exclui GUI e tudo fora de `Workspace`. Nosso `Workspace` não tem uma `Part`. Efeito literalmente nulo. |
| **`LuaTuple` para matar a alocação de `moveActor`** | Exige o runtime `$tuple` do roblox-ts e quebraria os dez harnesses de Node. O scratch + `…Into(out, …)` dá o mesmo zero-alocação nos dois runtimes, e já é padrão do projeto (`drawKit.ts:85-105`, `vec2.ts`). |
| **`Vector2`/`Vector3` nativos em `shared/sim`** | Sem shim nos harnesses; e `vec2.ts` já usa `out` mutável, que o `Vector2` imutável não permitiria. (Mesma conclusão de `docs/research/engine-apis.md` §6, por motivos independentes.) |
| **Destruir sprites ociosos em vez de escondê-los** | Add/remove de descendente é um dos três gatilhos de invalidação do `LayerCollector`, e "Rebuild Z-order list" manda evitar mudança de parent. `Visible = false` é o certo. |
| **Tratar o número do `tools/test-ai.mjs --tick` como veredito de Luau** | Roda sob Node/V8, sem replicação, sem combate, com jogadores parados e com o `out/` nunca tocado. Ótimo para pegar um O(n²) acidental; não serve para decidir `SIM_HZ`. Ver seção 6. |

---

## Avaliado e descartado (um motivo por linha)

- **`--!native` no cliente** — a doc é explícita: "applies exclusively to server-side scripts".
- **`SharedTable` como estrutura geral de estado** — só aceita Boolean/Number/Vector/String/SharedTable, e a
  própria doc diz que `update` é bem mais lento que `increment`; nossas entidades não cabem.
- **`ConnectParallel`** — mesmo bloqueio do `Actor` (exige raiz sob `Actor`), sem caso de uso com interface
  pequena o bastante.
- **Paralelizar só a separação ou o `updateCrowd`** — são as duas únicas fases genuinamente Jacobi
  (`zombieBrain.ts:1370-1371`), mas somam ~0,3 ms de um orçamento de 3,5 ms. Não pagam a fronteira.
- **`ScrollingFrame` como suspeito** — existe num único sítio (`widgets.ts:1707`), usado só na mochila e no
  painel de admin, nunca no HUD nem no mundo.
- **Sprite sheet / `ImageRectOffset`** — zero ocorrências e não faz falta: o mundo é `Frame` +
  `BackgroundColor3`, sem uma textura. Adotar traria `LoadImage` e memória de textura para resolver um
  problema que não temos.
- **`UIGradient` no HUD** — só 4 vinhetas (`hud.ts:772`). O volume está todo no light map (2.3).
- **`RichText`** — zero em jogo (só `lobby.ts:208` e `logo.ts:21`), explicitamente `false` nos balões
  (`chatBubbles.ts:330`).
- **Limite de payload do `UnreliableRemoteEvent`** — a doc diz "Events with payloads larger than 1000 bytes
  are dropped"; já tratado: `UNRELIABLE_PAYLOAD_LIMIT = 1000` e `UNRELIABLE_MAX_BYTES = 900`
  (`mpConfig.ts:141-144`), com snapshot fatiado em partes de ≤ 900 B (`protocol.ts:6-23`). Verificado, nada a
  fazer.
- **`p95Ms()` alocar cópia e ordenar** — `simulation.ts:242-249`, mas roda 1×/s (`METRIC_INTERVAL = 1`,
  `mpHost.ts:61`). Irrelevante.
- **`table.create` em `flowField.acquire`** — `flowField.ts:166-174` faz `new Array` + 256 pushes só quando o
  pool está vazio (fase de crescimento). Trocar exigiria shim nos harnesses para ganho em código frio.
- **`Map.clear()` por tick no hash espacial** — `spatialHash.ts:39-42`; é `table.clear`, e os buckets são
  reciclados. Correto como está.
- **Fechamento `lap` criado por tick** — `zombies.ts:250`, uma closure a 60 Hz. Desprezível.
- **`querySolids(...).size()` no card de stats** — `world.ts:746` aloca, mas só com o card ligado, a 4 Hz.
- **`debug.setmemorycategory`** — útil para separar threads no console de memória; temos poucas threads longas
  e o ganho diagnóstico é menor que o de `Stats` por tag. Reavaliar se a memória virar problema.
- **`Humanoid`, `PathfindingService`, fidelidade de colisão, draw calls de mesh, `RenderFidelity`, física
  adaptativa** — a maior parte da página "improve performance" trata de mundo 3D. Não temos nenhum deles.

---

## Contradições entre a doc (ou a medição) e o que já escrevemos

**C1. A estimativa de `--!native` é otimista para a nossa saída de transpiler.**
`docs/MULTIPLAYER.md` §3.3 estima "~2 µs/célula interpretado (~0,7–1 µs com `--!native`)" — 2–3×. A doc de
código nativo diz que parâmetros sem tipo desotimizam, e roblox-ts apaga todos os tipos (verificado em
`out/shared/game/physics.luau`). Medir com o Script Profiler, que marca funções nativas com `<native>`.

**C2. A quebra por etapa de §12.2 existe e está morta.**
§12.2 promete "`os.clock()` por etapa, num anel de 300 amostras". O anel existe (`simulation.ts:227-249`) e os
atributos existem (`mpHost.ts:401-405`), mas `horde.nowMs` só é atribuído em `tools/test-ai.mjs:1101` — no
servidor vivo os seis contadores de `zombies.ts:98` são sempre zero.

**C3. O p95 que decide `SIM_HZ` é medido com viés para baixo.**
§3.2/§12.2 fixam "tick p95 ≤ 6 ms" e fazem `SIM_HZ` depender disso. O `pz_tick_p95_ms` publicado é o p95 das
médias por heartbeat (`mpHost.ts:398` divide por `ran`), não dos ticks.

**C4. O LOD de IA rende 19%, não o que a ordem das alavancas de §3.2 supõe.**
`docs/MULTIPLAYER.md:274` lista "LOD de IA mais agressivo" como a segunda alavanca. Medido com
`tools/test-ai.mjs --bench`: 150 zumbis no anel perto (30 Hz) custam 0,849 ms/frame; 150 no anel longe
(5–10 Hz) custam 0,686 ms — **19% de economia**, não 3–6×. A causa é que o LOD gate **só** o re-plano de rumo
(`navDue`, `zombieBrain.ts:478-483`, com dois chamadores: `chaseHeading:529` e `gotoHeading:561`). Rodam todo
tick, para os 150, seja qual for o anel: decaimento de timers (`:1122-1128`), `perceive` + `Mind.think`
(`:1153`), `updateJam`/`pathCells` (`:1157`), os `think*` por tipo (`:1196-1198`), **`steer` chamado direto
sem `navDue`** (`:1216`, `:1222`, `:1230`, `:1233`, até 7 `circleBlocked` cada), `moveActor` (`:1266`),
`findTrap` → `querySolids` (`:1323`) e `faceAndAnimate` (`:1327`).
→ Se o LOD for a alavanca escolhida, ela precisa gate mais que `navDue` — senão a ordem de §3.2 precisa mudar.

**C5. Os seis números do LOD estão duplicados, e a cópia que o documento cita é a que ninguém lê.**
`src/shared/net/mpConfig.ts:51-57` declara `AI_NEAR_HZ = 30`, `AI_MID_HZ = 15`, `AI_FAR_HZ_MIN/MAX = 5/10`,
`AI_NEAR_RANGE = 800` e `AI_MID_RANGE = 1600` — e **nenhum dos seis tem um único consumidor em `src/`**
(grep confirmado). O LOD real vive em `src/shared/sim/ai/perception.ts:84-100`, com constantes próprias
`LOD_NEAR = 800` / `LOD_MID = 1600` e taxas 30 / 15 / 7,5 Hz em `decisionInterval` (`:89-93`) e `losInterval`
(`:96-100`).
O comportamento está correto; o problema é que o cabeçalho de `mpConfig.ts:2-4` se declara fonte única
("Every number below comes from the doc... Change the doc and this file together") e, para o LOD, não é. Mudar
`AI_MID_HZ` hoje não muda nada no jogo.

**C5b. O anel `far` é quase inalcançável de qualquer forma.**
`population.cleanup` recicla qualquer zumbi vivo fora de `DESIGN.ZOMBIE_SPAWN_MAX = 1080 u` de todo
sobrevivente (`src/shared/sim/ai/population.ts:437`, `src/shared/engine/constants.ts:36`), abaixo do
`LOD_MID = 1600` que define a fronteira do anel longe.

**C6. O orçamento de §3.2 descreve um tick que ainda não existe.**
§3.2 orça dez etapas. Hoje o tick roda **duas** (entrada/movimento de 6 jogadores e replicação): a horda não é
construída (`simulation.ts:129` + `mpHost.ts:143`), e `combat.ts`, `history.ts` e `progress.ts` não têm call
site em `src/`. As fases 3 (anel de histórico) e 5 (anti-cheat/métricas) de `docs/MULTIPLAYER.md:252-254` não
existem no tick. Não é erro do documento — ele descreve a F2 —, mas explica por que `pz_tick_avg_ms` hoje é
~0,03 ms e por que esse número não diz nada sobre o orçamento.
