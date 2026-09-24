# Creator Hub: o que configurar, e por quê

Decisões de configuração da experiência no Creator Hub, ancoradas no que o jogo **é**: **Last Town**, sobrevivência
zumbi co-op 2D top-down, servidor autoritativo, **6 jogadores** por servidor (MP-01), sem pay-to-win, ainda privado.

**Nomes de armazenamento: continuam "ProjectZ" — nunca renomeie.** O jogo se chamou **Project Z** até 2026-09-24
e os identificadores guardados nasceram com esse nome. Eles **ficam** assim, de propósito, mesmo com o jogo chamado
Last Town:

| O quê | Nome | Onde no código |
| --- | --- | --- |
| DataStores do jogador | `ProjectZ_Save_v2`, `ProjectZ_Save_v1`, `ProjectZ_Titles` (+ as cópias `_studio`) | `server/save/stores.ts` |
| DataStores do servidor | `ProjectZ_AdminLog`, `ProjectZ_Worlds`, `ProjectZ_PrivateTowns` (+ `_studio`) | `server/save/stores.ts` |
| MemoryStore (lista Servers) | `ProjectZ_Servers` | `server/match/serverList.ts` |
| RTBF e `cloud -- erase` | as mesmas chaves acima; os seis modelos de RTBF desta página | `tools/rtbf.mjs`, `tools/cloud.mjs` |
| Atributos entre servidor e cliente | `pz_*` (`pz_world_seed`, `pz_world_day`…, `pz_supporter`), `PZAdmin`, `PZTownNet`, `PZAdminNet` | `shared/net/*`, `shared/admin/*`, `shared/data/supporter.ts` |
| Analytics | nomes e campos dos eventos e funis, a config `pz_welcome_pack` | `server/analytics/events.ts`, `docs/ANALYTICS.md` |
| Teleporte | as chaves do TeleportData | `server/match/rules.ts` |

Trocar um DataStore é criar outro **vazio**: todo jogador perde o progresso (ou fica dividido entre dois stores), e
os modelos de RTBF e o `erase` passam a apagar o lugar errado. Trocar um atributo, um evento ou uma chave de
teleporte separa servidores e clientes de versões diferentes e quebra os painéis. O nome **do jogo** mora só em
`GAME_NAME` (`src/shared/module.ts`) e nos textos; nenhum desses identificadores o segue.

O que o Open Cloud consegue mudar está marcado `[api]` — o resto é mão no painel, e está dito onde e por quê.

---

## Já aplicado por API (verificado lendo de volta)

| Campo | Era | É | Por quê |
| --- | --- | --- | --- |
| `serverSize` | **50** | **6** | O host tem 6 vagas (`MAX_PLAYERS`). Com 50, do 7º jogador em diante a pessoa entra, fica no lobby e **nunca recebe corpo no mundo** — o servidor não tem slot. Era a configuração mais errada do painel. |
| `vrEnabled` | true | **false** | O jogo é desenhado em `ScreenGui` 2D. Em VR não há o que renderizar: o jogador entraria numa experiência quebrada. |

Estado atual confirmado: `ageRating AGE_RATING_13_PLUS`, `voiceChatEnabled false`, `visibility PRIVATE`,
desktop/mobile/tablet/console habilitados.

**A API aceita e ignora `displayName` e `description`** (responde 200, devolve o valor antigo e não mexe no
`updateTime`). Esses dois são obrigatoriamente manuais.

---

## Configure

### Settings — **faça antes de publicar**

- **Nome**: hoje é "Experiência sem título". O nome é **Last Town: Zombie Survival** (o jogo se chama **Last Town**;
  decisão do dono, 2026-09-24).
- **Descrição**: está vazia. O texto oficial está em `docs/promo/DESCRIPTION.md` (em inglês, como a página): a
  apresentação e, embaixo, **as regras e o recurso**, que a mensagem de ban aponta. Cole os dois juntos.

  A linha do pay-to-win (no bloco das regras) não é marketing: é a regra que já governa a loja, e dizê-la na página filtra a
  expectativa certa de quem entra. **As regras e o recurso são obrigatórios** (diretrizes de ban do Roblox:
  regras que todo usuário possa ler, e um jeito de recorrer ao criador): são o mesmo texto de
  `src/shared/data/rules.ts` (no jogo em How to play › Rules), e a mensagem de ban aponta para **esta página**,
  que é o único lugar que um jogador banido ainda consegue abrir. Troque `<link do grupo>` pelo link do grupo
  e ponha o mesmo grupo em **Social links**.
- **Classificação**: não se escolhe aqui — sai do questionário (abaixo, "Maturity & Compliance"). Com as
  respostas honestas o jogo fica **Moderate (13+)**: o sobrevivente derrubado rasteja sangrando (consequência
  realista = violência moderada) e há sangue de pixel a cada golpe, poças que secam num dia de jogo (ART-15) e
  manchas secas no mapa.
- **Gêneros**: Survival como principal; Action como secundário.
- **Dispositivos**: desktop, celular e tablet ligados (temos controles de toque medidos em 500 combinações de
  tela). **Console pode ficar ligado** — o suporte a gamepad existe e foi construído junto. VR desligado.

### Places — **feito**

`serverSize` = 6. Não mexa para cima sem mudar `MAX_PLAYERS` no código junto: os dois números **são o mesmo
número**, e se divergirem o sintoma é um jogador fantasma no lobby.

### Custom matchmaking — **só os dois atributos, sem sinal de dia por enquanto** (MP-25)

