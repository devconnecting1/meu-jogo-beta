# Auditoria: Input (UserInputService / ContextActionService / GuiService)

Escopo: `src/shared/engine/input.ts`, `src/client/bootstrap.ts`, `src/client/ui/hud.ts` (e `src/client/ui/widgets.ts`
onde o foco de gamepad é implementado). Confrontado com:

- Input geral: https://create.roblox.com/docs/input
- `UserInputService`: https://create.roblox.com/docs/reference/engine/classes/UserInputService
- `ContextActionService`: https://create.roblox.com/docs/reference/engine/classes/ContextActionService
- `GuiService`: https://create.roblox.com/docs/reference/engine/classes/GuiService
- `Enum.UserInputType`: https://create.roblox.com/docs/reference/engine/enums/UserInputType
- Guias específicos: https://create.roblox.com/docs/input/mobile ·
  https://create.roblox.com/docs/input/gamepad · https://create.roblox.com/docs/input/mouse-and-keyboard

Nota geral: a doc "input" (visão geral) hoje empurra para o **Input Action System** (ações nomeadas + bindings
por dispositivo, detectadas via `UserInputService.PreferredInput`). Não usamos esse sistema em lugar nenhum —
ver achado #5.

---

## 1. UserInputService vs ContextActionService

**Regra da doc:** `UserInputService` é para input bruto de baixo nível; `ContextActionService` é a camada de
abstração multi-dispositivo — uma ação nomeada com bindings para várias entradas, criação automática de botão
de toque (`createTouchButton=true` no `BindAction`), prioridade (`BindActionAtPriority`) e "sink" do evento.

**Achado:** o projeto usa exclusivamente `UserInputService` (`InputBegan`/`InputChanged`/`InputEnded`) para
tudo — movimento, ataque, mira, toque e gamepad. `ContextActionService` não é importado em nenhum arquivo de
`src/` (confirmado por grep).

- **Prioridade:** Baixa (é uma escolha correta, não um erro) — mas vale documentar a exceção.
- **Arquivo:linha:** `src/client/bootstrap.ts:19` (só `UserInputService`/`GuiService` são obtidos via
  `GetService`); handlers em `bootstrap.ts:412-498`.
- **Por quê está certo aqui:** o joystick e o "pad" de mira são geometria customizada e pixel-exata
  (`computeTouchLayout` em `src/shared/engine/input.ts:226-341`), com dois dedos simultâneos, dead-zone,
  "grab radius" de stick fixo e a lógica de *grace period* de mira (`bootstrap.ts:277-333`). O botão de toque
  automático do `BindAction(..., true, ...)` é redondo e genérico — não reproduz esse gesto. Rastrear
  `InputObject` por dedo via `InputBegan/Changed/Ended` é o mesmo padrão de baixo nível que o próprio
  `ControlModule` da Roblox usa para o thumbstick padrão, então a escolha é compatível com a doc, não uma
  violação dela.
- **Lacuna real:** `ContextActionService` também dá prioridade/"sink" de input (`BindActionAtPriority`,
  `UnbindAction`), que ajudaria a resolver a assimetria do achado #2 abaixo sem checagem manual de estado.
  Link: https://create.roblox.com/docs/reference/engine/classes/ContextActionService

---

## 2. Toque: `TouchEnabled`, gestos, `GuiButton` vs `InputBegan`

**Regra da doc:** para controles virtuais analógicos (stick/pad), o padrão de baixo nível
(`InputBegan`/`InputChanged`/`InputEnded` por `InputObject`) é o caminho korreto quando não se quer os gestos
prontos (`TouchSwipe`, `TouchPinch`) nem o botão redondo automático do `ContextActionService`.

**Achado A (compatível):** a implementação de "um dedo por lado" (`onMoveSide` em
`src/shared/engine/input.ts:344-346`, roteamento em `bootstrap.ts:600-658`) usa um `Map<InputObject, "move"|"aim">`
para nunca confundir dedos, e ignora `GuiButton`/`Activated` de propósito — os botões de ação (`USE`, `RELOAD`,
`BAG`, `PAUSE`) são desenhados como retângulos em `hud.ts` mas a lógica de clique deles usa o kit de widgets
(`Button(...)`, que É `GuiButton` por baixo) — ok, sem conflito, pois vivem em zonas diferentes da tela do
stick/pad.

- **Prioridade:** Informativo (nenhuma ação necessária).
- **Link:** https://create.roblox.com/docs/input/mobile

**Achado B (inconsistência real):** a decisão de "este dispositivo é touch" é feita de duas formas diferentes
em dois arquivos:
- `bootstrap.ts:106` → `UserInputService.TouchEnabled && !UserInputService.MouseEnabled` (só entra em modo
  toque se **não** houver mouse).
- `hud.ts:265-266` → `const mobile = UserInputService.TouchEnabled; this.touch = mobile;` (ignora
  `MouseEnabled`).

