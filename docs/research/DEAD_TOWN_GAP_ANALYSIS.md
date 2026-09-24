# Dead Town × Project Z — análise de lacunas e recomendações

Pedido do dono (2026-09-24): "verifica tudo no jogo original Dead Town e verifica se há algo que podemos tornar o nosso
melhor, e recomendações e entre outros que faça sentido pro nosso." Base: `main` em `915d3f0`.

**Como ler.** Cada afirmação tem um rótulo:

- **[repo]** — evidência no nosso repositório (arquivo ou regra citada ao lado). É onde mora quase tudo o que sabemos
  do original: os números portados em `src/shared/engine/constants.ts` e `src/shared/data/*`, os comentários `obj_*`,
  `par_*`, `sys_*` do código e a análise do `rom_play` em `docs/DESIGN_RULES.md` §1.
- **[web]** — fonte pública, listada na §6 com o link. Página que não abriu fica dita.
- **[inferência]** — conclusão nossa a partir das duas acima; nunca um fato sobre o original.

Veredito: ✅ igualamos ou somos melhores · ⚠️ falta, ou está pior que o original · 💡 oportunidade de superá-lo.
Esforço (a mesma unidade de `docs/MULTIPLAYER.md` §11): **S** ≤ 1 agente-dia · **M** 2–4 · **L** 5–8 · **XL** > 8.

---

## 0. Resumo

- **No núcleo do jogo já somos melhores que o original** em quase todo sistema: IA dos zumbis (IA-01..06), interiores
  com janelas e mais de uma entrada (EDI-08..15), letreiros (ART-07), energia e torretas que custam e fazem sentido
  (ELE-01..09), veículos que não trivializam a noite (VEI-05), HUD e controles para toque, controle e teclado
  (UI-01..12), servidor autoritativo com até 6 em co-op (MP-00..23) e monetização sem pay-to-win (MON-01..05). [repo]
- **O original ainda ganha em nove pontos** (§3): o novato sempre começava no dia 1; dava para jogar sozinho de
  verdade; a base provavelmente persistia; conquistas apareciam na plataforma; tradução humana em quatro línguas; áudio
  de moto e farol; chefes com arte própria; encomendas no mapa; e um mapa fixo que se aprendia.
- **Achamos cinco incoerências internas** (doc × código, §4) — a maior: os chefes nascem desde o dia 5 e dão troféus,
  mas a CON-03, o Records e a tela Survivor dizem que "o Núcleo 1 não tem chefe".
- **Top 3:** (1) o jogador novo nunca pode cair num mundo público no dia 20; (2) o "Play solo" que a §7.4 do
  `MULTIPLAYER.md` desenhou e ninguém construiu; (3) decidir os chefes e alinhar regra, telas e arte. Lista completa na §5.
- **Atualização (2026-09-24): P0-3 e P0-4 feitos.** Os chefes estão ligados na CON-03, aparecem no Records e na tela
  Survivor e têm pixel art (ART-14, à espera do `upload-art` do dono); a mordida, as portas, o uso de item, o
  lança-chamas, o motor, a buzina, a campainha e a voz da horda têm som, e a moto tem farol (VEI-05, LUZ-04). Com isso a
  incoerência I1 fechou e dois dos nove pontos da §3 (moto, chefes) saíram. O que sobra dos dois está nas seções P0-3 e
  P0-4 da §5.

---

## 1. O que sabemos do original, e de onde

### 1.1 Fatos

| Fato                                                                                                                                 | Rótulo e fonte                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Jogo mobile (Android e iOS), top-down, lançado em 2016-11-07; última versão 1.4.2 em junho de 2017                                   | [web] TapTap, APKCombo                                                            |
| Mais de 1 milhão de instalações; 4,2★ em ~43,7 mil avaliações no Google Play; classificação "Everyone"                               | [web] APKCombo                                                                    |
| A descrição final diz que a compra no app foi desligada "por problema da empresa" e pede desculpas pela falta de atualização         | [web] APKCombo                                                                    |
| Retirado do Google Play em 2021-11-08; o desenvolvedor sumiu depois de 2017                                                          | [web] NamuWiki, só pelo resumo da busca (a página devolve 403)                    |
| **Single-player, offline, sem rede**, a 30 fps (GameMaker)                                                                           | [repo] LEG-05 ("a 30 fps e sem rede"), `constants.ts` linha 1, `types.ts`         |
| Três ondas por noite (WAVE1, WAVE2, WAVE3); a primeira horda chega no fim do dia 1                                                   | [web] NamuWiki (resumo), LevelWinner; [repo] `spawns.ts` `DAY_POPULATION`         |
| Mapa **feito à mão**, fixo; prédios são caixas de quatro paredes com uma porta, sem cômodo nem janela                                | [repo] `constants.ts` `TOWN_SEED`, DESIGN_RULES EDI (interiores), §1              |
| Câmera **girava** (o manche direito girava a vista); bússola girava com ela; GPS escrevia coordenadas                                | [repo] VEI-05, ITM-04, `hudNav.ts`; [web] Uptodown (resumo)                       |
| 22 conquistas com id do **Google Play Games**                                                                                        | [repo] `achievements.ts` (`androidId`)                                            |
| Textos em inglês, coreano, chinês e japonês                                                                                          | [repo] `lang.ts` (cabeçalho)                                                      |
| Moedas por anúncio com recompensa (5), pacotes de moedas, trajes e pets por dinheiro, conquista por avaliar a loja e por 50 anúncios | [repo] `constants.ts` `MONEY_AD_REWARD`, `shop.ts:155`, `achievements.ts`, CON-05 |
| Save local com autosave a cada 5 s (150 quadros)                                                                                     | [repo] `constants.ts` `SAVE_FILE`, `AUTOSAVE_SEC`                                 |
| Elogios: "kept me awake all night to make a base with turrets"; charme apesar do pouco conteúdo                                      | [web] Aptoide, TapTap (avaliações)                                                |
| Críticas: controles "wonky", UI ruim, fica repetitivo, **as ondas restringem a exploração**, mundo pequeno, sem atualizações         | [web] TapTap (avaliações)                                                         |

### 1.2 O que NÃO sabemos (e não afirmamos)

- Se a **base** (construções, itens no chão) era gravada no save. É provável num jogo offline de construir base com
  autosave, mas não há prova no repo nem na web. [inferência]
- Se os pets e trajes do original tinham efeito de jogo. Os nossos dados os trazem com defesa e velocidade 0
  (`equips.ts`, `kind` 4), o que sugere que não. [inferência]
- O que contavam as conquistas Collector e Ninja (CON-04 as deixou escondidas por isso). [repo]
- O guia da LevelWinner diz que "construções se consertam sozinhas se você fica perto" (ícone de martelos). No nosso
  código o conserto é o E com madeira ou aço, como a lista de conserto do `obj_player` (`interactQuery.ts`). Pode ser a
  mesma coisa descrita de fora; fica **a verificar**. [web] × [repo]
- **Não há notas do original em `docs/research/`.** Os seis arquivos de lá (`audio`, `engine-apis`, `input`,
  `performance`, `servidores-e-dados`, `ui`) auditam APIs do Roblox; a evidência do original está no código e na
  DESIGN_RULES. Este documento é a primeira nota da pasta sobre o original. [repo]

---

## 2. Sistema por sistema