Fila continua fora: não há partida para enfileirar. Um jogador novo não pode cair num mundo público no dia 23
(`docs/MULTIPLAYER.md` §7.4): hoje quem o protege é a **oferta** de cidade própria no lobby, que o jogo faz sozinho.
O servidor público também publica dois números (`server/match/matchmaking.ts`, `MatchmakingService:SetServerAttribute`,
só quando mudam); sem o passo 1 o jogo funciona igual e o log avisa uma vez "the matchmaking attributes were refused".

1. **Matchmaking → atributos de servidor** (a página "Customize your matchmaking configuration"): crie
   `WorldDay` (número, padrão 1) e `Survivors` (número, padrão 0). Os nomes são os do código: não traduza.
2. **Não** crie um sinal "`WorldDay` contra a constante 1" (a primeira versão deste passo o pedia). Ele empurra
   **todo mundo** para as cidades jovens, inclusive o veterano de dia 30, que colheria XP e moedas nas noites fáceis
   do dia 2 (revisão de f25727a, M3). Se já criou, desligue.
3. **O sinal certo, quando existir o atributo de jogador:** o "numérico servidor × jogador que entra" da doc
   (`1 − min(|WorldDay − LifeDay| / maxRelevantDifference, 1)`; sugestão: `maxRelevantDifference` 10, peso 3), que põe
   cada um perto do **próprio** dia — o novato nas cidades jovens, o veterano nas velhas. Ele precisa de um **atributo
   de jogador** `LifeDay`, que o matchmaking lê de um data store por uma chave (`{UserId}`) e um caminho JSON; o nosso
   save guarda o `data` como texto dentro do documento, então o código precisa antes escrever um documento próprio
   (`{"lifeDay": N}`) — e essa chave entra nos modelos de RTBF e no `cloud erase`. É trabalho de código, não daqui:
   peça quando quiser.
4. Opcional: um sinal numérico de servidor com `Survivors` contra a constante 6, `maxRelevantDifference` 6, peso 1:
   a pontuação cresce com quem está de pé, e uma cidade onde todos estão mortos (que vai acabar, MP-22) pontua 0.
   Ligue só se o painel mostrar gente chegando em cidades à beira do fim.
5. **Prévia com servidores de mentira** (a própria página oferece) antes de ativar qualquer sinal.

### Server management — **Play solo feito; VIP é decisão sua**

O "jogar sozinho" que você pediu é o **Play solo** da tela Survivor: um servidor **reservado** pelo próprio jogo
(`TeleportService:ReserveServerAsync` + `TeleportAsync`), com as mesmas regras do público e a cidade no **dia da vida do
dono** (MP-13; um save novo: dia 1; `docs/MULTIPLAYER.md` §7.4, MP-25). Não precisa de configuração nenhuma aqui, e **só funciona no jogo publicado**: no
Studio a tela explica que não há teleporte. Teste numa experiência de teste separada (o roteiro está na §7.4). O
servidor privado (VIP) é independente e **decidido: grátis** (2026-09-24): Audience › **Access Settings** › ligue
**Allow private servers** e **desligue Requires Robux** › Save Changes; o jogo o reconhece sozinho
(`pz_server_kind = private`). O que **não** pode acontecer continua sendo o solo virar um modo pior que o co-op — MP-14.

### Permissions / Collaborators — **só você, por enquanto**

Cada colaborador com acesso de escrita pode publicar e ler DataStore. Adicione um por vez, quando houver
motivo, e prefira o papel mais fraco que resolva.

### Configs — **vale a pena, depois da F2**

Permite mudar número de balanceamento sem republicar. Os nossos candidatos naturais são os que já sabemos
que vão pedir ajuste: `SIM_HZ`, o alcance de visão dos zumbis, o teto da horda e o raio do chat. Fazer antes
da F2 fechar é ajustar um alvo em movimento. O gancho de código já existe (`src/server/config/experiments.ts`, a
chave `pz_welcome_pack`): uma config só faz algo quando o código a lê (`docs/ANALYTICS.md` §12).

### Experiments — **depois de ter jogadores**

Teste A/B sem base de jogadores não mede nada: a própria página avisa que com menos de 1.000 DAU é difícil ter dado
útil (MDE). O código já lê o knob por jogador e a inscrição acontece só quando o valor é usado; passo a passo e as três
propostas (pacote de boas-vindas, primeira noite mais leve, preço do Rebirth) em `docs/ANALYTICS.md` §12.

### Alerts — **ligue assim que tiver 100+ DAU**

Crash, memória, FPS, CCU e data store — é o que avisa que algo quebrou sem depender de alguém reclamar. A página não
oferece alerta de **taxa de erro** (só métricas de performance e de data store): erros se olham no Error Report depois
de cada publish. Precisa de um webhook (Configure → Webhooks). Lista com limites em `docs/ANALYTICS.md` §13.

### Secrets — **não precisamos**

O jogo não chama serviço externo nenhum. A nossa chave de Open Cloud vive no `.env` local, fora do jogo, e
**não** deve ser colocada aqui (a da CI, só de assets, vive nos secrets do GitHub: "Open Cloud na CI", abaixo).

### Webhooks — **opcional (depois dos modelos de RTBF)**

Um gatilho **Right to Erasure Request** (com segredo) avisa na hora de um pedido de exclusão, em vez de
esperar a mensagem diária da caixa de entrada. Não é bloqueante: os modelos de RTBF (abaixo) apagam sozinhos
o que cabe neles, e o resto sai com `npm run cloud -- erase <userId> --yes`.

### Data Stores manager — **RTBF: faça antes de publicar**

