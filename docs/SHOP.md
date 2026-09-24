# Loja, moedas e preços

Tudo o que se compra, se ganha ou se dá no Last Town, quanto custa, onde aparece, o que entrega e **por que custa isso**.
A fonte de cada número é **uma só**: `src/shared/data/shop.ts` (`ECONOMY`, `SHOP_PACKS`, `COSTUMES`, `rebirthPrice`, o
modelo de renda e as faixas). O servidor cobra e paga com ela, toda tela mostra com ela, e `npm run test:shop` falha
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
- **Não existe venda** (trocar item por moeda) nem **nada em Robux** — nenhum passe, produto de desenvolvedor ou
  servidor pago no código (`MarketplaceService` não é chamado em lugar nenhum). Moedas só se ganham jogando (MON-01).
- **Estava errado e foi corrigido** (detalhe em "Achados"): o servidor cobrava um pacote de pet que o cartão dizia
  "Owned"; as moedas ganhas à meia-noite e nos chefes nunca eram avisadas; três textos tinham números fixos que
  mentiriam na próxima mudança; o conteúdo dos pacotes estava escrito duas vezes; e os preços eram fáceis demais para o
  que o dono pediu (um pet em 1,6 h de jogo). Os preços novos seguem o modelo abaixo.

## Tabela de produtos

A coluna **Preço** é conferida linha a linha contra os dados pelo `test:shop` (§1): mudar um preço é mudar
`shop.ts` **e** esta tabela. **Horas** = horas de jogo de um jogador médio (18,5 moedas/h, modelo abaixo).
**Roblox**: o que o dono cria no Creator Hub para este produto.