### 2.1 Loop central: dia, noite, ondas, chuva

| Aspecto            | Original                                                                                                  | Nosso                                                                                                 | V   |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --- |
| Relógio            | Dia 387 s + noite 218 s = ~10 min por dia de jogo [repo `clock.ts`, MULTIPLAYER §1]                       | Os mesmos números, agora do servidor (MP-20) [repo]                                                   | ✅  |
| Ondas              | 19h / 22h / 1h, tabela fixa por dia: 3/3/6 no dia 1 até 30/30/50 + especiais no dia 20 [repo `spawns.ts`] | A mesma tabela, intocada, × S(k) por grupo (MP-09) [repo `waves.ts`]                                  | ✅  |
| Ritmo              | Tabela que nunca olha o jogador: a noite é uma linha reta [repo `director.ts`]                            | Diretor no estilo Left 4 Dead: pico → alívio → subida, sem tirar zumbi prometido [repo `director.ts`] | ✅  |
| Chuva              | 10% dos dias, nunca antes do dia 5 [repo `waves.ts:365`]                                                  | Igual; abafa ruído (IA-02) e encurta a visão (IA-01) [repo]                                           | ✅  |
| Saber a hora       | Só com relógio (item) [repo `hudConsole.ts:100`]                                                          | Céu no console: sol e lua no arco, "Night in 2:14", pips das ondas (UI-09) [repo]                     | ✅  |
| Exploração × ondas | Críticas: "as ondas restringem a exploração", repetitivo [web TapTap]                                     | Ainda três ondas às mesmas horas; a noite continua sendo "fique na base" [inferência]                 | 💡  |

### 2.2 O sobrevivente: vitais, fome, regeneração, skills

| Aspecto          | Original                                                                                             | Nosso                                                                                                                                                                                           | V   |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Vida e fome      | HP 100, fome 100 (−0,3/s: ~5,5 min cheia → vazia); fome 0 tira 0,6 HP/s [repo `constants.ts`]        | Os mesmos números (`playerMove.ts`) [repo]                                                                                                                                                      | ✅  |
| Regeneração      | 1,2 HP/s sempre que alimentado; a fome regula a cura [repo; web LevelWinner]                         | Igual, × (1 + Recovery) [repo `playerMove.ts:127`]                                                                                                                                              | ✅  |
| Estômago         | **Estômago cheio deixava mais lento** (`move_speed -= hungry/hungry_max*0.5`) [repo `player.ts:151`] | Só a fome abaixo de 25% desacelera (P2) [repo]                                                                                                                                                  | ✅  |
| Guarda pós-golpe | 1,5 s: dez zumbis mordiam como um [repo LEG-04]                                                      | 0,5 s; cercado é mais perigoso (LEG-04) [repo]                                                                                                                                                  | ✅  |
| Stamina / sede   | Não há evidência de nenhuma das duas [inferência: nada em `constants.ts`]                            | Nenhuma                                                                                                                                                                                         | ✅  |
| Skills e nível   | 21 skills em três árvores (luta, craft, sobrevivência) [web LevelWinner; repo `skills.ts`]           | As mesmas 21; 1 ponto por nível, curva `⌊√L·10+2⌋·10` [repo `save.ts:573`]                                                                                                                      | ✅  |
| Bugs             | XP dos chefes 3 e 4 valia 10 por bug [repo `entities.ts:294`]                                        | Corrigido; e os bugs do **nosso** port (Quick reload invertido, Health só no próximo corpo, Robotics e Engineering sem efeito) viraram testes [repo `server/sim/combat.ts:639`, ITM-05, ELE-08] | ✅  |
| Kit inicial      | Adaga, 3 bandagens, 3 enlatados [repo `save.ts:457`]                                                 | Igual [repo]                                                                                                                                                                                    | ✅  |

### 2.3 Armas

| Aspecto       | Original                                                                                                       | Nosso                                                                                                       | V   |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --- |
| Lista         | 30 armas: 13 brancas (adaga … katana dourada), 12 de fogo, 3 arcos, lança-chamas, Stun gun [repo `weapons.ts`] | As mesmas 30, com os números do original [repo]                                                             | ✅  |
| Tiro          | Dispersão = (base + recuo + corrida) × faixa [repo `combat.ts:714`]                                            | A mesma fórmula, sorteada **em segredo no servidor**, com rebobinagem de até 300 ms (MULTIPLAYER D5) [repo] | ✅  |
| Corpo a corpo | Varredura com ease-out; **a lâmina não acertava chefes** [repo `client/systems/combat.ts:757`]                 | Acerta chefes; cadência é do sobrevivente, não da arma (ITM-06) [repo]                                      | ✅  |
| Arma guardada | Mãos vazias [repo ITM-06]                                                                                      | Igual, e todos veem (ITM-06) [repo]                                                                         | ✅  |
| Ruído         | Um só: 800 para todo tiro [repo `noise.ts:36`]                                                                 | Por classe: pistola 800 … sniper 1400, silenciador ÷3, arco mudo (IA-02) [repo]                             | ✅  |
| Toque         | Atirava "onde o último dedo estivesse" [repo `bootstrap.ts:357`]                                               | Gesto de mira e mira assistida para o polegar (`input.ts:401`) [repo]                                       | ✅  |
| Sensação      | —                                                                                                              | Faltam sons de lança-chamas e de mordida (§2.18) [repo `design/audio-credits.md` D]                         | ⚠️  |

### 2.4 Itens, crafting, receitas

| Aspecto          | Original                                                                                                        | Nosso                                                                                                            | V   |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --- |
| Catálogo         | 20 consumíveis, 26 equipamentos, 49 materiais e construções [repo `data/*`]                                     | Os mesmos, e **todos funcionam** (CON-03, `test:items` §F5) [repo]                                               | ✅  |
| Receitas         | Craft na bancada; `item_cook` e `item_fire` [repo `craftRule.ts`]                                               | 80 escritas + 5 de cozinha geradas da coluna `cook` (ITM-01) [repo `crafts.ts`]                                  | ✅  |
| Fogo             | O braseiro **só fundia** [repo `craftRule.ts:16`]                                                               | O braseiro também cozinha (é fogo aberto, P3) [repo ITM-01]                                                      | ✅  |
| Saque            | Prédio sorteia ao chegar perto; volta em 12 h de jogo [repo `items.ts`]                                         | Igual e compartilhado (MP-05); uma tabela para cliente e servidor (ITM-03) [repo]                                | ✅  |
| Troféus de chefe | Lança-chamas, Robot suit, Plastic armor, circuitos [repo `spawns.ts` `BOSS_TROPHIES`]                           | Restaurados (ITM-05) [repo]                                                                                      | ✅  |
| Uso sob pressão  | O menu e a mochila **pausavam** no port que copiou o original [repo MULTIPLAYER §1; inferência para o original] | Nada pausa (UI-06); o Bag cobre ~80% da tela 16:9 — comer ou enfaixar no meio da luta é abrir o Bag [repo UI-06] | ⚠️  |

### 2.5 Construção, barricadas, armadilhas, torretas, energia