Em um dispositivo híbrido (tablet Windows/Surface com mouse + touch, Chromebook touch, etc.) o HUD desenha os
controles de toque (stick, pad, botões grandes) por cima da tela, mas `input.aimMode` começa como `"mouse"` —
telas e input ficam em modos diferentes até o primeiro toque/clique.

- **Prioridade:** Média.
- **Arquivo:linha:** `src/client/bootstrap.ts:106`; `src/client/ui/hud.ts:265-266`.
- **Link:** https://create.roblox.com/docs/reference/engine/classes/UserInputService (propriedades
  `TouchEnabled` / `MouseEnabled`).

---

## 3. Gamepad: `GuiService:GetSelectedObject`, navegação por seleção, `BindActivate`, ícones

**Achado A (compatível e bem feito):** `GuiService.SelectedObject`/`GuiNavigationEnabled` são usados como a
doc recomenda:
- `bootstrap.ts:44` liga `GuiService.GuiNavigationEnabled = true` para permitir navegação por seleção nos
  menus.
- `widgets.ts:91-117` assina `GuiService:GetPropertyChangedSignal("SelectedObject")`, troca a imagem de seleção
  padrão por `NO_SELECTION_IMAGE` (`SelectionImageObject`) e desenha o próprio anel de foco — exatamente o
  padrão de "replace the default highlight" que a doc de `GuiService` descreve.
- `bootstrap.ts:361-374` (`focusFirstMenuControl`) seleciona o primeiro `GuiButton` visível quando um gamepad
  "desperta" com um menu já aberto e nada selecionado — cobre o caso que a doc de navegação por seleção deixa
  implícito (nada selecionado = nada navegável).

- **Prioridade:** Informativo (nenhuma ação necessária). Link:
  https://create.roblox.com/docs/reference/engine/classes/GuiService

**Achado B — correção sobre `BindActivate`:** a pergunta original citava
`ContextActionService:BindActivate`. Ele existe de fato (assinatura
`BindActivate(userInputTypeForActivation, keyCodesForActivation)`) e **não está deprecado** — o método
deprecado da classe é `BindActionToInputTypes`. O projeto não usa nenhum dos dois (nenhuma referência a
`ContextActionService` em `src/`). `BindActivate` serve para o botão de "ativação" genérico de plataforma (uma
única ação global), não para binds de gameplay — não achamos uso justificado para ele aqui, já que toda ação já
tem tratamento próprio via `UserInputService`.

- **Prioridade:** Baixa / informativo.
- **Link:** https://create.roblox.com/docs/reference/engine/classes/ContextActionService

**Achado C (assimetria real):** a checagem "o menu tem foco, não deixe o jogo roubar o botão"
(`menuHasFocus()`) só é aplicada ao caminho de **gamepad**:

```
bootstrap.ts:412  UserInputService.InputBegan.Connect((inputObj, gpe) => {
bootstrap.ts:454      } else if (inputObj.UserInputType.Name.sub(1, 7) === "Gamepad") {
bootstrap.ts:456          if (menuHasFocus()) { ... }
```

Teclado (`W/A/S/D/E/R/Tab/B/P/Esc`, bloco `bootstrap.ts:423-451`) e mouse (`bootstrap.ts:413-422`) não
verificam `menuHasFocus()` — só dependem do `gameProcessedEvent` (`gpe`) que a Roblox marca quando um
`TextBox`/`GuiButton` realmente consumiu o evento. Um `Frame` sem `TextBox` focado (a maioria das telas do kit)
não gera `gpe=true` para teclado. Se algum outro sistema não filtrar `input.keyW`/`input.actionPressed` pela
fase do jogo, um menu aberto com foco de teclado deixaria o jogador andar/atacar por baixo dele. Não confirmamos
se há um filtro de fase em outro arquivo (fora do escopo desta auditoria) — sinalizando para checagem.

- **Prioridade:** Média (a confirmar se há filtro em outro lugar, ex. `client/systems`).
- **Arquivo:linha:** `src/client/bootstrap.ts:412-464` (comparar o bloco de teclado com `handleGamepadButton`
  em `bootstrap.ts:385-410` e `menuHasFocus` em `bootstrap.ts:350-353`).
- **Link:** https://create.roblox.com/docs/reference/engine/classes/ContextActionService (o `BindActionAtPriority`
  + `UnbindAction` resolveria isso de forma uniforme para os três dispositivos).

**Achado D (ícones de botão):** a doc de `ContextActionService` recomenda `SetImage()` para desenhar o ícone do
botão de toque criado automaticamente. Não é o nosso caso (não usamos `ContextActionService`), mas o dica de
interação (`hud.ts:1107-1136`, `setInteractHint`) já diferencia teclado vs. gamepad — mostra a letra `"X"`
(`setBadge`, `hud.ts:1130`) em vez de `"E"` quando `gamepadActive()` é verdadeiro. É um selo de texto pixelado
do próprio kit, não um glifo de botão da Roblox — consistente com a arte "Pixel Quest" do projeto, então não é
um problema, só uma nota de que não há ícone de botão físico (import de imagem) em lugar nenhum.

