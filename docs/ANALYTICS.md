# Analytics — o que o jogo manda para o Creator Hub, e por quê

Os painéis **Economy**, **Funnels** e **Custom events** do Creator Hub (Analytics) só existem se o jogo chamar o
`AnalyticsService`. Este documento é o catálogo: cada evento, quando dispara, os campos e a pergunta de painel que
ele responde. O código é um módulo só, `src/server/analytics/events.ts`; o resto do servidor chama ganchos de uma
linha. Testado por `npm run test:analytics` (`tools/test-analytics.mjs`).

Referências (Context7 `/roblox/creator-docs` e `/websites/create_roblox`): `production/analytics/event-types.md`
(limites), `funnel-events.md`, `economy-events.md`, `custom-events.md`, `custom-fields.md` e a referência de
`AnalyticsService`.

## 1. Regras

1. **Só o servidor, só os números dele.** Todo evento lê o save vivo que o próprio servidor escreve (moedas, dia
   da vida, `lifeNights`, `zombieKills`, `titles`, nível) no instante em que o servidor o muda, ou uma vez por
   segundo (`poll`). Nada que um cliente relata vira evento (MP-00). **Exceção única, sem valor nenhum:** a resposta
   a "Do you want to watch the tutorial?" (`tutorialDone` / `firstInstall`) só existe no cliente; é lida da cópia do
   servidor, nunca do relatório, e o máximo que um cliente adulterado consegue é mexer no próprio funil.
2. **Agregado, nunca por abate.** Uma horda faz vários abates por segundo com 6 sobreviventes; um evento cada
   estouraria o orçamento numa luta. Abate só aparece como contagem num ponto natural (o primeiro de um jogador novo,
   o resumo da sessão). Craft, cozinha e uso de item, idem.
3. **Cardinalidade baixa.** Os campos customizados são poucos textos fixos ("Life day - 4-7", "Time - Night"):
   nada de texto livre, nome ou UserId. Os SKUs são os nomes do catálogo (9 pacotes, 9 trajes) e mais 7 fixos.
4. **Abaixo do limite.** O limite documentado é **120 + 20 × CCU chamadas por minuto** por servidor. O módulo usa no
   máximo **75 %** disso em qualquer janela de 60 s (`RATE_SHARE`); o que não cabe espera numa fila limitada (512) e
   sai quando a janela abre. Um evento de economia que precisa esperar é **somado** ao último evento de economia do
   mesmo jogador na fila, se tiver a mesma direção e o mesmo tipo (SKU `Batched` se forem itens diferentes): a
   contagem de compras fica menor, mas nenhuma moeda some e cada saldo continua seguindo do anterior.
5. **Nunca atrapalha.** Sem `AnalyticsService` (um teste, uma plataforma sem ele) todo gancho retorna na hora. Cada
   chamada ao módulo e cada chamada ao serviço roda em `pcall`: analytics não derruba tick, compra nem save. Uma falha
   é contada e avisada no máximo uma vez por minuto.
