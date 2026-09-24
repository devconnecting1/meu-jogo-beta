# Analytics — o que o jogo manda para o Creator Hub, e por quê

Os painéis **Economy**, **Funnels** e **Custom events** do Creator Hub (Analytics) só existem se o jogo chamar o
`AnalyticsService`. Este documento é o catálogo: cada evento, quando dispara, os campos e a pergunta de painel que
ele responde. O código é um módulo só, `src/server/analytics/events.ts`; o resto do servidor chama ganchos de uma
linha. Os experimentos (configs) ficam em `src/server/config/experiments.ts`. Testado por `npm run test:analytics`
(`tools/test-analytics.mjs`).

Referências: as páginas oficiais `production/analytics` (índice, `get-started`, `event-types`, `funnel-events`,
`economy-events`, `custom-events`, `custom-fields`, `feedback`, `performance`, `insights`, `error-report`,
`crashes`, `alerts`), `production/experiments`, `production/configs` e a referência de engine de
`AnalyticsService`, `ConfigService` e `ConfigSnapshot` — lidas em 2026-09-24 (fonte: repositório
`Roblox/creator-docs`; Context7 `/websites/create_roblox`). A auditoria página por página está na §11.

## 1. Regras

1. **Só o servidor, só os números dele.** Todo evento lê o save vivo que o próprio servidor escreve (moedas, dia
   da vida, `lifeNights`, `zombieKills`, `titles`, nível) no instante em que o servidor o muda, ou uma vez por
   segundo (`poll`). Nada que um cliente relata vira evento (MP-00). **Duas exceções, sem valor nenhum:** a resposta
   a "Do you want to watch the tutorial?" (`tutorialDone` / `firstInstall`, lida da cópia do servidor, nunca do
   relatório) e "a loja abriu" (o `viewShop` do `ShopAction`, §4.4). Só o cliente sabe essas duas; os campos que
   elas carregam são todos do servidor, e o máximo que um cliente adulterado consegue é mexer no próprio funil — é
   o padrão da própria documentação (funnel-events.md, "Protect your funnels from exploiters").
2. **Agregado, nunca por abate.** Uma horda faz vários abates por segundo com 6 sobreviventes; um evento cada
   estouraria o orçamento numa luta. Abate só aparece como contagem num ponto natural (o primeiro de um jogador novo,
   o resumo da sessão). Craft, cozinha, uso de item e arma usada, idem.
3. **Cardinalidade baixa.** Os campos customizados são poucos textos fixos ("Life day - 4-7", "Time - Night"):
   nada de texto livre, nome ou UserId. Os SKUs são os nomes do catálogo (9 pacotes, 9 trajes) e mais 7 fixos. O
   teste (§13 da suíte) prova que cada valor visto é de um conjunto fechado e que o teto de combinações dos três
   campos é **681**, contra o limite de **8.000** por experiência.
4. **Abaixo do limite.** O limite documentado é **120 + 20 × CCU chamadas por minuto** por servidor. O módulo usa no
   máximo **75 %** disso em qualquer janela de 60 s (`RATE_SHARE`); o que não cabe espera numa fila limitada (512) e
   sai quando a janela abre. Um evento de economia que precisa esperar é **somado** ao último evento de economia do
   mesmo jogador na fila, se tiver a mesma direção e o mesmo tipo (SKU `Batched` se forem itens diferentes): a
   contagem de compras fica menor, mas nenhuma moeda some e cada saldo continua seguindo do anterior.
5. **Nunca atrapalha.** Sem `AnalyticsService` (um teste, uma plataforma sem ele) todo gancho retorna na hora. Cada
   chamada ao módulo e cada chamada ao serviço roda em `pcall`: analytics não derruba tick, compra nem save. Uma falha
   é contada e avisada no máximo uma vez por minuto, com mensagem fixa (§10).