O Roblox manda **todo dia** para a caixa de entrada do Creator Hub a lista de pedidos de exclusão de dados
(direito ao esquecimento, RTBF), e quem responde por apagar é o criador. O caminho recomendado são os **modelos
de exclusão**: com eles, o Roblox apaga sozinho as chaves de quem pediu.

**Checklist — Configure → Data Stores Manager → RTBF → Create template** (uma linha por modelo):

| # | Tipo | Data store | Chave (`key pattern`) | Escopo |
| --- | --- | --- | --- | --- |
| 1 | Standard | `ProjectZ_Save_v2` | `{UserId}` | `global` |
| 2 | Standard | `ProjectZ_Save_v1` | `{UserId}` | `global` |
| 3 | Standard | `ProjectZ_Titles` | `{UserId}` | `global` |
| 4 | Standard | `ProjectZ_Save_v2_studio` | `{UserId}` | `global` |
| 5 | Standard | `ProjectZ_Save_v1_studio` | `{UserId}` | `global` |
| 6 | Standard | `ProjectZ_Titles_studio` | `{UserId}` | `global` |

- [ ] Escreva `{UserId}` exatamente assim (`{userId}` não vale) e confira a **amostra** de cada modelo: um UserId
      de teste deve virar a chave `12345` no escopo `global`.
- [ ] **Se o painel recusar a chave `{UserId}` sozinha**, não mude as chaves do jogo: use o comando abaixo para
      cada pedido da mensagem diária.
- [ ] `ProjectZ_AdminLog` **não tem modelo**: é um log com vários jogadores por chave (uma por servidor por dia,
      `log_AAAAMMDD_<job>`). Ele guarda só UserIds e texto filtrado (`server/admin/auditLog.ts`); para cada pedido,
      `npm run cloud -- erase <userId> --yes` tira as entradas sobre aquele jogador. **Limite:** o `erase` acha as
      entradas pelo UserId (o admin que agiu ou o jogador alvo). Um motivo de kick/ban ou um anúncio **filtrado**
      que cite alguém pelo nome, em palavras, continua lá: se um pedido citar isso, procure o nome no painel de
      admin (Server › Audit log) e apague a entrada à mão pelo Data Stores Manager.
- [ ] `ProjectZ_Worlds` não tem dado de jogador (semente, dias, JobId, uma contagem): fica de fora.
- [ ] `ProjectZ_PrivateTowns` também não (MP-26: a semente e o início da cidade de um servidor privado,
      com a chave = o `PrivateServerId`, sem UserId nem nome do dono): fica de fora.
- [ ] O **MemoryStore** `ProjectZ_Servers` (MP-26, a lista Servers do lobby) não é data store e não tem dado de
      jogador: a chave é o `JobId` do servidor e o valor, semente, dia, lotação e hora; cada entrada expira sozinha em
      90 s. Fica de fora do RTBF (e nada a apagar: some com o servidor).
- [ ] **Uma chave de Open Cloud só para isto:** crie uma chave com **apenas** as permissões de data store —
      ler, listar, atualizar e apagar **entradas** — para o universo do jogo, restrita ao seu IP, e ponha no `.env`
      como `ROBLOX_ERASE_API_KEY`. É separada da `ROBLOX_API_KEY` do `publish` / `upload-art`: a chave que apaga
      saves não publica o jogo, e a que publica não apaga saves. (Sem ela, o `erase` usa a `ROBLOX_API_KEY` e avisa.)
- [ ] **Uma vez, antes do primeiro pedido real:** com uma conta de teste sua (uma alt que jogou no Studio e no
      jogo publicado), rode `npm run cloud -- erase <UserId da alt> --yes` e confira no Data Stores Manager que as
      chaves sumiram — inclusive as `_studio` — e que o log de admin foi regravado. O teste em Node roda contra um
      Open Cloud falso; a forma exata das respostas reais (o `etag` numa gravação concorrente) só se confirma assim.
- [ ] **Para cada pedido da mensagem diária:**
      1. O jogador tem de estar **fora do jogo**. Se estiver online, **kick** pelo painel de admin (ou ban, se ele
         não deve voltar) e **espere 1 minuto**: ao sair, o servidor dele ainda grava o registro de títulos, o save e
         o log de admin (a cada 30 s) — rodar antes disso recria as chaves que o comando apaga.
      2. `npm run cloud -- erase <userId> --dry-run` mostra o plano (não lê chave nenhuma).
      3. `npm run cloud -- erase <userId> --yes` apaga, no PC, com o `.env`. Sem `--yes` ele só mostra o plano; um
         argumento a mais ou digitado errado (`--dryrun`, dois UserIds, um nome) recusa o comando inteiro. Se
         nenhuma das seis chaves existia, ele sai com erro: confira o UserId e o `ROBLOX_UNIVERSE_ID`.
      Apagar marca a chave como apagada; o Roblox remove as versões antigas em até 30 dias (o mesmo prazo dos
      modelos).

Cada gravação do save e do registro de títulos leva o UserId do dono (`UpdateAsync` devolve `[userId]`), então
o próprio Data Stores Manager mostra de quem é cada chave. O sufixo `_studio` (feito) separa os playtests do
Studio dos saves de produção.

### Publicar — **todo publish reinicia os servidores**

**A cada publish**, mude o save ou não, **publique e reinicie todos os servidores na hora**: Creator Hub → a
experiência → **Restart servers** (o antigo "Migrate to latest update"; basta "só os desatualizados", **sem**
bleed-off) ou **Shut down all servers**. Nunca "deixe esvaziar".

