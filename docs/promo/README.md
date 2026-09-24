# LAST TOWN — arte da página do jogo no Roblox

Tudo nesta pasta é gerado por `npm run promo` (`tools/render-promo.mjs`) com o **código real do jogo**: a cidade de `generateTown(seed)`, desenhada por `worldView.ts` com a pixel art de `design/world-art/` (as 134 texturas já têm id aprovado no `assets.json` e o sha1 de cada PNG confere com o que subiu: é o que o jogo mostra hoje), a horda por `actorsView.drawZombies`, os sobreviventes por `survivorView.drawSurvivor`, o chefe por `bossView.drawBoss`, as máquinas por `machinesView.ts`, as marcas de estado (ponto azul, `?` dourado, `!` vermelho) por `zombieAwareness.ts`, e a noite pelo `LightMap` com a escuridão do relógio e as luzes que o `gameLoop.drawLight` empurra. Nada é desenhado à mão: só o enquadramento, o instante e a faixa do título.

Determinístico: a mesma semente dá os mesmos bytes (`npm run promo` duas vezes = arquivos idênticos).

O **texto** da página (o nome "Last Town: Zombie Survival", a descrição com as regras e o recurso, e o About do
repositório no GitHub) está em [`DESCRIPTION.md`](DESCRIPTION.md). No jogo, o título do lobby e o splash usam o mesmo
desenho do wordmark como a textura `wordmark` do `npm run art:world` (`client/ui/logo.ts`), que a CI sobe com a cidade.

## Arquivos