6. **Studio não manda nada.** A documentação é explícita: eventos só saem do servidor de um jogo **publicado**. No
   Studio o módulo roda todas as regras (o playtest as exercita) e entrega cada evento a um coletor seco que só conta
   — atributos `pz_analytics_sent`, `pz_analytics_deferred`, `pz_analytics_dropped` do Workspace — e imprime cada um
   se o atributo `pz_analytics_echo` do Workspace for `true`. Uma **experiência de teste publicada** (a "Project Z
   [dev]" da §7.4 de `docs/MULTIPLAYER.md`) é outro universo, com painéis próprios: jogo de teste nunca suja os
   números do jogo de verdade.

Por que não `LogProgressionEvent`: a referência da API diz que ele "does not currently display in any
Roblox-provided charts". A curva de nível virou um **funil** ("Levels"), que a página Funnels desenha.

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

- **Cada passo uma vez e em ordem:** o módulo só anda para a frente. Um passo alcançado antes do anterior sai
  sozinho (sobreviver à primeira noite sem matar ninguém manda o 5 e o painel conta o 4 como feito — é a ordem do
  próprio jogo). A ordem é a do jogo: a pergunta do tutorial vem **antes** de entrar na cidade (`survivor.ts`
  `enterCity`).
- **Segunda sessão de um jogador novo:** o que o save mostra que já aconteceu não é mandado de novo (entrou, matou);
  só o que for novo.
- **Pergunta respondida pelo painel:** onde o jogador novo desiste — no lobby, na pergunta do tutorial, antes do
  primeiro abate ou na primeira noite? É a curva que diz se o onboarding funciona (`docs/CREATOR_HUB.md`).

A escolha em si vai num evento custom, `TutorialChoice` (§5), porque a resposta às vezes chega ao servidor depois
da entrada (a janela de relatório do cliente é de 10 s) e o passo 2 não pode esperar por ela.

## 3. Economia (`LogEconomyEvent`, moeda `Coins`)

Uma moeda só, o `money` do save. Todo lugar onde o servidor muda `money` tem um evento, com o saldo **depois** da
mudança, como a API pede. Sessões que nunca serão gravadas (status `error` / `unavailable`) não mandam economia.

| Fluxo         | transactionType    | itemSKU          | Quando                                             | Onde                              |
| ------------- | ------------------ | ---------------- | -------------------------------------------------- | --------------------------------- |
| Source        | Onboarding         | Welcome gift     | o presente de 20 de um save novo                   | `loadSession`                     |
| Source        | Gameplay           | Day survived     | a meia-noite pagou o dia (3)                       | `progress.ts` `creditDaySurvived` |
| Source        | Gameplay           | Record milestone | o bônus de recorde em múltiplo de 5 (10)           | `progress.ts` `creditDaySurvived` |
| Source        | Gameplay           | Boss             | chefe abatido, para cada participante (8)          | `progress.ts` `creditBossKill`    |
| Sink          | Shop               | nome do pacote   | pacote comprado                                    | `main.server.ts` `handleAction`   |
| Sink          | Shop               | nome do traje    | traje comprado (MON-04)                            | `main.server.ts` `handleAction`   |
| Sink          | ContextualPurchase | Rebirth          | Rebirth pago; campo `Continue - 1/2/3/4+`          | `main.server.ts` `handleAction`   |
| Source / Sink | Admin              | Admin edit       | um admin mudou as moedas (para os saldos fecharem) | `main.server.ts` `adminEdit`      |

- Os tipos são os nomes do enum `AnalyticsEconomyTransactionType` (checados pelo tipo no código); "extra lives" é o
  exemplo da própria documentação de `ContextualPurchase`, e é exatamente o Rebirth. `Admin` é o único tipo nosso.
- Compra recusada (sem moedas, já possuído, pedido inválido) não gera evento; o preço é sempre o do catálogo.
- **Pergunta:** de onde vêm as moedas (dia, recorde, chefe) e para onde vão (qual pacote, qual traje, quanto em
  Rebirth)? O saldo médio sobe ou desce com o tempo? O Rebirth é o sumidouro dominante?

## 4. Funis de progressão (`LogFunnelStepEvent`)

### NightSurvival — um funil por **vida**

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

### Levels — funil único por jogador

Sem `funnelSessionId` (repetição ignorada pela plataforma). Passos nos níveis 1, 2, 3, 5, 10, 15, 20, 25, 30, 40,
50, 75 e 100. Cada sessão que entra na cidade manda o degrau atual uma vez e depois cada degrau novo; um nível posto
por admin não é mandado. **Pergunta:** quantos jogadores chegam a cada nível?

## 5. Eventos custom (`LogCustomEvent`) — todos agregados

| Evento         | Valor                   | Campos                                                                | Quando                                                                                                            | Pergunta                                                |
| -------------- | ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| TutorialChoice | —                       | `Choice - Accepted` / `Declined`                                      | a resposta chegou ao save do servidor (jogador novo)                                                              | quantos aceitam o tutorial?                             |
| Died           | dia da vida             | `Life day - …`; `Time - Night` / `Day`; `Survivors - Solo` / `Group`  | o servidor matou o sobrevivente (`life.ts` `died`)                                                                | onde e quando se morre; o grupo protege?                |
| LifeEnded      | dia que a vida alcançou | `End - New game` / `World end`; `Life day - …`; `Rebirths - 0/1/2/3+` | New game aceito, ou o mundo acabou (MP-22)                                                                        | quanto dura uma vida; quem paga Rebirth vai mais longe? |
| WorldEnded     | dias que o mundo durou  | `Reason - Timeout` / `Declined`; `Fallen - 1/2/3+`; `World day - …`   | uma vez por mundo, no primeiro sobrevivente conectado que caiu com ele (`worldLog.ts` guarda o registro completo) | quanto dura um mundo; solo desiste mais que grupo?      |
| TitleEarned    | —                       | `Title - Survivor` / `Horde Breaker` / `Week One`                     | o servidor concedeu o título (MON-05), uma vez por save                                                           | quantos ganham cada título por dia?                     |
| SessionKills   | golpes finais na sessão | `Kills - 0/1-9/10-49/50-199/200+`                                     | ao sair do servidor, se entrou na cidade                                                                          | quanto se luta por sessão                               |
| Crafted        | crafts na sessão        | `Kind - Crafted` / `Cooked` / `Smelted`                               | ao sair, se > 0 (decisão do servidor: `sim.onBackpack`)                                                           | cozinha e fundição são usadas?                          |
| ItemsUsed      | itens usados na sessão  | —                                                                     | ao sair, se > 0                                                                                                   | consumo por sessão                                      |

Buckets de dia: `1`, `2-3`, `4-7`, `8-14`, `15-29`, `30+` (os degraus da dificuldade, não um valor por dia).

Uma New game que nunca ficou de pé e é engolida por um fim de mundo não conta como segunda vida (no solo, New game
**é** a recusa que acaba o mundo: uma vida encerrada, `End - New game`).

## 6. Orçamento de taxa

- Limite: 120 + 20 × CCU por minuto; com 6 jogadores, **240/min**. O módulo se limita a 75 %: **180/min**.
- **Uma noite real no servidor de verdade** (`test:analytics` §2–3: 6 jogadores, 23:00 → 06:00, abates, meia-noite,
  títulos): 20 eventos a noite inteira; o minuto mais cheio do teste todo foi o das 6 entradas, com 42.
- **Uma hora pessimista de 6 jogadores** (§8: todos jogando a hora toda, 2 abates por segundo cada, morte e Rebirth
  toda noite, chefe toda noite, loja a cada 3 minutos, níveis subindo, um fim de mundo, duas reconexões): **427
  eventos/hora ≈ 7/min**; o minuto mais cheio (6 jogadores novos entrando ao mesmo tempo) tem **60 = 25 % do
  limite**. Nada esperou na fila.
- **Enxurrada** (§8: 6 jogadores ricos comprando 150 pacotes cada em 10 s, muito além do balde do ShopAction):
  nenhum minuto passa de 180, nada é descartado, cada moeda chega (900 compras viram 186 eventos somados).
- Por tipo, também longe dos tetos: 1 moeda (limite 5–10), 5 transactionTypes (20), ~25 SKUs (100), 3 funis (10),
  13 passos no maior (100), 8 nomes custom (100), 44 valores de campo no total (8 000).

## 7. O que o dono vê no Creator Hub, e quando

1. **Publicar** (o jogo precisa ser publicado; nada sai do Studio).
2. **Minutos depois:** Creator Hub → a experiência → **Analytics** → páginas **Economy**, **Funnels** e **Custom
   events**, botão **View Events**: lista quase em tempo real dos últimos eventos. É o jeito de conferir que está
   chegando (atualize a página).
3. **Em até ~24 h** (os eventos são agregados por dia): os gráficos aparecem.
    - **Economy:** fontes × sumidouros de `Coins` por transactionType e por SKU, saldo médio, com quebra pelos campos.
    - **Funnels:** a aba **Onboarding** (o funil embutido) e abas para **NightSurvival** e **Levels** (até 10 funis):
      conversão e abandono por passo.
    - **Custom events / Explore:** cada evento com contagem, usuários únicos, soma, média, mínimo, máximo e média por
      usuário do valor, fatiado pelos campos. Dá para montar um **Custom dashboard** com os que importam (Died por
      `Time`, LifeEnded médio por `Rebirths`, WorldEnded médio).
4. Retenção, engajamento e aquisição continuam vindo sozinhos, sem código.

## 8. Limites conhecidos (aceitos)

- **Resposta do tutorial** vem de uma flag de UX do cliente (regra 1). Pior caso: um cliente adulterado mexe no
  próprio funil.
- **Chave da vida** (`runRev − deathCount`) anda também num Rebirth gratuito (amanhecer que já passou no lobby) ou
  numa edição de admin: a mesma vida abre uma segunda sessão do funil. Raro; os passos repetidos continuam
  honestos (a vida passou mesmo por eles).
- **Vidas de antes do v5** começam com `lifeNights` 0: entram no NightSurvival do zero.
- **Vida encerrada longe do servidor** (caiu com o mundo, saiu durante a janela e voltou nos 5 min — a vida nova
  "devida" da MP-22) não gera LifeEnded: sem `Player` conectado não há como chamar a API.
- **Servidor que cai sem `BindToClose`** perde os resumos de sessão (SessionKills, Crafted, ItemsUsed) dele.
- Com MP_PHASE < 2 (moedas pagas pelo relatório) a economia não seria registrada; o jogo está no MP_PHASE 2, onde o
  relatório não paga nada.
- **Mochila no servidor** (branch F3 NET-1..6): `sim.onBackpack` já está ligado ao `Analytics.backpack`; o resultado
  novo `delivered` (pacote entregue) é ignorado, porque não mexe em moeda (a compra já foi o sumidouro).

## 9. Como adicionar um evento

1. A regra e o nome vão em `src/server/analytics/events.ts` (catálogo no topo, emissor na classe), nunca espalhados
   pelo servidor; no lugar da decisão, um gancho de uma linha (`Analytics.<gancho>(…)`).
2. Leia um número que o servidor decide. Nunca um por abate: agregue num ponto natural.
3. Campos: poucos valores fixos, com o nome da dimensão no texto ("Time - Night").
4. Uma seção ou um check em `tools/test-analytics.mjs`, e a linha na tabela certa deste documento.
