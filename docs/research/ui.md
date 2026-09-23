# Auditoria: UI (ScreenGui, escala, texto, 9-slice, acessibilidade)

Escopo: `src/client/bootstrap.ts`, `src/client/ui/**` (`skin.ts`, `skinAssets.ts`, `widgets.ts`, `theme.ts`,
`themeTokens.ts`, `hud.ts`, `nameplate.ts`), `src/client/view/{chatBubbles,allyPlate}.ts`,
`src/shared/engine/{renderer,input}.ts`, `src/client/admin/{adminClient,patches,controls}.ts`.

Confrontado com:

- Visão geral: https://create.roblox.com/docs/ui
- Contêineres de tela: https://create.roblox.com/docs/ui/on-screen-containers
- Posição e tamanho (ZIndex, fatores multiplataforma): https://create.roblox.com/docs/ui/position-and-size
- Modificadores de tamanho (AutomaticSize, constraints): https://create.roblox.com/docs/ui/size-modifiers
- 9-slice: https://create.roblox.com/docs/ui/9-slice
- Modificadores de aparência (UIStroke): https://create.roblox.com/docs/ui/appearance-modifiers
- Desenvolvimento multiplataforma: https://create.roblox.com/docs/projects/cross-platform
- Design adaptativo: https://create.roblox.com/docs/production/publishing/adaptive-design
- Acessibilidade: https://create.roblox.com/docs/production/publishing/accessibility
- Referência: `ScreenGui`, `LayerCollector`, `GuiObject`, `TextLabel`, `ImageLabel`, e os enums
  `ZIndexBehavior`, `ScreenInsets`, `SafeAreaCompatibility`, `AutomaticSize`, `ResamplerMode`
  (texto exato lido em https://github.com/Roblox/creator-docs/tree/main/content/en-us/reference/engine ,
  que é a fonte das páginas de referência — as páginas renderizadas não entregam o texto por fetch).

Classificação usada em cada achado: **ERRO** (contra a doc), **OPORTUNIDADE** (a doc oferece algo melhor do
que fazemos), **DECISÃO NOSSA** (a doc não cobre; registramos a exceção) e **CORRETO** (confere com a doc;
listado para não ser "consertado" por engano).

Nota de premissa: o enunciado da pesquisa dizia "usamos `UIScale` + espaço de design fixo". **Não é o que o
código faz.** Existem só 3 `UIScale` no projeto e os três são animação local (ver achado 1.1). A escala real é
um sistema próprio (`uiScale()` em `skin.ts:59`) + `UDim2.fromScale` + `UIAspectRatioConstraint`. Vários
achados abaixo dependem dessa correção.

---

## 1. Escala e telas

### 1.1 Como escalamos de verdade — **DECISÃO NOSSA** (compatível com a doc)

**Regra da doc:** posicionar e dimensionar por `Scale` (percentual), não por pixels, porque "pixels can vary
arbitrarily by both number and density across devices". `UIScale` é apresentado como ferramenta de zoom de
edição e de *tween* (hover de botão), não como mecanismo de resolução independente.

**Achado:** o kit declara uma caixa de design por objeto (`setDesign`, `widgets.ts:144`) e converte tudo para
`UDim2.fromScale(x/dw, y/dh)` (`widgets.ts:150-155`); a tela inteira é um `Body` com
`UIAspectRatioConstraint` de 1120/630 (`widgets.ts:1305-1306`, helper `addAspect` em `widgets.ts:188-195`).
Separadamente, `uiScale()` (`skin.ts:59-62`) devolve "px de tela por unidade de design" e alimenta o tamanho
de texto, a espessura de traço e o `SliceScale`. Os 3 `UIScale` reais são efeitos transitórios:
`hud.ts:740` (pop do banner), `nameplate.ts:110` (pop de level-up), `widgets.ts:1430` (zoom de entrada do
modal, 0.95 → 1).

- **Classificação:** DECISÃO NOSSA, alinhada com a doc. Layout por `Scale` é exatamente o recomendado, e o uso
  de `UIScale` só para tween é literalmente o exemplo da doc.
- **Prioridade:** —  (nenhuma ação; registrar para não "migrar para UIScale" achando que é o padrão)
- **Arquivo:linha:** `src/client/ui/widgets.ts:144-155`, `src/client/ui/skin.ts:59-62`
- **Link:** https://create.roblox.com/docs/ui/size-modifiers

### 1.2 `IgnoreGuiInset = true` põe a UI interativa no inset errado — **ERRO**

**Regra da doc:** `ScreenInsets` controla a *safe area*. `CoreUISafeInsets` (o padrão) "keeps all descendant
GuiObjects inside the core UI safe area, clear of the top bar buttons and other screen cutouts. **This setting
is recommended if the ScreenGui contains interactive UI elements.**" O `IgnoreGuiInset` é descrito como um
atalho: quando `false` o `ScreenInsets` é `CoreUISafeInsets`; **ao virar `true`, o `ScreenInsets` passa a
`DeviceSafeInsets`** — que protege do *notch*, mas **não reserva nada para a barra superior do Roblox**.

**Achado:** os três `ScreenGui` do projeto setam `IgnoreGuiInset = true` e **nenhum** seta `ScreenInsets`:

- `src/client/bootstrap.ts:55-61` (`GameGui`, `DisplayOrder = 100`) — contém HUD, controles de toque, modais
- `src/client/admin/patches.ts:111-117` (`PZAnnouncements`, `DisplayOrder = 140`)
- `src/client/admin/adminClient.ts:57-63` (`PZAdmin`, `DisplayOrder = 150`)

Ou seja: toda a UI **interativa** do jogo roda em `DeviceSafeInsets`, contrariando a recomendação explícita da
doc, e a folga da barra superior é reimplementada à mão por `topInset()`
(`src/client/ui/skin.ts:41-50` e a cópia em `src/client/bootstrap.ts:130-139`), aplicada encolhendo o `Body`
(`widgets.ts:1308-1312`).

Vale dizer o que **não** está quebrado: como `DeviceSafeInsets` já garante que nada é ocluído por recortes de
tela, o *notch* está coberto pelo engine. O problema é (a) a barra superior virou responsabilidade nossa e (b)
`GetGuiInset()` só é lido no eixo Y (`skin.ts:42`, `bootstrap.ts:131`), então qualquer inset **horizontal** é
ignorado pelo nosso cálculo.