| Aspecto         | Original                                                                                                                          | Nosso                                                                                                        | V   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --- |
| Barricada/porta | Madeira 700 / ferro 1700; porta 500 / 1500 [repo `constants.ts`]                                                                  | Iguais; **encaixam no vão** de porta e janela (EDI-13); porta trancável pelo dono (MP-11) [repo]             | ✅  |
| Rede elétrica   | Caixa mais perto a 300 px; geradores queimando sempre; consumidores ligados desde a construção; drones de graça [repo `power.ts`] | Mesma regra de raio, com interruptor, óleo automático, bateria de drone e custo por tiro (ELE-01..05) [repo] | ✅  |
| Torretas        | 200 px, 25 de dano a cada 20 quadros; a armadilha elétrica só feria [repo `power.ts`]                                             | 300 u (exceção documentada), choque que segura e salta, tudo no servidor (ELE-04) [repo]                     | ✅  |
| GPS do original | `obj_gps`: sinal para achar a base [repo ELE-06]                                                                                  | Farol com seta para todos (ELE-06) [repo]                                                                    | ✅  |
| Pendências      | —                                                                                                                                 | Forno elétrico e bancadas noturnas funcionam **sem energia** (pendência da §10A) [repo]                      | ⚠️  |

### 2.6 Veículos

| Aspecto  | Original                                                                                           | Nosso                                                                               | V   |
| -------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --- |
| Pilotar  | Bicicleta e moto; manche girava a câmera; bicicleta exigia óleo (erro) [repo VEI-05]               | Manche aponta para onde ir; bicicleta sem óleo; acidente e conserto (VEI-05) [repo] | ✅  |
| Horda    | A moto **tornava a noite trivial**: nenhum zumbi reagia, sem atropelamento nem queda [repo VEI-05] | Atropelamento derruba o piloto; motor faz barulho que chama a horda (VEI-05) [repo] | ✅  |
| Presença | A moto tinha **farol** e **som de motor** [repo VEI-05]                                            | Farol e sons de motor e campainha **pendentes** (VEI-05 "Pendente") [repo]          | ⚠️  |

### 2.7 O mapa e a cidade

| Aspecto         | Original                                                                                                             | Nosso                                                                                                                                     | V   |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Tamanho         | 22 400 × 16 640 u [repo `constants.ts`]; "mundo pequeno" nas críticas [web TapTap]                                   | Mesmo tamanho; **cidade nova a cada fim de mundo** (MP-22) [repo]                                                                         | ✅  |
| Planta          | Feita à mão; carros e barricadas dentro de cruzamentos, carros contra a mão (`rom_play`, 1.658 instâncias) [repo §1] | Procedural validada por regra `[auto]` (CID, VEG, EDI, INT); 3 escolas, 3 hospitais, 5 postos, 6 praças [repo `world.ts`]                 | ✅  |
| Prédios         | Caixa de 4 paredes e 1 porta; interior vazio; a porta era a única saída [repo EDI-10]                                | Plantas por tipo, móveis, janelas para pular e mais de uma entrada, sem esconderijo (EDI-08..15) [repo]                                   | ✅  |
| Ler a cidade    | Telhado em HSV sorteado; farmácia e loja de armas só se distinguiam entrando [repo ART-07]                           | Letreiro por tipo e cor de telhado (ART-07) [repo]                                                                                        | ✅  |
| Memória do mapa | Mapa fixo: rotas e lugares se aprendem [inferência]                                                                  | Primeira cidade fixa (semente 7331); depois, sorteada. Chefes nas mesmas coordenadas em toda cidade [repo `constants.ts`, `world.ts:323`] | 💡  |

### 2.8 Zumbis: tipos, IA, horda

| Aspecto        | Original                                                                                                                                                 | Nosso                                                                                                                                                                                                | V   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Tipos          | Walker, Spitter, Exploder, Charger, Jumper; 10% rápidos a partir do dia 2, 5% grandes a partir do dia 3 [repo `zombies.ts`, `entities.ts:220`]           | Os cinco nascem (`population.ts` `SPECIAL_TYPES`), com pixel art (ART-10) [repo]                                                                                                                     | ✅  |
| Sentidos       | Sem olhos: nota a 50 px ou por anel de ruído de dia; **à noite e na chuva todo zumbi do mapa caça a posição ao vivo através de paredes** [repo IA intro] | Visão com cone, alcance e luz; ouvido por ação; memória; grito limitado (IA-01..03) [repo]                                                                                                           | ✅  |
| Caminho        | `mp_potential_step`, sem pathfinding; separação O(n²) [repo `flank.ts`, `spatialHash.ts`]                                                                | Flow field multi-fonte, flanco, hash espacial (MULTIPLAYER D6) [repo]                                                                                                                                | ✅  |
| Mordida        | Morde no quadro em que encosta: nada para ler nem desviar [repo `zombieBrain.ts:1359`]                                                                   | Inclinação telegrafada e mordida (LEG-04) [repo]                                                                                                                                                     | ✅  |
| Estado visível | Um "!" [repo `zombieBrain.ts:132`]                                                                                                                       | Ponto azul, "?" dourado, "!" vermelho, com contraste medido (IA-05) [repo]                                                                                                                           | ✅  |
| Voz            | —                                                                                                                                                        | Gemidos, rosnado ao te ver e o grito do grupo, de takes humanos e de criatura da biblioteca oficial, com orçamento para a horda não virar barulho (P0-4) [repo `audio-credits.md` B, `gameAudio.ts`] | ✅  |

### 2.9 Chefes

| Aspecto     | Original                                                                                                                                                                     | Nosso                                                                                                                                                  | V   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| Quais       | Centopeia (dia 10), Rafflesia (dia 8), Gigante (dia 5), Ouriço (dia 10); voltam a cada 3 dias; 10 000 HP, regeneram 30/s (45 o Gigante) [repo `constants.ts`, `entities.ts`] | Os quatro nascem nas âncoras (`population.ts` `spawnBoss`), HP × S(k) (MP §3.5) [repo]                                                                 | ✅  |
| Recompensa  | XP do 3 e do 4 dava 10 por bug [repo `entities.ts:294`]                                                                                                                      | 1000/800/800/1000 XP a todo participante, 8 moedas, troféu, conquista (MP-15, ITM-05, CON-04) [repo]                                                   | ✅  |
| Arte        | Sprites próprios [inferência: o jogo era todo em sprites]                                                                                                                    | Pixel art dos quatro, do tamanho em que são acertados, com o desenho liso de reserva até o `upload-art` (ART-14, P0-3) [repo `bossView.ts`]            | ✅  |
| Na tela     | —                                                                                                                                                                            | "Bosses defeated" no Records e nas Stats da tela Survivor (UI-10, UI-12, P0-3) [repo]                                                                  | ✅  |
| Como evento | Encontro no lugar fixo [repo]                                                                                                                                                | Nenhum aviso de que um chefe acordou além de encontrá-lo, nem telegrafar dos ataques (o resto da P0-3) [inferência: nenhum anúncio no `population.ts`] | 💡  |

### 2.10 NPCs e companheiros

| Aspecto | Original                                                          | Nosso                                                                   | V   |
| ------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- | --- |
| NPCs    | Nenhum objeto de NPC na evidência que temos [inferência]          | Nenhum; o companheiro é outro jogador (MP-03 derrubar e reviver) [repo] | ✅  |
| Pets    | Slot de decoração, sem efeito nos dados [inferência, `equips.ts`] | Seguem o dono, não colidem, não mudam a noite (MON-04, MON-01) [repo]   | ✅  |

### 2.11 Pets e cosméticos

