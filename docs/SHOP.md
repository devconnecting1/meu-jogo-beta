# Loja, moedas e preços

Tudo o que se compra, se ganha ou se dá no Last Town, quanto custa, onde aparece, o que entrega e **por que custa isso**.
A fonte de cada número é **uma só**: `src/shared/data/shop.ts` (`ECONOMY`, `SHOP_PACKS`, `COSTUMES`, `rebirthPrice`, o
modelo de renda, as faixas e o preço em Robux de cada faixa, `ROBUX_TIER_PRICE`). O servidor cobra e paga com ela, toda tela mostra com ela, e `npm run test:shop` falha
quando um número da tela, do servidor, dos dados ou **desta página** diverge, ou quando um preço sai da faixa de horas
de jogo que o modelo dá ao seu tier. Regras de produto: DESIGN_RULES MON-01..07, BEM-02, SAV-01.

## Resposta curta (a pergunta do dono, 2026-09-24)

> "Compras e vendas: ao comprar itens, pets, trajes, pacotes etc., fica disponível/desbloqueado? Os valores estão
> certos, sem valor diferente em outro lugar?"

- **Sim, fica disponível**, e agora isso é verificado de ponta a ponta com o servidor real: cada pacote vai para a
  mochila ao entrar na cidade (item por item, uma vez); cada traje e pet fica seu, veste pelo guarda-roupa fora da
  cidade, **aparece para os outros jogadores** (MON-04) e continua seu e vestido ao entrar em **outro** servidor; cada
  Rebirth cobra o preço mostrado e levanta o sobrevivente. O guarda-roupa, a loja e o lobby montados com o save que
  voltou do servidor mostram tudo como seu (`test:shop` §3–§6).
- **Os valores batem**: o preço de cada cartão, ladrilho, botão "Buy for N coins", tela de morte e tela Survivor é
  exatamente o que o servidor tira do saldo, e é o mesmo número do evento de analytics. Um `price` enviado pelo cliente
  nunca é lido.
- **Não existe venda** (trocar item por moeda), e moedas só se ganham jogando (MON-01). **Robux** (decidido e
  implementado em 2026-09-24): servidor privado **grátis**, e trajes e pets **também** por Robux (49 / 149 / 349), o
  mesmo item das moedas — um produto de desenvolvedor por traje, o prompt aberto pelo servidor, a concessão só depois
  de a gravação com o `PurchaseId` chegar ao DataStore ("Robux: decisões e desenho", `test:shop` §7–§8). Enquanto o
  dono não criar os 9 produtos e colar os ids, **nada** é oferecido em Robux e o guarda-roupa é o de moedas.
- **Estava errado e foi corrigido** (detalhe em "Achados"): o servidor cobrava um pacote de pet que o cartão dizia
  "Owned"; as moedas ganhas à meia-noite e nos chefes nunca eram avisadas; três textos tinham números fixos que
  mentiriam na próxima mudança; o conteúdo dos pacotes estava escrito duas vezes; e os preços eram fáceis demais para o
  que o dono pediu (um pet em 1,6 h de jogo). Os preços novos seguem o modelo abaixo.

## Tabela de produtos

A coluna **Preço** é conferida linha a linha contra os dados pelo `test:shop` (§1): mudar um preço é mudar
`shop.ts` **e** esta tabela. **Horas** = horas de jogo de um jogador médio (18,5 moedas/h, modelo abaixo).
**Roblox**: o que o dono cria no Creator Hub para este produto.