| Produto               | Onde aparece                                                   | Faixa   | Preço                         | Moeda  | O que dá                                                                                           | Horas              | Roblox                     |
| --------------------- | -------------------------------------------------------------- | ------- | ----------------------------- | ------ | -------------------------------------------------------------------------------------------------- | ------------------ | -------------------------- |
| First Night Kit       | Loja › Packs (cartão)                                          | starter | 20                            | moedas | 1 × Cotton clothes, 1 × Axe, 1 × Flashlight — na mochila ao entrar na cidade                       | 1,1                | nada (moedas do jogo)      |
| Pantry Crate          | Loja › Packs                                                   | supply  | 30                            | moedas | 3 × Cooked meat, 3 × Pizza, 3 × Cooked meal                                                        | 1,6                | nada                       |
| Medic Bag             | Loja › Packs                                                   | supply  | 45                            | moedas | 2 × First aid kit, 3 × Bandage, 2 × Adrenaline                                                     | 2,4                | nada                       |
| Builder's Basics      | Loja › Packs                                                   | starter | 15                            | moedas | 20 × Wood, 10 × Cloth, 20 × Stone                                                                  | 0,8                | nada                       |
| Workshop Supplies     | Loja › Packs                                                   | supply  | 60                            | moedas | 5 × Blueprint, 20 × Steel, 10 × Machine parts                                                      | 3,2                | nada                       |
| Electronics Box       | Loja › Packs                                                   | supply  | 60                            | moedas | 5 × Battery, 2 × Computer chip, 2 × Bulb                                                           | 3,2                | nada                       |
| Ammo Makings          | Loja › Packs                                                   | supply  | 40                            | moedas | 10 × Steel, 10 × Gunpowder (matéria-prima; munição pronta nunca é vendida, MON-03)                 | 2,2                | nada                       |
| Pet Pigeon            | Loja › Packs (o pet desenhado no cartão)                       | rental  | 20                            | moedas | 1 × Pigeon na mochila, até o próximo New game                                                      | 1,1                | nada                       |
| Pet Carolina          | Loja › Packs                                                   | rental  | 20                            | moedas | 1 × Carolina na mochila, até o próximo New game                                                    | 1,1                | nada                       |
| Pigeon                | Guarda-roupa › Pets (ladrilho, painel, "Buy for N coins")      | common  | 70                            | moedas | o pombo para sempre, visto por todos                                                               | 3,8                | nada                       |
| White pigeon          | Guarda-roupa › Pets                                            | common  | 90                            | moedas | o pombo branco para sempre                                                                         | 4,9                | nada                       |
| Carolina              | Guarda-roupa › Pets                                            | common  | 70                            | moedas | a cadela caramelo para sempre                                                                      | 3,8                | nada                       |
| Malamute              | Guarda-roupa › Pets                                            | rare    | 220                           | moedas | o malamute (maior) para sempre                                                                     | 11,9               | nada                       |
| Doberman              | Guarda-roupa › Pets                                            | rare    | 220                           | moedas | o doberman para sempre                                                                             | 11,9               | nada                       |
| Santa                 | Guarda-roupa › Outfits                                         | rare    | 250                           | moedas | o traje para sempre, visto por todos                                                               | 13,5               | nada                       |
| Cowboy                | Guarda-roupa › Outfits                                         | rare    | 250                           | moedas | o traje para sempre                                                                                | 13,5               | nada                       |
| Zombie                | Guarda-roupa › Outfits                                         | top     | 600                           | moedas | o traje para sempre                                                                                | 32,4               | nada                       |
| Eagle                 | Guarda-roupa › Pets                                            | top     | 600                           | moedas | a águia (asas sempre abertas) para sempre                                                          | 32,4               | nada                       |
| Rebirth               | tela de morte, tela Survivor (lobby)                           | —       | 10 + 10·d² (10, 20, 50, 100…) | moedas | levanta agora, com a mochila; d = continues já pagos nesta vida (volta a 0 no New game)            | 0,5 o 1º; 9,2 o 5º | nada                       |
| Welcome gift          | Loja › Earn coins ("+20"), o aviso de boas-vindas              | fonte   | 20                            | moedas | uma vez, a todo save novo                                                                          | —                  | nada                       |
| Day survived          | Loja › Earn coins ("+3"), o aviso "+3 coins · Day survived ×1" | fonte   | 3                             | moedas | a cada meia-noite vivida (vivo à meia-noite, no mundo ≥ 50% do dia, sem AFK)                       | —                  | nada                       |
| Record day            | Loja › Earn coins ("+10"), o aviso "Record day ×1"             | fonte   | 10                            | moedas | a primeira vez que uma vida chega a um recorde múltiplo de 5 (`MILESTONE_EVERY`)                   | —                  | nada                       |
| Boss defeated         | Loja › Earn coins ("+8"), o aviso "Boss defeated ×1"           | fonte   | 8                             | moedas | a cada chefe derrubado com você na luta (≥ 3% do dano ou 20 s perto, MP-15)                        | —                  | nada                       |
| Pacote de boas-vindas | cartão do pacote ("Pending ×1"), tela Survivor                 | —       | 0                             | —      | knob `pz_welcome_pack` (−1 = nenhum; 0–8 = o pacote): um save novo ganha aquele pacote, pendente   | —                  | Configs: `pz_welcome_pack` |
| Títulos               | Guarda-roupa › Titles                                          | —       | nunca vendido                 | —      | ganhos jogando (MON-05)                                                                            | —                  | nada                       |
| Conquistas            | Conquistas                                                     | —       | não pagam                     | —      | nada: "No coins or items: a record of what you did." (UI-14)                                       | —                  | nada                       |
| Vender itens          | —                                                              | —       | não existe                    | —      | não há venda; o ouro do banco é material de fabricação, não moeda                                  | —                  | nada                       |
| Robux                 | —                                                              | —       | —                             | Robux  | **Nenhum produto em Robux**: nenhum passe, produto de desenvolvedor ou servidor pago; plano abaixo | —                  | nada a criar hoje          |

## O modelo

Uma hora de jogo na cidade rende, com os números que o servidor paga (`coinsPerHour`), `3600 / 605,2` dias × a
parte das meias-noites pagas × 3 moedas, mais os recordes × 10 e os chefes × 8. O dia de jogo tem **605,2 s reais**
(06:00–19:00 a 0,8× e 19:00–06:00 a 1,2× `TIME_SPEED`, `shared/sim/clock.ts`; o teste integra o relógio do mundo e
confere). As suposições de cada perfil estão em `INCOME_PROFILES`, escritas para serem discutidas — e medidas: quando o
jogo for público, o painel Economy do Creator Hub dá as fontes "Day survived", "Record milestone" e "Boss" por jogador
(`docs/ANALYTICS.md`), e é com elas que o modelo se corrige.

