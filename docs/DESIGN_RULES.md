# Bíblia de ambientação — Project Z

Regras do que **deve** e do que **não deve** existir no mundo do jogo, para que a cidade, os objetos e a interface façam sentido. Toda mudança de conteúdo (gerador de mapa, sprites, UI, spawns) segue este documento.

Cada regra tem um ID (`VEG-01`) e um tipo de verificação:

- **[auto]** — checada por código (`npm run validate:world`, roda no CI). Se falhar, o PR não passa.
- **[revisão]** — checada no playtest (via MCP no Studio) e na revisão do PR.

Ordem de prioridade quando duas regras brigam: **legibilidade de gameplay → lógica do mundo real → fidelidade ao Dead Town original**. Toda exceção de gameplay precisa estar escrita aqui, com o motivo.

## 0. Princípios

- **P1 — Faz sentido ou tem motivo.** Tudo segue a lógica do mundo real, ou é uma exceção de gameplay documentada.
- **P2 — Melhor que o original.** Copiamos o que o Dead Town faz bem e corrigimos o que ele faz mal (IA sem pathfinding, bugs de XP, estômago cheio deixando lento…).
- **P3 — Se parece X, se comporta como X.** Aparência e comportamento nunca se contradizem.
- **P4 — A cidade funcionava antes do surto.** Cada objeto tinha função numa cidade normal; o apocalipse só bagunçou.

## 1. Cenário e escala

- Cidade pequena norte-americana genérica (como o original: posto, escola, hospital, loja de armas), **poucos dias** depois do surto: grama ainda aparada, carros abandonados, lixo espalhado — nada de ruínas de décadas.
- Trânsito pela direita.
- **Escala: 1 m ≈ 55 unidades de mundo.**

| Elemento | Unidades | Metros | Observação |
|---|---|---|---|
| Jogador (diâmetro) | 36 | ~0,65 | largura de ombros vista de cima |
| Zumbi (diâmetro) | 32 (×1,4 no grande) | ~0,6 | |
| Porta | 112 | ~2,0 | **exceção [ESC-02]**: porta dupla para dar espaço de combate na entrada |
| Carro | 200 × 100 | 3,6 × 1,8 | máscara do original |
| Lixeira | 36 | ~0,65 | |
| Tronco de árvore (colisão) | 44 | ~0,8 | |
| Copa de árvore | 150–172 | 2,7–3,1 | aérea, não colide |
| Rua (2 faixas) | 384 | ~7 | |
| Avenida (2 + 2 faixas) | 768 | ~14 | canteiro central arborizado de 96 u |
| Calçada | 128 | ~2,3 | 48 de faixa de serviço (junto ao meio-fio) + 80 de faixa livre; o tile de calçada do original também tem 128 |
| Escola / hospital | 1064 × 812 | ~19 × 15 | sobra lote para pátio ou estacionamento |
| Beco mínimo entre prédios | 96 | ~1,7 | passam 2 corpos |

**Evidência do original** (`rom_play`: 1.658 instâncias analisadas): 85% das 220 árvores ficam na grama (quintais e parques); nenhuma fica na calçada residencial; as árvores de rua ficam a ~264 u do asfalto (calçada + jardim), com espaçamento mediano de 768 u. Lixeiras ficam na borda do meio-fio. Casas ficam a 240–496 u do asfalto; comércio a 0–240 u; os postos ficam em esquinas de avenida. **Não copiamos** do original: carros e barricadas dentro de cruzamentos, e carros ignorando a mão da via.

## 2. Ruas e calçadas (CID)

- **CID-01 [auto]** ✅ Toda calçada tem uma **faixa livre contínua** onde um círculo de raio 18 passa de ponta a ponta. ❌ Nenhum sólido (tronco, lixeira, carro, poste) na faixa livre.
- **CID-02 [auto]** ✅ Árvores de rua, postes, lixeiras e hidrantes ficam só na **faixa de serviço** (canteiro/covas junto ao meio-fio).
- **CID-03 [auto]** ✅ Faixa de pedestre em cada braço de cruzamento. ❌ Nada estacionado ou plantado a menos de um carro (200 u) da esquina, medido a partir da borda do cruzamento.
- **CID-04 [revisão]** ✅ Faixa central tracejada só em rua de mão dupla; avenidas podem ter canteiro central arborizado.
- **CID-05 [auto]** ✅ Toda rua e todo lote são alcançáveis a pé a partir do ponto de nascimento. ❌ Becos sem saída sem motivo.