Por quê: um servidor antigo que continua no ar só conhece o que o código dele conhece. Quem jogou num servidor novo e
entra num antigo (pelo amigo, por um servidor privado, por um que ainda não esvaziou) tem o save reescrito sem o que
é novo: um campo novo some (no v7, os títulos novos e os contadores deles, no save **e** no `ProjectZ_Titles`), e
cada lista é cortada ao tamanho das tabelas **dele** — uma arma, um traje, um título ou uma conquista acrescentados
sem mudar o `SAVE_VERSION` se perdem, e a arma na mão com eles (revisão de b0174ed, M-1). Não é só um risco de
rollback. Do código deste PR em diante o servidor se defende (revisões de 97cd734, H1, e b0174ed, M-1): um servidor
que carrega um save de versão maior, ou da mesma versão com uma lista mais longa que a tabela dele, não escreve nada
daquele jogador e o manda entrar de novo ("This server is out of date. Rejoin to play."), e a lista de servidores do
lobby só mostra servidores do mesmo build (o filtro `pv` supõe exatamente este reinício). Mas o servidor que já está
no ar é o código **anterior**, e esse não sabe disso: só o reinício o tira do caminho. Detalhes:
`docs/MULTIPLAYER.md` §6.7b, `docs/DESIGN_RULES.md` MON-05 ("Save v7").

O outro lado da mesma proteção (revisão de b0174ed, L-3):

- **Rollback que desce o `SAVE_VERSION`:** todo mundo que jogou no build mais novo tem um save de versão maior que a
  do código de volta — e esse código o recusa: **cada entrada** dessas pessoas é um kick com "This server is out of
  date". Um rollback abaixo de um `SAVE_VERSION` já publicado só serve para o jogador que nunca entrou no build novo;
  um defeito num build que subiu a versão se corrige **para frente**, com outro publish.
- **No Studio:** o save de playtest fica no `ProjectZ_Save_v2_studio` (os `_studio` são separados dos de produção).
  Um playtest numa branch com `SAVE_VERSION` maior grava ali um save que a `main` recusa: o desenvolvedor passa a
  levar o kick no Studio da `main`. Para voltar, apague **só a chave de Studio** do seu UserId: no **Data Stores
  Manager** (Configure → Data Stores Manager → `ProjectZ_Save_v2_studio` → a chave do seu UserId → Delete; o próprio
  painel permite desfazer durante a espera), ou pela barra de comandos do Studio (View → Command Bar, com Game
  Settings → Security → Enable Studio Access to API Services ligado):
  `game:GetService("DataStoreService"):GetDataStore("ProjectZ_Save_v2_studio"):RemoveAsync("<seu UserId>")`.
  **Nunca** `npm run cloud -- erase`: ele apaga também as chaves **de produção** do jogador.

### Leaderboard — **depois da F2**

Recorde de dias sobrevividos, via `OrderedDataStore`. Depende do XP e do progresso já serem do servidor
(F2-2C), senão o ranking premia quem edita o cliente.

### Maturity & Compliance Questionnaire — **obrigatório, e declarando o sangue**

Sem o questionário completo e correto, o Roblox **restringe a experiência para todos**; declarar menos do que o
jogo mostra é o que gera moderação (declarar a mais não é punido). O jogo tem: sangue em pixel art a cada golpe
(vermelho vivo no sobrevivente, vermelho-escuro nos zumbis, LEG-02; só gotas, poças e respingos, nenhum pedaço ou
víscera), poças que secam e somem em um dia e meio de jogo (ART-15; sem a textura, 10 s), manchas de sangue seco
no mapa, o sobrevivente derrubado que
**rasteja sangrando** por 30 s (MP-03), zumbis que somem ao morrer, armas e hordas à noite.

**Checklist — Configure → Maturity & Compliance (Questionnaire):**

- [ ] **Violence:** Yes → intensidade **Moderate**. Os zumbis somem ao morrer (seria Mild), mas basta **um**
      momento de consequência realista, e o sobrevivente derrubado rastejando e sangrando imita um ferimento real.
- [ ] **Blood:** Yes → **Unrealistic** (pixelado: o Roblox chama de irrealista o sangue "pixelated or having a
      different color or shape") → **não** é "infrequent / fleeting" (a cada golpe, poças que duram um dia de jogo,
      manchas permanentes no mapa): o nível pesado do sangue irrealista.
- [ ] **Fear:** Yes → **Mild** (NPCs assustadores, música e batimento cardíaco, tensão das ondas à noite; nada de
      susto repentino nem conteúdo perturbador).
- [ ] **Crude humor:** No. **Romance:** No. **Alcohol:** No. **Strong language:** No (o chat é filtrado pelo
      Roblox; conteúdo de jogador não conta).
- [ ] **Gambling:** No. **Paid random items:** No (os pacotes da loja têm conteúdo fixo e declarado e custam
      moedas do jogo, não Robux — MON-03). **Paid item trading:** No.
- [ ] **Free-form user creation:** No (construir barricada/porta é peça pronta, sem texto nem desenho livre).
      **Social hangout:** No (é um jogo de sobrevivência).
- [ ] Rótulo esperado: **Moderate (13+)** — o mesmo `AGE_RATING_13_PLUS` que a API mostra hoje. Confira também
      o resultado de conformidade regional.
- [ ] Refaça o questionário quando o conteúdo mudar (ex.: Robux, anúncios, sangue realista).

---

## Analytics

**Ligue tudo.** Retention, Engagement, Acquisition e Demographics funcionam sozinhos. Economy, Funnels e Custom
events vêm das chamadas de `AnalyticsService` do servidor (`src/server/analytics/events.ts`): o catálogo, o
orçamento de taxa e o que aparece em cada página estão em `docs/ANALYTICS.md`. Só um jogo **publicado** manda
eventos (o Studio não); os gráficos levam ~24 h, e **View Events** mostra os eventos em minutos.