| Aspecto  | Original                                                                                                                        | Nosso                                                                                                           | V   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --- |
| Catálogo | 3 trajes e 6 pets vendidos por dinheiro [repo `shop.ts:155`], num slot só de decoração [inferência: o `equipDeco` que herdamos] | Dois slots (traje + pet), por moedas do jogo, visíveis para todos, em pixel art (MON-04, ART-09, ART-11) [repo] | ✅  |
| Títulos  | Não havia [inferência]                                                                                                          | Três títulos ganhos jogando (MON-05) [repo]                                                                     | ✅  |
| Cadência | Nada novo depois de 2017 [web]                                                                                                  | Catálogo parado em 3 + 6; sem calendário de cosmético [repo `shop.ts`; MONETIZATION "Assinatura — ainda não"]   | 💡  |

### 2.12 Economia, loja e monetização

| Aspecto            | Original                                                                        | Nosso                                                                                                                                         | V   |
| ------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| De onde vêm moedas | Anúncio (5 por anúncio), pacote de moedas pago [repo `constants.ts`, CON-05 F8] | Só jogando: 3 por dia, +10 a cada 5 dias de recorde, 8 por chefe, 20 de boas-vindas [repo `shop.ts` `ECONOMY`]                                | ✅  |
| Pacotes            | Conteúdo fixo por moedas [repo CON-05]                                          | Nove pacotes fixos (MON-03), entregues pelo servidor [repo]                                                                                   | ✅  |
| Robux              | Compra no app desligada em 2017 [web APKCombo]                                  | **Nenhuma** chamada de `MarketplaceService` [repo MONETIZATION]                                                                               | 💡  |
| Risco              | —                                                                               | Pacotes (Axe, Medic Bag) e o Rebirth são **capacidade comprada com moedas**: vender moedas por Robux viraria pay-to-win (MON-01) [inferência] | ⚠️  |

### 2.13 Conquistas e recordes

| Aspecto    | Original                                                | Nosso                                                                                                      | V   |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --- |
| Conquistas | 22, **no Google Play Games** (perfil do jogador) [repo] | 18 à vista, só o servidor conta (CON-04); **nenhuma vira badge do Roblox** (`BadgeService` ausente) [repo] | ⚠️  |
| Recordes   | Melhor dia [inferência: `bestDay` herdado]              | Records (UI-12), placar da partida (MP-23), registro dos mundos (`worldLog.ts`) [repo]                     | ✅  |
| Ranking    | —                                                       | Sem ranking global; o CREATOR_HUB o previa "depois da F2" (`OrderedDataStore`) [repo]                      | 💡  |

### 2.14 Progressão entre vidas

| Aspecto    | Original                                                                                                                       | Nosso                                                                                                 | V   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --- |
| Morreu     | "Continue" pago com moedas, ou jogo novo [repo `shop.ts` `rebirthPrice`, "the n-th continue"; inferência que veio do original] | Rebirth pago (10 + 10·d²), **espera do amanhecer grátis**, ou New game (MP-21) [repo]                 | ✅  |
| O que fica | Nível, skills, moedas [inferência: o port manteve "como hoje"]                                                                 | Nível, skills, moedas, pacotes, títulos; o mundo acaba quando todos caem e nasce outro (MP-22) [repo] | ✅  |
| A base     | Provavelmente no save local [inferência]                                                                                       | Some quando o servidor fecha ou o mundo acaba: nada da cidade entra no save (`PlayerSaveData`) [repo] | ⚠️  |
| Legado     | —                                                                                                                              | O registro dos mundos existe no DataStore, mas o jogador não o vê [repo `worldLog.ts`]                | 💡  |

### 2.15 Curva de dificuldade

| Aspecto    | Original                                                                                                                           | Nosso                                                                                                                                                     | V   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Degraus    | População nos dias 2, 4, 10, 20; dificuldade no dia 15 (×2 HP e dano, +33% velocidade) e 30 (×3) [repo `spawns.ts`, `save.ts:581`] | Iguais, + S(k), diretor e variantes [repo]                                                                                                                | ✅  |
| Quem sente | Todo jogador começa no dia 1 [repo `DAY_POPULATION`, jogo solo]                                                                    | A dificuldade é a do **dia do mundo** (`waves.ts:335`): um novato que entra num servidor público no dia 20 enfrenta 30/30/50 + especiais com ×2 HP [repo] | ⚠️  |
| Medir      | —                                                                                                                                  | Funil NightSurvival pergunta exatamente onde a curva mata (ANALYTICS §4) [repo]                                                                           | 💡  |

### 2.16 Onboarding e tutorial

| Aspecto | Original                                                        | Nosso                                                                                                                   | V   |
| ------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --- |
| Ensinar | Tutorial opcional ("watch the tutorial?") [repo `tutorialDone`] | Cinco objetivos que observam o mundo, o último com prazo às 19:00 (`onboarding/objectives.ts`); nunca interrompe [repo] | ✅  |
| Medir   | —                                                               | Funil de onboarding no Creator Hub (ANALYTICS §2) [repo]                                                                | ✅  |
| Chegada | Dia 1, sozinho [repo]                                           | Pode chegar num mundo avançado e cheio de estranhos (§2.15, §2.19) [repo]                                               | ⚠️  |

### 2.17 UI, HUD e controles

| Aspecto     | Original                                                                                           | Nosso                                                                                                                                                | V   |
| ----------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Toque       | Analógico à esquerda, pad de mira à direita, câmera girando; "wonky" [repo `input.ts`; web TapTap] | Câmera fixa, canhoto, analógico flutuante, alvos ≥ 44 px, mira assistida, HUD que nunca cobre o polegar (UI-09) [repo]                               | ✅  |
| Plataformas | Só celular [web]                                                                                   | Toque, teclado e mouse, controle (foco, B volta, D-pad troca de arma) (UI-07, ITM-06) [repo]                                                         | ✅  |
| Visual      | "UI not the best in design" [web TapTap]                                                           | Kit próprio com contraste medido, sem contorno de texto, Reduzir Movimento (UI-01..12) [repo]                                                        | ✅  |
| Pausa       | O port copiava a pausa [repo MULTIPLAYER §1; inferência para o original]                           | Nenhum menu pausa (UI-06, decisão do dono) [repo]                                                                                                    | ✅  |
| Uso rápido  | Não sabemos [—]                                                                                    | Não existe barra de uso rápido (UI-09 proíbe "fingir uma"); curar = abrir o Bag no meio da horda [repo]                                              | 💡  |
| Falar       | —                                                                                                  | Só texto por proximidade (MP-17); no celular e no console digitar é lento e às vezes indisponível; **nenhum ping ou fala rápida** [repo; inferência] | ⚠️  |

### 2.18 Áudio

| Aspecto | Original                                                                                  | Nosso                                                                                                                                                                                                                                                                                                      | V   |
| ------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Regra   | De dia sem música, música à noite, batimento em três níveis (35/22/10%) [repo `music.ts`] | A mesma regra + stingers das ondas e pássaros do amanhecer [repo]                                                                                                                                                                                                                                          | ✅  |
| Licença | —                                                                                         | Só bibliotecas oficiais, com registro por som (`design/audio-credits.md`) [repo]                                                                                                                                                                                                                           | ✅  |
| Buracos | Moto com som de motor [repo VEI-05]                                                       | Fechados na P0-4: mordida, portas, uso de item (som de mundo do servidor), lança-chamas, motor pela velocidade, buzina, campainha, voz da horda [repo `audio-credits.md`]. Faltam: a injeção (slot vazio, silêncio), a dor e a morte do jogador (ainda o `uuhhh` do motor) e a passada de escuta no Studio | ⚠️  |