## 3. Vegetação (VEG)

- **VEG-01 [auto]** ❌ Árvore na faixa livre da calçada, na pista, na frente de porta/garagem ou a menos de 200 u de uma esquina.
- **VEG-02 [auto]** ✅ Árvores de rua só em covas na faixa de serviço, alinhadas e espaçadas regularmente (480–600 u, ~9–11 m); uma cova vazia conta como múltiplo do espaçamento.
- **VEG-03 [revisão]** ✅ A maioria das árvores fica em **quintais** (laterais e fundos), **praças/parques** e **terrenos baldios**. Parques densos; zona comercial pouco arborizada.
- **VEG-04 [auto]** ✅ A copa pode cobrir calçada e rua (é aérea); o **tronco nunca**. A copa fica translúcida quando há um ator embaixo.
- **VEG-05 [revisão]** ❌ Árvore menor que o jogador ou do tamanho de um prédio.

## 4. Edifícios (EDI)

- **EDI-01 [auto]** ✅ Porta sempre virada para a rua, com acesso livre: um círculo de raio 18 vai da calçada ao interior.
- **EDI-02 [auto]** ✅ Recuo por tipo: **casa** com jardim frontal de 112–176 u, caminho até a porta e quintal; **comércio** (mercado, farmácia, lojas, restaurante) a no máximo 16 u da calçada, com estacionamento nos fundos; **posto** na esquina com pátio de bombas de pelo menos 320 u; **escola/hospital** maiores, com pátio ou estacionamento.
- **EDI-03 [auto]** ✅ Loot coerente com o tipo: farmácia/hospital → remédios; loja de armas → munição e pólvora; mercado/restaurante → comida; posto → óleo; oficina/"tech" → peças e chips. Cor do telhado e emblema identificam o tipo.
- **EDI-04 [revisão]** ✅ De fora, o telhado esconde todo o interior; ele some **só com o jogador dentro** (regra do autor: dentro/fora puro, como o `par_building` do original).
- **EDI-05 [auto]** ❌ Prédio invadindo calçada ou rua; prédios colados sem beco de pelo menos 96 u.
- **EDI-06 [revisão]** ✅ Comércio nas vias principais e esquinas; residências nas ruas secundárias.
- **EDI-07 [revisão]** ✅ Interiores (quando houver móveis) com caminho livre de pelo menos um corpo e nada bloqueando a porta.

## 5. Veículos (VEI)

- **VEI-01 [auto]** ✅ Carro estacionado fica paralelo ao meio-fio (a ~12 u dele), na faixa de estacionamento, no sentido da mão (direita), com pelo menos 40 u entre carros. Em estacionamentos, vagas perpendiculares são permitidas.
- **VEI-02 [auto]** ❌ Carro em cruzamento, faixa de pedestre, calçada ou na frente de porta/garagem.
- **VEI-03 [auto]** ✅ Carros abandonados/batidos em ângulo no meio da rua são permitidos (é um apocalipse), mas **poucos** (no máximo 15% dos carros de rua) e sempre deixando pelo menos uma faixa livre contínua de 150 u por pista.
- **VEI-04 [revisão]** ✅ Cores variadas e plausíveis (levemente dessaturadas). ❌ Neon, cores de desenho animado.

## 6. Mobiliário urbano e lixo (MOB)

- **MOB-01 [auto]** ✅ Lixeira junto ao meio-fio perto de entradas (até 400 u na mesma calçada), ou em becos e fundos de lote. ❌ No meio da faixa livre.
- **MOB-02 [revisão]** ✅ Postes/lampiões na faixa de serviço, espaçados; iluminam só se tiverem motivo (ver LUZ-02).
- **MOB-03 [revisão]** ✅ Todo objeto tem função ou história. ❌ Objetos soltos sem razão de estar ali.

## 7. Apocalipse e narrativa ambiental (APO)

- **APO-01 [revisão]** ✅ Sinais de abandono de poucos dias: carros batidos, portas abertas, lixo espalhado, manchas de sangue, barricadas improvisadas em algumas casas.
- **APO-02 [auto]** ❌ Destroços bloqueando rotas inteiras.
- **APO-03 [revisão]** ❌ Elementos de outro gênero ou época (neon cyberpunk, ruínas de décadas, fantasia).
- **APO-04 [revisão]** ✅ Densidade de zumbis coerente com o lugar (hospital e escola mais cheios; parques mais vazios) — quando o spawner suportar.