| Produto               | Onde aparece                                                   | Faixa     | Preço                         | Moeda  | O que dá                                                                                         | Horas              | Roblox                                                |
| --------------------- | -------------------------------------------------------------- | --------- | ----------------------------- | ------ | ------------------------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------- |
| First Night Kit       | Loja › Packs (cartão)                                          | starter   | 20                            | moedas | 1 × Cotton clothes, 1 × Axe, 1 × Flashlight — na mochila ao entrar na cidade                     | 1,1                | nada (moedas do jogo)                                 |
| Pantry Crate          | Loja › Packs                                                   | supply    | 30                            | moedas | 3 × Cooked meat, 3 × Pizza, 3 × Cooked meal                                                      | 1,6                | nada                                                  |
| Medic Bag             | Loja › Packs                                                   | supply    | 45                            | moedas | 2 × First aid kit, 3 × Bandage, 2 × Adrenaline                                                   | 2,4                | nada                                                  |
| Builder's Basics      | Loja › Packs                                                   | starter   | 15                            | moedas | 20 × Wood, 10 × Cloth, 20 × Stone                                                                | 0,8                | nada                                                  |
| Workshop Supplies     | Loja › Packs                                                   | supply    | 60                            | moedas | 5 × Blueprint, 20 × Steel, 10 × Machine parts                                                    | 3,2                | nada                                                  |
| Electronics Box       | Loja › Packs                                                   | supply    | 60                            | moedas | 5 × Battery, 2 × Computer chip, 2 × Bulb                                                         | 3,2                | nada                                                  |
| Ammo Makings          | Loja › Packs                                                   | supply    | 40                            | moedas | 10 × Steel, 10 × Gunpowder (matéria-prima; munição pronta nunca é vendida, MON-03)               | 2,2                | nada                                                  |
| Pet Pigeon            | Loja › Packs (o pet desenhado no cartão)                       | rental    | 20                            | moedas | 1 × Pigeon na mochila, por esta vida (até o New game ou o fim da cidade)                         | 1,1                | nada                                                  |
| Pet Carolina          | Loja › Packs                                                   | rental    | 20                            | moedas | 1 × Carolina na mochila, por esta vida (até o New game ou o fim da cidade)                       | 1,1                | nada                                                  |
| Pigeon                | Guarda-roupa › Pets (ladrilho, painel, "Buy for N coins")      | common    | 70                            | moedas | o pombo para sempre, visto por todos                                                             | 3,8                | nada                                                  |
| White pigeon          | Guarda-roupa › Pets                                            | common    | 90                            | moedas | o pombo branco para sempre                                                                       | 4,9                | nada                                                  |
| Carolina              | Guarda-roupa › Pets                                            | common    | 70                            | moedas | a cadela caramelo para sempre                                                                    | 3,8                | nada                                                  |
| Malamute              | Guarda-roupa › Pets                                            | rare      | 220                           | moedas | o malamute (maior) para sempre                                                                   | 11,9               | nada                                                  |
| Doberman              | Guarda-roupa › Pets                                            | rare      | 220                           | moedas | o doberman para sempre                                                                           | 11,9               | nada                                                  |
| Santa                 | Guarda-roupa › Outfits                                         | rare      | 250                           | moedas | o traje para sempre, visto por todos                                                             | 13,5               | nada                                                  |
| Cowboy                | Guarda-roupa › Outfits                                         | rare      | 250                           | moedas | o traje para sempre                                                                              | 13,5               | nada                                                  |
| Zombie                | Guarda-roupa › Outfits                                         | top       | 600                           | moedas | o traje para sempre                                                                              | 32,4               | nada                                                  |
| Eagle                 | Guarda-roupa › Pets                                            | top       | 600                           | moedas | a águia (asas sempre abertas) para sempre                                                        | 32,4               | nada                                                  |
| Rebirth               | tela de morte, tela Survivor (lobby)                           | —         | 10 + 10·d² (10, 20, 50, 100…) | moedas | levanta agora, com a mochila; d = continues já pagos nesta vida (volta a 0 no New game)          | 0,5 o 1º; 9,2 o 5º | nada                                                  |
| Welcome gift          | Loja › Earn coins ("+20"), o aviso de boas-vindas              | fonte     | 20                            | moedas | uma vez, a todo save novo                                                                        | —                  | nada                                                  |
| Day survived          | Loja › Earn coins ("+3"), o aviso "+3 coins · Day survived ×1" | fonte     | 3                             | moedas | a cada meia-noite vivida (vivo à meia-noite, no mundo ≥ 50% do dia, sem AFK)                     | —                  | nada                                                  |
| Record day            | Loja › Earn coins ("+10"), o aviso "Record day ×1"             | fonte     | 10                            | moedas | a primeira vez que uma vida chega a um recorde múltiplo de 5 (`MILESTONE_EVERY`)                 | —                  | nada                                                  |
| Boss defeated         | Loja › Earn coins ("+8"), o aviso "Boss defeated ×1"           | fonte     | 8                             | moedas | a cada chefe derrubado com você na luta (≥ 3% do dano ou 20 s perto, MP-15)                      | —                  | nada                                                  |
| Pacote de boas-vindas | cartão do pacote ("Pending ×1"), tela Survivor                 | —         | 0                             | —      | knob `pz_welcome_pack` (−1 = nenhum; 0–8 = o pacote): um save novo ganha aquele pacote, pendente | —                  | Configs: `pz_welcome_pack`                            |
| Títulos               | Guarda-roupa › Titles                                          | —         | nunca vendido                 | —      | ganhos jogando (MON-05)                                                                          | —                  | nada                                                  |
| Conquistas            | Conquistas                                                     | —         | não pagam                     | —      | nada: "No coins or items: a record of what you did." (UI-14)                                     | —                  | nada                                                  |
| Vender itens          | —                                                              | —         | não existe                    | —      | não há venda; o ouro do banco é material de fabricação, não moeda                                | —                  | nada                                                  |
| Robux                 | Guarda-roupa: o painel do traje bloqueado ("See Price")        | cosmético | 49 / 149 / 349                | Robux  | o mesmo traje ou pet das moedas, para sempre; nunca pacote, moeda, Rebirth ou XP (seção abaixo)  | —                  | 9 produtos de desenvolvedor; servidor privado: grátis |

## O modelo

Uma hora de jogo na cidade rende, com os números que o servidor paga (`coinsPerHour`), `3600 / 605,2` dias × a
parte das meias-noites pagas × 3 moedas, mais os recordes × 10 e os chefes × 8. O dia de jogo tem **605,2 s reais**
(06:00–19:00 a 0,8× e 19:00–06:00 a 1,2× `TIME_SPEED`, `shared/sim/clock.ts`; o teste integra o relógio do mundo e
confere). As suposições de cada perfil estão em `INCOME_PROFILES`, escritas para serem discutidas — e medidas: quando o
jogo for público, o painel Economy do Creator Hub dá as fontes "Day survived", "Record milestone" e "Boss" por jogador
(`docs/ANALYTICS.md`), e é com elas que o modelo se corrige.

| Perfil            | Dias pagos | Chefes por hora | Recordes por hora | Moedas por hora | Uma vida (h) |
| ----------------- | ---------- | --------------- | ----------------- | --------------- | ------------ |
| `new` (novo)      | 0,4        | 0               | 0,15              | 8,6             | 1,5          |
| `average` (médio) | 0,7        | 0,5             | 0,2               | 18,5            | 4            |
| `strong` (forte)  | 0,95       | 1,5             | 0,3               | 32,0            | 10           |

- **Novo:** morre na maioria das noites nas ondas 1 e 2 (antes da meia-noite, então aquele dia não paga), não chega
  perto de chefe, alcança o dia 5 nas primeiras ~7 h.
- **Médio:** vive a maioria das noites, ajuda num chefe a cada duas horas, recorde de ~30 dias em ~30 h.
- **Forte:** quase nunca perde uma meia-noite, caça chefes (acordam do dia 5 do mundo, a cada 3 dias), ~45 dias em ~30 h.
- **Uma vida** (`lifeHours`): as horas de jogo do dia 1 de uma vida até o New game ou o fim da cidade (MP-22: todos
  caídos e ninguém pagando). É quanto dura o pet de um pacote (o `resetRun` o leva), e é contra ela que o pacote se
  preça.