### 2.19 Multiplayer

| Aspecto | Original                            | Nosso                                                                                                                                         | V   |
| ------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Modo    | Single-player offline [repo LEG-05] | Até 6 em co-op, servidor autoritativo, sem PvP (MP-00, MP-01) [repo]                                                                          | ✅  |
| Solo    | Sempre solo                         | "Play solo" (servidor reservado) **desenhado e não construído**: nenhum `TeleportService` em `src/` [repo MULTIPLAYER §7.4]                   | ⚠️  |
| Privado | —                                   | VIP funciona como público; a regra "privado continua no dia do dono" (MP-13) não está no código (nenhum `PrivateServerId` no servidor) [repo] | ⚠️  |
| Morto   | —                                   | Espera do amanhecer sem "Espectar" (MULTIPLAYER D11 o previa; só o bit `Spectating` reservado) [repo `protocol.ts:439`]                       | 💡  |
| Chegar  | —                                   | Sem convite de amigo (`SocialService` ausente); matchmaking padrão já prioriza amigos (servidores-e-dados §2.2) [repo]                        | 💡  |

### 2.20 Retenção

| Aspecto            | Original                                                                                                                      | Nosso                                                                                                | V   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --- |
| Ganchos            | Anúncio com recompensa, conquistas do Google Play, compras [repo]                                                             | Títulos, conquistas, recorde, moedas por dia [repo]                                                  | ✅  |
| Voltar amanhã      | Nenhum gancho diário conhecido [inferência]                                                                                   | Nenhum: sem desafio diário, sem evento, sem badge, sem ranking [repo: nenhuma dessas APIs em `src/`] | 💡  |
| "Minha base"       | O motivo de jogar a noite inteira [web Aptoide]                                                                               | A base é de uma sessão (§2.14) [repo]                                                                | ⚠️  |
| Encomendas no mapa | 4 encomendas (`PARCEL_NUMBER`), ligadas a anúncio a cada 2 min (`PARCEL_ADS_TIME`) [repo; o vínculo com anúncio é inferência] | Constantes sem uso; nada cai no mapa [repo]                                                          | ⚠️  |

### 2.21 Save e língua

| Aspecto | Original                                       | Nosso                                                                                                                   | V   |
| ------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --- |
| Save    | Arquivo local, autosave de 5 s [repo]          | DataStore com trava de sessão, migrações v2→v6, RTBF (MULTIPLAYER §6) [repo]                                            | ✅  |
| Línguas | EN, KR, CN, JP escritos à mão [repo `lang.ts`] | Inglês + tradução **automática** do Roblox; `OVERRIDES` vazio, CSV só com a fonte (`design/locale/ProjectZ.csv`) [repo] | ⚠️  |

---

## 3. Onde o original está MELHOR hoje

| #   | O original                                             | O nosso hoje                                                                                                           | Evidência                                                   |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Todo jogador começa no dia 1                           | Um novato pode cair num mundo público no dia 20+ e levar a dificuldade dele                                            | [repo] `waves.ts:335`, `spawns.ts`; servidores-e-dados §2.3 |
| 2   | Jogar sozinho, sem estranhos, quando quiser            | Só servidor público; o "Play solo" não existe                                                                          | [repo] MULTIPLAYER §7.4; grep sem `TeleportService`         |
| 3   | A base provavelmente persistia                         | A base some quando o servidor esvazia ou o mundo acaba                                                                 | [inferência] × [repo] `PlayerSaveData`                      |
| 4   | Conquistas no perfil da plataforma                     | Conquistas só dentro do jogo                                                                                           | [repo] `achievements.ts` `androidId`; sem `BadgeService`    |
| 5   | Tradução humana em coreano, chinês e japonês           | Tradução automática, sem revisão                                                                                       | [repo] `lang.ts`                                            |
| 6   | Moto com farol e som de motor                          | **Resolvido (P0-4, 2026-09-24):** farol pela regra da luz, motor, buzina e campainha                                   | [repo] VEI-05, LUZ-04, `audio-credits.md`                   |
| 7   | Chefes com arte própria, sem contradição de regra      | **Resolvido (P0-3, 2026-09-24):** ligados na CON-03, nas telas de recorde, pixel art (ART-14) à espera do `upload-art` | [repo] CON-03, ART-14, UI-10, UI-12                         |
| 8   | Encomendas no mapa: um motivo a mais para sair da base | Nada cai no mapa                                                                                                       | [repo] `constants.ts` `PARCEL_NUMBER`                       |
| 9   | Mapa fixo que se aprende (trade-off, não defeito)      | Cidade nova a cada fim de mundo; bom para explorar, ruim para dominar rotas                                            | [inferência]; MP-22                                         |

Fora da lista de propósito: jogar offline (limite da plataforma) e a pausa (UI-06 é decisão do dono; a resposta certa é o
Play solo, não pausar o mundo).

---

## 4. Incoerências internas encontradas (doc × código)

| #   | Onde                             | O que diz                                                                                             | O que o código faz                                                                                                                                                                                                                 |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | CON-03, ART-10, UI-10, UI-12     | Zumbis do Núcleo 1 são Walker e Charger, **sem chefe**; Records e tela Survivor sem "Bosses defeated" | Os 5 tipos e os 4 chefes nascem (`population.ts`); CON-04 e ITM-05 contam com eles; a loja mostra "Bosses defeated" (`client/ui/shop.ts:299`). **Fechada (P0-3, 2026-09-24):** as regras e as telas agora dizem o que o código faz |
| I2  | MP-13, MP-20                     | Servidor privado continua no dia do dono; "compartilhado" lido de `PrivateServerId`                   | Nenhum `PrivateServerId` no servidor; o comentário em `main.client.ts:153` diz que a divisão saiu                                                                                                                                  |
| I3  | MULTIPLAYER.md cabeçalho         | "Status: proposta de arquitetura (nada implementado)"                                                 | F0–F3 e boa parte da F4 estão no jogo (`MP_PHASE` 2, `WORLD_SERVER_PHASE` 2)                                                                                                                                                       |
| I4  | MULTIPLAYER D11, §7.3, §7.4      | Espectar e Play solo                                                                                  | Nenhum dos dois existe                                                                                                                                                                                                             |
| I5  | MONETIZATION.md × CREATOR_HUB.md | "Assinatura — ainda não" × "Subscriptions: Não"                                                       | Sem código; só as duas frases divergem no tom (uma espera cadência, a outra recusa)                                                                                                                                                |

---

## 5. Recomendações priorizadas

**P0** = quebra a primeira impressão ou uma regra prometida; antes de abrir o jogo. **P1** = maior impacto em seguida.
**P2** = depois, ou operação contínua. Impacto de 1 a 5, para o jogador.

### Tabela