Os funis que valem, para este jogo especificamente:

1. **Entrou → apertou PLAY → sobreviveu à primeira noite.** É a curva que diz se o onboarding funciona (funil
   Onboarding).
2. **Primeira morte → jogou de novo.** Diz se morrer é frustrante ou convidativo (funil Rebirth e `SessionEnded`
   com `Where - Dead`).
3. **Jogou sozinho → jogou acompanhado.** Diz se o co-op está sendo descoberto (funil Night, breakdown `Survivors`).

O que configurar em cada página (funis, dashboard custom, regras do Error Report, alertas, experimentos) está na
checklist da §14 de `docs/ANALYTICS.md`.

---

## Monetization — **a aba onde a sua regra tem que virar decisão**

Você foi explícito: **não quero pay-to-win**. Isso se traduz assim:

| Item | Decisão |
| --- | --- |
| Passes / Developer products | **Só cosmético e conveniência.** Skin, roupa, cor de nameplate: sim. Arma, munição, dano, XP, vida: **não**. |
| Shop / Managed pricing | Não antes de publicar. |
| Subscriptions | **Uma, de apoio: "Last Town Supporter"** (MON-07, 2026-09-24). Só um coração no nome e o rastro do golpe na cor Supporter; nada que uma noite sinta, nenhum título. Passo a passo em "Assinatura Supporter", abaixo. |
| Ads | **Desligado** enquanto privado. Reavaliar só depois de o jogo estar bom. |
| Third-party avatar commissions | Pode ligar: é receita que não afeta equilíbrio nenhum. |

A regra prática para qualquer item futuro: **se dá vantagem numa noite, não se vende.**

### Trajes e pets por Robux

**A criar aqui:** os 9 produtos de desenvolvedor dos trajes e pets por Robux (49 / 149 / 349 R$, um por traje;
nome, preço exato, descrição e configurações em `docs/SHOP.md`, "Os produtos que o dono cria": **Unlisted**, **sem**
"Allow external purchases"), e depois colar os ids em `src/shared/data/robuxProducts.ts`. Sem id, nada é oferecido.
A tabela de todo produto, o modelo de horas de jogo por trás de cada preço e as decisões de Robux (2026-09-24:
servidor privado **grátis**) estão em `docs/SHOP.md`.

### Assinatura Supporter — **o código está pronto e escondido; faça isto para ligar**

O jogo já tem tudo (MON-07): o servidor pergunta ao Roblox quem assina (`server/supporter/supporter.ts`), marca o
jogador com o atributo `pz_supporter`, e a aba **Supporter** do guarda-roupa aparece com a oferta. Enquanto
`SUPPORTER_SUBSCRIPTION_ID` estiver vazio em `src/shared/data/supporter.ts`, nada disso liga.

1. **Creator Hub → a experiência → Monetization → Subscriptions → Create Subscription.** (Exige conta com e-mail
   verificado e 30+ dias, como qualquer venda em Robux; o Roblox pode pedir mais — siga o que o painel mostrar.)
2. **Imagem de capa:** o coração Supporter sobre o logo (512 × 512; pode partir do ícone em `docs/promo/icon/`).
3. **Nome** (único na experiência): `Last Town Supporter`.
4. **Descrição** (cole exatamente; diz tudo o que dá e o que não dá, como pedem as diretrizes do Roblox):

   > Support Last Town and wear it. While your subscription is active: a heart beside your name on your nameplate,
   > for everyone to see, and your melee swing trail in the Supporter rose. That's all it does: no coins, no XP, no
   > items, no titles and nothing that changes a night. Titles are always earned by playing. Renews monthly until you
   > cancel; cancel any time in your Roblox settings.

5. **Pagamento:** *Subscribers pay Robux*, **99 Robux/mês** (o mínimo é 49; o Regional Pricing vem ligado e não se
   desliga). **Tipo de produto:** *Durable* (um benefício que dura enquanto a assinatura dura; nada consumível, nenhuma
   moeda). Salve.
6. **Copie o id** da assinatura (começa com `EXP-`) e cole em `src/shared/data/supporter.ts`:
   `export const SUPPORTER_SUBSCRIPTION_ID = "EXP-...";` — depois `npm run build`, `npm run test:titles` e um PR
   (ou peça à sessão da nuvem para colar e abrir o PR).
7. **Teste no jogo publicado** (o `GetUserSubscriptionStatusAsync` e o prompt só funcionam de verdade publicado): abra
   o guarda-roupa → Supporter → See price; assine com uma conta de teste; o coração aparece em até ~10 s (o servidor
   pergunta de novo depois do prompt) e a página diz ACTIVE. Cancele: ao fim do período o coração some (o servidor
   pergunta a cada 10 min e a cada mudança de status).
8. **Números:** Monetization → Subscriptions → Analytics (assinantes, receita, cancelamentos). O jogo só manda o
   evento custom `Supporter` (quem assinou ou venceu **durante** uma sessão, `docs/ANALYTICS.md` §5).

Não há DataStore novo nem modelo de RTBF a criar: o status é do Roblox e fica só na memória do servidor.

---

## Monitoring — **liga depois de publicar, e economiza Studio**

Performance, Error report, Crashes, Memory Stores, Data Stores, HTTP e Messaging Service. Isto responde em
produção parte do que hoje só o Studio responde — especialmente **Error report** e **Crashes**, que capturam
exatamente a classe de erro que os testes em Node não veem (limite de registradores do Luau, asset que não
carrega, remote que estoura). Vale conferir aqui **depois de cada publicação**. O Error Report agrupa por
mensagem: os avisos do jogo são frases fixas (ids e contagens vão para o log), e as regras sugeridas estão na §14 de
`docs/ANALYTICS.md`.