### As faixas (horas de jogo médio, `PRICE_TIERS`)

Direção do dono (2026-09-24): "os valores têm que fazer sentido e ser **desafiadores**": cosmético comum ~3–5 h, raro
~10–15 h, topo 25 h ou mais; a primeira compra na primeira ou segunda sessão; a cauda longa exigente.

| Faixa     | Horas   | O que é                                                                                                                                                                   |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starter` | 0,5–1,5 | o primeiro pacote; o presente de boas-vindas (20) compra qualquer um deles na hora                                                                                        |
| `supply`  | 1,5–4   | os outros pacotes: consumíveis e materiais, algumas horas cada                                                                                                            |
| `rental`  | 0,5–1,5 | pacote de pet: o pet **por esta vida** (New game ou fim da cidade), no máximo 35% (`PET_RENTAL_SHARE`) do mesmo pet para sempre e 50% da vida média (`rentalShareOfLife`) |
| `common`  | 3–5     | cosmético comum para sempre                                                                                                                                               |
| `rare`    | 10–15   | cosmético raro                                                                                                                                                            |
| `top`     | 25–40   | o topo                                                                                                                                                                    |

Promessas do modelo (`ECONOMY_TARGETS`, cada uma um teste): o jogador novo compra o pacote mais barato só jogando em
≤ 2 h (hoje 1,7 h); um cosmético do topo custa ≥ 15 h até para o forte (hoje 18,8 h); o 1º Rebirth de uma vida fica
entre 0,25 e 1,5 h (hoje 0,5 h), o 3º ≥ 2 h (2,7 h) e o 5º ≥ 8 h (9,2 h); cada continue custa mais que o anterior, por
mais a cada vez; um pacote de pet custa ≤ 50% da vida média que dura (hoje 1,1 h de 4 h); o preço em Robux de cada
traje fica entre 8 e 16 Robux por hora de jogo médio que o preço em moedas pede (hoje 10,1–13,0). O guarda-roupa
inteiro custa 2.370 moedas: **128 h** de jogo médio, 74 h de um jogador forte.

## Por que cada preço

- **O presente (20) compra um pacote na hora.** O First Night Kit custa exatamente o presente: machado para lenha,
  lanterna para a primeira noite, roupa. A primeira compra acontece na primeira sessão (o Builder's Basics, 15, também
  cabe). Sem o presente, o jogador novo compra o pacote mais barato em 1,7 h.
- **Pacotes são capacidade comprada com o que já se ganhou jogando** (MON-01, a nota da MON-03): nenhuma arma de fogo
  nem munição pronta, e cada um custa algumas horas — não um atalho para a noite. Pantry Crate (30, comida para uns
  dias) < Ammo Makings (40, aço e pólvora) < Medic Bag (45, o remédio que decide uma noite ruim) < Workshop Supplies e
  Electronics Box (60: projetos, chips e peças, o que mais custa achar — o chip sai em 7,4% das revistas de
  laboratório).
- **Pacote de pet é aluguel de uma vida** (até o New game **ou o fim da cidade**, MP-22: os dois começam uma vida nova,
  e o `resetRun` leva o pet — a revisão de segurança de `de31f47`, L6, achou o texto "até o New game" incompleto): 20,
  menos de um terço do mesmo pet para sempre (70), e 1,1 h de jogo médio numa vida que dura ~4 h (≤ 50%,
  `rentalShareOfLife`): a própria vida o paga. Os 35% (`PET_RENTAL_SHARE`) conferidos contra essa duração: alugar a cada
  vida passa a custar mais que o pet para sempre na 4ª vida (3,5 vidas, ~14 h de jogo médio). É o "experimente por uma
  vida"; quem quer o pet sempre compra no guarda-roupa.
- **Robux: o mesmo item, pelas horas que o preço em moedas pede.** 49 / 149 / 349 dão 10–13 Robux por hora de jogo
  médio poupada (a faixa aceita é 8–16, `ECONOMY_TARGETS.robuxPerHour`), nos degraus de preço comuns do Roblox; nunca
  mais barato em moedas por ser pago, nunca exclusivo de Robux (MON-04).
- **Cosmético para sempre por raridade de leitura** (MON-02: cor e silhueta a 32 px): os dois pombos e a Carolina são
  os comuns (70; o branco, 90); os cães grandes e os trajes que mudam o corpo inteiro são raros (220–250); a águia de
  asas abertas e o traje Zombie são o topo (600, ~32 h de jogo médio, ~19 h de um forte).
- **Rebirth, a curva do Dead Town mantida** (10 + 10·d², por vida): o primeiro continue é barato (meia hora de jogo:
  errar a primeira noite não é um muro, BEM-08), o terceiro já é uma decisão (2,7 h), o quinto é caro (9,2 h). A saída
  grátis continua sendo esperar o amanhecer (MP-21); num servidor onde todos caíram, o Rebirth é o que salva a cidade
  (MP-22), e por isso a escalada importa.
- **A renda não mudou** (3 por dia, 10 por recorde, 8 por chefe, 20 de presente): subir preço deixou o jogo mais
  exigente sem mexer no que o servidor paga nem no que os painéis de analytics já contam.

## Como cada compra chega (e o que acontece quando algo falha)

1. O cliente manda **só o id** pelo `ShopAction` (`{kind: "buyPack", packId, nonce}`, `{kind: "buyCostume",
costumeId}`, `{kind: "robuxCostume", costumeId}`, `{kind: "rebirth", runRev}`). Preço, posse e saldo são do servidor (`server/main.server.ts`
   `handleAction`, `server/save/costumes.ts`): sem `yield` entre conferir e escrever.
2. Recusas sem mexer em nada: moedas a menos (`funds`), já possuído — traje, ou pacote de pet cujo pet já é seu ou está
   a caminho (`owned`) —, 20 pacotes do mesmo tipo pendentes (`limit`), id inválido (`invalid`), corpo vivo ou vida já
   mudada no Rebirth (`invalid` / `outdated`), sessão só-leitura (`readonly`), rajada (`rate`), um prompt de Robux
   aberto para o mesmo traje (`pending`). Nenhuma recusa gera evento de economia.
3. **Idempotência:** a mesma compra de pacote de novo (o mesmo `nonce`) responde como a primeira e cobra uma vez; um
   traje comprado responde `owned`; o Rebirth nomeia o `runRev`.
4. **Gravação (SAV-01):** a compra marca um save de evento (`purchase`) que chega ao DataStore em segundos
   (`UpdateAsync` com a trava de sessão); moedas e item estão no **mesmo** documento. Com o DataStore falhando, a compra
   fica na sessão e o jogador vê "Progress not saved — retrying"; a próxima tentativa grava os dois juntos. Uma queda do
   servidor antes de gravar perde **os dois** juntos — ninguém paga por nada nem ganha de graça.
5. **Entrega:** o pacote espera na conta (`packsBought` − `packsOpened`, "Pending ×N") e entra na mochila quando o
   sobrevivente está de pé na cidade (`server/sim/backpack.ts` `deliverPacks`); o traje vale na hora, veste pelo
   guarda-roupa (o mesmo verbo Equip do Bag, conferido de novo pelo servidor) e vai no fio para todos
   (`PlayerJoined` / `PlayerProfile`, MON-04).
6. **Moedas ganhas:** a meia-noite e o chefe pagam no save do servidor (`server/sim/progress.ts`) e a carteira empurrada
   diz o quanto (`earned`, `earnedDays`, `earnedRecords`, `earnedBosses`), uma vez: o cliente mostra
   "+13 coins Day survived ×1 · Record day ×1".

**Robux:** o caminho é outro (a seção seguinte). O `ShopAction` só pede o prompt; o traje chega com o recibo
(`ProcessReceipt`), que só responde `PurchaseGranted` **depois** de a gravação com a compra chegar ao DataStore (a
exceção ao coalescimento, SAV-01), e o `PurchaseId` fica no save (v7) para que um recibo entregue duas vezes conceda uma.

## Robux: decisões e desenho (implementado)

Implementado em 2026-09-24, depois da revisão de segurança de `de31f47`, como o desenho abaixo manda; o que a
implementação decidiu além dele está em "O que a implementação decidiu". O pedido de 2026-09-24 ("pacotes em Robux com preço de jogo de Roblox, sem pagar-para-vencer") esbarrava em regras
escritas; a proposta foi levada ao dono, que **delegou a decisão ao orquestrador** (2026-09-24). Decidido:

| Decisão                                                       | Preço                                 | Por quê                                                                                                   | Regra                                                                                     |
| ------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Servidor privado (VIP) **grátis** no lançamento               | 0                                     | conveniência pura; o Play solo grátis continua existindo (MP-14); grátis agora evita mudar o preço depois | MONETIZATION.md §1. Mudar o preço mais tarde **cancela as assinaturas**                   |
| Traje ou pet **também** por Robux: o mesmo item das moedas    | comum 49 R$, raro 149 R$, topo 349 R$ | ~11–13 R$ por hora de jogo médio poupada, nos degraus de preço comuns do Roblox                           | MON-01 (identidade, nunca capacidade); MON-04 emendada: moedas **ou** Robux, o mesmo item |
| Paleta do sobrevivente (passe)                                | ainda não                             | precisa ser construída; entra como passe próprio, depois                                                  | MON-02, MONETIZATION.md §2                                                                |
| Pacotes de itens, moedas, Rebirth, XP, caixa, pular o relógio | **nunca** por Robux                   | decidem uma noite (ou compram o que decide): pagar-para-vencer                                            | MON-01, nota da MON-03, BEM-02, BEM-03                                                    |

### O desenho

O código: `server/save/robux.ts` (o servidor: a verificação dos preços, o prompt, o `ProcessReceipt`),
`shared/data/robuxProducts.ts` (os ids e a oferta publicada), `shared/game/save.ts` (v7), `server/main.server.ts` (a
ligação com a sessão) e `client/ui/wardrobe.ts` (a tela). Fontes (Context7, `roblox/creator-docs`, 2026-09-24): `production/monetization/developer-products.md`,
`cloud-services/data-stores/player-data-purchasing.md`, `reference/engine/classes/MarketplaceService.yaml`,
`production/monetization/shop.md`, `production/monetization/private-servers.md`, `production/analytics/economy-events.md`.

1. **Um produto de desenvolvedor por traje (9), não um por faixa.** O recibo do `ProcessReceipt` só diz `PlayerId`,
   `ProductId`, `PurchaseId`, `CurrencySpent`, `PlaceIdWherePurchased` e `ProductPurchaseChannel` — nada do que o jogador
   escolheu. Com um produto por faixa o servidor teria de **lembrar** qual traje foi pedido, e essa lembrança some
   exatamente quando o recibo precisa dela: o jogador sai antes do recibo, o servidor cai, o Roblox entrega o recibo de
   novo no próximo login **noutro servidor** ("tries again next time the user joins the game"), ou a compra veio de fora
   do jogo (a aba Store / as superfícies da Shop, se um dia ligadas). Aí o item concedido seria o errado, ou nenhum, e o
   jogador pagou. Com um produto por traje, **o `ProductId` sozinho decide o item**: a concessão é uma função pura do
   recibo e idempotente por natureza (`costumes[id] = 1`), e o relatório de vendas do Creator Hub mostra cada traje.
   Custo: 9 produtos a criar em vez de 3; o preço de cada um é o da sua faixa.
2. **Quem abre o prompt é o servidor.** O guarda-roupa manda `ShopAction {kind: "robuxCostume", costumeId}`; o servidor
   confere (sessão carregada e gravável, traje válido e desenhável, produto configurado e verificado, **não possuído**,
   nenhum prompt de Robux aberto para o jogador, o balde de taxa) e só então chama
   `MarketplaceService:PromptProductPurchase(player, productId)`. A posse é do servidor (MON-04: o cliente nunca declara
   o que tem), então "não oferecer o que já é seu" é decidido onde a verdade mora. Enquanto um prompt de Robux do traje X
   está aberto (até `PromptProductPurchaseFinished` com `isPurchased = false`, o recibo, ou 120 s), a compra **em
   moedas** de X é recusada (`pending`): nenhuma corrida faz alguém pagar duas vezes pelo mesmo traje.
3. **`ProcessReceipt`** (lógica pura em `server/save/robux.ts`, ligação em `main.server.ts`; a receita do Roblox para
   sessão travada, "player-data-purchasing"):
    1. `PlayerId` → o `Player` neste servidor; não está → `NotProcessedYet` (o Roblox tenta de novo no próximo login). Um
       recibo de **outro** jogador nunca toca um save que não é o dele: o `PlayerId` escolhe o save, e nada vem do
       cliente.
    2. A sessão: espera o carregamento (até 30 s; desiste se o jogador sair); não carregada, só-leitura (`error`), sem
       DataStore (`unavailable`, o Studio sem acesso à API) ou trava perdida → `NotProcessedYet`.
    3. `ProductId` → traje pela configuração; desconhecido (produto que não vendemos, ou tirado) → `NotProcessedYet` e um
       aviso, nunca uma concessão às cegas.
    4. `PurchaseId` já no save (`robuxReceipts`): se uma gravação que o contém já chegou ao DataStore →
       `PurchaseGranted`; se não, grava agora e só responde `PurchaseGranted` se a gravação chegar.
    5. Concede: `costumes[id] = 1` e guarda `"<costumeId>:<PurchaseId>"` em `robuxReceipts` (os 64 mais novos).
    6. **Grava agora** (`UpdateAsync` sob a trava da sessão, fora do coalescimento: a exceção já escrita na SAV-01),
       esperando uma gravação que já estiver no ar; chegou → `PurchaseGranted`; falhou, sem orçamento ou trava perdida →
       `NotProcessedYet`. A concessão fica na sessão (o custo que o próprio Roblox documenta: "free for the duration of
       the session"), e o próximo `ProcessReceipt` acha o `PurchaseId` e tenta gravar de novo.
    7. Carteira empurrada (o traje aparece no guarda-roupa na hora), o aviso "Unlocked: Santa", analytics (item 7).
       **Nunca** o `isPurchased` do `PromptProductPurchaseFinished` concede algo (a documentação: pode ser falsificado e
       não prova compra).
4. **Já possuído.** Nunca oferecido: o botão some e o servidor recusa o prompt (`owned`). Se ainda assim um recibo chegar
   para um traje que já é seu (uma compra de fora do jogo, se o dono um dia ligar; uma queda no meio), **não existe API
   de reembolso** no Roblox: o `PurchaseId` é guardado, a resposta é `PurchaseGranted` (não há o que conceder) e o evento
   `RobuxOwned` + a linha `[PZ-ROBUX]` (o `PurchaseId`, sem nome nem PII) avisam o dono, que compensa à mão pelo painel
   de admin (outro traje da mesma faixa). **Nunca moedas**: seria vender moeda por Robux (MON-01) — e, com a aba Store
   ligada, um jeito de comprar 600 moedas por 349 R$.
5. **Save v7 (aditivo):** `robuxReceipts: Array<string>` (`"<costumeId>:<PurchaseId>"`, os 64 mais novos). Do servidor:
   o relatório do cliente nunca o move (`sanitizeClientReport` copia) e ele não vai na carteira. Um servidor de volta ao
   v6 o descarta ao gravar — inofensivo, porque a concessão é idempotente (`costumes[id] = 1`). Apagar o jogador (RTBF) o
   leva junto (a mesma chave). O painel de admin **não** tira um traje pago em Robux (a operação `costume` com
   `owned: false` recusa quando `robuxReceipts` tem aquele traje).
6. **Configuração** (`src/shared/data/robuxProducts.ts`): o preço por faixa (`ROBUX_TIER_PRICE`: 49 / 149 / 349) e o id
   de cada produto por **nome** do traje, todos `0` (= ainda não criado). Na partida o servidor confere cada id com
   `GetProductInfo(id, Enum.InfoType.Product)`: `IsForSale` e `PriceInRobux` igual ao preço da faixa; o que não bate
   **não é oferecido** (e avisa uma vez) — o mostrado é o cobrado também em Robux. Os verificados vão para o cliente num
   atributo `pz_robux_products` na pasta `Net`; **sem id configurado o botão de Robux não aparece e o caminho em moedas
   continua igual**. (A otimização de preços do Roblox mostraria preços diferentes a jogadores diferentes: não ligar para
   estes produtos; o recibo traz o `CurrencySpent` real de qualquer forma.)
7. **Analytics:** **nenhum** evento de economia em "Coins" (nenhuma moeda se move; o `IAP` da documentação é Robux →
   recurso do jogo, e um Source de moedas inventaria moedas e quebraria a soma dos saldos). O Robux gasto já aparece no
   painel de Monetization do Roblox. Nosso: o passo 3 "Bought" do funil Shop (o mesmo das moedas) e um evento custom
   `RobuxPurchase` (valor = `CurrencySpent`; campos `Category - Costume`, `Tier - common/rare/top`, `Channel - …`),
   **uma vez por `PurchaseId`**, na concessão — nunca no prompt, nunca num recibo repetido. `RobuxOwned` para o item 4.
8. **Tela:** no guarda-roupa, o painel do traje bloqueado mostra os dois preços ("600 coins · 349 R$", tokens do tema,
   textos na `lang.ts`); as ações: "Buy for 600 coins" (a principal, onde o foco do controle cai — BEM-02: a opção que se
   ganha jogando vem primeiro) e, ao lado, sem destaque (variante secundária), "See Price", que abre o prompt do Roblox
   (BEM-02: "See Price", nunca "GET IT NOW"). Sem moedas, o botão de moedas diz quanto falta, desabilitado, e o foco fica
   na grade — nunca pula sozinho para o de Robux. Os ladrilhos continuam só com o preço em moedas (Robux em cada ladrilho
   seria vitrine, não informação). **Nunca** na tela de morte, no menu da partida, na Loja de pacotes ou durante uma
   noite (BEM-02, UI-13).
9. **Testes** (`test:shop` §8, com um `MarketplaceService` falso): sem id → nenhum atributo, nenhum prompt, botão
   escondido, moedas iguais; com ids → prompt só do que não é seu; possuído → `owned`, sem prompt; recibo → concede
   **depois** de a gravação chegar (o documento guardado tem o traje e o `PurchaseId`); o mesmo recibo duas vezes → uma
   concessão, `PurchaseGranted` nas duas, um `RobuxPurchase`; DataStore falhando → `NotProcessedYet`, e o mesmo recibo
   depois da volta → `PurchaseGranted`; recibo de um `PlayerId` que não está no servidor → `NotProcessedYet`, nada muda;
   recibo antes do carregamento → espera; `ProductId` desconhecido → `NotProcessedYet`; preço diferente na partida →
   produto escondido; recibo de traje já possuído → `PurchaseGranted`, nada novo, `RobuxOwned`; compra em moedas com o
   prompt aberto → `pending`; outro servidor → ainda seu; a tela real mostra os dois preços, iguais à configuração e ao
   `GetProductInfo`, com o foco no botão de moedas; e o admin não tira um traje pago em Robux.

### Os produtos que o dono cria

Creator Hub → a experiência → **Monetization › Developer Products** → Create. Em cada um: **não** marcar "Allow external
purchases" e deixar **Unlisted** ("Hide from Shop"): o jogo só vende pelo seu próprio prompt. Depois, colar cada id em
`src/shared/data/robuxProducts.ts` (`ROBUX_PRODUCT_IDS`, pelo nome do traje), `npm run build`, commit.

| Nome do produto          | Preço (R$) | Faixa  | Descrição (inglês, a da página do produto)                                                      | Ícone sugerido                                  |
| ------------------------ | ---------- | ------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Last Town — Pigeon       | 49         | common | Unlocks the Pigeon pet in the Wardrobe, for good. Cosmetic only: it changes nothing in a night. | o ladrilho do Pigeon no guarda-roupa, 512 × 512 |
| Last Town — White pigeon | 49         | common | Unlocks the White pigeon pet in the Wardrobe, for good. Cosmetic only.                          | o ladrilho do White pigeon                      |
| Last Town — Carolina     | 49         | common | Unlocks the Carolina dog in the Wardrobe, for good. Cosmetic only.                              | o ladrilho da Carolina                          |
| Last Town — Malamute     | 149        | rare   | Unlocks the Malamute dog in the Wardrobe, for good. Cosmetic only.                              | o ladrilho do Malamute                          |
| Last Town — Doberman     | 149        | rare   | Unlocks the Doberman dog in the Wardrobe, for good. Cosmetic only.                              | o ladrilho do Doberman                          |
| Last Town — Santa        | 149        | rare   | Unlocks the Santa outfit in the Wardrobe, for good. Cosmetic only.                              | o sobrevivente de Santa, como na prévia         |
| Last Town — Cowboy       | 149        | rare   | Unlocks the Cowboy outfit in the Wardrobe, for good. Cosmetic only.                             | o sobrevivente de Cowboy                        |
| Last Town — Eagle        | 349        | top    | Unlocks the Eagle pet in the Wardrobe, for good. Cosmetic only.                                 | a águia de asas abertas                         |
| Last Town — Zombie       | 349        | top    | Unlocks the Zombie outfit in the Wardrobe, for good. Cosmetic only.                             | o sobrevivente com o traje Zombie               |

Os ícones podem sair do código real (a `SurvivorPreview` do guarda-roupa, pelo mesmo caminho de
`tools/render-menus.mjs`); a ferramenta que os gravaria em `docs/promo/products/` **ainda não existe** (pendente): por
ora, um print do guarda-roupa com o item selecionado serve.

### O que a implementação decidiu (além do desenho)

- **"Robux" na tela, não "R$".** A linha de preço diz "250 coins · 149 Robux": a MON-06 tira da tela todo sinal de
  dinheiro de verdade ("$"), e "R$" é também o símbolo do real. Nos documentos, "R$" continua abreviando Robux.
- **Pet de pacote** (o estado "From a pack", com Wear | Keep for good): **sem** botão de Robux — três botões numa
  linha é demais, e o Keep em moedas já é o caminho do que fica. Some quando o pacote deixa de ser a única posse.
- **O relatório do cliente não leva os recibos** (`client/systems/saveClient.ts` `reportJson`): são do servidor, e 64
  recibos com `PurchaseId` de 64 caracteres passariam do `MAX_SAVE_PAYLOAD` (8 KB) — o relatório seria recusado.
- **Admin:** a edição que tiraria um traje pago em Robux é **recusada inteira** (nem o save do servidor nem o cliente,
  que aplica as mesmas operações, se movem), e `applyAdminOps` e `enforceSaveInvariants` o mantêm de novo, por
  garantia; o **reset** do admin leva os recibos e os trajes pagos para o save novo (`carryRobuxPurchases`).
- **A espera do carregamento:** um recibo que chega antes do save espera em passos de 0,25 s até 30 s
  (`RECEIPT_LOAD_WAIT_S`) e desiste na hora se o jogador sai; o `ProcessReceipt` é ligado antes de qualquer jogador ser
  admitido.
- **O prompt aberto** segura o traje por 120 s (`PROMPT_HOLD_S`) desde o prompt ou a confirmação; o fechamento sem
  compra o solta. Recusas: `invalid` (sem produto verificado, id quebrado), `readonly`, `owned`, `pending`.
- **A verificação** roda na partida e a cada 10 min (`VERIFY_EVERY_S`): um preço mudado no Creator Hub tira o produto
  da oferta em até 10 min. Sem nenhum verificado, **nenhum** atributo é publicado.
- **Analytics:** o campo de canal é `Channel - In game` (`InExperience`) ou `Channel - Other` (nunca esperado: os
  produtos são Unlisted e sem compra externa). Um recibo concedido numa sessão cuja gravação falhou manda o evento
  quando a gravação chega; se o servidor cair antes, o evento daquela compra se perde (a compra não).
- **O aviso "Unlocked: Santa"** aparece no guarda-roupa aberto quando a carteira empurrada traz o traje; fechado, o
  traje só aparece como seu na próxima vez.

## O que o dono faz no Creator Hub

1. **Servidor privado: grátis (já).** Audience › **Access Settings** › ligar **Allow private servers** e **desligar
   Requires Robux** › Save Changes. Não precisa de código: o jogo reconhece um servidor privado sozinho
   (`pz_server_kind = private`). Mudar para pago depois é possível, mas mudar o preço cancela as assinaturas ativas.
2. **Monetization › Developer Products:** criar os 9 produtos da tabela "Os produtos que o dono cria" (preço
   **exato**, Unlisted, sem "Allow external purchases"), colar os ids em `src/shared/data/robuxProducts.ts`
   (`ROBUX_PRODUCT_IDS`, pelo nome do traje), `npm run build` e commit. Sem id, nada muda no jogo. O servidor confere
   cada produto com o Roblox na partida e a cada 10 min: um com outro preço ou fora de venda **não é oferecido**, e o log
   do servidor diz `[PZ-ROBUX] product <id>: …`. Um recibo de traje já possuído aparece como
   `[PZ-ROBUX] owned <PurchaseId>` e no evento `RobuxOwned`: compense pelo painel de admin (outro traje da mesma faixa).
   **Não** ligue a otimização de preços para estes produtos.
3. **Passes:** nenhum (a paleta do sobrevivente, quando existir, será o primeiro).
4. **Configs:** `pz_welcome_pack` (Number, −1) já está no roteiro de `docs/ANALYTICS.md` §12; o valor 0 dá o First
   Night Kit a quem entra pela primeira vez.
5. **Questionnaire:** refazer agora que o Robux entrou: "Paid random items: **No**" continua certo (pacotes de
   conteúdo fixo, em moedas do jogo; os trajes em Robux são itens fixos e declarados, nunca aleatórios).
6. **Depois de publicar:** comparar o painel Economy com o modelo (moedas por hora por jogador; quantos chegam ao
   primeiro cosmético) e ajustar `INCOME_PROFILES` se a realidade for outra.

## Achados desta auditoria (2026-09-24)

| #   | O que estava errado                                                                                                                                                                                                                | O que foi feito                                                                                                                                                              | Onde / teste                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | O servidor **cobrava** um pacote de pet cujo pet já era seu (para sempre ou na mochila): só o cartão dizia "Owned", e um pedido que passasse por fora pagava por nada. Um segundo pacote de pet ainda pendente também era vendido. | `packPetOwned` (`shared/game/save.ts`): o servidor recusa `owned` e o cartão usa a mesma regra ("Owned" / "Pending").                                                        | `server/main.server.ts`, `client/ui/shop.ts`; `test:shop` §3, `test:items` G1 |
| 2   | As moedas da meia-noite e do chefe **nunca eram avisadas**: desde que o servidor passou a pagar (F2/F3) o `earned` do relatório era sempre 0 e o empurrão da carteira não dizia nada — o aviso "+3 coins" da MON-06 não aparecia.  | `onIncome` (`server/sim/progress.ts`) soma o que foi pago na sessão; o próximo empurrão leva `earned`/`earnedDays`/`earnedRecords`/`earnedBosses`, uma vez; o cliente avisa. | `test:shop` §5–§6                                                             |
| 3   | O aviso de boas-vindas dizia "Here are **20** coins" num texto fixo; o Earn coins dizia "every **5** days" e "multiple of **5**": mudar `ECONOMY` deixaria os três mentindo.                                                       | O número vem de `ECONOMY` no código (`welcomeText`, a linha do recorde); nenhum texto da `lang.ts` carrega valor de moeda.                                                   | `client/ui/shop.ts`, `lang.ts`; `test:shop` §1                                |
| 4   | O conteúdo de cada pacote estava escrito duas vezes (`contents` à mão e `items`).                                                                                                                                                  | `contents` é escrito a partir de `items`.                                                                                                                                    | `shared/data/shop.ts`; `test:shop` §1, `test:items` G1                        |
| 5   | Com o saldo no teto (`MONEY_MAX`), o analytics registrava a fonte cheia, e a soma não fechava com o saldo (inalcançável na prática: 100 milhões).                                                                                  | Dia e chefe registram e avisam o que de fato entrou.                                                                                                                         | `server/sim/progress.ts`                                                      |
| 6   | Os preços eram fáceis demais para o pedido do dono: um pet em 1,6 h de jogo médio, a águia em 2,7 h, o guarda-roupa inteiro em 16 h.                                                                                               | Rebalanceados pelo modelo: 3,8–4,9 h o comum, 11,9–13,5 h o raro, 32,4 h o topo; pacotes de 0,8 a 3,2 h; o presente ainda compra o primeiro pacote.                          | `shared/data/shop.ts`; `test:shop` §2                                         |
| 7   | O comentário do balde de moedas do analytics dizia "packs cost 20-60" (eram 10–30).                                                                                                                                                | Comentário corrigido; os rótulos do balde ficam (são valores de painel).                                                                                                     | `server/analytics/events.ts`                                                  |
| 8   | Rebirth grátis no lobby (o amanhecer já veio): o servidor não cobrava, mas as telas mostravam o preço — e o cliente recusava sozinho quem não tinha as moedas.                                                                     | O servidor diz `pz_rebirth_free` no `Player` (`LifeKeeper.daybreakDuePeek`, a cada empurrão da carteira); o lobby mostra 0 e o cliente não recusa.                           | `server/main.server.ts`, `client/ui/survivor.ts`, `lobby.ts`; `test:shop` §9  |
| 9   | Revisão de `de31f47`, L1–L5: o aviso contava o recorde inteiro quando o teto cortava parte dele; moedas pagas logo após o carregamento esperavam um empurrão que não vinha; `onIncome` aceitava um ouvinte só; dois comentários.   | O aviso conta o que entrou; o primeiro empurrão leva a renda pendente (fechar a sessão perde só o aviso, documentado); `onIncome` é uma lista com cancelamento; comentários. | `server/sim/progress.ts`, `main.server.ts`, `saveClient.ts`                   |
| 10  | L6: "o pet do pacote fica até o New game" estava incompleto: o fim da cidade (MP-22) também o leva.                                                                                                                                | O texto diz "for this life"; o modelo preça o aluguel contra a vida (`lifeHours`), e os 35% foram reconferidos contra ela.                                                   | `shared/data/shop.ts`, `lang.ts`; `test:shop` §2                              |
| 11  | Robux: decidido, não implementado.                                                                                                                                                                                                 | Implementado (seção "Robux"): save v7, `ProcessReceipt` idempotente, prompt do servidor, verificação de preço, tela com os dois preços.                                      | `server/save/robux.ts`; `test:shop` §7–§8, `test:save` §34                    |

**Conhecidos, não corrigidos aqui:**

- **`showPause(ctx, 2)`** (`client/ui/pauseMenu.ts`, o cartão antigo de fim de partida) não é mais chamado por ninguém,
  mas ainda desenha um preço de Rebirth (o mesmo `rebirthPrice`): código morto para tirar num passo próprio.

## Para a revisão de segurança (mudança de economia)

- `server/main.server.ts`: uma recusa nova (`owned`) para pacote de pet, **antes** de olhar as moedas — só impede
  cobranças; o recibo do `nonce` continua respondendo antes dela. A soma `income` por sessão sai no `SaveAck` empurrado
  (servidor → cliente, só informativo).
- `server/sim/progress.ts`: o crédito do dia e do chefe é o que entrou no saldo (igual ao de antes abaixo de
  `MONEY_MAX`); um ouvinte de módulo (`onIncome`) que só `main.server.ts` registra.
- `shared/data/shop.ts`: preços novos; o servidor cobra dos mesmos dados que o cliente mostra.
- `shared/net/net.ts`: campo opcional `earnedRecords` no `SaveAck` (servidor → cliente).
- Nenhum remote novo, nenhum campo novo que o servidor leia do cliente.

### Robux (segunda revisão)

- **`ProcessReceipt`** (`server/save/robux.ts` `decide`): o `PlayerId` escolhe o save (nada vem do cliente); espera o
  carregamento até 30 s com `task.wait` dentro do callback (permitido pelo Roblox); `PurchaseGranted` só com
  `commit()` verdadeiro — `flush(s, false)` sob a trava, e a sessão ainda aberta, sem `released` e persistente depois
  dele (uma saída que gravou no meio pode ter codificado o save **antes** da concessão). Toda outra saída é
  `NotProcessedYet`; a concessão fica na sessão até lá (o custo que o Roblox documenta).
- **Idempotência:** `robuxReceipts` (save v7, "<costumeId>:<PurchaseId>", os 64 mais novos, validados entrada a entrada
  na leitura); o recibo repetido acha o `PurchaseId` e só confirma a gravação. Recibo de traje já possuído: guarda o
  `PurchaseId`, `PurchaseGranted`, nunca moedas.
- **O prompt é do servidor** (`handleAction` `robuxCostume`, na ficha do balde do `ShopAction` e na linha de flood): só
  o `costumeId` do pedido é lido; produto verificado, sessão gravável, não possuído, nenhum prompt aberto. O
  `isPurchased` do `PromptProductPurchaseFinished` nunca concede. Com o prompt aberto, a compra em moedas do mesmo traje
  é recusada (`pending`).
- **A oferta** (`pz_robux_products` na pasta `Net`) é só o que o `GetProductInfo` confirmou (à venda, preço = faixa); o
  cliente a lê para desenhar e nada mais — o servidor decide de novo no prompt.
- **O cliente não move recibos**: `readProgress` copia os do servidor; o relatório nem os envia (`reportJson`).
- **Admin:** a edição que tiraria um traje pago é recusada inteira; o reset leva os recibos (`carryRobuxPurchases`);
  `enforceSaveInvariants` devolve o traje de todo recibo lido.
- **`pz_rebirth_free`** (servidor → cliente, só exibição): o preço cobrado continua decidido por `daybreakDue` no
  pedido.