| ID   | O quê                                                                                          | Impacto | Esforço | Regras tocadas                                       |
| ---- | ---------------------------------------------------------------------------------------------- | ------- | ------- | ---------------------------------------------------- |
| P0-1 | Novato nunca cai num mundo de dia alto                                                         | 5       | S–M     | MP-09, MP-13, MP-20                                  |
| P0-2 | Construir o Play solo (servidor reservado)                                                     | 4       | M       | MP-14, MP-20, MP-13, UI-10                           |
| P0-3 | ✅ **Feito** (2026-09-24): chefes ligados, nas telas, pixel art; sobram o telegrafar e o aviso | 4       | S + M   | CON-03, CON-04, ITM-05, UI-10, UI-12, ART-10, ART-14 |
| P0-4 | ✅ **Feito** (2026-09-24): sons dos eventos centrais e farol; sobram injeção, dor e escuta     | 3       | S–M     | VEI-05, LEG-04, LUZ-04, CON-02 (licença)             |
| P1-1 | Cidade persistente em servidor privado                                                         | 5       | L–XL    | MP-13, MP-20, MP-22, MON-01, MON-03                  |
| P1-2 | Pings e falas rápidas de proximidade (toque e controle)                                        | 4       | M       | MP-17, MP-07, UI-04, UI-09, LEG-02                   |
| P1-3 | Uso rápido de cura e comida sem abrir o Bag                                                    | 4       | M       | UI-06, UI-09 (emenda), MON-01                        |
| P1-4 | Badges do Roblox para conquistas e títulos                                                     | 3       | S       | CON-04, MON-05, MP-00                                |
| P1-5 | Encomendas de volta, como evento de mundo de dia                                               | 4       | M       | MP-05, MP-06, IA-02, LEG-01, APO-01, MON-01          |
| P1-6 | Desafios diários do servidor                                                                   | 4       | M       | MON-01, MON-05, CON-03, MP-00                        |
| P1-7 | Espectar enquanto espera o amanhecer                                                           | 3       | M       | MP-21, MP-07, UI-06                                  |
| P1-8 | Convidar amigos                                                                                | 3       | S       | UI-07, UI-10                                         |
| P1-9 | Ranking: melhor dia e a cidade que mais durou                                                  | 3       | M       | MON-05, MP-00, MP-22                                 |
| P2-1 | Eventos sazonais no tom do Dead Town                                                           | 3       | M cada  | MON-01, MON-03, APO-03, LUZ-02                       |
| P2-2 | Tradução revisada (PT-BR, ES, KO) pelos `OVERRIDES`                                            | 3       | S–M     | UI-03                                                |
| P2-3 | Robux só cosmético e conveniência (VIP, paleta), nunca moedas                                  | 3       | M       | MON-01..04                                           |
| P2-4 | Papéis co-op legíveis a partir das skills                                                      | 2       | S       | MP-23, UI-12, MON-01                                 |
| P2-5 | Memorial das cidades caídas no lobby                                                           | 2       | S–M     | UI-10, MP-22                                         |
| P2-6 | Afinar a curva e a economia com os painéis                                                     | 3       | S       | MP-09, ANALYTICS                                     |
| P2-7 | Fechar pendências registradas (forno, raio do aliado; o farol saiu com a P0-4)                 | 2       | S–M     | LUZ-04, ELE-03, §10A                                 |
| P2-8 | Marcos fixos na cidade procedural                                                              | 2       | M       | EDI-02, EDI-06, INT-01                               |
| P2-9 | Noite com um motivo para sair da base                                                          | 3       | M       | IA-03, LUZ-02, MP-09                                 |

### P0-1 — O novato nunca cai num mundo de dia alto

- **O quê:** publicar o dia do mundo como atributo numérico de matchmaking (`MatchmakingService:SetServerAttribute`,
  `WorldDay`) a cada virada de dia, com o sinal configurado no Creator Hub para aproximar jogadores de nível baixo de
  servidores de dia baixo; e, no primeiro save (funil "Joined"), preferir servidor com dia ≤ 5 ou, sem ele, o Play solo
  (P0-2). Quem já joga continua caindo com os amigos (o peso de _Friends_ é maior que a soma dos outros).
- **Por quê:** a dificuldade e as ondas seguem o **dia do mundo** (`server/sim/waves.ts:335`, `spawns.ts`
  `getDayPopulation`) [repo]. Um save novo com adaga entra no dia 20: 30/30/50 walkers + 4 especiais por onda, com ×2 de
  HP a partir do dia 15 [repo]. No original todo mundo começava no dia 1 [repo]. O problema já estava apontado em
  `servidores-e-dados.md` §2.3, como "Média, pós-F5"; aqui ele sobe porque é o funil de onboarding (ANALYTICS §2) que
  paga. O CREATOR_HUB diz "Custom matchmaking — não agora": este sinal é a exceção, porque não é fila, é um atributo.
- **Esforço:** S (atributo + sinal) a M (regra do primeiro save). Confirmar a API no Context7 antes (regra da casa).
- **Regras:** MP-09, MP-13, MP-20.

### P0-2 — Construir o Play solo

- **O quê:** o que a §7.4 do `MULTIPLAYER.md` já especifica — `TeleportAsync` com `ShouldReserveServer`, SafeTeleport,
  detector de modo por `PrivateServerId` / `PrivateServerOwnerId` — com um botão na tela Survivor (UI-10), não no menu.
- **Por quê:** o original era solo [repo]; MP-14 promete que "solo é o jogo de hoje" e o CREATOR_HUB diz que "o solo não
  pode virar um modo pior que o co-op". Hoje não há `TeleportService` em `src/` [repo]: quem quer jogar sozinho cai com
  estranhos. Também é a resposta certa para quem sente falta da pausa (UI-06 fica como está).
- **Esforço:** M. No Studio o teleporte não roda; testar numa experiência de teste separada (servidores-e-dados §4).
- **Regras:** MP-14, MP-20, MP-13 (definir de novo o que é "solo/privado"), UI-10.

### P0-3 — Decidir os chefes e alinhar tudo

- **O quê:** registrar na CON-03 que os chefes **estão no jogo** (é o que o código, a CON-04 e a ITM-05 já dizem);
  mostrar "Bosses defeated" no Records e nas Stats da tela Survivor; dar aos quatro a pixel art da ART-08/ART-10 e um
  telegrafar legível dos ataques (a centopeia moendo, as agulhas do ouriço); e um aviso de mundo quando um chefe acorda
  ("Something big is awake near the school"), só para quem está perto.
- **Por quê:** incoerência I1 (§4). Os chefes são a meta de meio de jogo do original (dias 5–10) e a única fonte do
  lança-chamas e da Plastic armor (ITM-05) [repo]. Desligá-los tiraria conteúdo que funciona; escondê-los das telas faz o
  jogador achar que não existem.
- **Esforço:** S (texto e telas) + M (arte e telegrafar).
- **Regras:** CON-03, CON-04, ITM-05, UI-10, UI-12, ART-08, ART-10, LEG-03.
- **Status (2026-09-24): feito.** A CON-03 diz que os chefes estão ligados e por quê (a CON-04, a ITM-05, a ART-10, a
  UI-10 e a UI-12 foram alinhadas); "Bosses defeated" (o `bossKills` do servidor) está no Records e nas Stats da tela
  Survivor; os quatro têm pixel art (ART-14: `tools/boss-model.mjs`, `client/view/bossView.ts`), com o desenho liso de
  antes, chamada por chamada, até o dono rodar `npm run cloud -- upload-art` (12 texturas novas) — `test:world-art`
  §10f, com a LEG-03 medida em sete chãos. **O que sobra:** (1) o **telegrafar dos ataques** — a centopeia moendo, o
  leque do ouriço antes de sair, o açoite da rafflesia, a arrancada do gigante — legível antes do golpe, como a
  inclinação do walker (LEG-04); (2) o **aviso de que um chefe acordou** ("Something big is awake near the school"), só
  para quem está perto (o `spawnBoss` do `population.ts` não anuncia nada), com o texto na `lang.ts`; (3) ver a arte no
  Studio depois do `upload-art`.