---

## Audience

- **Access settings**: mantenha **privado** até a F2 fechar e o teste de 2 clientes passar. Publicar um jogo
  em que dois jogadores veem hordas diferentes queima a primeira impressão, que não volta.
- **Communication settings**: o chat já está no `TextChatService` (trocado do legado). O nosso chat é **por
  proximidade**, filtrado no servidor (MP-17), **sem sussurro** (o `/whisper` do Roblox fica desligado pelo
  jogo) e sem barra de digitar no lobby, onde ninguém ouve (MP-18). Voz continua desligada: não está no design
  e adiciona superfície de moderação.
- **Localization**: os textos do jogo passam por `src/shared/data/lang.ts`. O original tinha coreano; hoje
  respondemos em inglês. Traduzir é barato e amplia alcance, mas só depois que os textos pararem de mudar.
  A **Automatic Text Capture** pode ser ligada: todo rótulo que mostra nome de jogador ou texto digitado (placar,
  palco do lobby, aviso do admin, painel de admin) tem `AutoLocalize` desligado, então nenhum nome vai parar na
  tabela de tradução.

---

## Engagement

- **Badges**: valem, e são baratos. Os que fazem sentido aqui: sobreviver à primeira noite, ao dia 5, ao dia
  10; matar o primeiro chefe; reviver um companheiro. **Nenhum badge por compra.**
- **Social links / Events & updates / Notifications**: só quando houver comunidade para avisar.
- **Referral rewards**: não antes de o jogo estar bom. Convite para um jogo inacabado gasta a boa vontade de
  quem convidou.

---

## Safety

- **Moderation**: acompanhe depois de publicar. O chat por proximidade já entrega **texto filtrado pelo
  Roblox** (MP-19) — nunca desenhamos texto cru de jogador.
- **Collaborators**: vazio é o certo hoje.

---

## Moderação e bans

- **`Players.BanningEnabled`** liga o `BanAsync` / `UnbanAsync` / `GetBanHistoryAsync` do painel de admin e não
  pode ser mudado por script. Ele agora vai **fixo** no `default.project.json`, então todo `rojo build` (o place
  da CI e o `npm run cloud -- publish`) o leva ligado; a CI confere o `.rbxlx` que o Rojo escreveu
  (`npm run check:place`), e o `publish` se recusa a subir sem ele. Depois do próximo publish, abra o painel de
  admin e peça o **Ban history** de um UserId qualquer: deve responder sem "Ban API failed".
- A mensagem de ban diz o motivo **filtrado** e aponta para as regras e o recurso na página da experiência.
- O log do painel guarda só UserIds e texto filtrado, numa chave por servidor por dia (`server/admin/auditLog.ts`).
- Os bans podem ser revistos em Creator Hub → **Moderation → Bans**.

---

## Open Cloud na CI — **faça uma vez** (a arte e o áudio sobem sozinhos)

Com isto, cada push na `main` sobe as texturas novas ou alteradas, espera a moderação, commita os ids na `main` e o
`LastTown-ci.rbxl` do **mesmo** run já sai com eles (`.github/workflows/ci.yml`, job `assets`; como funciona:
`CLAUDE.md`, "Arte (e áudio) da cidade no jogo"). Sem isto a CI só avisa ("upload pulado") e segue verde; o
`npm run cloud -- upload-art` do PC continua funcionando como antes.

1. **Uma chave só para assets.** Creator Hub → **Open Cloud → API Keys → Create API Key**
   (`create.roblox.com/dashboard/credentials`):
    - Nome: `last-town-ci-assets` (uma chave criada antes como `project-z-ci-assets` serve igual: o nome é só um rótulo).
    - **Access Permissions**: adicione só a API **Assets**, operações **Read** e **Write** (`asset:read` +
      `asset:write`). Nada de data store, de publish, de universo: esta chave vai morar fora do seu PC.
    - **Security → Accepted IP Addresses**: `0.0.0.0/0`. Os runners do GitHub não têm IP fixo (os intervalos
      publicados mudam e cobrem milhares de endereços), então esta chave não dá para travar por IP como a do `.env`.
    - **Expiration**: 90 dias (ver o item 4).
    - Copie a chave: ela só aparece uma vez. Não cole em chat, issue, commit nem no `.env` do PC (lá fica a outra).
2. **Os secrets do repositório.** GitHub → `devconnecting1/project-z` → **Settings → Secrets and variables →
   Actions → New repository secret**:
    - `ROBLOX_API_KEY` = a chave do item 1.
    - `ROBLOX_CREATOR_USER_ID` = o seu UserId (o número de `roblox.com/users/<id>/profile`). Se a experiência for de
      um grupo, crie `ROBLOX_CREATOR_GROUP_ID` com o id do grupo no lugar dele.
3. **Forçar um run** (para subir agora o que falta, sem esperar um push): GitHub → **Actions → CI → Run
   workflow** → branch `main` → **Run workflow**. No run, o job `assets` mostra no **Summary** a tabela de cada
   arquivo (aprovado / em análise / recusado / falhou); o `LastTown-ci.rbxl` está no artefato **place** do mesmo run.
   Um commit `art: asset ids uploaded by CI run … [skip ci]` de `github-actions[bot]` aparece na `main`: é
   esperado (`git pull` no PC antes de mexer). A caixa **`reupload_all`** do mesmo botão (desligada por padrão)
   reenvia **tudo** como o criador dos secrets, mesmo o que já é dele; para uma troca de conta ela **não** é
   necessária (abaixo).