- **Prioridade:** Baixa / informativo.
- **Arquivo:linha:** `src/client/ui/hud.ts:1122-1131`.

---

## 4. Mouse: `MouseBehavior`, `MouseIconEnabled`, captura

**Achado:** nenhuma das duas propriedades é usada em `src/` (grep de `MouseBehavior`/`MouseIconEnabled`/
`MouseIcon` no projeto inteiro: zero ocorrências). A mira usa `UserInputService.GetMouseLocation()` (posição
absoluta na tela) convertida para mundo pela câmera (`bootstrap.ts:323-333`, também usado em
`admin/placement.ts:111` e `admin/adminClient.ts:209`).

- **Isso está certo?** Sim, para o padrão de mira "cursor absoluto" (estilo Diablo/ARPG top-down) o comportamento
  correto É o `MouseBehavior.Default` (cursor livre, sem lock) — `LockCenter`/`LockCurrentPosition` é para
  câmeras em primeira pessoa que precisam de delta relativo, não é o caso aqui. Não achar nenhum lock é o
  esperado, não uma omissão.
- **Lacuna real:** com `MouseIconEnabled` no padrão (`true`) e nenhum `MouseIcon` customizado, o jogador de
  mouse mira com a seta padrão do sistema operacional. Já o jogador de toque tem uma mira desenhada em Frame
  (`hud.ts:979-992`, `aimCursor`, visível só quando `input.aimMode === "touch"`). Ou seja, dois dispositivos,
  duas miras com aparências completamente diferentes — a de mouse não tem nada do estilo "Pixel Quest" do resto
  do HUD.
- **Prioridade:** Média (consistência visual/DESIGN_RULES, não é bug funcional).
- **Arquivo:linha:** `src/client/ui/hud.ts:979-992` (mira só para `aimMode === "touch"`);
  `src/client/bootstrap.ts:323-333` (mira de mouse não seta `MouseIconEnabled=false` nem desenha substituto).
- **Link:** https://create.roblox.com/docs/reference/engine/classes/UserInputService (propriedades
  `MouseBehavior`, `MouseIconEnabled`).

---

## 5. API nova a conhecer

- **`UserInputService.PreferredInput`** — API recomendada pela doc geral de input
  (https://create.roblox.com/docs/input) para decidir "qual dispositivo o jogador está usando agora" de forma
  unificada (em vez de checar `TouchEnabled`/`MouseEnabled`/prefixo `"Gamepad"` em três lugares diferentes como
  hoje). Não é usada em nenhum arquivo do projeto. Trocar as checagens espalhadas (`bootstrap.ts:106`,
  `hud.ts:265`, `widgets.ts:111`, o `.Name.sub(1,7) === "Gamepad"` repetido em `bootstrap.ts:454/485/495`) por
  uma única leitura de `PreferredInput` resolveria de raiz o achado #2-B.
  - **Prioridade:** Média (redução de dívida técnica, não corrige bug crítico).
  - **Link:** https://create.roblox.com/docs/input
- **`ContextActionService:BindActionAtPriority` / `UnbindAction`** — ver achado #3-C; resolveria a assimetria
  menu-vs-input sem `menuHasFocus()` manual espalhado pelo código.
  - **Link:** https://create.roblox.com/docs/reference/engine/classes/ContextActionService
- **`TouchInputService`** citado no pedido original: não encontramos evidência, nas páginas de classes/enums
  consultadas, de que essa classe exista na doc atual — o suporte a toque documentado hoje passa inteiramente
  por `UserInputService` (`Enum.UserInputType.Touch`) e pelos gestos (`TouchTap`, `TouchSwipe`, `TouchPinch`)
  descritos em https://create.roblox.com/docs/input/mobile. Vale confirmar com uma busca dedicada se não for
  crítico, mas não é uma classe que faltou usar.

---

## Resumo por prioridade

| Prioridade | Achado |
|---|---|
| Média | #2-B — `TouchEnabled` sozinho no HUD vs `TouchEnabled && !MouseEnabled` no bootstrap (dispositivos híbridos) |
| Média | #3-C — `menuHasFocus()` só no caminho de gamepad; teclado/mouse dependem só de `gpe` |
| Média | #4 — mira de mouse é a seta padrão do SO, sem retícula própria (inconsistente com a mira de toque) |
| Média | #5 — `PreferredInput` substituiria 4 checagens espalhadas de dispositivo |
| Baixa | #1 — uso exclusivo de `UserInputService` (correto para os controles customizados, mas vale registrar a exceção) |
| Baixa | #3-B — `BindActivate` existe e não está deprecado (correção sobre a pergunta original); não usado, sem necessidade aparente |
| Baixa | #3-D — hint de gamepad usa selo de texto próprio, não ícone de botão da Roblox (estilístico, não é falha) |