### P0-4 — Fechar os buracos de áudio

- **O quê:** criar os `FxEvent` que faltam (mordida, porta, uso de item, lança-chamas) e preenchê-los só com bibliotecas
  oficiais; motor e campainha da VEI-05; um take humano para dor e morte; seguir procurando voz de criatura licenciada.
- **Por quê:** a mordida é o evento mais importante do jogo e é muda [repo `audio-credits.md` D]; a moto do original
  tinha motor [repo VEI-05]. Som é o canal que o jogador de celular usa quando o dedo cobre a tela [inferência].
- **Esforço:** S–M.
- **Regras:** VEI-05 (pendente), LEG-04, a política de licença de `design/audio-credits.md`.
- **Status (2026-09-24): feito.** Mordida, portas de madeira e de ferro, comer, enfaixar, kit médico e comprimidos saem
  do servidor como som de mundo (`Fx Sound`, a tabela `WIRE_SOUNDS`, MULTIPLAYER §4.2); o lança-chamas é um jato em
  laço com ignição; o motor da moto é um laço que sobe de tom e de volume com a velocidade, para o piloto e para quem o
  vê; buzina e campainha; a voz da horda (gemidos, rosnado ao te ver, o grito do grupo) com orçamento, posicionada; e o
  **farol da moto** como luz, pela regra única da LUZ-04. Tudo da biblioteca oficial (ProSoundEffects, domínio
  público), cada id conferido pelas APIs públicas da Roblox e listado em `design/audio-credits.md`; volumes pelos grupos
  da Settings; nenhuma Instance nova por som (`test:audio`, `test:vehicles` §B12). **O que sobra:** (1) o **som da
  injeção** (`useInject`: slot vazio, toca silêncio; o dono escolhe o id — pendência D do `audio-credits.md`); (2) a
  **passada de escuta no Studio** — as janelas foram medidas pelo envelope do arquivo, não ouvidas (pendência F); (3) o
  take humano para **dor e morte** do jogador, que continua o `uuhhh` do motor (pendência C).

### P1-1 — Cidade persistente em servidor privado

- **O quê:** em servidor VIP, gravar por `PrivateServerId` a semente, o dia do mundo, as construções (com dono e HP), a
  rede elétrica e os itens no chão; carregar ao abrir o servidor. O fim do mundo (MP-22) continua valendo: todos caíram,
  a cidade cai. Público continua como hoje.