4. **Trocar a chave** (a cada 90 dias, ou na hora se ela vazar): crie outra igual ao item 1, cole por cima do secret
   `ROBLOX_API_KEY` (**Update secret**) e revogue a antiga em Credentials.

Se um dia a `main` ganhar proteção de branch (ou um ruleset), libere o `github-actions[bot]` para dar push nela; sem
isso o commit dos ids é recusado e o job `assets` falha dizendo isso.

### Mudou de conta: o que acontece

Cada id em `design/world-art/assets.json` e `design/audio/assets.json` guarda **quem o subiu** (`creator`:
`"user:<id>"` ou `"group:<id>"`; é o número público do perfil ou do grupo, não é segredo). Os ids de antes de
2026-09-24 não têm `creator`: foram subidos pela conta antiga.

1. Troque os secrets `ROBLOX_API_KEY` (a chave da conta **nova**, como no item 1 acima) e `ROBLOX_CREATOR_USER_ID`
   (o UserId novo); se a experiência for de um grupo, `ROBLOX_CREATOR_GROUP_ID` (ele vence o de usuário). A chave
   tem de ser de quem é o criador: a de um usuário só sobe como ele, ou como um grupo em que ele pode criar assets.
2. **A experiência tem de ser da conta nova (ou do grupo novo).** O áudio subido pela conta nova é privado dela:
   uma experiência que ainda é da conta antiga não o toca (é a mesma regra, ao contrário).
3. Faça push na `main` ou **Actions → CI → Run workflow** na `main` (sem marcar nada). O job `assets` compara o
   criador dos secrets com o de cada id e **reenvia como a conta nova todo id de outro criador** (ou sem criador):
   hoje, as 135 texturas e os 5 bancos de som. Valem as regras de sempre: só id **aprovado** entra; em análise
   depois da espera → `pending` (consultado no próximo run, nunca reenviado); recusado → `rejected` (não reenvia os
   mesmos bytes; o run fica vermelho); falhou → o próximo run tenta de novo.
4. **Até o novo ser aprovado.** Um arquivo que falhou, foi recusado ou segue em análise continua com o id da conta
   antiga no `assets.json`. No jogo: a **textura** fica com o id antigo (uma imagem pode ser Open Use, então pode
   seguir aparecendo); o **banco de som** fica **sem id** no `audioAssets.ts` — o `assets.json` grava `owner` (a
   conta dos secrets) e o `tools/gen-sfx.mjs` deixa de fora todo banco de outro criador, porque o id antigo tocaria
   silêncio numa experiência da conta nova e sem id cada som toca a biblioteca (SND-01). O Summary conta "N ainda
   com o id de outro criador" e o run avisa (`::warning`) até o último ser trocado. Aprovado, o id novo entra no
   mesmo commit do bot.
5. O job tem 60 minutos: ~140 uploads (700 ms entre um e outro, abaixo do limite de 120 por minuto) e até
   10 minutos de moderação na arte e mais 10 no áudio. O que passar disso fica `pending` para o próximo run.
6. No PC, `npm run cloud -- upload-art` / `upload-audio` **não** troca ids de conta sozinho nem muda o `owner`: só
   avisa quando o `.env` é de outro criador que os ids (ou que o `owner`: um banco subido daqui não entraria no
   `audioAssets.ts`). Com o `.env` da conta nova, `-- upload-art --reupload-all` (e
   `upload-audio --reupload-all`) reenvia tudo como ela; depois `npm run build` e commit dos mesmos arquivos. Se o
   `.env` do PC ainda for da conta antiga, troque a chave e o `ROBLOX_CREATOR_USER_ID` lá também.

A alternativa sem reenvio (não usada: o dono decidiu subir tudo na conta nova em 2026-09-24): a conta **antiga**
dá à experiência nova a permissão de uso de cada asset (Creator Hub → o asset → **Permissions** → o Universe ID da
experiência; ou `PATCH /asset-permissions-api/v1/assets/permissions` com uma chave da conta antiga). Funciona, mas
deixa o jogo dependendo de uma conta que não se usa mais, e uma permissão dada a um jogo não se revoga depois.

O que a documentação do Roblox diz (Context7 `/websites/create_roblox` e as próprias páginas, lidas em 2026-09-24):

- **Áudio é privado de quem sobe.** `create.roblox.com/docs/audio/assets` ("Import audio"): "Although you are
  initially the only one who can view and use private audio assets, the asset privacy system lets you grant usage
  permissions to specific friends and experiences." Um áudio da conta antiga só toca numa experiência da conta
  nova se a antiga der a permissão: por isso os bancos de som **precisam** subir de novo.
- **Imagens, decals e meshes nascem "Open Use", salvo o Asset Privacy.** `create.roblox.com/docs/projects/assets/privacy`:
  "By default, Images, Decals, and Meshes are created as Open Use" (qualquer criador ou jogo usa), mas se a conta
  ligou **Settings → Advanced → Asset Privacy**, as novas nascem **Restricted**, e "If a creator or game doesn't have
  permission to use an asset, it cannot load". Audio, Video, Models, Animations e Packages "have their own creation
  defaults and are not changed by the Asset Privacy setting". Não dá para saber daqui se a conta antiga ligou essa
  opção, e uma conta abandonada (ou moderada) leva os assets dela junto: por isso as texturas sobem de novo também.