## 8. Escala e proporções (ESC)

- **ESC-01 [auto]** ❌ Qualquer objeto do mundo real em proporção absurda em relação ao jogador (tabela da seção 1, com tolerância de ±30%).
- **ESC-02** Exceção documentada: porta de 112 u (~2 m) para permitir combate na entrada e passagem de zumbis pelo pathfinding.

## 9. Colisão e física (COL)

- **COL-01 [revisão]** ✅ Se parece sólido, colide; se colide, parece sólido.
- **COL-02 [auto]** ✅ Aéreo não colide (copas, telhados); chão não colide (poças, manchas, faixas, canteiros de grama).
- **COL-03 [auto]** ❌ Jogador, zumbi ou item nascendo dentro de um sólido.
- **COL-04 [revisão]** ❌ Decoração escura que pareça sombra de um objeto que não existe (lição da mancha de grama).
- **INT-01 [auto]** ✅ Integridade do gerador: nenhum sólido sobreposto, grade espacial consistente com a lista de sólidos, 4 paredes íntegras por prédio (com uma porta), praças dos chefes livres, e tudo alcançável a pé a partir do ponto de nascimento.

## 10. Luz, sombra e tempo (LUZ)

- **LUZ-01 [revisão]** ✅ De dia todas as sombras apontam para o mesmo lado (sol); à noite, se afastam das fontes de luz.
- **LUZ-02 [revisão]** ✅ Só ilumina o que tem motivo: o próprio jogador (~250 u), fogueira/braseiro acesos, lampião ligado, disparos e explosões.
- **LUZ-03 [revisão]** ✅ A noite é escura mas legível: o jogador sempre enxerga ao redor de si.

## 11. Legibilidade de gameplay (LEG)

- **LEG-01 [revisão]** ✅ O que é interativo mostra a pílula "E: …"; decoração nunca imita algo interativo.
- **LEG-02 [revisão]** ✅ Cores com significado fixo (herdado do original): vermelho = sangue do jogador/dano, verde = sangue de zumbi, roxo = veneno, amarelo = eletricidade, azul = máquinas.
- **LEG-03 [revisão]** ✅ Inimigos sempre se destacam do fundo (silhueta + cor + "!").

## 12. Interface (UI)

- **UI-01 [revisão]** ✅ Toda cor, fonte e raio vêm do tema do tweakcn (`design/tweakcn-theme.json` → `npm run theme` → `themeTokens.ts`). ❌ Cores ou fontes literais nas telas.
  - Exceção documentada (auditoria `docs/research/ui.md` 5.3): o relevo da skin é uma textura em **tons de cinza** tingida com `ImageColor3 = token`, e `ImageColor3` **multiplica**. Ninguém escreve outra cor além do token, mas o que uma superfície com textura mostra na tela é o token escurecido pela textura. Consequência: uma razão de contraste calculada entre tokens é exata só no visual plano de reserva (sem texturas); para texto claro sobre chapa ela é o pior caso, porque a textura só escurece a chapa.