Isto também é a regra **UI-02** do nosso próprio `docs/DESIGN_RULES.md` ("Nada sob a barra do Roblox"):
hoje ela é cumprida por aritmética manual em dois arquivos, e não pela propriedade que o engine oferece para
exatamente isso.

- **Classificação:** ERRO (contraria recomendação explícita da doc para UI interativa)
- **Prioridade:** Alta
- **Esforço:** Médio (ver 1.3 — a correção certa é a mesma)
- **Arquivo:linha:** `src/client/bootstrap.ts:58`, `src/client/admin/patches.ts:114`,
  `src/client/admin/adminClient.ts:60`
- **Link:** https://create.roblox.com/docs/ui/on-screen-containers#screen-insets

### 1.3 Um único `ScreenGui` para mundo (não-interativo) e UI (interativa) — **ERRO**

**Regra da doc:** os valores de `ScreenInsets` existem justamente para separar camadas — `None` "should only
be used for a `ScreenGui` that contains **non-interactive content like background images**", e
`CoreUISafeInsets` para o que é interativo. Múltiplos `ScreenGui` se empilham por `DisplayOrder`. E a doc de
`SafeAreaCompatibility` é direta: "it's **recommended that you avoid fullscreen extensions for new work**;
instead, use the `ScreenInsets` property to specify which insets should be respected for different
`ScreenGuis`".

**Achado:** `GameGui` carrega, no mesmo contêiner, o `worldLayer` (mundo 2D, quer sangrar até a borda física)
e o `uiLayer`/`hudLayer` (interativos, querem safe area) — `src/client/bootstrap.ts:63-100`. Duas
consequências concretas, ambas de propriedades que **nunca setamos** e cujos defaults trabalham contra nós:

1. `ClipToDeviceSafeArea` (default `true`, 0 ocorrências no `src/`): o mundo é **recortado** na safe area do
   dispositivo. Num celular com recorte, o mundo não ocupa a tela inteira.
2. `SafeAreaCompatibility` (default `FullscreenExtension`, 0 ocorrências no `src/`): o *fundo* de um objeto
   que cobre a safe area inteira é esticado até a borda física, mas — texto da doc — "this expansion does
   **not** affect the size or position of the descendant's **content**". Como `Root` é um `Frame` com
   `BackgroundColor3 = COLORS.bg` em `fromScale(1,1)` (`bootstrap.ts:63-68`), a **cor de fundo** vaza até a
   borda enquanto os *sprites* do mundo param na safe area. É uma emenda visível, e é exatamente o mecanismo
   que a doc pede para não usar em trabalho novo.

**Correção documentada:** dois `ScreenGui`. Mundo em `ScreenInsets = None` + `ClipToDeviceSafeArea = false`
(conteúdo não-interativo, sangra até a borda); HUD/menus/toque em `ScreenInsets = CoreUISafeInsets` com
`DisplayOrder` maior. Isso também elimina o `topInset()` manual: o engine passa a reservar a barra superior, e
`ScreenGui.AbsoluteSize` já vem descontado (ver 1.4).

- **Classificação:** ERRO
- **Prioridade:** Alta
- **Esforço:** Médio (separar `worldLayer` para um `ScreenGui` próprio; remover a compensação manual de
  `topInset()` de `widgets.ts:1308-1312` e de `computeTouchLayout`)
- **Arquivo:linha:** `src/client/bootstrap.ts:55-100`
- **Links:** https://create.roblox.com/docs/ui/on-screen-containers#screen-insets ·
  https://create.roblox.com/docs/reference/engine/enums/SafeAreaCompatibility

### 1.4 Medimos a tela pelo `Camera.ViewportSize`, não pelo `ScreenGui.AbsoluteSize` — **OPORTUNIDADE**

**Regra da doc:** `ScreenInsets` define a área útil do `ScreenGui`; o `AbsoluteSize` do `LayerCollector` já
reflete o inset escolhido. `Camera.ViewportSize` é a resolução do viewport 3D e não sabe nada de safe area.

**Achado:** `viewportSize()` (`skin.ts:52-56`) e o `resize()` de `bootstrap.ts:186-208` leem
`Workspace.CurrentCamera.ViewportSize` e subtraem `topInset()` à mão. Se 1.2/1.3 forem corrigidos, essa
subtração vira erro duplo (o engine já descontou). Ler `screen.AbsoluteSize` resolve os dois casos e é
imune a mudanças futuras da barra superior.

- **Classificação:** OPORTUNIDADE
- **Prioridade:** Média
- **Esforço:** Baixo
- **Arquivo:linha:** `src/client/ui/skin.ts:52-62`, `src/client/bootstrap.ts:186-208`
- **Link:** https://create.roblox.com/docs/ui/on-screen-containers

### 1.5 `topInset()` e `1120`/`630` duplicados; dois sistemas de resize paralelos — **OPORTUNIDADE**

**Achado (manutenção, não é violação de doc):**

- `topInset()` existe idêntico em `src/client/ui/skin.ts:41-50` e `src/client/bootstrap.ts:130-139`.
- `DESIGN_W`/`DESIGN_H` são declarados em `skin.ts:32-33`, mas `1120`/`630` aparecem como literais em
  `bootstrap.ts:123-124`, `bootstrap.ts:187-188`, `onboarding/gameOver.ts:76`, `ui/pauseMenu.ts:58,145`,
  `ui/shop.ts:59`, `ui/settings.ts:36`. Mudar a resolução-base em `skin.ts` não propaga.
- Dois observadores independentes de `ViewportSize`: `watchCamera()/queueRefresh()` em `skin.ts:157-168`
  (governa texto, traços, `SliceScale`) e `resize()` em `bootstrap.ts:186-213` (governa câmera, renderer,
  layout de toque). Podem rodar em ordens diferentes no mesmo frame.

- **Classificação:** OPORTUNIDADE
- **Prioridade:** Média
- **Esforço:** Baixo
- **Arquivo:linha:** ver lista acima

### 1.6 `GuiService.ViewportDisplaySize` e *Style Queries* não usados — **OPORTUNIDADE**

**Regra da doc:** "attempting to predict screen size by pixels often leads to misinterpretation"; a doc
oferece `GuiService.ViewportDisplaySize` (`Small` = celular/tablet, `Medium` = laptop/monitor, `Large` = TV)
e, no pipeline de estilo, seletores intrínsecos como `@ViewportDisplaySizeSmall` e `@PreferredInputTouch`.