- **Por quê:** "a base que eu fiz" é o que os jogadores lembram do original ("kept me awake all night to make a base
  with turrets") [web Aptoide]; hoje a base some quando o servidor esvazia [repo]. É também o que faz o **servidor
  privado** — o produto nº 1 do `MONETIZATION.md` — valer o preço sem vender vantagem nenhuma.
- **Esforço:** L–XL (formato novo de DataStore, limites de tamanho e escrita de `servidores-e-dados` §3.3, migração,
  RTBF do dono do servidor).
- **Regras:** MP-13 (implementá-la de verdade), MP-20, MP-22, MON-01, MON-03; revisão independente de save e segurança
  (CLAUDE.md, "merge grande").

### P1-2 — Pings e falas rápidas de proximidade

- **O quê:** uma roda de 6–8 falas fixas ("Help!", "Zombies here", "Come to the base", "Loot here", "Need ammo",
  "Thanks") e um marcador no chão onde se mira, com o alcance do chat (MP-17) e nas cores da LEG-02. No controle, um
  botão; no toque, um botão na fileira do Menu e do Bag.
- **Por quê:** no celular digitar no meio da horda é impossível e no console o chat de texto costuma estar indisponível
  [inferência]; o co-op (derrubar e reviver, MP-03) depende de avisar. Textos fixos passam pela `lang.ts` e dispensam
  filtro de texto livre.
- **Esforço:** M.
- **Regras:** MP-17 (mesmo alcance), MP-07 (o marcador só aponta o que quem marcou vê), UI-04, UI-09 (no console, não
  um card solto), LEG-02.

### P1-3 — Uso rápido de cura e comida

- **O quê:** um botão de "usar o melhor curativo" e outro de "comer" (ou um ladrilho de consumível na hotbar), que
  escolhem pela mesma regra do servidor (`itemUseWouldWork`).
- **Por quê:** nada pausa (UI-06) e o Bag cobre ~80% da tela 16:9 — a própria UI-06 registra esse limite [repo]. No
  toque, enfaixar no meio da horda é abrir uma janela sobre o perigo.
- **Esforço:** M. **Precisa de decisão do dono:** a UI-09 diz "este jogo não tem barra de uso rápido, então não se
  finge uma" — isto a tornaria real, com emenda na regra.
- **Regras:** UI-06, UI-09, MON-01 (não se vende).

### P1-4 — Badges

- **O quê:** um badge por conquista à vista (18) e por título (3), concedido **no servidor**, no mesmo evento que já as
  credita (`server/save/achievements.ts`, `titles.ts`). Nenhum badge por compra (CREATOR_HUB).
- **Por quê:** o original punha as conquistas no perfil do Google Play Games [repo]; no Roblox o equivalente é o badge,
  que aparece no perfil e na página do jogo [inferência]. O CREATOR_HUB já o recomenda.
- **Esforço:** S. Verificar no Context7 o custo e o limite de criação de badges antes de criar os 21.
- **Regras:** CON-04, MON-05, MP-00.

### P1-5 — Encomendas de volta, como evento de mundo

- **O quê:** de dia, uma encomenda (caixa de suprimento lançada) cai numa rua sorteada, com fumaça visível de longe e um
  ruído que chama a horda; o primeiro que abrir leva (MP-06), com conteúdo da tabela geral. Nada ligado a anúncio.
- **Por quê:** o original tinha 4 encomendas no mapa [repo `PARCEL_NUMBER`] e a crítica "as ondas restringem a
  exploração" [web TapTap] pede motivo para sair de dia. Em grupo vira corrida ou escolta.
- **Esforço:** M.
- **Regras:** MP-05, MP-06, IA-02 (o ruído), LEG-01 (a pílula "E: Open"), APO-01 (faz sentido na cidade), MON-01.

### P1-6 — Desafios diários do servidor

- **O quê:** três por dia real, sorteados de uma lista temática e contados só pelo servidor: "Survive a night without
  firing a gun", "Cook 3 meals", "Barricade a window before 19:00", "Revive an ally". Recompensa em moedas do jogo e
  progresso para um título.
- **Por quê:** hoje não há gancho para voltar amanhã [repo]; o original também não tinha, e não teve atualização depois
  de 2017 [web]. Desafio sobre conteúdo que funciona ensina o jogo (cozinhar, fortificar).
- **Esforço:** M.
- **Regras:** MON-01 (a moeda nunca é vendida por Robux), MON-05 (título só jogando), CON-03 (só conteúdo que
  funciona), MP-00, ANALYTICS (evento agregado, nunca por ação).

### P1-7 — Espectar enquanto espera o amanhecer

- **O quê:** na espera da MP-21, a câmera segue um aliado vivo (troca com ◀ ▶), com o interesse de rede do espectado.
- **Por quê:** a espera pode chegar a ~3,6 min de noite [repo MP-21]; ver o grupo lutar mantém o jogador ali e ensina.
  Estava no plano (D11) e só o bit `Spectating` existe [repo].
- **Esforço:** M.
- **Regras:** MP-21, MP-07 (recebe só o que o espectado vê), UI-06.

### P1-8 — Convidar amigos

- **O quê:** "Invite friends" no menu do lobby e no menu da partida (`SocialService:PromptGameInvite`).
- **Por quê:** o jogo é co-op e o matchmaking já prioriza amigos [repo servidores-e-dados §2.2]; falta o convite.
  Não é o "Referral rewards" que o CREATOR_HUB adia: não dá prêmio.
- **Esforço:** S.
- **Regras:** UI-07, UI-10.

### P1-9 — Ranking

- **O quê:** `OrderedDataStore` com o melhor dia de uma vida e a cidade que mais durou (do `worldLog`), numa aba do
  Records.
- **Por quê:** "sobreviver o máximo" é o objetivo declarado (MP-22) e hoje não se compara com ninguém [repo].
- **Esforço:** M.
- **Regras:** MON-05, MP-00 (só números do servidor), MP-22.

### P2 — depois

- **P2-1 Eventos sazonais:** uma "Noite longa" de Halloween (ondas maiores, título de evento) e o Natal com o traje Santa
  que já existe. Sem fantasia nem neon (APO-03), luz só com motivo (LUZ-02), nada à venda que mude a noite (MON-01).
- **P2-2 Tradução revisada:** o original tinha coreano escrito à mão [repo]; os `OVERRIDES` existem para corrigir a
  tradução automática por chave. Começar pelo que o jogador lê primeiro (lobby, HUD, objetivos) em PT-BR, ES e KO. UI-03.
- **P2-3 Robux:** VIP e a paleta do sobrevivente, na ordem do `MONETIZATION.md`, com `PolicyService`. **Nunca vender
  moedas:** com moedas se compram pacotes com arma e remédio e o Rebirth — vender moeda seria vender vantagem (MON-01).
- **P2-4 Papéis co-op legíveis:** no placar (MP-23), um glifo do papel que as skills já criam (Engineering/Robotics =
  engenheiro, Chef/Recovery = cozinheiro, Repairman = reparos, Head shooter = atirador). Nada de classe nova.
- **P2-5 Memorial das cidades:** uma seção do lobby com as últimas cidades que caíram (dia, quantos caíram), do
  `worldLog` que já existe. UI-10.
- **P2-6 Afinar com dados:** o salto do dia 15 (×2 HP e dano) e o preço do Rebirth contra 3 moedas por dia só se mexem
  depois dos painéis NightSurvival e Economy (ANALYTICS §3–4).
- **P2-7 Pendências registradas:** farol da moto como luz (LUZ-04), forno elétrico e bancadas noturnas exigindo energia
  (§10A), o raio da luz do aliado no fio (LUZ-04, `BUG [LUZ-04-ally-radius]`).
- **P2-8 Marcos fixos:** peças que aparecem em toda cidade (a praça do centro, a torre d'água, as praças dos chefes já
  livres) para recuperar parte da memória do mapa feito à mão, sem perder a cidade nova da MP-22. EDI-02, EDI-06, INT-01.
- **P2-9 Um motivo para sair à noite:** saque melhor só à noite em alguns prédios, ou a encomenda noturna rara (P1-5)
  — a resposta à crítica "as ondas restringem a exploração", respeitando que a onda sempre persegue (IA-03).

### Avaliado e descartado

| Ideia                                               | Por que não                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Sede ou stamina                                     | O original não tinha [inferência]; mais uma barra num console sem espaço (UI-09)      |
| NPCs sobreviventes                                  | Não é a identidade do Dead Town; o companheiro é o outro jogador (MP-03)              |
| PvP ou fogo amigo                                   | MP-01                                                                                 |
| Pausa no solo                                       | UI-06 (decisão do dono); o Play solo resolve a necessidade                            |
| Caixa aleatória, XP em dobro, reviver pago em Robux | MON-01, MON-03                                                                        |
| Câmera que gira, como no original                   | P2: a câmera fixa é o que deixa ler a cidade e mirar no toque                         |
| Voz, sussurro, chat global                          | MP-17, CREATOR_HUB (superfície de moderação)                                          |
| Anúncios com recompensa                             | CREATOR_HUB: desligados; no original davam moeda, que aqui compra capacidade (MON-01) |

---

## 6. Fontes

**Web** (consultadas em 2026-09-24):

- TapTap, página do jogo: <https://www.taptap.io/app/24494> — lançamento, última atualização, plataformas, descrição.
- TapTap, avaliações: <https://www.taptap.io/app/24494/review> — elogios e críticas citados.
- APKCombo: <https://apkcombo.com/dead-town-zombie-survival/com.lemonpuppy.deadtown/> — instalações, nota, versões,
  classificação, o aviso da compra no app desligada.
- Aptoide: <https://dead-town.en.aptoide.com/app> — avaliações ("make a base with turrets").
- LevelWinner, guia: <https://www.levelwinner.com/dead-town-tips-cheats-and-strategies/> — primeira horda no fim do dia 1,
  fome e regeneração, três árvores de skill, detecção por som, "auto-reparo".
- NamuWiki: <https://en.namu.wiki/w/%EB%8D%B0%EB%93%9C%20%ED%83%80%EC%9A%B4> — **não abriu (403)**; usado só o resumo
  do buscador (três ondas, retirada do Google Play em 2021-11-08). Tratar como não verificado.
- Uptodown: <https://dead-town.en.uptodown.com/android> — **não abriu (410)**; resumo do buscador (manche direito gira
  a câmera).
- O resumo de uma busca citou jogos de outro estúdio com nomes parecidos ("Dead Town Survival", "Dead Town Defense") e
  multiplayer; **não são o original** e nada deles entrou aqui.

**Repo:** `docs/DESIGN_RULES.md` (todas as seções citadas), `docs/MULTIPLAYER.md`, `docs/MONETIZATION.md`,
`docs/ANALYTICS.md`, `docs/CREATOR_HUB.md`, `docs/research/servidores-e-dados.md`, `design/audio-credits.md`,
`src/shared/engine/constants.ts`, `src/shared/data/{spawns,zombies,weapons,equips,usables,etcItems,skills,shop,achievements,lang}.ts`,
`src/shared/game/{entities,player,save,world}.ts`, `src/shared/sim/{playerMove,craftRule,loot}.ts`,
`src/shared/sim/ai/{director,population,zombieBrain,perception,memory,noise,bossBrain}.ts`,
`src/server/sim/{waves,power,items,combat}.ts`, `src/client/audio/music.ts`, `src/client/onboarding/objectives.ts`.

Nota de propriedade intelectual: este é um documento interno de pesquisa. No jogo continuam valendo a CON-01 (nenhum
nome, logo ou arte do original; os créditos dizem só "Inspired by the original Dead Town") e a CON-05 (texto nosso).