- **UI-02 [revisão]** ❌ Nada sob a barra do Roblox; nenhuma tecla que o CoreGui captura (Esc, Tab).
- **UI-03 [revisão]** ✅ Textos em inglês via `lang.ts` (EN/KR). Exceção: o painel de admin (`src/client/admin`, ferramenta interna que só o desenvolvedor vê) usa inglês direto no código.
- **UI-04 [auto]** ✅ **Texto nunca tem contorno.** Nenhum `UIStroke` parentado a `TextLabel`, `TextButton` ou `TextBox`, e nenhum `TextStroke` visível — em nenhum tipo de texto do jogo. Motivo: decisão do dono, contorno em texto deixa feio. `UIStroke` continua valendo em **frames** (borda de painel, chapa, anel de foco); no kit ele só nasce por `boxStroke()` (`skin.ts`), que nunca o põe num objeto de texto. A opção `outline` que telas antigas passavam para o kit não desenha mais nada (o kit a ignora) e foi retirada de todo call site fora dela mesma. Checado em **todo `src/`**, não só no kit: `npm run test:contrast` varre cada `.ts` do jogo atrás de `TextStrokeTransparency` visível, `ApplyStrokeMode.Contextual`, `textOutline()` e `outline: true`.
- **UI-05 [auto]** ✅ **Rótulo sobre chapa é claro, e quem garante o contraste é a chapa.** Todo texto sobre chapa (botão, aba ativa, tecla, badge) usa o `foreground` claro, nunca a cor quase preta do corpo — letra escura em chapa de ferro foi testada e parece botão desativado. A chapa precisa de **3:1** contra um título de botão (grande, SemiBold/Bold) e de **4,5:1** contra texto pequeno sobre ela (o "Day 1" do PLAY, subtítulos dos botões do lobby, legenda de tecla). Se a cor escolhida para a chapa não alcança, **escurece-se a chapa** pelo menor passo que passa, mantendo matiz e croma — nunca se escurece a letra e nunca se põe contorno (UI-04). Checado por `npm run test:contrast`.
- **UI-06 [auto + revisão]** ✅ **Nenhum menu pausa o mundo, e nenhum texto promete pausa.** O mundo é do servidor e é compartilhado: o Bag, o menu e o craft não param os zumbis — nem no solo, para a regra ser uma só (decisão do dono, 2026-09-23, depois de um playtest em que o sobrevivente perdeu 65 de vida com o Bag aberto). Em troca, o menu **não esconde o perigo**: o fundo é semitransparente para o entorno continuar visível e a tela **pisca quando o sobrevivente toma dano**. ❌ "(pauses)" ou "pausa" em qualquer texto de ajuda. ❌ Menu opaco por cima de um mundo que continua andando.
  - **O que o cliente fazia (e era mentira):** com o Bag, o menu ou a tela de fim de partida aberta, `main.client.ts` pulava `loop.update` inteiro (a variável `simulate`), e `GameLoop.update` saía na primeira linha com o sobrevivente morto. O servidor nunca parou: sem comandos, ele segura o sobrevivente parado e os zumbis mordem; o cliente só deixava de desenhar e de receber — a tela mostrava uma foto parada e a vida caía de uma vez ao fechar o Bag. De quebra, a espera do amanhecer (MP-21) nunca via o revive chegar, porque o `netUpdate` que o traz também não rodava com o sobrevivente morto.
  - **Implementação:** o loop roda **todo quadro da partida** — menu aberto e sobrevivente morto inclusive. O que um menu (ou a morte) para é o **sobrevivente**: `InputState.setHeld` (`shared/engine/input.ts`) descarta os toques do quadro (clique, E, R, tecla de arma) e bloqueia o ataque até o botão ser solto (fechar o Bag com o mouse apertado não dispara — e o bloqueio agora chega ao servidor: nem o bit de ataque segurado nem a borda de soltar saem enquanto o botão está bloqueado); `readRawInput` manda o comando de quem está parado, de mãos vazias, a 60 Hz; a mira não gira atrás do cursor. Zumbis, aliados, relógio, snapshots e dano seguem. O coach do primeiro jogo não conta o tempo passado em menu.
  - **Fundo:** as telas sobre a partida (Bag, menu, as duas telas de fim de partida) usam o scrim `TRANSPARENCY.overWorld` = 0,55 (fundo a 45%), pelo tema e por `worldTransparency` (respeita a Transparência de Fundo do sistema). Diálogos fora da partida seguem com `overlay`. **Os painéis continuam opacos**: o texto deles é medido a 4,5:1 contra a cor do painel, e texto secundário sobre um painel em que a rua aparece cai abaixo de 4,5:1 antes de o painel chegar a 10% de transparência. Limite honesto: o Bag cobre ~80% de uma tela 16:9 (o sobrevivente fica embaixo dele); o que se vê em volta é a margem — por isso o aviso abaixo é o que vale.
  - **Aviso de dano:** `client/ui/dangerFlash.ts` desenha as quatro bordas da tela em `GAME.blood` (vinheta que some em direção ao centro, pico `TRANSPARENCY.alarm`) **acima** de todo menu e popup, só com uma tela aberta sobre um sobrevivente vivo (sem menu, a vinheta da HUD já faz isso). Um "hit" é HP caindo ≥ 1 entre dois quadros (`client/ui/hitAlarm.ts`: mordida é 10 antes da armadura; fome e veneno drenam menos que isso por quadro, então não piscam para sempre). No máximo um flash novo a cada 0,4 s (< 3/s, WCAG 2.3.1). Sem texto (UI-04), sem som novo, não fecha o menu; com Reduzir Movimento o flash acende e apaga em vez de esmaecer.
  - **Textos:** "(pauses)", "Pause menu", "Paused", "Resume" e o glifo "II" saíram; a tecla P / Start / o botão de três barras abrem o **Menu**, cujo botão principal é "Back to game". O "How to play" e as dicas do lobby dizem a regra: "The backpack and the menu never stop the world: open them somewhere safe."
  - **Checagem:** `npm run test:contrast` (seção 5) falha se qualquer string de `src/` — `lang.ts` incluído — prometer pausa, se uma tela sobre a partida usar o scrim opaco, se o flash não ficar acima delas ou piscar mais de 3 vezes por segundo. `npm run test:menus` roda o input real do cliente com o Bag aberto contra o servidor real e mostra o mundo seguindo (relógio, zumbis, dano) e o flash disparando. O visual (quanto se vê em volta do Bag, a vinheta) é **[revisão]** no Studio.