**Achado:** 0 ocorrências de `ViewportDisplaySize` no `src/`. Nossa adaptação por tamanho é toda derivada de
`short / 414` (`shared/engine/input.ts:229`) e de `screenShape()` (`input.ts:205`), que classifica por
proporção (`wide`/`classic`/`tablet`) e não por classe de dispositivo. Funciona para o toque, mas não
distingue "tablet" de "TV 4K" — exatamente o caso que a doc cita ("75% would render to a huge size on 4K TVs").

- **Classificação:** OPORTUNIDADE
- **Prioridade:** Média
- **Esforço:** Baixo (consultar + ouvir a propriedade e ajustar `uiScale()`/margens por classe)
- **Arquivo:linha:** `src/shared/engine/input.ts:205-234`, `src/client/ui/skin.ts:59-62`
- **Link:** https://create.roblox.com/docs/projects/cross-platform#screen-size-adaptation

---

## 2. `AutomaticSize` + `TextWrapped` + `UISizeConstraint`

### 2.1 Balões, nameplates e allyPlate seguem o caminho documentado — **CORRETO**

**Regra da doc:** com `AutomaticSize` ligado, "the object's `Size` property controls its **minimum size**";
para texto multi-linha, `Enum.AutomaticSize.Y` só funciona com `TextWrapped` ("Text objects will only resize
along the Y axis if their `TextWrapped` property is enabled"); e `UISizeConstraint` **sobrepõe** o layout
("the constraint will **override** the layout and control the object's size").

**Achado:** a implementação do balão de chat é o padrão da doc, item por item —
`AutomaticSize.XY` + `Size = UDim2.fromOffset(0, 0)` + `TextWrapped = true` + `UISizeConstraint.MaxSize` como
largura de quebra, com `TextSize` explícito (não `TextScaled`):
`src/client/view/chatBubbles.ts:300-337`, com o cap em `chatBubbles.ts:334-336` e o comentário certo na
linha 334 ("AutomaticSize grows the label to the text, the constraint decides where it folds").

**Armadilha clássica que evitamos:** `AutomaticSize` num eixo cujo `Size` tem `Scale != 0` cria realimentação
(o mínimo depende do pai, que depende do filho). A varredura completa não achou **nenhum** caso: todos os 8
usos de `AutomaticSize` no `src/` usam `fromOffset(0,0)`, e o único de eixo simples
(`ui/lobby.ts:396-397`, `AutomaticSize.X` com `Size = fromScale(0, 1)`) tem `Scale = 0` justamente no eixo
automático.

- **Classificação:** CORRETO — usar como referência ao mexer em outras telas
- **Arquivo:linha:** `src/client/view/chatBubbles.ts:300-352`, `src/client/ui/nameplate.ts:49-64,91-92`,
  `src/client/admin/controls.ts:216-229`, `src/client/ui/widgets.ts:1716-1717` (`AutomaticCanvasSize`)
- **Link:** https://create.roblox.com/docs/ui/size-modifiers#automatic-sizing

### 2.2 Recalcular offsets no resize é obrigatório e está feito — **CORRETO**

`AutomaticSize` mede conteúdo em offsets reais, então todo valor em unidade de design precisa virar px a cada
mudança de tela. `onLayoutChange` (`skin.ts:171-175`) faz isso para `CornerRadius`, `UIPadding`, `TextSize` e
`MaxSize` do cap — `chatBubbles.ts:339-350`, `nameplate.ts:157-171`, `allyPlate.ts:140-147`. Correto.

Ressalva: esse recálculo escuta `ViewportSize` e `TopbarInset` (`skin.ts:164-168`), mas **não**
`GuiService.PreferredTextSize` — ver achado 6.3.

### 2.3 O resto da UI não usa `AutomaticSize`; usa `TextScaled` — **OPORTUNIDADE**

**Regra da doc (verbatim, em `TextLabel.TextScaled`):** a doc recomenda usar `AutomaticSize` no lugar de
`TextScaled`, "as it resizes the UI to fit content while maintaining consistent font size, rather than scaling
text smaller which may reduce readability".

**Achado:** fora dos 3 casos do item 2.1, nada no kit usa `AutomaticSize`. Toda label passa por `scaleText()`
(`widgets.ts:372`, `widgets.ts:693`, `widgets.ts:388`), que liga `TextScaled`. Isso é a origem dos achados
4.1 e 4.2 (tamanho mínimo ilegível e preferência de texto do jogador ignorada).

- **Classificação:** OPORTUNIDADE (é a correção estrutural de 4.1 e 4.2)
- **Prioridade:** Média
- **Esforço:** Alto (mudar o modelo de texto do kit inteiro)
- **Arquivo:linha:** `src/client/ui/skin.ts:92-100`, `src/client/ui/widgets.ts:362-372,683-693`
- **Link:** https://create.roblox.com/docs/reference/engine/classes/TextLabel#TextScaled

---

## 3. `ZIndexBehavior`

### 3.1 Usamos `Sibling` explicitamente nos três `ScreenGui` — **CORRETO**

**Regra da doc (`LayerCollector.ZIndexBehavior`):** com o comportamento `Sibling`, "children always render
above parents, with ZIndex deciding render order among siblings". Já `Global` "sorts all descendants by ZIndex
value, breaking ties using hierarchy, which means **child elements need ZIndex values at least as high as
their parent to avoid rendering underneath**".

**Achado:** `Enum.ZIndexBehavior.Sibling` é setado nos três (`bootstrap.ts:60`, `patches.ts:116`,
`adminClient.ts:62`). Está certo e **deve continuar explícito** — um `ScreenGui` criado por script não
herda o default de inserção do Studio, então confiar no default é frágil.

### 3.2 A skin depende de `Sibling` — o bug sutil se alguém trocar para `Global`

Vale escrever porque é exatamente a classe de bug que a pergunta pede: as camadas 9-slice são desenhadas com
**ZIndex negativo** para ficarem sob o conteúdo — `label.ZIndex = -10 + i` (`src/client/ui/skin.ts:334`, com o
comentário "under every child a screen adds"). Isso só funciona em `Sibling`, onde o filho está sempre acima
do pai e o ZIndex só ordena irmãos. Em `Global`, pela regra citada acima, um filho com ZIndex menor que o pai
renderiza **por baixo do pai** — as camadas de skin (-10..-9) sumiriam atrás do painel, e todo painel do jogo
ficaria liso. O mesmo vale para as camadas raiz `darkLayer=80` / `hudLayer=90` / `uiLayer=100`
(`bootstrap.ts:84,92,100`) contra os sprites do mundo, que usam ZIndex 1..N (`renderer.ts:341`): em `Global`
eles passariam a competir num único espaço numérico e o mundo atravessaria o HUD.

- **Classificação:** CORRETO hoje; registrar a dependência
- **Prioridade:** Baixa (documentar)
- **Esforço:** Baixo (um comentário em `bootstrap.ts:60` e uma linha em `DESIGN_RULES.md`)
- **Arquivo:linha:** `src/client/ui/skin.ts:334`, `src/client/bootstrap.ts:60,84-100`
- **Link:** https://create.roblox.com/docs/reference/engine/classes/LayerCollector#ZIndexBehavior

### 3.3 Não há faixas de ZIndex nomeadas — **OPORTUNIDADE**

**Achado:** as faixas são literais espalhados, com o mesmo `2`/`3` reinventado como "primeiro filho
decorativo" em pelo menos 8 arquivos (`hud.ts`, `backpack.ts`, `lobby.ts`, `pauseMenu.ts`, `settings.ts`,
`coach.ts`, `gameOver.ts`, `sectionPlayers.ts`). Faixas altas colidem numericamente entre telas
(`backpack=200`, `pauseMenu=250`, `tutorial=260`, `popup=300`, `lobby=300`, `logo=500`, toast=1000-1004).
Hoje não vira bug porque, em `Sibling`, cada tela é uma subárvore isolada e as telas modais são mutuamente
exclusivas — mas é uma invariante **implícita**, não garantida por nada. Três pontos ainda usam ZIndex
relativo ao pai (`admin/controls.ts:62,241`, `widgets.ts:686`), misturando dois modelos mentais.