| Perfil            | Dias pagos | Chefes por hora | Recordes por hora | Moedas por hora |
| ----------------- | ---------- | --------------- | ----------------- | --------------- |
| `new` (novo)      | 0,4        | 0               | 0,15              | 8,6             |
| `average` (médio) | 0,7        | 0,5             | 0,2               | 18,5            |
| `strong` (forte)  | 0,95       | 1,5             | 0,3               | 32,0            |

- **Novo:** morre na maioria das noites nas ondas 1 e 2 (antes da meia-noite, então aquele dia não paga), não chega
  perto de chefe, alcança o dia 5 nas primeiras ~7 h.
- **Médio:** vive a maioria das noites, ajuda num chefe a cada duas horas, recorde de ~30 dias em ~30 h.
- **Forte:** quase nunca perde uma meia-noite, caça chefes (acordam do dia 5 do mundo, a cada 3 dias), ~45 dias em ~30 h.

### As faixas (horas de jogo médio, `PRICE_TIERS`)

Direção do dono (2026-09-24): "os valores têm que fazer sentido e ser **desafiadores**": cosmético comum ~3–5 h, raro
~10–15 h, topo 25 h ou mais; a primeira compra na primeira ou segunda sessão; a cauda longa exigente.

| Faixa     | Horas   | O que é                                                                                          |
| --------- | ------- | ------------------------------------------------------------------------------------------------ |
| `starter` | 0,5–1,5 | o primeiro pacote; o presente de boas-vindas (20) compra qualquer um deles na hora               |
| `supply`  | 1,5–4   | os outros pacotes: consumíveis e materiais, algumas horas cada                                   |
| `rental`  | 0,5–1,5 | pacote de pet: o pet até o New game, no máximo 35% (`PET_RENTAL_SHARE`) do mesmo pet para sempre |
| `common`  | 3–5     | cosmético comum para sempre                                                                      |
| `rare`    | 10–15   | cosmético raro                                                                                   |
| `top`     | 25–40   | o topo                                                                                           |

Promessas do modelo (`ECONOMY_TARGETS`, cada uma um teste): o jogador novo compra o pacote mais barato só jogando em
≤ 2 h (hoje 1,7 h); um cosmético do topo custa ≥ 15 h até para o forte (hoje 18,8 h); o 1º Rebirth de uma vida fica
entre 0,25 e 1,5 h (hoje 0,5 h), o 3º ≥ 2 h (2,7 h) e o 5º ≥ 8 h (9,2 h); cada continue custa mais que o anterior, por
mais a cada vez. O guarda-roupa inteiro custa 2.370 moedas: **128 h** de jogo médio, 74 h de um jogador forte.

## Por que cada preço

- **O presente (20) compra um pacote na hora.** O First Night Kit custa exatamente o presente: machado para lenha,
  lanterna para a primeira noite, roupa. A primeira compra acontece na primeira sessão (o Builder's Basics, 15, também
  cabe). Sem o presente, o jogador novo compra o pacote mais barato em 1,7 h.
- **Pacotes são capacidade comprada com o que já se ganhou jogando** (MON-01, a nota da MON-03): nenhuma arma de fogo
  nem munição pronta, e cada um custa algumas horas — não um atalho para a noite. Pantry Crate (30, comida para uns
  dias) < Ammo Makings (40, aço e pólvora) < Medic Bag (45, o remédio que decide uma noite ruim) < Workshop Supplies e
  Electronics Box (60: projetos, chips e peças, o que mais custa achar — o chip sai em 7,4% das revistas de
  laboratório).