- **UI-07 [revisão]** ✅ **Um vocabulário só de janela, o da referência do dono** (janela "Settings" em pixel, 2026-09-23: "o design dos componentes é maravilhoso"). Mora no kit — `plate.ts` (chapas), `window.ts` (janela, seção, linhas, ladrilho), `widgets.ts` (botões, abas, slider, teclas) — e toda tela que usa o kit o herda:
  - **Chapa**: cantos cortados em degrau de pixel; o relevo é banda clara em cima, orelhas laterais (claras em cima, escuras embaixo) e lábio escuro embaixo, uma unidade de relevo cada. A luz e a sombra são `foreground` e `background` lavados sobre a face — token sobre token, como as texturas da UI-01 —, desenhados com Frames (sem asset novo). Chapa **lisa** (sem relevo) para o que está em repouso; **em relevo** para o que é ativo ou apertável.
  - **Janela**: moldura grossa do painel, corpo grafite (`SURFACE.window`, um passo mais claro que os painéis, para a janela e as abas saltarem da página), faixa de cabeçalho um tom abaixo com o **título grande ExtraBold centralizado**, **"?"** de ajuda à esquerda (opcional por tela) e **X vermelho em relevo** à direita.
  - **Abas**: chapas espaçadas sobre o corpo, sem bandeja; a inativa é ferro liso (`secondary`), a ativa é **azul em relevo** (`tabActive`). **O que está escolhido é azul** em todo o kit: aba ativa, item selecionado de um trilho (Bag, loja), segmento escolhido, ladrilho selecionado. A ação principal continua verde.
  - **Seção** (o "poço" com título Bold à esquerda): chapa lisa mais clara que o corpo (`SURFACE.section`); dentro dela, o **leito escuro** (`SURFACE.groove`) onde linhas e ladrilhos assentam — os vãos entre eles são o sulco.
  - **Linha de ajuste**: uma forma só em dois tons, sem corte na junção — rótulo Bold centralizado na célula mais escura (`cellLabel`), valor na mais clara (`cell`).
  - **Tecla de valor**: ferro **escuro** (`SURFACE.key`) com letra clara, crescendo para caber o texto. Diferença consciente da referência (tecla cinza-clara com letra contornada): sem contorno (UI-04) a letra clara não leria numa tecla clara (UI-05).
  - **Slider e seletor**: sulco escuro com a quantidade escolhida em azul e alça de ferro em relevo; o seletor segmentado é a barra de abas dentro de uma canaleta escura. **Barra de rolagem** fina e clara (`border`), só quando a lista transborda.
  - **Ladrilho** (grade do guarda-roupa): liso escuro = seu; ferro = em uso; cadeado de pixel + preço = bloqueado; azul em relevo = selecionado. Sempre sobre o leito escuro.
  - **Tipografia da janela**, medida na referência: título `xl3` ExtraBold, abas `lg` Bold, título de seção `xl2` Bold, rótulos `lg` Bold, teclas `base` Bold (sempre pelo tema, com o piso de 9 px e o Text Size do jogador).
  - ❌ Chapa com contorno escuro em volta, aba dentro de bandeja, controle fino de formulário web, seção vazia sob duas linhas (seção se ajusta ao conteúdo ou agrupa). Os pares de cor da janela estão em `npm run test:contrast`; o resto é revisão lado a lado com a referência.