- **Classificação:** OPORTUNIDADE
- **Prioridade:** Baixa
- **Esforço:** Baixo (um `Z = { skin, content, hud, modal, toast }` em `theme.ts` ou `widgets.ts`)

---

## 4. Texto

### 4.1 `MinTextSize` cai abaixo de 9 — **ERRO** (a doc tem alerta de nível `error`)

**Regra da doc (verbatim, `<Alert severity="error">` em size-modifiers):** "Do not use `MinTextSize` property
values lower than `9` or the text will be difficult to read for many viewers."

**Achado:** `applyTextSize` (`src/client/ui/skin.ts:86-90`) faz
`MaxTextSize = clamp(round(design * uiScale()), 6, 100)` e
`MinTextSize = clamp(floor(max * 0.5), 5, max)` — ou seja, **piso de 5 px por construção**. Como
`scaleText()` também liga `TextScaled`, quando a string não cabe o engine encolhe até esse piso. Valores
calculados com as fórmulas reais do código:

| Dispositivo (paisagem) | `uiScale()` | `caption` (12) Max/Min | `label` (14) Max/Min | `body` (16) Max/Min |
|---|---|---|---|---|
| Celular 844×390 | 0,56 | 7 / **5** | 8 / **5** | 9 / **5** |
| 720p 1280×720 | 1,09 | 13 / **6** | 15 / **7** | 17 / **8** |
| Tablet 1180×820 | 1,05 | 13 / **6** | 15 / **7** | 17 / **8** |
| PC 1920×1080 | 1,66 | 20 / 10 | 23 / 11 | 27 / 13 |

Em celular, mesmo o **máximo** de `caption` (7 px) e de `label` (8 px) já fica abaixo do piso de 9 da doc —
não é só o mínimo. Agrava o quadro que os menores tamanhos de design do jogo são ainda menores que
`TEXT.xs`: `COUNT_TEXT = TEXT.xs - 2` = 10 (`view/allyPlate.ts:34`), `HANDLE_TEXT = TEXT.xs - 1` = 11
(`ui/nameplate.ts:24`), e o `px()` local desses arquivos só tem piso de **1 px** (`nameplate.ts:157`).

- **Classificação:** ERRO
- **Prioridade:** Alta
- **Esforço:** Baixo para o piso (`math.max(9, ...)` em `applyTextSize`), Médio para a consequência (com piso
  de 9, textos longos deixam de caber e passam a precisar de `TextTruncate` ou `AutomaticSize`)
- **Arquivo:linha:** `src/client/ui/skin.ts:86-90`; tamanhos de origem em `src/client/ui/theme.ts:181-192`,
  `src/client/view/allyPlate.ts:34`, `src/client/ui/nameplate.ts:22-24`
- **Link:** https://create.roblox.com/docs/ui/size-modifiers#text-size

### 4.2 `TextScaled` desliga a preferência de tamanho de texto do jogador — **ERRO**

**Regra da doc (verbatim, acessibilidade):** "When `TextScaled` is enabled for a `TextLabel` or `TextButton`,
the element's text will **not** be scaled by the `PreferredTextSize` value." A mesma lista diz que elementos
com `AutomaticSize` **crescem** conforme a preferência, e que `UITextSizeConstraint` limita o efeito.

**Achado:** `scaleText()` (`skin.ts:93-100`) liga `TextScaled = true` **e** instala um
`UITextSizeConstraint`. É o único caminho de texto do kit (`widgets.ts:372,388,693`). Resultado: a combinação
neutraliza a configuração **Text Size** do jogador duas vezes — pelo `TextScaled` e pelo teto do constraint.
Na prática, o ajuste de tamanho de texto do menu do Roblox **não faz nada** em praticamente toda a UI do jogo.
As 7 exceções que setam `TextSize` diretamente (`controls.ts:236`, `lobby.ts:403`, `nameplate.ts:169-171`,
`allyPlate.ts:147`, `chatBubbles.ts:348`) também não reagem, porque calculam a partir de `uiScale()`.

- **Classificação:** ERRO
- **Prioridade:** Alta
- **Esforço:** Alto se for a correção estrutural (2.3); Médio para um paliativo (ler
  `GuiService.PreferredTextSize`, converter em multiplicador e aplicá-lo em `applyTextSize`, registrando o
  `GetPropertyChangedSignal` junto dos listeners já existentes em `skin.ts:164-168`)
- **Arquivo:linha:** `src/client/ui/skin.ts:86-100`
- **Link:** https://create.roblox.com/docs/production/publishing/accessibility#preferred-text-size

### 4.3 `RichText` e texto de jogador — **CORRETO** (e bem feito)

**Regra da doc:** `RichText` interpreta marcação no conteúdo de `Text`; `ContentText` existe justamente para
recuperar o texto sem marcação.