- **Pacote de pet é aluguel** (até o New game): 20, menos de um terço do mesmo pet para sempre (70). É o "experimente";
  o guarda-roupa vende o que fica.
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
costumeId}`, `{kind: "rebirth", runRev}`). Preço, posse e saldo são do servidor (`server/main.server.ts`
   `handleAction`, `server/save/costumes.ts`): sem `yield` entre conferir e escrever.
2. Recusas sem mexer em nada: moedas a menos (`funds`), já possuído — traje, ou pacote de pet cujo pet já é seu ou está
   a caminho (`owned`) —, 20 pacotes do mesmo tipo pendentes (`limit`), id inválido (`invalid`), corpo vivo ou vida já
   mudada no Rebirth (`invalid` / `outdated`), sessão só-leitura (`readonly`), rajada (`rate`). Nenhuma recusa gera
   evento de economia.
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

**Robux (quando existir):** nada disto vale sozinho. O `ProcessReceipt` só pode responder `PurchaseGranted` **depois**
de a gravação com a compra chegar ao DataStore (a exceção ao coalescimento, SAV-01), e o `PurchaseId` tem de ficar no
save para que um recibo entregue duas vezes conceda uma.

## Robux: o que não existe, o que se propõe, e por quê

Hoje **não há produto em Robux**. O pedido de 2026-09-24 ("pacotes em Robux com preço de jogo de Roblox, sem
pagar-para-vencer") esbarra em regras escritas; em vez de quebrá-las em silêncio, a proposta é esta — **nada aqui está
implementado**, e cada linha pede a decisão do dono:

| Proposta                                        | Preço sugerido                        | Por quê                                                                                               | Regra                                                                                  |
| ----------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Servidor privado (VIP)                          | 50 R$ por mês (ou grátis)             | conveniência pura; o Play solo grátis continua existindo (MP-14); jogos do gênero cobram 0–100 R$/mês | MONETIZATION.md §1: "comece por aqui". Mudar o preço depois **cancela as assinaturas** |
| Traje ou pet por Robux, o mesmo item das moedas | comum 49 R$, raro 149 R$, topo 349 R$ | ~12–13 R$ por hora de jogo médio poupada, nos degraus de preço comuns do Roblox (49/149/349)          | MON-01 permite (identidade); **a MON-04 diz "preço em moedas"**: emendar antes         |
| Paleta do sobrevivente (passe)                  | 99 R$                                 | o primeiro passe cosmético que a MONETIZATION.md recomenda; precisa ser construída                    | MON-02, MONETIZATION.md §2                                                             |
| Pacotes de itens por Robux                      | **não**                               | comida, remédio e material decidem uma noite: com Robux, cada pacote vira pagar-para-vencer           | MON-01, nota da MON-03                                                                 |
| Moedas por Robux                                | **não**                               | compraria os pacotes e o Rebirth por Robux                                                            | MON-01                                                                                 |
| Rebirth, XP, "pular a noite", craft mais rápido | **não**                               | capacidade; o Rebirth ainda é oferecido no momento da perda                                           | MON-01, BEM-02                                                                         |

Se o dono aprovar a linha 2, o trabalho é: um produto de desenvolvedor por faixa (ou um passe por item) no Creator Hub;
`MarketplaceService.ProcessReceipt` no servidor, concedendo `costumes[id]` na sessão travada, gravando e só então
`PurchaseGranted`, com os `PurchaseId` guardados no save (v7, aditivo); o botão "See Price" (BEM-02) ao lado do de
moedas, nunca no lugar dele; o questionário de maturidade refeito; e o `test:shop` §7 trocado por testes do recibo
(duplicado concede uma vez, falha de gravação não concede, reembolso impossível documentado).

## O que o dono faz no Creator Hub

1. **Nada a criar para a loja de hoje.** Os preços estão no código; não há id de produto nem de passe, e nenhum deve
   ser criado enquanto a tabela acima disser "Nenhum produto em Robux".
2. **Monetization › Passes / Developer products:** deixar vazio. Se aprovar a proposta de Robux, criar os produtos com
   **exatamente** os preços da tabela e mandar os ids para o código (uma constante em `shared/data/shop.ts`).
3. **Servidor privado:** decidir grátis ou 50 R$/mês antes do lançamento (mudar depois cancela as assinaturas ativas).
4. **Configs:** `pz_welcome_pack` (Number, −1) já está no roteiro de `docs/ANALYTICS.md` §12; o valor 0 dá o First
   Night Kit a quem entra pela primeira vez.
5. **Questionnaire:** "Paid random items: No" continua certo (pacotes de conteúdo fixo, em moedas do jogo).
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

**Conhecidos, não corrigidos aqui:**

- **Rebirth grátis no lobby:** se o amanhecer já passou enquanto o sobrevivente morto estava no lobby, o servidor não
  cobra o Rebirth (`LifeKeeper.daybreakDue`), mas as telas ainda mostram o preço. Cobra-se **menos** que o mostrado,
  nunca mais. Corrigir pede o servidor dizer ao cliente "o amanhecer já veio" (um atributo `pz_*`).
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