## 13. Conteúdo e propriedade intelectual (CON)

- **CON-01** ❌ Nome, logo ou arte do Dead Town. ✅ Créditos mantêm "Inspired by Dead Town (Lemon Puppy Games)".
- **CON-02** ❌ Marcas reais em lojas, carros ou produtos.
- **CON-03 [revisão]** ✅ **Conteúdo entra por etapa, e o que está fora é desligado, nunca apagado.** Decisão do dono (2026-09-23): começar pelo **Núcleo 1** — Dagger, Axe, Baseball bat e Pistol; carne crua → cozida, maçã, enlatado e bandagem; madeira, pedra, aço, tecido, munição, fogueira, barricada, porta e bancada; roupa de algodão e lanterna; zumbis Walker e Charger, **sem chefe** — e expandir quando a etapa anterior estiver estável em multiplayer. O custo de depurar é por **mecânica**, não por item. ❌ Apagar item: saves reais podem tê-lo, e o catálogo inteiro continua validado pelos testes. Receita e pacote de loja se ligam sozinhos (só se o resultado e todos os ingredientes estão ligados), e a trava vale no **servidor**.

## 14. Multiplayer (MP)

O jogo é multiplayer nativo: mundo compartilhado por servidor (até 6 jogadores), simulado pelo servidor. Arquitetura completa em `docs/MULTIPLAYER.md`.