**Achado:** o default do kit é `RichText = false` (`widgets.ts:367`, precisa `rich: true` explícito). Os dois
únicos `rich: true` são texto literal e estático do logo (`ui/lobby.ts:196-209`, `ui/logo.ts:12-21`). O único
caminho dinâmico (lista de ingredientes de craft, `ui/backpack.ts:1057-1065`) passa por `colorTag()`
(`backpack.ts:229-231`), que chama `escapeRich()` (`backpack.ts:225-227`, escapa `&`, `<`, `>`) antes de
embutir na tag `<font>`. E os dois vetores óbvios estão fechados de propósito: o balão de chat seta
`label.RichText = false` com comentário justificando (`view/chatBubbles.ts:329-330`) e a nameplate usa um
helper que nunca liga `RichText` (`ui/nameplate.ts:49-64`, alimentado por `player.DisplayName`/`player.Name`).

Nenhuma string de jogador alcança um label com `RichText = true`. Não há ação.

### 4.4 `MaxVisibleGraphemes`, `TextFits`, `TextBounds`, `LineHeight` não usados — **OPORTUNIDADE**

**Regra da doc:** `MaxVisibleGraphemes` é o caminho documentado para efeito "máquina de escrever" e "doesn't
affect layout positioning of visible graphemes" (o layout não pula enquanto o texto aparece). `TextFits` é
leitura direta de "o texto coube?", já considerando `TextWrapped`/`TextTruncate`/`TextScaled`.

**Achado:** 0 ocorrências das quatro propriedades no `src/`. Duas lacunas concretas:
- O coach/tutorial (`src/client/onboarding/coach.ts`, `src/client/ui/tutorial.ts`) revela texto sem
  `MaxVisibleGraphemes`.
- `TextFits` resolveria o dilema criado por 4.1: com piso de 9 px, dá para detectar overflow e decidir entre
  truncar (`TextTruncate.AtEnd`, hoje usado uma única vez, em `admin/controls.ts:61`) ou crescer o
  contêiner — em vez de encolher a fonte até o ilegível.

- **Classificação:** OPORTUNIDADE
- **Prioridade:** Baixa (`MaxVisibleGraphemes`) / Média (`TextFits`, se 4.1 for corrigido)
- **Esforço:** Baixo
- **Link:** https://create.roblox.com/docs/reference/engine/classes/TextLabel

### 4.5 Fontes e contorno de texto — **CORRETO**

- Fontes: nenhuma ocorrência de `Enum.Font` (legado). Tudo passa por `new Font(family, weight)` em cache
  (`theme.ts:227-238`) com famílias `rbxasset://fonts/families/BuilderSans.json` e `BuilderMono.json`
  (`themeTokens.ts:210-216`). É o caminho moderno (`FontFace`), com pesos reais em vez de variantes de enum.
- `UIStroke` em texto: `textOutline()` (`skin.ts:163-176`) usa `ApplyStrokeMode.Contextual`, que é exatamente
  o modo documentado para contorno de texto. A doc avisa: "**Avoid tweening the `Thickness` property** of a
  `UIStroke` instance applied to text objects. This renders and stores many glyph sizes each frame,
  potentially causing performance issues or text flickering." Conferimos: `Thickness` só muda em resize
  (`setPixelStroke`, `skin.ts:117-121`, e `refreshAll`, `skin.ts:133-136`), nunca por frame; `fadeText()`
  (`skin.ts:179+`) tweena `TextTransparency` e a transparência do stroke, não a espessura. Correto.

---

## 5. 9-slice e pixel art

### 5.1 A matemática do `SliceScale` está certa — **CORRETO**

**Regra da doc:** `SliceScale` "scales the 9-slice edges by the specified ratio", com as bordas crescendo
"as if you'd uploaded a new version of the texture upscaled" (default `1.0`). `ResamplerMode.Pixelated` é
"nearest neighbor filtering of the closest pixel in the image".

**Achado:** as texturas são desenhadas em pixel art e subidas com upscale inteiro de `SKIN_UNIT = 4`
(`ui/skinAssets.ts:12-13`), e os `slice` são declarados em px da textura **já upscalada** —
`[12,12,20,20]` para botões, `[20,20,28,28]` para painéis, `[8,8,16,16]` para faixas/wells, `[16,16,24,24]`
para o anel de foco (`skinAssets.ts:30-57`). O render usa `SliceScale = skinPx() / SKIN_UNIT`
(`ui/skin.ts:332`, recalculado em `skin.ts:137-141`), com `skinPx()` sempre **inteiro**
(`skin.ts:74-76`). Ou seja: uma borda de 3 px autorais vira 12 px de textura e volta a 3 × `skinPx()` px de
tela. Como o upscale é 4× e o downscale é 1/4 exato, o *nearest neighbour* é sem perda — cada pixel autoral
cai em um bloco inteiro de pixels de tela, que é o objetivo declarado.

Também correto: `ScaleType = Enum.ScaleType.Slice` (`skin.ts:330`), `ResampleMode = Enum.ResamplerMode.Pixelated`
(`skin.ts:331` — note que a **propriedade** é `ResampleMode` e o **enum** é `ResamplerMode`; o código acerta),
e `SliceCenter` reaplicado a cada `applySurface` (`skin.ts:342`).

### 5.2 Os `UIScale` locais quebram a grade de pixel durante o tween — **ERRO** (leve, transitório)

**Regra da doc:** `UIScale` "proportionally scales the object and all of its children"; `SliceScale` é um
multiplicador absoluto da borda, não percentual — os dois não se conversam.

**Achado:** os 3 `UIScale` de animação (`hud.ts:740-742` banner 1.2 → 1; `nameplate.ts:110-111` pop;
`widgets.ts:1430-1433` modal 0.95 → 1) multiplicam o `AbsoluteSize` do elemento, mas `SliceScale` continua no
valor derivado de `skinPx()`. Durante o tween (0,15–0,35 s) a borda 9-slice fica numa escala não-inteira; com
`ResamplerMode.Pixelated` isso aparece como bloco de pixel irregular / tremulação na moldura. Como todo modal
do jogo entra por `widgets.ts:1430`, é visível em toda abertura de tela.

- **Classificação:** ERRO (contradiz o próprio invariante de grade que `skinPx()` existe para garantir)
- **Prioridade:** Média
- **Esforço:** Baixo (animar `GroupTransparency` de um `CanvasGroup` — ver 6.5 — ou `Position`/transparência
  em vez de `Scale`; alternativamente, quantizar o `Scale` do tween a múltiplos de `1/skinPx()`)