- **Permissões** (mesma página): dar uso a outro criador exige amizade na plataforma (usuário) ou o direito "Edit
  all group experiences" (grupo); a um jogo, pelo Universe ID; "Once a game has permission to use a restricted
  asset, you cannot revoke access". Na API: `creationContext.assetPrivacy` (`default` / `restricted` / `openUse`)
  no upload, e `PATCH /asset-permissions-api/v1/assets/permissions` (ação `Use`, válida para áudio e animação) para
  dar uso a um usuário, grupo ou universo.
- **Cota de áudio** (`audio/assets`): 100 áudios grátis por 30 dias sem verificação de ID, 2.000 com ela, por
  conta: os 5 bancos cabem com folga.

**O risco do `0.0.0.0/0`, e por que é aceitável aqui.** Quem tiver o texto da chave consegue usá-la de qualquer
lugar. O estrago possível é o do escopo: **criar e atualizar assets em seu nome** (subir imagens ou áudio, ou uma
versão nova de uma textura nossa), o que pode render moderação na conta. Ela não alcança save de jogador, publish do
place nem configuração da experiência. As mitigações:

- **Escopo só Assets.** A chave do `.env` do PC (travada por IP) e a `ROBLOX_ERASE_API_KEY` continuam separadas.
- **Só nos secrets do repositório.** O job `assets` roda só na `main` (push ou Run workflow), nunca em pull request:
  fork não recebe secret. Só os dois passos de upload recebem a chave; ela é mascarada no log (`::add-mask::`) e o
  `cloud.mjs` a apaga de qualquer resposta de erro. O repositório é **público** (os logs também): por isso nada
  disso é opcional.
- **Nada estranho perto dela.** O job instala as dependências sem scripts de instalação e confere que as ferramentas
  são as do commit (`node tools/assets-ci.mjs untouched`) antes de a chave entrar.
- **Rotação.** Expira em 90 dias; se aparecer em qualquer log, chat ou commit, revogue na hora (item 4).

O que foi conferido na documentação do Roblox (Context7, `/websites/create_roblox`, 2026-09-24):

- **Assets API** (`create.roblox.com/docs/cloud/reference/features/assets` e `…/cloud/guides/usage-assets`):
  autenticação pelo header `x-api-key` (ou OAuth `Authorization: Bearer`); `POST /assets/v1/assets` (form multipart
  com `request` + `fileContent`; `asset:read` + `asset:write`; 120 por minuto) devolve uma **Operation**
  (`path: "operations/{id}"`, `done`, `error`, `response`); `GET /assets/v1/operations/{operationId}` (`asset:read`,
  300 por minuto) até `done: true`, com o asset (e o `assetId`) em `response`. O asset traz
  `moderationResult.moderationState`: a referência descreve `Reviewing`, `Rejected` e `Approved`, e o `cloud.mjs`
  sempre leu a forma `MODERATION_STATE_*`: ele aceita as duas, e qualquer outra conta como "em análise".
  `GET /assets/v1/assets/{assetId}` (120 por minuto) e `…/versions/{n}` releem a moderação de quem ficou pendente.
  A doc avisa que a moderação pode demorar (fala em até 24 h ao publicar itens de avatar): por isso o `pending`.
- **API keys** (`create.roblox.com/docs/cloud/auth/api-keys`): restrição por IP em CIDR, data de expiração, "never
  … committing it to public repositories", uma chave por aplicação e o menor escopo possível.

---

## Resumo do que depende de você

1. **Nome e descrição** em Settings (a API ignora esses dois): "Last Town: Zombie Survival" e o texto de
   `docs/promo/DESCRIPTION.md`, **com as regras e o recurso** e o link do grupo; as thumbnails e o ícone de `docs/promo/`.
2. **Maturity & Compliance Questionnaire**: responder como na checklist acima (Moderate, sangue irrealista
   frequente, medo leve).
3. **RTBF**: criar os seis modelos do Data Stores Manager e a chave `ROBLOX_ERASE_API_KEY` (só data store); testar
   o `erase` uma vez com uma alt; para cada pedido da mensagem diária, jogador fora do jogo e `npm run cloud --
   erase <userId> --yes`.
4. **Server management**: decidir como será o "jogar sozinho".
5. **Alerts**: ligar assim que tiver 100+ DAU (lista na §13 de `docs/ANALYTICS.md`).
6. **Access settings**: manter privado até a F2 fechar.
7. **Todo publish**: publicar e logo **Restart servers** ou **Shut down all servers** (seção "Publicar"). Depois do
   próximo publish: conferir o **Ban history** no painel de admin (bans ligados).
8. **Open Cloud na CI**: a chave só de Assets (IP `0.0.0.0/0`, 90 dias) e os secrets `ROBLOX_API_KEY` +
   `ROBLOX_CREATOR_USER_ID` no GitHub; depois Actions → CI → Run workflow na `main` (seção acima). Trocou de conta:
   a experiência na conta nova, os dois secrets novos e Run workflow; a CI reenvia tudo como a conta nova
   ("Mudou de conta").
9. **Private servers: Free** — Audience › Access Settings › Allow private servers ligado, Requires Robux desligado
   (decisão de 2026-09-24). **Monetization › Developer Products:** criar os 9 produtos de `docs/SHOP.md` ("Os
   produtos que o dono cria": preço exato, Unlisted, sem "Allow external purchases"), colar os ids em
   `src/shared/data/robuxProducts.ts`, `npm run build` e commit; refazer o questionário (Paid random items: No).
10. **Assinatura Supporter** (quando quiser ligar): criar em Monetization → Subscriptions com o nome, a descrição e o
    preço da seção "Assinatura Supporter" e colar o id `EXP-…` em `src/shared/data/supporter.ts`.