- **MP-00 [revisão]** ✅ **O servidor decide tudo o que importa**: posição (o cliente envia só inputs), dano, XP, itens, moedas, cooldowns, munição, crafting, construção, loot e reviver. ❌ Qualquer valor de jogo vindo do cliente. O cliente só tem autoridade sobre câmera, UI e efeitos visuais previstos.
- **MP-01 [revisão]** ✅ Só cooperação: tiros, flechas, fogo, choque e golpes **atravessam aliados**; torretas e armadilhas nunca afetam jogadores. ❌ Dano de jogador em jogador. Exceção (decisão do autor): a explosão do zumbi-bomba fere todos no raio, **aliados com 50%** do dano (P3: é o zumbi atacando).
- **MP-02 [revisão]** ✅ Jogadores **não colidem entre si**. Exceção documentada a COL-01, por anti-griefing (ninguém bloqueia uma porta ou um beco com o corpo).
- **MP-03 [revisão]** ✅ Derrubado: **rasteja a 20%** da velocidade, sem atacar nem usar itens; sangra por **30 s** (−3 s por mordida). Aliado em pé a **≤ 70 u** segura E por **4 s** para reviver (dano não interrompe); volta com 30% do HP. Sem aliado em pé no servidor, não há espera.
- **MP-04 [revisão → auto na fase F1]** ✅ **Spawn seguro**: fora de prédio, sobre chão livre, a **≥ 900 u de qualquer zumbi**, com 3 s de proteção. ❌ Nascer à vista de um zumbi ou dentro de um sólido.
- **MP-05 [revisão]** ✅ **Loot de prédio compartilhado** (decisão do autor): quem revistar primeiro leva; renasce a cada **12 h de jogo**. O conteúdo só é revelado a quem revista.
- **MP-06 [revisão]** ✅ Itens no chão: o primeiro pedido válido leva. ❌ Item "reservado" para quem matou.
- **MP-07 [revisão]** ✅ **O que o jogador não vê, o cliente não recebe**: interior de prédio com o telhado fechado, zumbi no escuro fora de toda luz, conteúdo de loot (anti-wallhack; coerente com EDI-04 e LUZ-03).
- **MP-08 [revisão]** ✅ Legibilidade co-op: todo jogador tem placa com nome, nível e barra de HP; o derrubado mostra anel de reviver e contagem **visíveis no escuro**; a luz de cada jogador ilumina para todos.
- **MP-09 [revisão]** ✅ A horda escala por grupo de jogadores próximos: **S(k) = 1 + 0,5·(k − 1)**, teto de 150 zumbis por servidor. ❌ Zumbi nascendo a menos de 720 u de qualquer jogador.
- **MP-10** ~~A pausa só congela o mundo se todos estiverem em menu.~~ **Substituída pela UI-06** (decisão do dono, 2026-09-23): nenhum menu congela o mundo, nem com todos os jogadores em menu. ❌ Um jogador congelar o mundo dos outros continua valendo.
- **MP-11 [revisão]** ✅ Construções só são danificadas por zumbis; **portas construídas podem ser trancadas pelo dono** (trancada, só o dono abre). ❌ Jogador destruir ou desmontar construção alheia.
- **MP-12 [revisão]** ✅ **Sair derrubado conta como morte.** Sair em combate (dano nos últimos 5 s) exige 5 s de espera.
- **MP-13 [revisão]** ✅ A HUD mostra o **dia do mundo** e o **dia da vida**. Recordes e moedas por dia são pessoais e exigem presença (≥ 50% do dia, sem AFK). Servidor **público começa no dia 1**; servidor **solo/privado continua no dia do dono**.
- **MP-14 [revisão]** ✅ **Solo é o jogo de hoje**: com um jogador só, S(1) = 1 e sem espera de derrubado (P2: o multiplayer não pode piorar o solo). A "pausa real" que esta regra prometia foi retirada pela UI-06: no solo o menu também não para o mundo, para a regra ser uma só.
- **MP-15 [revisão]** ✅ XP compartilhado com sentido: **60% de assistência** para quem ajudou a matar; XP de chefe para **todos os participantes**.
- **MP-16 [revisão]** ✅ Anti-trapaça proporcional: corrigir em silêncio → sinalizar com evidências no painel de admin → kick automático só para abuso inequívoco (flood de remotes). ❌ Ban automático (ban só por decisão humana).
- **MP-17 [revisão]** ✅ **Chat é do lugar, não da sala.** A mensagem só chega a quem está a até `INTEREST_MID` (1500 u, ~27 m) de quem falou, e a decisão é do **servidor** (`TextChannel.ShouldDeliverCallback`). A regra é "se você o vê, você o ouve": o alcance é amarrado ao raio em que o outro sobrevivente é replicado — acima dele não há corpo onde pendurar o balão. ❌ Filtrar alcance no cliente (um cliente modificado leria tudo, e quem falou é também onde ele está). ❌ Aumentar o alcance sem mover o raio de interesse junto.
- **MP-18 [revisão]** ✅ **Sem corpo, sem voz.** Quem não está no mundo (lobby, loja, créditos) não fala nem ouve o chat de proximidade, porque não tem posição. Pelo mesmo motivo, **só existe corpo na cidade entre `EnterWorld` e `LeaveWorld`**: ninguém fica de pé na rua por estar apenas conectado. ❌ Admitir jogador no mundo por efeito colateral de entrar no servidor.
- **MP-19 [revisão]** ✅ Balão de fala: no máximo **3 por sobrevivente** (o quarto expulsa o mais antigo), **7 s** de vida com 0,4 s de fade, texto **filtrado** pelo Roblox, cortado em 90 caracteres. ❌ Desenhar texto cru de jogador. ❌ Balão que sobrevive ao dono sair do mundo.
- **MP-20 [revisão]** ✅ **O dia pertence ao mundo, não ao jogador.** Num servidor compartilhado o relógio é do servidor e **nada que um jogador faça o reseta**: "New game" começa uma vida nova, não um mundo novo. A HUD mostra os dois números da MP-13 — o **dia do mundo** (compartilhado) e o **dia da vida** (pessoal, volta a 1). ❌ Cliente resetar o relógio local ao recomeçar: foi assim que dois jogadores no mesmo mundo apareceram em dias diferentes. **Implementação:** "compartilhado" é lido do **tipo do servidor** (`game.PrivateServerId === ""`), nunca da contagem de jogadores — a contagem muda no meio da noite e faria a mesma morte custar coisas diferentes conforme quem estivesse logado; o tipo do servidor não muda enquanto ele existir, então cliente e servidor chegam sempre à mesma resposta sem corrida. É a mesma taxonomia da MP-13 ("público" contra "solo/privado"). O **dia da vida** na HUD só aparece quando os dois números já se separaram: repetir o mesmo número duas vezes não explica nada.
- **MP-21 [revisão]** ✅ **Morreu: paga o Rebirth ou espera o amanhecer — em qualquer servidor.** Decisão do dono (2026-09-23): "Regras do dono, mas se os outros jogadores não tiverem dinheiro pro Rebirth, terão que esperar amanhecer, mesma coisa pro online". Vale igual em servidor público e privado: quem morre pode pagar o **Rebirth** na hora (morte decidida pelo **servidor**; vivo nunca faz Rebirth) ou, sem moedas, espera o **amanhecer (06:00)** e o servidor o revive. "New game" recomeça a **vida** (MP-20), mas não pula a regra: num mundo com alguém vivo, o corpo novo entra ao amanhecer ou pagando. ❌ Sair e voltar do mundo, reconectar ou "New game" como revive grátis. **Implementação:** o amanhecer é **06:00** (onde `isNightAt` acaba) — a noite dura ~3,6 min reais (11 h a 1,2× de `TIME_SPEED`); morte de dia claro espera no máximo **uma noite inteira**. A espera só existe enquanto houver alguém vivo: sem nenhum vivo vale a MP-22.
- **MP-22 [revisão]** ✅ **Sem nenhum sobrevivente vivo, o mundo acaba naquele dia e nasce uma cidade nova no dia 1.** Decisão do dono (2026-09-23): "se todos os jogadores sobreviventes do mundo morrerem, o mundo finaliza naquele dia específico pra resetar pro dia 1. O objetivo do jogo é durar mais tempo vivo e explorar o mundo." A cidade é **nova** (outra semente: explorar é metade do objetivo) e o mundo que acabou fica **registrado** com quantos dias durou. Nível, skills, moedas e pacotes de cada jogador ficam; o que volta a 1 é o mundo e a vida. **Janela de decisão:** quando o último vivo morre, o mundo só acaba se ninguém pagar Rebirth em **30 s** (ou antes, se todos os mortos já escolheram não pagar) — é o que mantém o jogo solo fazendo sentido: morrer sozinho com moedas ainda permite o Rebirth. Isso também encerra o "mundo estéril" (servidor com todos mortos e nenhum spawn): ele deixa de existir por construção.