| Arquivo                                                         | Tamanho     | Onde vai                                                                                                                                             |
| --------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thumbnails/01-survive-the-night.png`                           | 1920 × 1080 | Thumbnails (Home Page e Experience Detail Page) — o primeiro                                                                                         |
| `thumbnails/02-build-barricade-hold.png`                        | 1920 × 1080 | Thumbnails                                                                                                                                           |
| `thumbnails/03-loot-the-gun-shop.png`                           | 1920 × 1080 | Thumbnails                                                                                                                                           |
| `thumbnails/04-defeat-the-bosses.png`                           | 1920 × 1080 | Thumbnails                                                                                                                                           |
| `thumbnails/05-new-town-every-world.png`                        | 1920 × 1080 | Thumbnails                                                                                                                                           |
| `icon/icon.png`                                                 | 512 × 512   | Icon (é a variante `icon-c-horde`)                                                                                                                   |
| `icon/icon-a-shot.png`, `icon-b-walker.png`, `icon-c-horde.png` | 512 × 512   | as três variantes, para comparar ou testar                                                                                                           |
| `logo/last-town-logo.png`                                       | 1032 × 234  | logo com "ZOMBIE SURVIVAL", fundo transparente (lobby, splash)                                                                                       |
| `logo/last-town-logo-stacked.png`                               | 756 × 390   | o mesmo empilhado (telas quadradas, créditos)                                                                                                        |
| `logo/last-town-wordmark.png`                                   | 516 × 78    | só o nome, pequeno (cantos, placas)                                                                                                                  |
| `previews/*.png`                                                | —           | não sobe: cada thumbnail a 480 × 270 e 256 × 144, cada ícone a 256, 150, redondo e 50, e os logos no escuro e no claro — como o site e o app mostram |

Todos PNG, abaixo de 1 MB cada (o limite do upload de thumbnails da Home Page é 3 MB).

## Como subir (Creator Dashboard)

**Thumbnails** — [Creator Dashboard](https://create.roblox.com/dashboard/creations) → o jogo → **Configure › Places** → o place inicial → **Thumbnails** no menu da esquerda:

1. Aba **Experience Detail Page**: suba os cinco (até 10 são aceitos), na ordem 01 → 05, e preencha o **alt text** de cada um (acessibilidade; sugestões abaixo).
2. Aba **Home Page**: **Edit active thumbnails** → **Upload thumbnails** (ou marque **Active** nos já enviados) → ative de 2 a 5 → **Save changes** → **Start**. É a _thumbnail personalization_: o Roblox mostra a cada jogador a que funciona melhor para ele. A documentação pede para deixar várias ativas, não escolher uma vencedora.

**Ícone** — Creator Dashboard → o jogo → **Configure › Places** → o place inicial (marcado com a estrela) → **Icon** → Media type **Image** → **Change** → `icon/icon.png` → **Save Changes**.

Imagens passam pela moderação antes de aparecer para os outros.

Alt text sugerido (em inglês, como a página):

- 01: "Night street: a survivor's flashlight reveals a horde of pixel-art zombies closing in, red alert marks over their heads."
- 02: "Four survivors hold a house at night behind a wall of wooden barricades, with two powered turrets and a lamp, as zombies pile against the wall."
- 03: "Survivors inside a gun shop: one at the safe in the back room, one firing a shotgun at the zombies pouring in through the door and a window."
- 04: "Three survivors fire at a giant centipede boss on its plaza at night."
- 05: "Daytime view from above of a procedurally generated town: a college campus, a park, houses and streets."

## Especificações e política aplicadas

Conferido na documentação oficial do Roblox em 2026-09-24 (via Context7, `/roblox/creator-docs`, e o texto fonte em github.com/Roblox/creator-docs):

- **Thumbnail: 16:9, idealmente 1920 × 1080**, `.png` aceito — [Thumbnails › Images / Quality and aspect ratio](https://create.roblox.com/docs/production/publishing/thumbnails). Todos têm exatamente 1920 × 1080.
- **Upload da Home Page: abaixo de 3 MB e 1920 × 1080** — mesma página, _Set up thumbnail personalization_. O maior tem ~0,7 MB.
- **Nada essencial embaixo** ("avoid placing any essential text or elements at the bottom of the thumbnail, as it may potentially be covered by metadata like the player count") — mesma página, _Best practices_. Títulos e marca ficam no terço de cima; o sobrevivente, o chefe e a porta da loja ficam acima da faixa de baixo.
- **Conteúdo relevante e sem gráfico ambíguo** ("Unclear imagery and ambiguous graphic in top-right corner" é o exemplo de erro) — _Relevant content_. Cada imagem mostra uma coisa do jogo e o título a nomeia; o canto de cima à direita leva só o nome do jogo, legível.
- **Mostrar o jogo como ele é** — as regras dos vídeos (_Misrepresented Gameplay_, _Artificial Visuals_: "Graphics shown must be representative of the actual in-game visuals"), aplicadas às imagens: tudo é o renderizador do jogo, na câmera de cima do jogo; o zoom (2–2,5×, ou 0,5× na vista da cidade) é o que o celular já mostra com menos tela, e a pixel art só aumenta por vizinho mais próximo (um texel = número inteiro de pixels). Pós-processamento só leve, o que a documentação aceita ("Small adjustments like brightness, contrast… overlay your game's logo or branding"): uma faixa escura atrás do título e uma vinheta suave nos cantos.
- **Texto pouco, só de contexto de jogo; nada de anúncio ou alegação subjetiva** (_Text, Claims, and Advertisements_: "Overlay text sparingly and only to describe gameplay contexts… Do not include… an advertisement, promotion, or subjective claim, for example '50% off' or 'Free UGC!'") — cada título diz o que se faz no jogo ("SURVIVE THE NIGHT", "BUILD. BARRICADE. HOLD.", "LOOT THE GUN SHOP", "DEFEAT THE BOSSES", "A NEW TOWN EVERY WORLD"); nenhum "FREE", "BEST", "#1", "NEW", nota, estrela, preço ou Robux.
- **Nenhuma interface falsa** (_Misrepresented Gameplay_: "Do not display… UI elements… that are not actually available") — nenhuma HUD, botão, "PLAY", barra de vida ou selo. As marcas `!`/`?` são desenho do mundo do jogo (IA-05), não interface.
- **Nada externo nem fora da plataforma** (_External Content & Overlays_; [Advertising standards](https://create.roblox.com/docs/production/promotion/comply-with-advertising-standards): nada que leve o usuário para fora do Roblox) — sem foto real, URL, rede social, Discord ou telefone; e, pela bíblia (CON-01, CON-02), nada do Dead Town e nenhuma marca real.
- **Violência e sangue sem realismo** ([Content maturity](https://create.roblox.com/docs/production/promotion/content-maturity): "Realistic or excessive depictions of violence, blood… may be moderated regardless of your experience's content maturity label") — só o que o jogo desenha: pixel art, o respingo verde de um acerto em zumbi, uma mancha seca de rua; nada de gore.
- **Ícone quadrado, 512 × 512, conferido pequeno** ("icons scale down to smaller sizes like 150×150 pixels… preview an icon at smaller sizes") — [Icons](https://create.roblox.com/docs/production/publishing/experience-icons). `previews/icons.png` mostra cada variante a 256, 150, recortada em círculo e a 50; o conteúdo fica dentro do círculo central (alguns lugares recortam redondo) e os cantos escurecem para o recorte não cortar nada.
- **Regras da comunidade e termos de uso** — tudo o que sobe é moderado contra elas ([Community Rules](https://en.help.roblox.com/hc/articles/203313410)).

## O que cada imagem mostra (e por que é verdade)

1. **SURVIVE THE NIGHT** — 22:00 numa rua residencial: um sobrevivente com pistola e lanterna (o cone de 560 u e ±45° da LUZ-04), a horda em fileiras com o `!` vermelho (perseguindo, IA-05). Zumbi no escuro não aparece (o alpha do servidor, `zombieBrain` `isLit`): só os que estão na luz, e dois na borda dela sumindo. O tiro é o traçado do `weaponFx` do cano até o primeiro corpo na linha.
2. **BUILD. BARRICADE. HOLD.** — uma casa com o telhado aberto (quem está dentro, EDI-04), uma parede de barricadas de madeira na grade de 128 u do quintal (`placement.ts`), aço na porta e madeira nas janelas encaixadas no vão (EDI-13), duas torretas ligadas à caixa de bateria pelo cabo amarelo e um lampião aceso (ELE-01..04, ELE-09, como o `PowerSet` do servidor diria); a horda amontoada na parede, os tiros das torretas e dos sobreviventes.
3. **LOOT THE GUN SHOP** — a loja de armas de dia, telhado aberto: a vitrine, os suportes de armas e o cofre da sala dos fundos, com um sobrevivente no ponto de saque ao lado dele (EDI-03); outro segura a porta com a escopeta (os cinco chumbos em leque), um terceiro na janela por onde um zumbi está pulando (EDI-10). O fundo da multidão ainda só ouviu os tiros: `?` dourado (IA-02).
4. **DEFEAT THE BOSSES** — a centopeia (ART-14) na praça onde o jogo a acorda (`world.bossAnchors`, CON-03), às 21:00, com as 50 placas da corrente, e três sobreviventes atirando nela.
5. **A NEW TOWN EVERY WORLD** — a cidade vista de cima às 10:00 (como no lobby, UI-10), no pedaço com mais lugares diferentes (campus com a fonte, parque, casas, lojas), um grupo atravessando e alguns zumbis vagando. Todo mundo morre → o mundo acaba e o próximo é outra cidade (MP-22).

**Não usado de propósito:** o conceito "CRACK THE VAULT" pedia um banco com luz de alarme vermelha; este jogo não tem banco nem alarme, então virou a loja de armas com o cofre de verdade dela.

## O ícone

Três variantes, todas o mesmo renderizador a 3,5–4,5× (14–20 px por texel):

- `icon-a-shot`: o nome empilhado em cima, o sobrevivente atirando num zumbi embaixo — conta a história, mas a 50 px a cena vira um risco.
- `icon-b-walker`: um zumbi de perto na luz, o `!` em cima, o nome embaixo.
- `icon-c-horde` (**o escolhido**, `icon/icon.png`): três zumbis entrando na luz com os braços esticados e três `!` vermelhos, o nome embaixo. É o que melhor se lê de 512 a 50 px (três marcas vermelhas sobre verde e o nome), cabe inteiro no recorte redondo e diz o gênero de relance, com um só acento quente (o vermelho).

## Regenerar

```bash
npm run promo                                     # tudo em docs/promo/
npm run promo -- --only thumbnails                # ou icon, logo, previews, ou um nome: survive-the-night, build-barricade-hold, loot-the-gun-shop, defeat-the-bosses, new-town-every-world
npm run promo -- --seed 1234 --out /tmp/promo     # outra cidade: cada cena é procurada nela
npm run promo -- --only defeat-the-bosses --boss 3 --boss-hour 10   # outro chefe (1 centopeia, 2 rafflesia, 3 gigante, 4 ouriço), outra hora
```

Outras opções: `--shop-hour` (hora da loja, padrão 16), `--town-zoom` (zoom da vista da cidade, padrão 0,5). As fontes: o título usa a fonte pixel grossa de `tools/title-font.mjs` (desenhada em código), e o "ZOMBIE SURVIVAL" a fonte 5 × 7 de `tools/pixel-font.mjs`.

Se a arte da cidade mudar (`npm run art:world`) ou o desenho de algo que aparece aqui, rode `npm run promo` de novo e reveja os `previews/` antes de subir.
