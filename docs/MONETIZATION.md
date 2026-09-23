# Monetização

## A regra

> **Se muda o que acontece numa noite, não se vende.**

Vende-se **identidade**, nunca **capacidade**. Essa frase decide sozinha quase todo caso futuro, e é a razão de
este documento existir: para que a decisão não seja retomada do zero toda vez que aparecer uma ideia de
receita.

O motivo não é só ético, é de projeto. O jogo é **co-op**, e a horda escala por grupo (S(k), §3.5). Um jogador
com vantagem comprada sai da curva de dificuldade que o amigo está vivendo, e o amigo — que não comprou nada e
não escolheu nada — vira passageiro na própria partida. Num jogo solo isso seria uma escolha discutível; aqui
quebra a experiência **de outra pessoa**.

## A restrição que define o catálogo: o que é visível a 32 px

Num jogo 2D visto de cima, o sobrevivente tem cerca de 32 px. Isso elimina metade do catálogo cosmético
habitual do Roblox antes de começar: **chapéu, roupa e acessório não se leem**. Detalhe não aparece; **cor e
silhueta aparecem**.

O que de fato é visível para os outros jogadores, hoje, no que já desenhamos:

| Canal | Onde já existe | Lê a 32 px? |
| --- | --- | --- |
| Cor do corpo | `survivorView.ts:131` — hoje uma constante única (`COLORS.player`) | **Sim**, imediatamente |
| Nameplate | `ui/nameplate.ts`, `view/allyPlate.ts` — nome e nível sobre a cabeça | **Sim**, é texto |
| Balão de fala | `view/chatBubbles.ts` | **Sim** |
| Rastro de golpe | `SwingTrail`, já em `playersView.ts:56` | Sim, em movimento |
| Cone de lanterna | luz noturna | Sim, à noite |
| Decoração de base | fogueira e construções persistem | Sim, e é vista por quem passa |
| Roupa, chapéu, acessório | — | **Não.** Não construir. |
| Traje (cor do torso inteiro + silhueta: aba larga, pompom) e pet ao lado (MON-04) | `view/survivorView.ts`, `view/cosmeticsView.ts` | **Sim** — desenhados para se ler pela cor e pela silhueta, não pelo detalhe |

## O que vender, em ordem

### 1. Servidor privado — comece por aqui

Assinatura mensal **nativa** do Roblox. Não exige código nenhum e é o melhor produto que este jogo tem, por
três motivos que se somam:

- é **conveniência pura**, sem nenhuma vantagem de jogo;
- você **já quer** isso para o "jogar sozinho ou com amigos" (MP-14) — é monetizar algo que já está no plano;
- servidor privado fica fora do matchmaking, então não divide a comunidade.

### 2. Passes cosméticos — um de cada vez

Compra única, em Robux, entregando **identidade visível**:

- **Paleta do sobrevivente** — a mudança mais barata de implementar e a mais visível de todas.
- **Cor do nameplate** e um pequeno ícone de apoiador.
- **Estilo do balão de fala.**
- **Cor da lanterna.**

Cada um é independente. Comece com a paleta, meça, e só então faça o segundo.

### 3. Assinatura — **ainda não**

A assinatura recorrente do Roblox é boa, mas ela promete **cadência**: quem assina espera algo novo todo mês.
Hoje não existe produção de cosmético para honrar isso, e assinatura que entrega o mesmo dois meses seguidos
gera reembolso e reclamação — sai mais caro que a receita.

Quando existir um acervo suficiente para rotacionar, a assinatura certa é: rotação cosmética + acesso a
servidor privado + brasão no nameplate. Nunca XP, nunca dano, nunca vida.

## O que nunca se vende

XP ou multiplicador de XP · dano · vida · velocidade · munição · itens de sobrevivência · reviver · espaço de
inventário · crafting mais rápido · sorte de saque · pular a noite.

O caso do **XP** merece nome próprio porque é o que sempre volta disfarçado de inofensivo. No nosso jogo XP
vira `skillPoint`, que compra: `Health increases`, `Melee damage`, `Speed increases`, `Accuracy improves`,
`Knockback increases`, `Quick reload`, `Head shooter`, `Poison immunity`, `Find more items`. Vender XP é
vender cada uma dessas linhas de uma vez.

## O que falta construir

Nada disso existe hoje: **não há uma única chamada de `MarketplaceService` no código**. A loja atual usa moeda
do jogo (`SHOP_PACKS`), e os pacotes têm conteúdo **fixo** — não são caixa aleatória, e devem continuar não
sendo.

Para o primeiro produto (paleta do sobrevivente):

1. `SurvivorLook` ganha uma paleta opcional; `survivorView.ts:131` deixa de usar só `COLORS.player`.
2. A paleta escolhida entra no snapshot, para que **os outros vejam** (é o ponto do produto).
3. O servidor valida a posse: `MarketplaceService:UserOwnsGamePassAsync`, com cache por sessão. Cliente nunca
   declara o que possui — é a mesma regra de todo o resto (§8).
4. O save guarda a escolha, não a posse: posse é do Roblox, escolha é nossa.

Tudo isso toca `server/main.server.ts` e `client/view/*`, que estão com a frente F2-2D neste momento. Entra
depois dela.