- **MON-01 [revisão]** ✅ **Se muda o que acontece numa noite, não se vende.** Vende-se identidade, nunca capacidade. ❌ XP ou multiplicador de XP, dano, vida, velocidade, munição, item de sobrevivência, reviver, espaço de inventário, crafting mais rápido, sorte de saque. O XP é o caso que sempre volta disfarçado: no nosso jogo ele vira `skillPoint`, que compra dano, vida, velocidade e mira — vender XP é vender todas essas de uma vez. Ver `docs/MONETIZATION.md`.
- **MON-02 [revisão]** ✅ **Cosmético só vale se for visível a 32 px.** O sobrevivente é um sprite visto de cima: cor e silhueta se leem, detalhe não. Canais válidos: paleta do corpo, nameplate, balão de fala, rastro, cor da lanterna, decoração de base. ❌ Chapéu, roupa e acessório — não aparecem, e produzir o que não aparece é desperdício que o jogador percebe.
- **MON-03 [revisão]** ✅ Pacote de loja tem **conteúdo fixo e declarado**. ❌ Caixa aleatória, paga ou não: é jogo de azar e é pay-to-win ao mesmo tempo. ❌ Assinatura antes de existir cadência de cosmético para honrá-la — assinatura que entrega o mesmo dois meses seguidos custa mais em reembolso do que gera em receita.
- **MON-04 [revisão]** ✅ **Cosmético comprado aparece — para quem comprou e para os outros.** Trajes (Santa, Zombie, Cowboy) e pets (pombos, águia, cães) são desenhados no sobrevivente, no mundo e na prévia do guarda-roupa, e replicados para todos (é o ponto do produto, MON-02). São **dois slots**: um traje e um pet ao mesmo tempo (decisão do dono, 2026-09-23) — um muda o corpo, o outro segue o sobrevivente. A posse é do servidor (`ownsCostume`); o cliente nunca declara o que possui. O guarda-roupa mostra só abas do que existe e se lê a 32 px, preço em moedas do jogo e compra no próprio painel; busca só quando o catálogo crescer. ❌ Vender algo que ninguém vê: até 2026-09-23 o slot "Deco" era salvo e replicado mas nunca desenhado.

## Como adicionar ou mudar uma regra

1. Dê um ID novo na categoria certa (ou crie a categoria).
2. Escreva o ✅ deve / ❌ não deve e o **motivo** quando não for óbvio.
3. Marque **[auto]** só se houver checagem no validador; caso contrário, **[revisão]**.
4. Se for uma exceção de gameplay, registre na seção de escala ou na própria regra.