- **Arquivo:linha:** `src/client/ui/widgets.ts:1430-1433`, `src/client/ui/hud.ts:740-742,1040`,
  `src/client/ui/nameplate.ts:110-111`
- **Link:** https://create.roblox.com/docs/ui/size-modifiers

### 5.3 `ImageColor3` sobre texels cinza contradiz a regra escrita em `theme.ts` — **DECISÃO NOSSA** (mal documentada)

**Regra da doc:** `ImageColor3` "determines how an image is colorized"; branco não colore nada, e o recurso é
descrito como útil "for recoloring white transparent source images" — ou seja, é **multiplicação**.

**Achado:** `skin.ts:343` faz `label.ImageColor3 = layer.tint` com `tint` sempre um token exato. Mas os texels
não são brancos: são escala de cinza (é assim que o relevo é feito). Multiplicar cinza por token dá uma cor
que **não é** o token. Isso colide com a regra escrita no topo de `src/client/ui/theme.ts:11-14` ("every colour
written to a GuiObject / UIStroke / ImageLabel is EXACTLY one of these tokens (no Lerp, no tints, no
literals)").

Não é erro de engine nem de doc — é a técnica correta para relevo. O problema é de documentação e de
consequência: (a) a regra do `theme.ts` está literalmente falsa para tudo que é skin, e (b) **não dá para
calcular contraste a partir dos tokens** (ver 6.4), porque a cor renderizada do painel é token × cinza.

- **Classificação:** DECISÃO NOSSA (a doc não cobre "tingir pixel art de relevo"); registrar a exceção
- **Prioridade:** Baixa
- **Esforço:** Baixo (corrigir o comentário de `theme.ts:11-14` e anotar a exceção em `DESIGN_RULES.md` UI-01)
- **Arquivo:linha:** `src/client/ui/theme.ts:11-14`, `src/client/ui/skin.ts:343`

### 5.4 Nada impede o 9-slice de colapsar num contêiner pequeno — **OPORTUNIDADE**

Se a altura ou largura do host ficar menor que a soma das bordas (`slice × SliceScale`), as regiões de canto
se sobrepõem e a moldura quebra. As camadas de skin são `fromScale(1,1)` do host (`skin.ts:328`) e não há
`UISizeConstraint.MinSize` em nenhum painel skinado (o único `UISizeConstraint` do jogo fora do admin é o cap
de largura do balão de chat). Com `uiScale()` podendo cair a 0,35 (`skin.ts:61`), vale um piso.

- **Classificação:** OPORTUNIDADE
- **Prioridade:** Baixa
- **Esforço:** Baixo
- **Arquivo:linha:** `src/client/ui/skin.ts:318-346`

---

## 6. Acessibilidade

### 6.1 `GuiService.PreferredTransparency` ignorado — **ERRO**

**Regra da doc:** a configuração **Background Transparency** do jogador mapeia para
`GuiService.PreferredTransparency` (1 = padrão, 0 = totalmente opaco). "Multiplying a UI element's
`BackgroundTransparency` with `PreferredTransparency` is the **recommended** way to use this setting". A doc
entrega o script de referência (tag + `CollectionService` + `GetPropertyChangedSignal`).

**Achado:** 0 ocorrências no `src/`. E o jogo é um caso de uso forte: `theme.ts:100-118` define presets de
transparência precisamente para UI sobre o mundo — `overlay: 0.2`, `hud: 0.15`, `nameplate: 0.25`,
`touchIdle: 0.85`, `fireIdle: 0.45`. Um jogador que pediu fundo opaco continua lendo HUD e nameplate por cima
de um mundo em movimento.

- **Classificação:** ERRO
- **Prioridade:** Alta
- **Esforço:** Baixo — já temos o ponto de enganche certo: `TRANSPARENCY` é central e `skin.ts` já mantém
  registros de instâncias vivas (`textConstraints`, `strokeWidths`, `skinLayers`) atualizados por
  `refreshAll()`. Basta um registro análogo para superfícies transparentes e mais um listener ao lado dos de
  `skin.ts:164-168`.
- **Arquivo:linha:** `src/client/ui/theme.ts:100-118`, `src/client/ui/skin.ts:123-168`
- **Link:** https://create.roblox.com/docs/production/publishing/accessibility#preferred-transparency

### 6.2 `GuiService.ReducedMotionEnabled` ignorado — **ERRO**

**Regra da doc:** a opção **Reduce Motion** mapeia para `GuiService.ReducedMotionEnabled`; quando `true`, "the
player wants motion effects through UI animations/tweens to be reduced or completely removed". A doc dá duas
receitas: `TweenInfo` com `Time = 0`, ou trocar o tween de posição por um *fade* de `GroupTransparency` num
`CanvasGroup`.

**Achado:** 0 ocorrências no `src/`, e o kit anima bastante: helper `tween()` (`widgets.ts:197-201`), zoom de
modal (`widgets.ts:1430-1433`), pop do banner (`hud.ts:1040`), pop de level-up (`nameplate.ts:215`), fades de
texto e superfície (`skin.ts:179+`, `skin.ts:394`), pilha de toasts (`widgets.ts:1598-1659`).

- **Classificação:** ERRO
- **Prioridade:** Alta
- **Esforço:** Baixo — todo tween do kit passa por `tween()`/`tweenTo()`; ler a propriedade uma vez e zerar o
  `Time` nesses dois helpers cobre quase tudo de uma vez.
- **Arquivo:linha:** `src/client/ui/widgets.ts:197-201`, `src/client/ui/skin.ts:179+`
- **Link:** https://create.roblox.com/docs/production/publishing/accessibility#reduced-motion

### 6.3 Preferência de tamanho de texto — ver 4.2 — **ERRO**

### 6.4 Contraste: três pares abaixo do recomendado — **ERRO**

**Regra da doc:** "it's recommended that you pick text and background colors with sufficient color contrast" e
"make sure all UI has sufficient contrast". **A doc da Roblox não fixa nenhum número** — só mostra exemplos de
"high contrast" e "low contrast". Os limiares abaixo são WCAG 2.x, adotados por nós como critério objetivo:
4,5:1 para texto normal, 3:1 para texto grande (≥ 18,66 px em negrito ou ≥ 24 px) e 3:1 para elementos
não-textuais. Trate a coluna "veredito" como nosso critério, não como citação da doc.

**Achado:** razões calculadas a partir de `src/client/ui/themeTokens.ts:37-85`:

| Par | Razão | Veredito |
|---|---|---|
| `foreground` #ffffe3 / `background` #10100e | 18,74:1 | OK |
| `foreground` / `secondary` #606055 | 6,26:1 | OK |
| `mutedForeground` #8c8c7d / `background` | 5,59:1 | OK |
| `chart3` #d2691e / `background` (fome, moeda) | 5,24:1 | OK |
| `destructive` #ef4444 / `background` (HP) | 5,06:1 | OK |
| `chart2` #4682b4 / `background` (XP, noite) | 4,64:1 | OK |
| `chart1` #2e8b57 / `background` (cura) | 4,49:1 | limítrofe |
| `foreground` / `primary` #2e8b57 (**botão principal**) | **4,18:1** | falha para texto normal |
| `chart5` #a0522d / `background` (materiais) | 3,39:1 | só passa como "texto grande" |
| `accentForeground` / `accent` #8c8c7d (hover, aba, linha selecionada) | **3,35:1** | falha |
| `chart4` #8a2be2 / `background` (raro, chefe) | **3,20:1** | falha para texto normal |
| `border` #404040 / `SURFACE.panel` #1a1a1a | **1,68:1** | falha (separadores quase invisíveis) |

Dois pontos merecem destaque:

1. `theme.ts:30` já **documenta** o 3,4:1 de `accent` e tenta compensar com "text on accent is SemiBold / Bold
   and >= 14". Mas 14 px SemiBold **não** é "texto grande" por WCAG (precisa ≥ 18,66 px em negrito). E pelo
   achado 4.1, esse texto de 14 px de design renderiza a 8 px num celular. A mitigação escrita não se sustenta.
2. `border` sobre `panel` a 1,68:1 é o contorno de *well*, de aba inativa e de linha de lista
   (`theme.ts:91`) — a estrutura visual dos painéis.

Ressalva honesta: por 5.3, a cor **renderizada** de uma superfície skinada é o token multiplicado pelo cinza
da textura, então as razões reais dos pares que envolvem `SURFACE.*` são piores, não melhores, que a tabela.

- **Classificação:** ERRO
- **Prioridade:** Alta (o par do botão principal e o de `accent`), Média (`chart4`, `border`)
- **Esforço:** Médio (é mexer no tema; por UI-01 tem de vir do tweakcn, não de literal no código)
- **Arquivo:linha:** `src/client/ui/themeTokens.ts:37-85`, `src/client/ui/theme.ts:29-33,85-94`
- **Link:** https://create.roblox.com/docs/production/publishing/accessibility#color-contrast

### 6.5 Significado por cor sem símbolo redundante — **ERRO**

**Regra da doc:** "Over 5% of people in the world have some form of color blindness"; a solução recomendada é
"modifying the image to use different **symbols** alongside colors". A doc multiplataforma repete: "nothing
relies solely on color to distinguish an action or outcome".

**Achado:** `docs/DESIGN_RULES.md` LEG-02 fixa significados **puramente** por cor: "vermelho = sangue do
jogador/dano, verde = sangue de zumbi, roxo = veneno, amarelo = eletricidade, azul = máquinas". Vermelho vs
verde é exatamente o par que deuteranopia/protanopia colapsam — e aqui distingue "estou tomando dano" de
"estou acertando o zumbi", que é informação de gameplay crítica. O mesmo vale para `GAME.rare` (#8a2be2) e
`GAME.success` (#2e8b57) como únicos marcadores de raridade/estado em `theme.ts:122-150`.

- **Classificação:** ERRO
- **Prioridade:** Média
- **Esforço:** Médio (forma/símbolo redundante nas partículas e badges; a vinheta de dano já é posicional, o
  que ajuda)
- **Arquivo:linha:** `docs/DESIGN_RULES.md` (LEG-02), `src/client/ui/theme.ts:122-150`
- **Link:** https://create.roblox.com/docs/production/publishing/accessibility#color-non-reliance

### 6.6 `CanvasGroup` não usado — **OPORTUNIDADE**

**Regra da doc:** o exemplo oficial de *reduced motion* cria um `CanvasGroup` "to tween all children
uniformly" e anima `GroupTransparency`.

**Achado:** 0 ocorrências no `src/`. Hoje cada elemento é desvanecido individualmente (`fadeText`,
`fadeSurface`, `skin.ts:394`), o que (a) multiplica tweens por elemento, (b) produz o artefato de camadas
sobrepostas desvanecendo em taxas independentes, e (c) obriga o cuidado extra de `fadeText` ter de desvanecer
o `UIStroke` à parte porque a transparência do stroke não segue `TextTransparency` (comentário em
`skin.ts:177-178`). Um `CanvasGroup` por tela resolveria os três e é o caminho direto para 6.2 e 5.2.

- **Classificação:** OPORTUNIDADE
- **Prioridade:** Média
- **Esforço:** Médio
- **Arquivo:linha:** `src/client/ui/skin.ts:177-200`, `src/client/ui/widgets.ts:1430-1433`

### 6.7 Alvo de toque: 44 px com *fit pass* — **CORRETO**, com ressalva de origem

**Achado:** `MIN_TOUCH_PX = 44` (`src/shared/engine/input.ts:175`, comentado como "Apple HIG / Material
floor"), aplicado como piso duro depois do *fit pass* que encolhe os dois polegares proporcionalmente quando
a tela é curta (`input.ts:226-341`, piso em `input.ts:236,298,308,329`). O HUD ainda desenha a camada de
toque em **pixels de tela**, não em unidades de design, justamente para o alvo não encolher com o letterbox
(`src/client/ui/hud.ts:82-91`) — e troca o botão de pausa em unidades de design pelo de pixel no toque
(`hud.ts:325-326`). Isso é melhor do que a maioria dos jogos Roblox e não deve ser mexido.

Ressalva de verificação: a busca na web atribuiu às páginas de acessibilidade da Roblox uma recomendação de
"pelo menos 9×9 mm" (WCAG *Touch Target Size and Spacing*), mas **não encontrei esse número no fonte atual
da creator-docs** que baixei. Tratar como referência WCAG, não como regra citável da doc. Se adotado, 9 mm ≈
58 px lógicos a ~163 ppi, acima dos nossos 44 — vale medir antes de mudar, já que o *fit pass* mostra que 44
já é apertado nos celulares estreitos.

- **Classificação:** CORRETO (com nota)
- **Prioridade:** Baixa
- **Arquivo:linha:** `src/shared/engine/input.ts:171-188,226-341`, `src/client/ui/hud.ts:82-91`

### 6.8 Zonas reservadas do mobile — **CORRETO** por construção

A doc pede evitar os cantos inferiores esquerdo/direito (controles padrão) e as "thumb zones". Não se aplica
literalmente aqui: `disableCoreGui` desliga a `Backpack`, `Health` e `EmotesMenu`
(`src/client/bootstrap.ts:29-40`) e não há personagem nem controles padrão — nós **somos** os controles
daqueles cantos, posicionados por `computeTouchLayout` com margens por formato de tela
(`input.ts:222-234`). Registrado como exceção coerente, não como violação.

---

## Avaliado e descartado

- **`UIScale` como mecanismo de escala global** — descartado: a doc apresenta `UIScale` para zoom/tween, e o
  caminho recomendado para resolução é `Scale` + constraints, que é o que já fazemos (1.1). Migrar seria
  trocar um sistema correto por outro sem ganho.
- **`ZIndexBehavior.Global`** — descartado: quebraria as camadas de skin de ZIndex negativo e a separação
  mundo/HUD (3.2). `Sibling` é o certo.
- **`TextTruncate` como correção isolada de 4.1** — descartado como correção *isolada*: truncar sem antes
  subir o piso de `MinTextSize` só troca "ilegível" por "cortado". Só faz sentido acoplado a 4.1/4.3.
- **`ImageRectOffset`/`ImageRectSize` (spritesheet) e `TileSize`** — 0 usos, e descartado por ora: o kit tem
  poucas texturas (`skinAssets.ts:30-57`), todas 9-slice, e já há `ContentProvider:PreloadAsync`
  (`skin.ts:442`). Um atlas reduziria requests mas é incompatível com `ScaleType.Slice` no mesmo asset.
- **`UIGridLayout`** — 0 usos; descartado: as grades do jogo (mochila, loja) são posicionadas por design
  units com `UDim2.fromScale`, o que já dá controle exato e sobrevive ao letterbox. `UIGridLayout` traria o
  aviso da doc sobre constraints sobrepondo layout sem benefício.
- **`UIAspectRatioConstraint` adicional nos ícones** — descartado: o kit já desenha ícones como retângulos
  compostos em espaço de design (`hud.ts:146-166`), então não há asset quadrado sujeito a esticamento.
- **Input Action System / `InputActionLabel`** — fora de escopo desta área (é input); já coberto em
  `docs/research/input.md`, achado #5.
- **`TextStrokeTransparency` em vez de `UIStroke`** — descartado: a doc diz que `UIStroke` é a alternativa
  mais poderosa e que o stroke legado renderiza 4 vezes; nosso uso de `UIStroke` com
  `ApplyStrokeMode.Contextual` (`skin.ts:163-176`) já é o caminho recomendado. O único
  `TextStrokeTransparency` restante (`view/allyPlate.ts:124-125`) é sobre o mundo e pode ficar.

---

## Resumo por prioridade

**Alta**

| # | Achado | Tipo | Esforço |
|---|---|---|---|
| 1.2 | `IgnoreGuiInset = true` põe UI interativa em `DeviceSafeInsets` | ERRO | Médio |
| 1.3 | Um `ScreenGui` para mundo + UI; depende de `FullscreenExtension` que a doc pede para evitar | ERRO | Médio |
| 4.1 | `MinTextSize` chega a 5; doc proíbe abaixo de 9 (e no celular o *máximo* já fica em 7–8) | ERRO | Baixo/Médio |
| 4.2 | `TextScaled` neutraliza `PreferredTextSize` em toda a UI | ERRO | Médio/Alto |
| 6.1 | `PreferredTransparency` ignorado (temos presets de transparência sobre o mundo) | ERRO | Baixo |
| 6.2 | `ReducedMotionEnabled` ignorado (kit anima em todo lugar) | ERRO | Baixo |
| 6.4 | Contraste: botão principal 4,18:1, `accent` 3,35:1, `border`/`panel` 1,68:1 | ERRO | Médio |

**Média**

| # | Achado | Tipo | Esforço |
|---|---|---|---|
| 1.4 | Medir a tela por `ScreenGui.AbsoluteSize`, não `Camera.ViewportSize` | OPORTUNIDADE | Baixo |
| 1.5 | `topInset()` duplicado, `1120`/`630` em 6 arquivos, 2 sistemas de resize | OPORTUNIDADE | Baixo |
| 1.6 | `ViewportDisplaySize` / Style Queries não usados | OPORTUNIDADE | Baixo |
| 2.3 | Kit usa `TextScaled` onde a doc recomenda `AutomaticSize` | OPORTUNIDADE | Alto |
| 5.2 | `UIScale` de tween quebra a grade de pixel do 9-slice | ERRO | Baixo |
| 6.5 | Significado por cor sem símbolo redundante (LEG-02) | ERRO | Médio |
| 6.6 | `CanvasGroup` não usado (resolve 5.2 e 6.2 de uma vez) | OPORTUNIDADE | Médio |
| 4.4 | `TextFits` para decidir truncar vs crescer | OPORTUNIDADE | Baixo |

**Baixa**

| # | Achado | Tipo | Esforço |
|---|---|---|---|
| 3.2 | Documentar a dependência da skin em `ZIndexBehavior.Sibling` | CORRETO (doc) | Baixo |
| 3.3 | Faixas de ZIndex nomeadas em vez de literais | OPORTUNIDADE | Baixo |
| 4.4 | `MaxVisibleGraphemes` no coach/tutorial | OPORTUNIDADE | Baixo |
| 5.3 | Corrigir a regra de cor de `theme.ts:11-14` (tint multiplica) | DECISÃO NOSSA | Baixo |
| 5.4 | `MinSize` nos painéis skinados para o 9-slice não colapsar | OPORTUNIDADE | Baixo |

**Sem ação (registrado para não regredir):** 1.1 (escala por `Scale` + letterbox), 2.1 e 2.2 (balões e
nameplates seguem a doc), 3.1 (`Sibling` explícito), 4.3 (`RichText` e texto de jogador), 4.5 (fontes e
`UIStroke`), 5.1 (matemática do `SliceScale`), 6.7 e 6.8 (alvo de toque e zonas reservadas).
