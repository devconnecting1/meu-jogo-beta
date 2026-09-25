# Last Town — o que está na fila

Lista viva do que o dono pediu e ainda não foi feito, em ordem de prioridade. **Toda sessão lê esta página antes de
começar**, e quem terminar um item o tira daqui no mesmo PR (e registra a regra nova em `docs/DESIGN_RULES.md`).
Criada em 2026-09-25, antes de uma pausa de 2–4 dias do dono; tudo o que foi feito até ali já está na `main` (#48–#57).

## 1. A partida por servidor (pedido do dono, 2026-09-24)

O servidor público vira **uma partida**: a cidade nasce, os sobreviventes vivem nela e ela cai. Decisões já tomadas:

- **Desistir é permanente naquele servidor.** Quem desiste não volta a jogar nessa cidade (não há "New game" em
  servidor público; o New game continua no Play solo / cidade própria, MP-25).
- **Modo espectador** para quem morreu ou desistiu: seguir os outros sobreviventes (trocar de alvo), ou sair quando
  quiser. Na tela: as estatísticas da partida (o placar da MP-23) e um contador simplificado de "a cidade cai em …".
- **Servidor fechado para novatos depois do dia 5** (decisão do orquestrador): a entrada pela lista Servers, por
  matchmaking e por amigo recusa quem não tem corpo nessa cidade a partir do dia 5 do mundo. Quem já tinha corpo
  nela continua podendo voltar.
- **A cidade que cai vira cidade nova** (MP-22 já faz o reset; revisar o fluxo com o espectador e a desistência).
- Mexe em: `server/match/*`, `server/main.server.ts` (corpo, vida), `client/ui/death*`, a lista de servidores
  (MP-26), analytics (o funil). Merge grande: revisão independente de correção e de segurança.

## 2. Multiplayer de 6 sobreviventes espalhados (análise pedida pelo dono, 2026-09-25)

O desenho já existe (`docs/MULTIPLAYER.md` §3.2–§3.5: aglomerados, S(k), inimigos por aglomerado, teto de 150
zumbis, LOD da IA, interesse por jogador), mas **nunca foi medido com os 6 longe uns dos outros**. A fazer:

- **Medir** com o servidor real (`test:server-sim`, `test:ai`, `test:waves`, `test:replication`): 6 sobreviventes
  em 6 bairros, de dia e numa noite com onda — CPU por tick (p95 ≤ 6 ms), o flow field (o pior caso previsto é
  ~1,3 Hz interpretado), banda por cliente, e quantos zumbis cada um enfrenta.
- **Achado provável (verificar):** 6 aglomerados de 1 pedem 6 × 40 = 240 comuns, mas o teto do servidor é 150. Hoje
  o isolado num servidor cheio pode enfrentar **menos** que o solo (~25 em vez de 40) — a promessa do §3.5 ("o
  jogador isolado enfrenta exatamente o solo") quebra. Opções: dividir o teto de forma justa por aglomerado com
  piso, subir o teto com LOD mais agressivo nos anéis longe, ou os dois. Decidir pelos números.
- **Inimigos para cada um:** ondas por aglomerado (já no desenho), especiais e chefes perto de quem está longe do
  grupo, e nenhum spawn na tela de ninguém (já existe, §3.5). Conferir que o grupo junto não "puxa" a horda do
  isolado.
- **Cooperação a distância:** o que ajuda quem está longe — marcar ponto no mapa, ping, ver no minimapa/placar onde
  está cada um, pedir socorro quando cai. Propor e perguntar ao dono antes de implementar.

## 3. A rua conta história (restos do pedido de 2026-09-24)

- **Engarrafamento nas saídas da cidade** (carros batidos em fila, portas abertas, malas no chão).
- **Casa queimada** (paredes escuras, telhado aberto, cinzas; interior com pouco loot).
- **Bloqueio militar** (barreiras, sacos de areia, tenda, veículo militar parado — cenário, não pilotável; loot de
  munição raro).
- Sangue nas ruas já existe (ART-15); tudo pelas regras `[auto]` da bíblia e pelo `world-sweep`.

## 4. Mapa 1,5× maior

Mais bairros, não ruas mais largas (ESC-01). Custo a medir: geração em fatias (`test:cache`), memória, flow field,
banda, o voo do lobby e o `world-sweep`. Rever as distâncias de chefes, postos e ondas.

## 5. Aviso antes do ataque dos chefes

Um sinal legível antes de cada golpe grande (a pose de preparação, uma marca no chão, som), para a morte por chefe
ser justa. Por chefe, na pixel art dele (ART-14), com Reduzir Movimento respeitado.

## 6. Mais veículos (pedido do dono, 2026-09-25) — recomendações

Hoje se pilotam a **bicicleta** e a **moto** (VEI-05); os carros da cidade são cenário (VEI-01..04). A proposta, na
ordem em que eu faria (cada um só entra se fizer sentido no jogo, não só na lista):

| Veículo                       | De onde vem                                                           | Para que serve (o motivo de existir)                                                               | Regras                                                                                      |
| ----------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Carro comum** (hatch/sedan) | um carro estacionado da própria rua, com a **chave** achada nas casas | mais rápido e mais protegido que a moto; **2 lugares** (motorista + 1 no co-op)                    | gasta Oil, faz barulho (a tabela da IA-02), bate, amassa, não passa por destroços nem becos |
| **Van**                       | estacionamentos, oficina                                              | **porta-malas compartilhado** (logística do grupo: levar material de construção), 3 lugares, lenta | a mais barulhenta dos carros; não entra em rua estreita                                     |
| **Picape**                    | oficina, casas grandes                                                | **empurra destroços** devagar (abre o engarrafamento das saídas, item 3), caçamba carrega um kit   | para-choque que aguenta mais batida                                                         |
| **Ambulância**                | hospital (rara)                                                       | a **sirene atrai a horda** (isca tática para tirar zumbis de um lugar) e leva kits médicos         | a sirene é o ruído mais alto da tabela; liga/desliga                                        |
| **Viatura**                   | delegacia (rara)                                                      | sirene como a ambulância; o porta-malas tem munição                                                | mesma regra de ruído                                                                        |
| **Caminhão** (baú/lixo)       | depósitos, saída da cidade                                            | **barricada móvel**: estacionar para fechar uma rua na noite (defesa em grupo)                     | muito lento, não cabe em beco; não é carro de fuga                                          |

**Não recomendo:** tanque, helicóptero, avião ou barco — quebram a escala da cidade (ESC-01), acabam com a tensão
da noite e não cabem na tela top-down. **Moto e bicicleta continuam** (silêncio e agilidade são a troca).

Para todos: pixel art na escala da ESC-01 (e o carro pilotável parece o estacionado), o servidor é o dono de quem
está em qual lugar (MP-00 / VEI-05: todos veem quem dirige e quem vai de carona), farol pela LUZ-04, som pelo
SND, combustível pelo ELE-02, zumbi que alcança o carro bate nele. Começar pelo **carro comum** e medir antes de
seguir para os outros.