6. **Studio não manda nada.** A documentação é explícita: eventos só saem do servidor de um jogo **publicado**. No
   Studio o módulo roda todas as regras (o playtest as exercita) e entrega cada evento a um coletor seco que só conta
   — atributos `pz_analytics_sent`, `pz_analytics_deferred`, `pz_analytics_dropped` do Workspace — e imprime cada um
   se o atributo `pz_analytics_echo` do Workspace for `true`. Uma **experiência de teste publicada** (a "Last Town
   [dev]" da §7.4 de `docs/MULTIPLAYER.md`) é outro universo, com painéis próprios: jogo de teste nunca suja os
   números do jogo de verdade.
7. **Campos só no passo 1 de um funil.** A referência de `LogFunnelStepEvent` / `LogOnboardingFunnelStepEvent`:
   "Funnel breakdowns only consider the user and event values from the first step in a funnel session". Por isso
   todo funil manda os campos customizados no primeiro passo e nenhum nos outros.

**Por que não `LogProgressionEvent`** (nem `LogProgressionStart/Complete/FailEvent`): a referência da API, conferida
em 2026-09-24, ainda diz que ele "does not currently display in any Roblox-provided charts", e nenhuma página o
lista. Gastaria orçamento de taxa para um gráfico que não existe. A curva de nível virou um **funil** ("Levels"), e as
noites viraram dois ("NightSurvival" por vida, "Night" por noite) — a página Funnels desenha os três.

## 2. Funil de onboarding (`LogOnboardingFunnelStepEvent`)

Só para **jogador novo**: um save que nasceu depois que analytics entrou (`titleEpoch` ≥ 2026-09-23, a data de
nascimento do save) e ainda não é Survivor. Isso importa porque o funil considera concluídos os passos pulados
(funnel-events.md, "Skipped steps"): o primeiro abate contado de um veterano não pode entrar como "First kill".

| Passo | Nome                 | Quando                                                                                                          | Onde                           |
| ----- | -------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1     | Joined               | o save foi criado agora (status `new` do `loadSession`)                                                         | `main.server.ts` `loadSession` |
| 2     | Tutorial answered    | `tutorialDone` passou a `true` no save do servidor — ou a entrada na cidade, que só acontece depois da pergunta | `poll` / `admit`               |
| 3     | Entered the city     | um corpo na cidade (`admit` do `mpHost`)                                                                        | `mpHost.ts`                    |
| 4     | First kill           | `zombieKills` ≥ 1 (o golpe final que o crédito de abate do servidor deu)                                        | `poll`                         |
| 5     | First night survived | o título **Survivor** (MON-05): pago à meia-noite e vivo até as 06:00                                           | `onTitleUnlocked`              |

- **Campo do passo 1:** `Welcome pack - None` ou `Welcome pack - <pacote>` — o que o knob `pz_welcome_pack` deu a
  esse save (§12). É o que põe o funil de onboarding de cada braço de um experimento lado a lado.
- **Cada passo uma vez e em ordem:** o módulo só anda para a frente, a partir do 1. Um passo alcançado antes do
  anterior sai sozinho (sobreviver à primeira noite sem matar ninguém manda o 5 e o painel conta o 4 como feito — é a
  ordem do próprio jogo). A ordem é a do jogo: a pergunta do tutorial vem **antes** de entrar na cidade
  (`survivor.ts` `enterCity`).
- **Segunda sessão de um jogador novo:** o que o save mostra que já aconteceu não é mandado de novo (entrou, matou);
  só o que for novo.
- **Pergunta respondida pelo painel:** onde o jogador novo desiste — no lobby, na pergunta do tutorial, antes do
  primeiro abate ou na primeira noite? É a curva que diz se o onboarding funciona (`docs/CREATOR_HUB.md`).

A escolha em si vai num evento custom, `TutorialChoice` (§5), porque a resposta às vezes chega ao servidor depois
da entrada (a janela de relatório do cliente é de 10 s) e o passo 2 não pode esperar por ela.

## 3. Economia (`LogEconomyEvent`, moeda `Coins`)

Uma moeda só, o `money` do save. Todo lugar onde o servidor muda `money` tem um evento, com o saldo **depois** da
mudança, como a API pede, e sempre **depois** da operação aceita (event-types.md: nunca na tentativa). Sessões que
nunca serão gravadas (status `error` / `unavailable`) não mandam economia.

| Fluxo         | transactionType    | itemSKU          | Campo 1               | Quando                                             | Onde                              |
| ------------- | ------------------ | ---------------- | --------------------- | -------------------------------------------------- | --------------------------------- |
| Source        | Onboarding         | Welcome gift     | —                     | o presente de 20 de um save novo                   | `loadSession`                     |
| Source        | Gameplay           | Day survived     | —                     | a meia-noite pagou o dia (3)                       | `progress.ts` `creditDaySurvived` |
| Source        | Gameplay           | Record milestone | —                     | o bônus de recorde em múltiplo de 5 (10)           | `progress.ts` `creditDaySurvived` |
| Source        | Gameplay           | Boss             | —                     | chefe abatido, para cada participante (8)          | `progress.ts` `creditBossKill`    |
| Sink          | Shop               | nome do pacote   | `Category - Pack`     | pacote comprado                                    | `main.server.ts` `handleAction`   |
| Sink          | Shop               | nome do traje    | `Category - Costume`  | traje comprado (MON-04)                            | `main.server.ts` `handleAction`   |
| Sink          | ContextualPurchase | Rebirth          | `Continue - 1/2/3/4+` | Rebirth pago                                       | `main.server.ts` `handleAction`   |
| Source / Sink | Admin              | Admin edit       | —                     | um admin mudou as moedas (para os saldos fecharem) | `main.server.ts` `adminEdit`      |

- Os tipos são os nomes do enum `AnalyticsEconomyTransactionType` (checados pelo tipo no código); "extra lives" é o
  exemplo da própria documentação de `ContextualPurchase`, e é exatamente o Rebirth. `Admin` é o único tipo nosso
  (a documentação permite nomes próprios). `IAP` e `TimedReward` não se aplicam: o jogo não vende nada por Robux e
  não tem recompensa por horário (o dia é pago por **sobreviver**, que é `Gameplay`).
- `Category` é o breakdown que põe todo pacote contra todo traje no mesmo gráfico (o exemplo "Category - Weapon" de
  custom-fields.md).
- Compra recusada (sem moedas, já possuído, pedido inválido) não gera evento de economia; o preço é sempre o do
  catálogo. A tentativa aparece no funil Shop (§4.4).
- **Pergunta:** de onde vêm as moedas (dia, recorde, chefe) e para onde vão (qual pacote, qual traje, quanto em
  Rebirth)? O saldo médio sobe ou desce com o tempo? O Rebirth é o sumidouro dominante?

## 4. Funis (`LogFunnelStepEvent`)

Seis funis contando o Onboarding, de 10 permitidos; o maior tem 13 passos, de 100. Os recorrentes têm um
`funnelSessionId`: uma chave natural quando existe (a vida, a morte), um GUID (`HttpService:GenerateGUID`) quando não
(a noite, a visita à loja) — as duas recomendações de funnel-events.md. A plataforma guarda os 10 ids mais recentes
por jogador e funil; nenhum dos nossos reabre um id antigo.

### 4.1 NightSurvival — um funil por **vida**

`funnelSessionId` = `life-<runRev − deathCount>`: um Rebirth pago move os dois (a vida continua, a chave não muda);
uma vida nova zera `deathCount` e move `runRev` (a chave cresce). Assim a mesma vida, espalhada em várias sessões e
servidores, é uma sessão só do funil. Os passos seguem `lifeNights` (as meias-noites que o **servidor** creditou à
vida, MP-13), nos degraus da tabela de ondas (dias 2, 4, 10, 20 — `getDayPopulation`), da dificuldade (15 e 30 —
`difficultyOfDay`), do Week One (8) e o dia 50:

| Passo | Nome                 | `lifeNights`                                         |
| ----- | -------------------- | ---------------------------------------------------- |
| 1     | Life started (day 1) | 0 — a vida entra quando o corpo está de pé na cidade |
| 2     | Night 1 (day 2)      | 1                                                    |
| 3     | Night 3 (day 4)      | 3                                                    |
| 4     | Night 7 (day 8)      | 7                                                    |
| 5     | Night 9 (day 10)     | 9                                                    |
| 6     | Night 14 (day 15)    | 14                                                   |
| 7     | Night 19 (day 20)    | 19                                                   |
| 8     | Night 29 (day 30)    | 29                                                   |
| 9     | Night 49 (day 50)    | 49                                                   |

- Run assistida por admin não conta noite (`lifeNights` não anda), então não aparece aqui.
- Um New game que ainda espera o amanhecer não abre funil: a vida só "começa" quando o corpo fica de pé.
- **Pergunta:** em que noite a curva de dificuldade perde as vidas? O salto do dia 15 (dificuldade 1) mata mais que
  o das ondas do dia 10?

### 4.2 Night — um funil por **noite vivida na cidade**

`funnelSessionId` = um GUID sorteado às 19:00. Só entra quem **está de pé na cidade ao anoitecer**: quem entra às
23:00 contaria como tendo vivido 19:00 e 22:00 (passos pulados contam como feitos). A noite de um jogador fecha na
morte dele (um Rebirth antes da hora seguinte é um corpo novo, não a noite vivida) ou numa hora em que ele não estava
de pé na cidade (morto, no lobby). O relógio é o do mundo (`mpHost` liga a visão do mundo, `bindWorld`), lido uma vez
por segundo; um relógio que pula (admin, cidade nova) não cruza hora nenhuma.

| Passo | Nome             | Hora do mundo, de pé na cidade |
| ----- | ---------------- | ------------------------------ |
| 1     | Wave 1 (19:00)   | anoitecer, primeira onda       |
| 2     | Wave 2 (22:00)   | segunda onda                   |
| 3     | Midnight (00:00) | a meia-noite que paga o dia    |
| 4     | Wave 3 (01:00)   | terceira onda                  |
| 5     | Dawn (06:00)     | amanhecer                      |

- **Campos do passo 1:** `World day - …` (o tamanho da horda é do dia do **mundo**), `Life day - …` (o progresso de
  quem joga) e `Survivors - Solo/Group` (quantos estão de pé na cidade às 19:00).
- **Pergunta:** em que onda se morre? A noite é dura demais para quem joga sozinho (breakdown por `Survivors`)? E
  para qual dia do mundo? (É onde foi parar a pergunta "o grupo protege?", que antes era um campo de `Died`.)

### 4.3 Rebirth — um funil por **morte**

`funnelSessionId` = `death-<vida>-<n-ésima morte da vida>` (`lifeDeaths`, que o servidor conta a cada morte): uma
chave natural, a mesma em qualquer servidor — um Rebirth comprado no lobby de outro servidor ainda fecha a morte que
ele responde.

| Passo | Nome           | Quando                                                      |
| ----- | -------------- | ----------------------------------------------------------- |
| 1     | Died           | o servidor matou o sobrevivente (`life.ts` `died`)          |
| 2     | Rebirth bought | um Rebirth **pago** aceito para essa morte (`handleAction`) |

- **Campos do passo 1:** `Continue - 1/2/3/4+` (qual continue da vida seria), `Afford - Yes/No` (o saldo cobre
  `rebirthPrice(deathCount)`?) e `Life day - …` (quanto a vida que ele salvaria já durou).
- O "abandono" entre 1 e 2 é a morte que terminou de outro jeito: New game, amanhecer de graça, fim do mundo ou saída.
  Um Rebirth de preço 0 (o amanhecer já tinha passado no lobby) não é conversão e não conta.
- **Pergunta:** o preço do Rebirth está certo? Quem pode pagar paga? Paga-se mais para salvar uma vida longa?

### 4.4 Shop — um funil por **visita à loja**

`funnelSessionId` = um GUID sorteado quando a visita abre. O passo 1 é a exceção da regra 1: o cliente avisa que a
tela abriu (`{ kind: "viewShop", screen }` no `ShopAction`, disparado e esquecido por `client/ui/shop.ts` e
`client/ui/wardrobe.ts`). O servidor responde na hora, sem cobrar nada, sem gastar a ficha de compra (o balde do
`ShopAction`), e o módulo aplica a proteção que a documentação pede: tela conhecida (0 Packs, 1 Wardrobe), no máximo
uma visita por segundo (`SHOP_OPEN_MIN_S`) e 30 por sessão (`SHOP_VISITS_MAX`).

| Passo | Nome         | Quando                                                                     |
| ----- | ------------ | -------------------------------------------------------------------------- |
| 1     | Opened       | a loja (ou o guarda-roupa) abriu                                           |
| 2     | Tried to buy | chegou um pedido de compra bem formado (pacote ou traje), antes da decisão |
| 3     | Bought       | o servidor aceitou a compra                                                |

- **Campos do passo 1**, todos do servidor: `Screen - Packs/Wardrobe`, `Coins - 0-9/10-49/50-199/200+` (o saldo no
  save naquele instante) e `Where - Lobby/City`.
- Cada passo uma vez por visita, compre quantas coisas comprar. Uma compra sem visita aberta (ou depois de 10 min,
  `SHOP_VISIT_S`) não abre funil — contaria "Opened" como feito.
- **Pergunta:** quem abre a loja compra? Quem tenta e não consegue (entre 2 e 3) é por falta de moeda (breakdown
  `Coins`)? A loja da rua converte mais que a do lobby?

**Por que o craft não virou funil:** um craft é um verbo só (o `Intent` pedido → aplicado ou recusado pelo servidor),
sem passos intermediários que o servidor veja — abrir a bancada é só tela do cliente. Um funil de um passo não mede
nada; o agregado `Crafted` (§5) responde a pergunta (cozinha e fundição são usadas?).

### 4.5 Levels — funil único por jogador

Sem `funnelSessionId` (repetição ignorada pela plataforma). Passos nos níveis 1, 2, 3, 5, 10, 15, 20, 25, 30, 40,
50, 75 e 100. Cada sessão que entra na cidade manda o degrau atual uma vez e depois cada degrau novo; um nível posto
por admin não é mandado. **Pergunta:** quantos jogadores chegam a cada nível?

### 4.6 NewTown — um funil por **viagem a uma cidade própria**

O Play solo e o New town da oferta de cidade nova (`docs/MULTIPLAYER.md` §7.4, MP-25; `server/match/*`).
`funnelSessionId` = um GUID sorteado pelo servidor de origem quando aceita o pedido, levado no bilhete do teleporte
(o TeleportData): o **mesmo** id fecha o funil no servidor de destino, como a chave natural do Rebirth vale em qualquer
servidor.

| Passo | Nome       | Quando                                                                                         | Onde                        |
| ----- | ---------- | ---------------------------------------------------------------------------------------------- | --------------------------- |
| 1     | Asked      | o servidor **aceitou** o pedido (limites e recusas: lobby, vivo, sem perigo, sem outra viagem) | `server/match/travel.ts`    |
| 2     | Teleported | `TeleportAsync` voltou sem erro (a viagem saiu; `TeleportInitFailed` ainda pode derrubá-la)    | `server/match/travel.ts`    |
| 3     | Arrived    | o **destino** leu o bilhete: deste place, da nossa forma, emitido para este jogador            | `server/match/matchHost.ts` |

- **Campos do passo 1**, todos do servidor: `Route - Play solo` / `Offer`, `World day - …` (o dia do mundo que ele
  deixa) e `Life day - …`.
- O pedido vem do cliente, mas o passo 1 é a **decisão** do servidor (como o "Tried to buy" da loja), e o passo 3 lê um
  bilhete que passou pelo cliente (a documentação avisa): ele só fecha o funil do **próprio** jogador, com um id de
  forma GUID, e só num servidor reservado — o pior que um cliente adulterado faz é mexer no próprio funil.
- Testado por `npm run test:match` (§3 a §5: o servidor real com os serviços falsos, os campos no conjunto fechado,
  nenhum UserId, nome ou código de acesso) e pelo conjunto fechado da §13 de `test:analytics`.
- **Pergunta:** quem aperta Play solo chega? Entre 2 e 3 está o teleporte que falha no fim (o `TripFailed` diz por
  quê). A oferta converte? (`Route - Offer` no passo 1 contra o `TownOffered`, §5.) Quem vai para a cidade própria
  vinha de que dia do mundo?

## 5. Eventos custom (`LogCustomEvent`) — todos agregados

| Evento         | Valor                     | Campos                                                                                                                        | Quando                                                                                                                                                                                                                                                                                                                                                                            | Pergunta                                                                                    |
| -------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| TutorialChoice | —                         | `Choice - Accepted` / `Declined`                                                                                              | a resposta chegou ao save do servidor (jogador novo)                                                                                                                                                                                                                                                                                                                              | quantos aceitam o tutorial?                                                                 |
| Died           | dia da vida               | `Life day - …`; `Time - Night` / `Day`; `Cause - Hunger/Poison/Boss/Horde`                                                    | o servidor matou o sobrevivente (`life.ts` `died`) — não depois que o jogador saiu: um corpo que morre no guarda contra o combat log (`MULTIPLAYER.md` §7.2, até 5 s depois da saída) não gera `Died` nem o passo do funil de Rebirth, porque a sessão já terminou (`SessionEnded` sai na saída, com o Player presente); a morte está no save (`runOver`)                         | onde, quando e **de quê** se morre                                                          |
| LifeEnded      | dia que a vida alcançou   | `End - New game` / `World end`; `Life day - …`; `Rebirths - 0/1/2/3+`                                                         | New game aceito, ou o mundo acabou (MP-22)                                                                                                                                                                                                                                                                                                                                        | quanto dura uma vida; quem paga Rebirth vai mais longe?                                     |
| WorldEnded     | dias que o mundo durou    | `Reason - Timeout` / `Declined` / `Restarted`; `Fallen - 0/1/2/3+`; `World day - …`                                           | uma vez por mundo, no primeiro sobrevivente conectado que caiu com ele; num **Restart town** (MP-26: toda vida da cidade acaba, então todos contam como caídos), no primeiro deles conectado ou no dono que pediu; um mundo que os mortos deixaram saindo do servidor (MP-22, L1: só acaba com alguém conectado), em quem estiver aqui (`worldLog.ts` guarda o registro completo) | quanto dura um mundo; solo desiste mais que grupo? quantos VIPs recomeçam a cidade?         |
| TitleEarned    | —                         | `Title - Survivor` / `Horde Breaker` / `Week One`                                                                             | o servidor concedeu o título (MON-05), uma vez por save                                                                                                                                                                                                                                                                                                                           | quantos ganham cada título por dia?                                                         |
| SessionEnded   | minutos jogados na sessão | `Where - Lobby/City/Dead`; `Time - Night/Dawn/Day`; `Visit - First/Returning`                                                 | ao sair do servidor, **toda** sessão gravável (inclusive quem nunca entrou na cidade)                                                                                                                                                                                                                                                                                             | **onde se desiste**: no lobby, na cidade, morto?                                            |
| SessionLength  | minutos jogados na sessão | `Length - 0-14 min/15-59 min/1-2 h/2-3 h/3 h+`                                                                                | junto do SessionEnded, **toda** sessão gravável                                                                                                                                                                                                                                                                                                                                   | a cauda da sessão (guarda da BEM-07, §15)                                                   |
| BreakNudge     | —                         | `Left - Yes` / `No` / `Unknown` (o servidor fechou nos 2 min)                                                                 | uma vez por sessão: o amanhecer em que o servidor deu a linha (§15); sai 5 s depois da saída ou 2 min depois                                                                                                                                                                                                                                                                      | a linha da pausa é ouvida? (BEM-04)                                                         |
| SessionKills   | golpes finais na sessão   | `Kills - 0/1-9/10-49/50-199/200+`                                                                                             | ao sair do servidor, se entrou na cidade                                                                                                                                                                                                                                                                                                                                          | quanto se luta por sessão                                                                   |
| WeaponKills    | golpes finais com o tipo  | `Weapon - Rifle/Pistol/MG/Shotgun/Sniper/Bow/Melee/Special/Machine/Other`                                                     | ao sair, **um por tipo de arma usado** na sessão (o crédito de abate do servidor diz o tipo)                                                                                                                                                                                                                                                                                      | que armas se usam (soma e usuários únicos por tipo)                                         |
| Crafted        | crafts na sessão          | `Kind - Crafted` / `Cooked` / `Smelted`                                                                                       | ao sair, se > 0 (decisão do servidor: `sim.onBackpack`)                                                                                                                                                                                                                                                                                                                           | cozinha e fundição são usadas?                                                              |
| ItemsUsed      | itens usados na sessão    | —                                                                                                                             | ao sair, se > 0                                                                                                                                                                                                                                                                                                                                                                   | consumo por sessão                                                                          |
| JoinedFromList | dia do mundo onde chegou  | `Players - 1/2-3/4+`; `World day - …`; `Best day - …`                                                                         | contado **onde chega** (MP-26; revisão de 0b44458, L5): o jogador veio da lista **Servers** de outro servidor público deste place — o teleporte leva `TeleportData {pz: "servers"}`, conferido contra o `SourcePlaceId` (`server/match/townServices.ts`) — e o save dele carregou; uma vez por sessão; os dados passam pelo cliente e só servem para esta contagem                | a lista é usada? que cidade se escolhe: cheia ou vazia, nova ou veterana, perto do recorde? |
| TownOffered    | dia do mundo              | `World day - …`; `Best day - …` (o recorde); `Visit - First` / `Returning`                                                    | um jogador **novo** (recorde ≤ 5) num servidor público de dia bem além do recorde recebeu a oferta (MP-25)                                                                                                                                                                                                                                                                        | quantos novatos caem em mundos de dia alto (P0-1)?                                          |
| TripFailed     | teleportes tentados       | `Stage - Reserve/Teleport/Init`; `Result - reserve/teleport/full/flooded/denied/timeout/cancelled`; `Route - Play solo/Offer` | uma viagem a uma cidade própria acabou com o jogador ainda aqui (`cancelled` = ele entrou na cidade)                                                                                                                                                                                                                                                                              | o teleporte falha onde e por quê?                                                           |

Buckets de dia: `1`, `2-3`, `4-7`, `8-14`, `15-29`, `30+` (os degraus da dificuldade, não um valor por dia).

- **Causa da morte** (`causeOfDeath`, `shared/data/deathCause.ts` `deathKindOf`): a **fonte do dano letal**. Toda
  perda de HP de um corpo vivo anota o que a tirou (`PlayerState.lastHurt`: um golpe, o estômago vazio, o veneno, a
  carne podre), e fica a que cruzou o zero: `Hunger` e `Poison` só quando a fome ou o veneno deram o último tique
  (revisão de ca9494a, L8: um faminto que uma mordida acaba morreu da mordida); um golpe com um chefe vivo a até 900
  (o alcance da agulha, `bossBrain.ts`) é `Boss`, senão `Horde`; a carne podre e uma chamada sem corpo, `Unknown`. É a
  mesma regra que a tela de morte diz ao morto (`Announce{Died}`, DESIGN_RULES UI-13). **Mudança de 2026-09-24:** o
  terceiro campo de `Died` era `Survivors - Solo/Group`; como os valores dizem a dimensão no próprio texto, os dois
  nunca se confundem num gráfico.
- **SessionEnded**: onde e quando vêm da última leitura por segundo, nunca do instante da saída (o `PlayerRemoving`
  do `mpHost` pode já ter tirado o corpo da cidade: os dois handlers rodam em ordem nenhuma). `Where - Dead` é quem
  sai esperando Rebirth ou amanhecer — a tela de morte como ponto de desistência. **`Time - Dawn`** (2026-09-24,
  BEM-07): a saída entre 06:00 e 07:30 do mundo (`shared/data/wellbeing.ts` `isDawnAt`), a parada saudável que o
  cartão do amanhecer oferece (BEM-04); antes ela caía em `Time - Day`, que agora é o resto do dia.
- **SessionLength** (2026-09-24, BEM-07): o mesmo valor do SessionEnded, com o comprimento num balde. A página de
  eventos custom dá média, mínimo e máximo de um valor, **nunca um percentil**: a cauda (a fatia de sessões acima de
  2 h e de 3 h) só se lê contando por `Length`. Um evento a mais por sessão, na saída.
- **BreakNudge** (2026-09-24, BEM-04; revisto na revisão de ca9494a, L7): a linha da pausa é **uma decisão só, do
  servidor**. Às 06:00, `server/main.server.ts` (`sim.onDawn`) pergunta `breakNudgeEarned` (`shared/data/wellbeing.ts`:
  sessão de 90 min ou mais no servidor, `BREAK_NUDGE_MIN`, desde a entrada; a noite vivida de pé desde a meia-noite, a
  mesma presença que o título Survivor conta; uma vez por sessão) e, no mesmo passo, avisa aquele sobrevivente
  (`Announce{BreakNudge}`, nota 24 do protocolo) e chama `Analytics.breakNudge`. O cliente não tem relógio próprio
  para isso: mostra o que ouviu, no cartão do amanhecer ou, sem cartão, no feed. Então **linha contada é linha
  enviada**, e linha enviada é linha vista (o `test:analytics` §12d confere, por jogador, avisos = eventos). O campo:
  `Left - Yes` se o jogador **saiu por conta própria** em até 2 min (`BREAK_NUDGE_LEFT_S`), `Left - No` quando os 2
  min passam com ele ainda aqui, e **`Left - Unknown`** quando ninguém pode dizer que ele escolheu sair: um **kick**
  (o `PlayerRemoving` traz `Enum.PlayerExitReason.CreatorKick` — `Player:Kick`, o do admin e o kick por flood — ou
  `PlatformKick`), um **teleporte** para outro servidor deste jogo (o Play solo e a entrada pela lista Servers marcam o
  jogador com `teleporting` logo antes do `TeleportAsync`; a saída em até 60 s depois é do teleporte), um
  **fechamento** (o `BindToClose` começou) ou um **reinício agendado** (`DataModel.ServerRestartScheduled`: atualização,
  manutenção), e uma saída que só a leitura por segundo percebeu (não se sabe quando nem por quê). **O veredito sai no
  próprio `PlayerRemoving`**, com o jogador ainda lá. O que a documentação diz (Context7, 2026-09-24): o
  `LogCustomEvent` pede o `Player` "who triggered the event" (tipado `Player`), o `PlayerRemoving` dispara "right
  before" o jogador sair e o `Player` é destruído logo depois; nada documenta um evento para um `Player` que já se foi,
  então não é seguro adiar o veredito. O limite que fica: o `PlayerExitReason` de um desligamento sem aviso ("Shut down
  all servers") é o genérico `Unknown`, e se esses kicks chegarem ao `PlayerRemoving` antes do `BindToClose` a saída
  conta como do jogador — o reinício agendado e o `BindToClose` cobrem o resto.
- **WeaponKills**: a contagem é por abate (`progress.ts` `creditKill` / `creditMachineKill`, depois da trava de run
  assistida, igual a `zombieKills`), mas só vira evento na saída: 1 a 3 por sessão na prática, nunca um por abate. A
  soma por `Weapon` é o total de abates com cada tipo; "usuários únicos" diz quantos usam cada um.

Uma New game que nunca ficou de pé e é engolida por um fim de mundo não conta como segunda vida (no solo, New game
**é** a recusa que acaba o mundo: uma vida encerrada, `End - New game`).

## 6. Orçamento de taxa

- Limite: 120 + 20 × CCU por minuto; com 6 jogadores, **240/min**. O módulo se limita a 75 %: **180/min**.
- **Uma noite real no servidor de verdade** (`test:analytics` §2–3: 6 jogadores, 23:00 → 06:00, abates, meia-noite,
  títulos): 20 eventos a noite inteira; o minuto mais cheio do teste todo foi o das 6 entradas, com 42. A §9 vive uma
  noite inteira de 4 jogadores desde as 18:48: 12 linhas do funil Night.
- **Uma hora pessimista de 6 jogadores** (§8: todos jogando a hora toda, 2 abates por segundo cada com armas
  nomeadas, morte e Rebirth toda noite, chefe toda noite, uma visita à loja com compra a cada 3 minutos, o funil
  Night de todos toda noite, níveis subindo, um fim de mundo, duas reconexões e o servidor fechando no fim):
  **1.044 eventos/hora ≈ 17/min** (Night 141, Rebirth 114, Shop 360, SessionEnded 8, SessionLength 8, WeaponKills
  16); o minuto mais cheio tem **66 = 28 % do limite**. Nada esperou na fila.
- **Enxurrada** (§8: 6 jogadores ricos comprando 150 pacotes cada em 10 s, muito além do balde do ShopAction):
  nenhum minuto passa de 180, nada é descartado, cada moeda chega (900 compras viram 186 eventos somados).
- Por tipo, também longe dos tetos: 1 moeda (limite 5), 5 transactionTypes (20), 25 SKUs (100), 7 funis com o
  Onboarding (10), 13 passos no maior (100), 15 nomes custom (100), teto de 681 combinações de campos (8.000).

## 7. O que o dono vê no Creator Hub, e quando

1. **Publicar** (o jogo precisa ser publicado; nada sai do Studio).
2. **Minutos depois:** Creator Hub → a experiência → **Analytics** → páginas **Economy**, **Funnels** e **Custom
   events**, botão **View Events**: lista quase em tempo real dos últimos eventos. É o jeito de conferir que está
   chegando (atualize a página).
3. **Em até ~24 h** (os eventos são agregados por dia): os gráficos aparecem.
    - **Economy:** fontes × sumidouros de `Coins` por transactionType e por SKU, saldo médio, com quebra pelos campos
      (`Category`, `Continue`).
    - **Funnels:** a aba **Onboarding** (o funil embutido) e abas para **NightSurvival**, **Night**, **Rebirth**,
      **Shop**, **Levels** e **NewTown** (até 10 abas): conversão e abandono por passo, com breakdown pelos campos do passo 1.
      Ao mudar um passo, ajuste o intervalo de datas para depois da mudança (funnel-events.md, "Modify funnels").
    - **Custom events / Explore:** cada evento com contagem, usuários únicos, soma, média, mínimo, máximo e média por
      usuário do valor, fatiado pelos campos. Dá para montar um **Custom dashboard** com os que importam (Died por
      `Cause`, SessionEnded por `Where`, WeaponKills soma por `Weapon`, LifeEnded médio por `Rebirths`, WorldEnded
      médio).
4. Retenção, engajamento e aquisição continuam vindo sozinhos, sem código. Os eventos somem 90 dias depois do último
   dado recebido (event-types.md).

## 8. Limites conhecidos (aceitos)

- **Resposta do tutorial e abertura da loja** vêm do cliente (regra 1). Pior caso: um cliente adulterado mexe no
  próprio funil (e a abertura da loja tem trava de ritmo e de quantidade).
- **Chave da vida** (`runRev − deathCount`) anda também num Rebirth gratuito (amanhecer que já passou no lobby) ou
  numa edição de admin: a mesma vida abre uma segunda sessão do funil. Raro; os passos repetidos continuam
  honestos (a vida passou mesmo por eles). A chave da morte (`death-…`) herda isso.
- **Vidas de antes do v5** começam com `lifeNights` 0: entram no NightSurvival do zero.
- **Vida encerrada longe do servidor** (caiu com o mundo, saiu durante a janela e voltou nos 5 min — a vida nova
  "devida" da MP-22) não gera LifeEnded: sem `Player` conectado não há como chamar a API.
- **Servidor que cai sem `BindToClose`** perde os resumos de sessão (SessionEnded, SessionKills, WeaponKills,
  Crafted, ItemsUsed) dele.
- **Night** segue o relógio do mundo lido uma vez por segundo: uma hora cruzada durante um soluço de vários segundos
  ainda sai (em ordem); um salto de mais de 2 horas de jogo (relógio de admin, cidade nova) não conta hora nenhuma.
- **Causa da morte** é inferida do estado, não do golpe: um faminto mordido conta como `Hunger` (a fome era o
  problema), um chefe a 900 conta mesmo que o último golpe tenha sido de um zumbi.
- Com MP_PHASE < 2 (moedas pagas pelo relatório) a economia não seria registrada; o jogo está no MP_PHASE 2, onde o
  relatório não paga nada.
- **Mochila no servidor** (branch F3 NET-1..6): `sim.onBackpack` já está ligado ao `Analytics.backpack`; o resultado
  novo `delivered` (pacote entregue) é ignorado, porque não mexe em moeda (a compra já foi o sumidouro).

## 9. Como adicionar um evento

1. A regra e o nome vão em `src/server/analytics/events.ts` (catálogo no topo, emissor na classe), nunca espalhados
   pelo servidor; no lugar da decisão, um gancho de uma linha (`Analytics.<gancho>(…)`).
2. Leia um número que o servidor decide. Nunca um por abate: agregue num ponto natural.
3. Campos: poucos valores fixos, com o nome da dimensão no texto ("Time - Night"). Num funil, só no passo 1.
4. Uma seção ou um check em `tools/test-analytics.mjs` (e o valor novo no conjunto fechado da §13 da suíte), e a
   linha na tabela certa deste documento.

## 10. Error Report, Crashes e Performance: o que o código faz por eles

**Error Report** (Monitoring → Error Report) junta os erros e **avisos** de servidor e cliente **pela mensagem**, e
guarda 500 erros e 500 avisos únicos a cada 6 h (error-report.md, "Error tracking limits"). "Player 12345 failed to
load" e "Player 67890 failed to load" são duas linhas — é o exemplo da própria página. Por isso:

- **Todo `warn()` do jogo é uma frase fixa.** O que muda de uma ocorrência para outra — UserId, chave do save, nome
  do jogador, contagem, tamanho, seed, hash do mapa — vai para um `print` logo depois, que o Developer Console mostra
  ao lado e o Error Report não conta. Arrumados em 2026-09-24: o save (`main.server.ts`: carga, escrita, tamanho,
  trava, JSON inválido, migração v1, patch de admin, e o `guarded`, que agora recebe a chave à parte), o `mpHost`
  (kick por flood, anomalia de input, falha do tick sem a contagem, banco do corpo no desligamento), `titleRecord`,
  `worldLog`, `backpackIntents`, o painel de admin, o próprio analytics (a contagem de falhas saiu da mensagem) e,
  no cliente, `netClient` (hash do mapa, handshake), `skin`, `worldArt`, `townCache` e `saveClient`. O texto do erro
  (`tostring(err)`, com o traceback do `xpcall`) continua na mensagem: é estável por versão e é o que diz onde foi.
- **O fim de um mundo (MP-22) deixou de ser aviso** e virou `print`: é o jogo funcionando, não uma falha.
- **Trava:** a §14 da suíte lê todos os `warn()` de `src/` e falha se algum interpolar algo fora de uma lista curta de
  coisas estáveis (constantes, o nome fixo de um passo, o texto do erro). Hoje são 56 chamadas, todas limpas.
- **Nada engolido que devesse aparecer:** os `pcall` que descartam a falha em silêncio são os que devem (atributo de
  métrica, `Kick`, `GetNetworkPing`, `SetCoreGuiEnabled` com nova tentativa, a própria entrega de analytics, que
  conta e avisa uma vez por minuto). Os caminhos que importam (save, tick, reset do mundo, banco do corpo) usam
  `xpcall` + `debug.traceback` e avisam.

**Performance** (Monitoring → Performance): os gráficos de CPU mapeiam para os grupos do **MicroProfiler** e a
memória para `Enum.DeveloperMemoryTag` (performance.md). O que o código já dá para o dono cavar um problema que o
painel mostrar: cada fase do tick do servidor é uma barra `PZ.*` (`PZ.step`, `PZ.players`, `PZ.horde.*`,
`PZ.world`, `PZ.combat`, `PZ.replication`, `PZ.repl.*`), agora também `PZ.analytics` (a leitura por segundo); o
quadro do cliente tem `pz.update`, `pz.render`, `pz.hud`, `pz.net`, `pz.mirror`, `pz.world`, `pz.light`; a memória
da simulação é a categoria `PZ.sim` no Developer Console. Num dump do servidor (MicroProfiler, modo Timers) essas
barras aparecem com o nome.

**Crashes** (Monitoring → Crashes): só crashes de **servidor** — falta de memória (com o "snapshot" do DataModel em
treemap) ou falha da plataforma. O nosso servidor cria poucas Instances (remotes); a memória dele é o heap de Luau da
simulação (`PZ.sim`). Um crash por memória aparece primeiro em **Server memory by age** subindo com a idade do
servidor; o treemap só ajudaria se Instances vazassem. Nada a mudar no código hoje.

## 11. Auditoria das dez páginas (2026-09-24)

Lacuna: CÓDIGO = nossa, feita neste commit; PAINEL = o dono faz no Creator Hub (§14). Linhas do commit desta auditoria.

| Página                 | O que oferece                                                                                                                                                                                                                                                                                        | O que já fazemos (arquivo:linha)                                                                                                                                                                                                                                                          | O que falta                                                                                                                                                                                          | Lacuna                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Analytics** (índice) | Plano em 3 passos (retenção/sessão → aquisição → monitorar a cada update); benchmarks com 100+ DAU; Analytics Home (watchlist de 9 jogos); `GetPlayerSegmentsAsync` (segmentos em tempo de jogo: pagante, quando jogou a 1ª vez, gastador da plataforma)                                             | Economy/Funnels/Custom alimentados por `server/analytics/events.ts`; retenção e engajamento vêm sozinhos                                                                                                                                                                                  | `GetPlayerSegmentsAsync`: **não usado de propósito** — o jogo não vende nada por Robux (os segmentos de pagante não mudam nada) e o "jogador novo" o save já diz com certeza. Watchlist e benchmarks | PAINEL                                  |
| **Get started**        | DAU/MAU/sessão; D1/D7/D30; ARPDAU/conversão/ARPPU; filtros de segmento; o ciclo analisar → config/experimento → medir                                                                                                                                                                                | Os funis respondem "onde param de progredir" (§4); configs/experimentos têm o gancho (`server/config/experiments.ts:88`)                                                                                                                                                                  | Usar os filtros (When user first played, Active payer status) nos gráficos                                                                                                                           | PAINEL                                  |
| **Funnel events**      | Funis únicos e recorrentes; `funnelSessionId` (GUID ou chave natural); passo 1 obrigatório, repetidos ignorados, pulados contam como feitos; 10 funis, 100 passos; breakdown só pelos campos do passo 1; proteção contra exploit                                                                     | Onboarding `events.ts:81`/`:914`; NightSurvival `:90`; Levels `:106`; **novos**: Night `:116`, Rebirth `:134`, Shop `:142`; campos no passo 1 (onboarding `:678`, Night `:832`, Rebirth `:1018`, Shop `:1066`); GUIDs pelo `HttpService` (boot `:1239`); proteção do `viewShop` (`:1066`) | — (fechado)                                                                                                                                                                                          | CÓDIGO (feito)                          |
| **Experiments**        | A/B de config (in-game) ou matchmaking; 14–60 dias; até 2 variantes + controle; `GetConfigForPlayerAsync` por jogador, `GetValue` inscreve; métricas D1/D7/playtime/ARPU/ARPPU/conversão/session time; boas práticas (MDE, hipótese, duração cheia, significância, sem mudanças no meio, documentar) | **Novo** `server/config/experiments.ts` (`readKnob` `:88`, `knobValue` `:53`, `grantWelcomePack` `:104`); ligado na criação do save (`main.server.ts:612`); o braço vai no passo 1 do onboarding (`main.server.ts:678`)                                                                   | Criar a config e o experimento; propostas na §12                                                                                                                                                     | CÓDIGO (feito) + PAINEL                 |
| **Feedback**           | Votos e comentários da página do jogo (desde fev/mar 2025), gráfico, tabela, CSV                                                                                                                                                                                                                     | Nada a fazer: **não existe API** para pedir feedback de dentro do jogo (a página e a referência de engine não listam nenhuma)                                                                                                                                                             | Ler toda semana, exportar CSV; com 20+ comentários, o relatório de feedback (Insights)                                                                                                               | PAINEL                                  |
| **Performance**        | FPS/CPU/memória/crash rate/OOM do cliente; CPU/FPS/memória/núcleos do servidor; P90/P50/P10; breakdown por Place Version; CPU ↔ MicroProfiler, memória ↔ `DeveloperMemoryTag`; 100+ DAU                                                                                                              | Barras `PZ.*` do servidor (`simulation.ts`, `zombies.ts`, `replication.ts`, perfilador `mpHost.ts:596`), **novo** `PZ.analytics` (`events.ts:1249`); `pz.*` do cliente (`main.client.ts:784`, `gameLoop.ts:608`); memória `PZ.sim` (`mpHost.ts:683`)                                      | Olhar depois de cada publish por Place Version; alertas (§13)                                                                                                                                        | CÓDIGO (feito: `PZ.analytics`) + PAINEL |
| **Insights**           | Mudanças grandes na visão geral (100+ DAU), painel de conquistas, relatórios de IA semanais/mensais (1000+ DAU), relatório de feedback (20+ comentários)                                                                                                                                             | Nada a fazer: nenhum evento habilita insights                                                                                                                                                                                                                                             | Ler a visão geral; "See full report"                                                                                                                                                                 | PAINEL                                  |
| **Error report**       | Erros e avisos de servidor e cliente por mensagem, stack trace, 500 únicos/6 h, top 100 novos por versão, regras (regex, até 100) para ignorar/agrupar                                                                                                                                               | **Mensagens estáveis** em todo `src/` (§10) e a trava da suíte (§14); falhas com traceback (`main.server.ts:279`, `mpHost.ts:693`)                                                                                                                                                        | Filtro "New errors since" a cada publish; regras para ruído de engine (§14)                                                                                                                          | CÓDIGO (feito) + PAINEL                 |
| **Crashes**            | Crashes de servidor por OOM (snapshot em treemap) ou plataforma; por place/versão/uptime                                                                                                                                                                                                             | Servidor com poucas Instances; memória da simulação em `PZ.sim`                                                                                                                                                                                                                           | Olhar depois de publicar; bug report se "platform crashes" subirem                                                                                                                                   | PAINEL                                  |
| **Alerts**             | Alertas de performance e de data store; valor fixo ou variação (semana/dia/hora); duração 1–10 (mín. 5 no minuto); severidade; webhook; 20 por experiência; 100+ DAU                                                                                                                                 | Nada de código (a página diz que não precisa); **não há alerta de taxa de erro** nem de evento custom — só as métricas de performance e de data store                                                                                                                                     | Webhook + as alertas da §13                                                                                                                                                                          | PAINEL                                  |

**Fora das dez páginas, anotado:** `AnalyticsService:LogJourneyEvent` (caminhos não lineares, desenhados num Sankey)
serviria para "o que acontece depois de uma morte" (Rebirth / New game / amanhecer / saída), mas ainda não tem página
de uso na documentação; o funil Rebirth + `LifeEnded` + `SessionEnded Where - Dead` cobrem a mesma pergunta hoje.

## 12. Experimentos e configs (`server/config/experiments.ts`)

**O que o código faz** (experiments.md "Add experiments to your code" e configs.md):

1. O valor de um jogador vem do **snapshot dele**, `ConfigService:GetConfigForPlayerAsync(player)`;
   `GetConfigAsync()` não aplica experimento nenhum. Só o servidor pode (ConfigService recusa cliente).
2. O primeiro `GetValue` nesse snapshot **inscreve** o jogador — por isso cada knob é lido onde é usado, nunca antes
   ("Calling GetValue() too early can cause you to enroll players who never interact with…").
3. Nada pode atrapalhar: tudo em `pcall`, espera no máximo 3 s (`SNAPSHOT_BUDGET_S`; um snapshot que chega depois
   nunca é lido, então ninguém fica inscrito sem receber o valor), e qualquer coisa fora da faixa — ou nada publicado —
   é o `fallback`, que é o jogo exatamente como era.
4. O que precisa durar é gravado no save (o pacote dado fica em `packsBought`): é o "persist the value yourself" que
   a página pede quando a elegibilidade pode mudar entre sessões.
5. No Studio, o ConfigService lê os valores **staged**, e `ConfigService:SetTestingValue("pz_welcome_pack", 0)` na
   barra de comandos força uma variante naquela sessão.

**Knob ligado:** `pz_welcome_pack` (número; −1 = nenhum, o padrão; 0–8 = o índice do pacote em `SHOP_PACKS`, 0 =
First Night Kit). Lido **uma vez por save**, no instante em que ele é criado (`main.server.ts` `readSession`); o
pacote é entregue na cidade como um comprado. O braço vai no passo 1 do onboarding (`Welcome pack - …`).

**Como o dono cria um experimento:** Creator Hub → a experiência → **Configs** → Create config (chave
`pz_welcome_pack`, tipo Number, valor −1) → Publish now. Depois **Experiments** → Create experiment → tipo
**In-experience** → nome, métrica-alvo, duração (14–60 dias) → rollout (100 % se o MDE deixar) → variante (o valor)
e divisão 50/50 → (opcional) targeting → agendar. Com o experimento rodando, a chave fica travada; no fim, **Make
decision** propõe a config vencedora.

**Boas práticas (experiments.md), aplicadas a nós:** olhe o **MDE** antes — com menos de 1.000 DAU a página avisa
que é difícil ter dado útil (é o nosso caso hoje: rode quando tiver público). Escreva a hipótese antes. Deixe
rodar a duração inteira (efeito novidade). Não aja sem significância (intervalo de confiança sem cruzar 0 %). Não
publique mudanças de conteúdo durante o experimento (conserto de bug grave, sim). Um de cada vez, a menos que não
interajam. Anote a decisão aqui.

**Propostas** (métricas do Roblox: D1, D7, playtime, session time; ARPU/ARPPU/conversão não se aplicam — nada é
vendido por Robux):

| #   | Experimento                                                                                                   | Hipótese                                                                                                                                                                                  | Métrica-alvo (e as nossas)                                                 | Código                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Pacote de boas-vindas**: controle −1, variante 0 (First Night Kit)                                          | Um kit de primeira noite no primeiro acesso põe o jogador novo no ciclo de loot mais cedo; mais gente sobrevive à primeira noite e volta amanhã                                           | **D1**; passo 5 do Onboarding por `Welcome pack`; Night por `Life day - 1` | **Pronto** (`pz_welcome_pack`)                                                                                                                  |
| 2   | **Primeira noite mais leve para quem é novo**: dano recebido ×0,75 na primeira vida, até o amanhecer do dia 2 | A maioria dos jogadores novos morre na primeira noite (Night / Onboarding 5); aliviar só para eles, sem mexer na horda do mundo compartilhado, sobe D1 sem tirar a tensão de quem já joga | **D1**; Rebirth e Died por `Life day - 1`                                  | A fazer: knob por jogador no dano do servidor (`combat.ts` `damageActor`); a horda é do mundo inteiro, então **não** pode ser o tamanho da onda |
| 3   | **Preço do Rebirth**: base 10 (controle) contra 5                                                             | Rebirth mais barato mantém a vida longa e a sessão; ou barateia a morte e encurta o jogo                                                                                                  | **Session time**; D7; funil Rebirth (conversão por `Afford`)               | A fazer: o cliente mostra o preço de `shared/data/shop.ts` — o servidor teria que mandar o preço no wallet antes                                |

## 13. Alertas recomendados (Configure → Alerts)

Precisam de 100+ DAU e de um webhook (Configure → Webhooks: Discord ou Slack, com segredo). Nomes no formato
"métrica - contexto" (alerts.md). **Antes de fixar os números, olhe 7–14 dias de gráfico** e ponha o limite em ~2× o
normal; os abaixo são o ponto de partida para um jogo de Frames em tela cheia com simulação a 60 Hz no servidor.
Taxa de erro **não** é métrica de alerta (só performance e data store): erros se olham no Error Report depois de cada
publish.

| Nome                        | Métrica                                               | Condição                                                      | Granularidade / duração | Severidade | Breakdown |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- | ----------------------- | ---------- | --------- |
| Client crash rate - todos   | Client crash rate                                     | > 3 %                                                         | hora / 2                | crítica    | Platform  |
| OOM exits - subida          | Unexpected out-of-memory exits                        | variação hora a hora > 50 %                                   | hora / 2                | crítica    | Platform  |
| Client memory % - mobile    | Client memory usage percentage                        | > 80 %                                                        | meia hora / 3           | média      | OS        |
| Client FPS - baixo          | Client frame rate                                     | < 30                                                          | meia hora / 3           | média      | Platform  |
| Server FPS - simulação      | Server frame rate                                     | < 50 (o tick de 60 Hz começa a dever ticks)                   | minuto / 5              | crítica    | —         |
| Server CPU - alto           | Server CPU time                                       | > 12 ms                                                       | meia hora / 3           | média      | —         |
| Server memory - alta        | Server memory usage (GB)                              | > 1,5 GB (a página: < 3 GB ou 50 %)                           | meia hora / 3           | média      | —         |
| Server memory - crescimento | Server memory usage (GB)                              | variação dia a dia > 30 %                                     | dia / 2                 | baixa      | —         |
| CCU - queda                 | Concurrent users                                      | variação hora a hora: queda > 50 % (pega um publish quebrado) | hora / 2                | crítica    | —         |
| Session time - queda        | Session time                                          | variação semana a semana: queda > 25 %                        | dia / 2                 | média      | —         |
| Data store - falhas         | a métrica de erros/limitação de data store do seletor | > 1 %                                                         | minuto / 5              | crítica    | —         |

Onze de 20. O save do jogo é DataStore com trava de sessão: uma falha de data store é perda de progresso, por isso a
última é crítica.

## 14. Checklist do dono no Creator Hub

1. **Publicar** e, em minutos, conferir **View Events** em Economy, Funnels e Custom: os 6 funis (Onboarding,
   NightSurvival, Night, Rebirth, Shop, Levels) e os 15 eventos custom.
2. **Funnels:** criar as abas (até 10); usar o breakdown pelos campos customizados (são os do passo 1).
3. **Custom dashboard:** Died por `Cause`; SessionEnded (contagem) por `Where`; WeaponKills (soma e usuários únicos)
   por `Weapon`; LifeEnded (média) por `Rebirths`; Shop por `Coins`.
4. **Error Report**, depois de cada publish: filtro **New errors since** a versão nova. Regras (Rules → Create Rule):
   `DataStore` → Group "DataStore" (os avisos de fila da própria engine — o exemplo da página — não passam pelo nosso
   código); `^\[Last Town\] save` → Group
   "Save"; `^\[Last Town\] kicking a player` → Group "Flood kicks"; `^\[Last Town\] input anomaly` → Group "Input".
   O prefixo é o `GAME_NAME` (`src/shared/module.ts`): até 2026-09-24 ele era `[Project Z]`, então uma regra criada
   antes disso precisa do prefixo novo (os avisos das versões antigas ainda no ar seguem com o velho até saírem).
5. **Alerts** (com 100+ DAU): criar o webhook e as alertas da §13.
6. **Configs/Experiments:** criar a config `pz_welcome_pack` (Number, −1) e publicar; o experimento 1 da §12 quando
   o MDE permitir (≈ 1.000 DAU).
7. **Feedback:** ler toda semana (os votos negativos também), exportar CSV; com 20+ comentários, o relatório.
8. **Performance / Crashes:** depois de cada publish, breakdown por **Place Version**; crash de servidor por memória
   → "Server memory by age".
9. **Insights / Analytics Home:** pôr o jogo na watchlist; os relatórios de IA vêm com 1.000+ DAU.
10. **Guardas (§15):** no Custom dashboard, SessionLength (contagem) por `Length`, SessionEnded (contagem) por `Time`,
    BreakNudge (contagem) por `Left`; toda semana, com a retenção D7 da página Retention e a página Feedback.

## 15. Guardas de bem-estar (DESIGN_RULES BEM-07)

Decisão de 2026-09-24 (a BEM-07, a partir de `docs/research/MOTIVATION_AND_ETHICS.md` §6): **nenhuma mudança fica por
aumentar tempo de sessão ou gasto de moedas se piorar o retorno, a avaliação da página ou a parada ao amanhecer.**
Tempo de sessão mede o "querer"; a volta espontânea e a opinião do jogador medem o "gostar" (research §1.2). Toda
mudança de retenção, economia ou feedback é lida com **uma métrica de sucesso e uma guarda**, e a hipótese se escreve
antes (§12). Tudo abaixo continua agregado, do servidor e de cardinalidade baixa (§1).

| Guarda                | Onde se lê                                                                                                             | O que é alarme (ponto de partida: olhar 2–4 semanas de base antes de fixar)                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Cauda da sessão**   | `SessionLength` (contagem) por `Length`: a fatia de `2-3 h` e de `3 h+`; o máximo e a média do valor do `SessionEnded` | a fatia acima de 3 h (ou de 2 h) sobe mais de **15%** depois de uma mudança **sem** a D7 subir junto                         |
| **Onde se para**      | `SessionEnded` (contagem) por `Time`: `Dawn` + `Day` contra `Night`                                                    | a fatia que para de dia ou ao amanhecer **cai**; queremos que ela suba (o cartão do amanhecer é a aposta, BEM-04)            |
| **Retorno (D7)**      | Creator Hub → Retention (vem sozinha, sem código): D1, **D7**, D30                                                     | D7 cai depois de uma mudança, mesmo com a sessão subindo                                                                     |
| **Gostar (a página)** | Creator Hub → Feedback: votos e comentários da página, semanalmente                                                    | queda depois de uma mudança de retenção é alarme **mesmo com a D7 subindo**                                                  |
| **A linha da pausa**  | `BreakNudge` por `Left` (`Unknown` fica de fora da fatia: o servidor fechou)                                           | nenhum: é medida do que a linha faz (a fatia de `Left - Yes`); a guarda dela é a D7 e a página não caírem                    |
| **Gasto sob pressão** | funil Rebirth (§4.3) por `Afford - Yes`                                                                                | a conversão sobe depois de uma mudança de interface **sem** as vidas ficarem mais longas (`LifeEnded`): é empurrão, não jogo |

**O que existe, por guarda** (conferido em 2026-09-24): a cauda e o lugar da parada são nossos (`SessionLength` e o
`Time - Dawn` do `SessionEnded`, novos nesta data; o `SessionEnded` já tinha `Where` e `Time`); a D7 e a página de
Feedback são da plataforma (§7, §11: não existe API para pedir avaliação de dentro do jogo, e não pediríamos); o
`BreakNudge` é novo; o funil Rebirth já existia. Nada aqui lê dado de um cliente, nem cria evento por abate.

**Os limites:** o painel não dá percentil de um valor custom, então "p95 da sessão" vira a fatia por balde; a D7 e a
página não saem por experimento dentro do jogo (a página Experiments dá D1, D7, playtime e session time por braço — use
esses). Mudança que só se justifica por tempo de sessão ou gasto não entra (BEM-07; research §5, item 18).
