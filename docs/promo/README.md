# LAST TOWN — arte da página do jogo no Roblox

Tudo nesta pasta é gerado por `npm run promo` (`tools/render-promo.mjs`) com o **código real do jogo**: a cidade de `generateTown(seed)`, desenhada por `worldView.ts` com a pixel art de `design/world-art/` (as 153 texturas já têm id aprovado no `assets.json` e o sha1 de cada PNG confere com o que subiu: é o que o jogo mostra hoje — as árvores da VEG-06, as entradas da ART-17, o mobiliário e a feira da ART-16, o vidro das janelas da EDI-18), o banco com o pórtico, a porta da caixa-forte e o sino do alarme por `townView.ts` (EDI-24), a horda por `actorsView.drawZombies`, os sobreviventes por `survivorView.drawSurvivor`, o chefe por `bossView.drawBoss`, as máquinas por `machinesView.ts`, as marcas de estado (ponto azul, `?` dourado, `!` vermelho) por `zombieAwareness.ts`, o sangue em pixel art por `bloodView.ts` (ART-15), o tempo (a chuva, as poças, o relâmpago) por `weatherView.ts` com o céu de `shared/sim/weather.ts` (LUZ-05), e a noite pelo `LightMap` com a escuridão do relógio e as luzes que o `gameLoop.drawLight` empurra. Nada é desenhado à mão: só o enquadramento, o instante e a faixa do título.

Determinístico: a mesma semente dá os mesmos bytes (`npm run promo` duas vezes = arquivos idênticos).

O **texto** da página (o nome "Last Town: Zombie Survival", a descrição com as regras e o recurso, e o About do
repositório no GitHub) está em [`DESCRIPTION.md`](DESCRIPTION.md). No jogo, o título do lobby e o splash usam o mesmo
desenho do wordmark como a textura `wordmark` do `npm run art:world` (`client/ui/logo.ts`), que a CI sobe com a cidade.

## Arquivos

| Arquivo                                                         | Tamanho     | Onde vai                                                                                                                                             |
| --------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thumbnails/01-survive-the-night.png`                           | 1920 × 1080 | Thumbnails (Home Page e Experience Detail Page) — o primeiro                                                                                         |
| `thumbnails/02-build-barricade-hold.png`                        | 1920 × 1080 | Thumbnails                                                                                                                                           |
| `thumbnails/03-crack-the-vault.png`                             | 1920 × 1080 | Thumbnails                                                                                                                                           |
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

**Nesta versão (2026-09-24, o jogo com o banco, o tempo e a cidade nova):** as cinco thumbnails mudaram — a 3 deixou de
ser "LOOT THE GUN SHOP" e virou **"CRACK THE VAULT"**, a 1 agora é a noite de tempestade, e as outras mostram a cidade
de hoje (as árvores, as entradas, o mobiliário, o sangue em pixel art). Suba as cinco de novo, nas duas abas, apague a
antiga "LOOT THE GUN SHOP" e troque o alt text de cada uma pelo de baixo. **O ícone não mudou:** o desenho é o mesmo e
só o grão do asfalto sob a luz difere (no máximo 27/255 por canal: a rua do instante é outra na cidade de hoje) — não
precisa subir de novo.

**Thumbnails** — [Creator Dashboard](https://create.roblox.com/dashboard/creations) → o jogo → **Configure › Places** → o place inicial → **Thumbnails** no menu da esquerda:

1. Aba **Experience Detail Page**: suba os cinco (até 10 são aceitos), na ordem 01 → 05, e preencha o **alt text** de cada um (acessibilidade; sugestões abaixo).
2. Aba **Home Page**: **Edit active thumbnails** → **Upload thumbnails** (ou marque **Active** nos já enviados) → ative de 2 a 5 → **Save changes** → **Start**. É a _thumbnail personalization_: o Roblox mostra a cada jogador a que funciona melhor para ele. A documentação pede para deixar várias ativas, não escolher uma vencedora.

**Ícone** — Creator Dashboard → o jogo → **Configure › Places** → o place inicial (marcado com a estrela) → **Icon** → Media type **Image** → **Change** → `icon/icon.png` → **Save Changes**.

Imagens passam pela moderação antes de aparecer para os outros.

Alt text sugerido (em inglês, como a página):

- 01: "A street at night in a thunderstorm: a lightning flash reveals a horde of pixel-art zombies closing in on a lone survivor, rain streaks and puddles on the road."
- 02: "Four survivors hold a house at night behind a wall of wooden barricades, with two powered turrets wired to a battery box, as zombies pile against the wall."
- 03: "Survivors inside a bank at night: one has just pried the vault door open with a crowbar, one loots the deposit boxes, two fire at the zombies pouring in through the front door while the red alarm flashes."
- 04: "Three survivors fire at a giant centipede boss on its plaza at night."
- 05: "Daytime view from above of a procedurally generated town: a park with a playground and groves of trees, a college campus, houses and streets."

## Especificações e política aplicadas

Conferido na documentação oficial do Roblox em 2026-09-24 (via Context7, `/roblox/creator-docs`, e o texto fonte em github.com/Roblox/creator-docs):

- **Thumbnail: 16:9, idealmente 1920 × 1080**, `.png` aceito — [Thumbnails › Images / Quality and aspect ratio](https://create.roblox.com/docs/production/publishing/thumbnails). Todos têm exatamente 1920 × 1080.
- **Upload da Home Page: abaixo de 3 MB e 1920 × 1080** — mesma página, _Set up thumbnail personalization_. O maior tem ~0,8 MB.
- **Nada essencial embaixo** ("avoid placing any essential text or elements at the bottom of the thumbnail, as it may potentially be covered by metadata like the player count") — mesma página, _Best practices_. Títulos e marca ficam no terço de cima; o sobrevivente, o chefe, a caixa-forte e o alarme ficam acima da faixa de baixo.
- **Conteúdo relevante e sem gráfico ambíguo** ("Unclear imagery and ambiguous graphic in top-right corner" é o exemplo de erro) — _Relevant content_. Cada imagem mostra uma coisa do jogo e o título a nomeia; o canto de cima à direita leva só o nome do jogo, legível.
- **Mostrar o jogo como ele é** — as regras dos vídeos (_Misrepresented Gameplay_, _Artificial Visuals_: "Graphics shown must be representative of the actual in-game visuals"), aplicadas às imagens: tudo é o renderizador do jogo, na câmera de cima do jogo; o zoom (1,5–2,25×, ou 0,5× na vista da cidade) é o que o celular já mostra com menos tela, e a pixel art só aumenta por vizinho mais próximo (um texel = número inteiro de pixels). O tempo também é o do jogo: a tempestade da 01 é um dia de tempestade (LUZ-05) com os riscos de chuva e as poças do `weatherView.ts`, e o clarão é um instante de um raio de verdade (um dos 16 níveis de `stormFlashAt`, pela conta de `weatherDark` que o servidor e a tela fazem), não um filtro. Pós-processamento só leve, o que a documentação aceita ("Small adjustments like brightness, contrast… overlay your game's logo or branding"): uma faixa escura atrás do título e uma vinheta suave nos cantos.
- **Texto pouco, só de contexto de jogo; nada de anúncio ou alegação subjetiva** (_Text, Claims, and Advertisements_: "Overlay text sparingly and only to describe gameplay contexts… Do not include… an advertisement, promotion, or subjective claim, for example '50% off' or 'Free UGC!'") — cada título diz o que se faz no jogo ("SURVIVE THE NIGHT", "BUILD. BARRICADE. HOLD.", "CRACK THE VAULT", "DEFEAT THE BOSSES", "A NEW TOWN EVERY WORLD"); nenhum "FREE", "BEST", "#1", "NEW", nota, estrela, preço ou Robux.
- **Nenhuma interface falsa** (_Misrepresented Gameplay_: "Do not display… UI elements… that are not actually available") — nenhuma HUD, botão, "PLAY", barra de vida ou selo. As marcas `!`/`?` são desenho do mundo do jogo (IA-05), não interface.
- **Nada externo nem fora da plataforma** (_External Content & Overlays_; [Advertising standards](https://create.roblox.com/docs/production/promotion/comply-with-advertising-standards): nada que leve o usuário para fora do Roblox) — sem foto real, URL, rede social, Discord ou telefone; e, pela bíblia (CON-01, CON-02), nada do Dead Town e nenhuma marca real.
- **Violência e sangue sem realismo** ([Content maturity](https://create.roblox.com/docs/production/promotion/content-maturity): "Realistic or excessive depictions of violence, blood… may be moderated regardless of your experience's content maturity label") — só o que o jogo desenha: o sangue em pixel art da ART-15 (poucos texels escuros num acerto, a mancha seca de uma rua), nada de gore.
- **Ícone quadrado, 512 × 512, conferido pequeno** ("icons scale down to smaller sizes like 150×150 pixels… preview an icon at smaller sizes") — [Icons](https://create.roblox.com/docs/production/publishing/experience-icons). `previews/icons.png` mostra cada variante a 256, 150, recortada em círculo e a 50; o conteúdo fica dentro do círculo central (alguns lugares recortam redondo) e os cantos escurecem para o recorte não cortar nada.
- **Regras da comunidade e termos de uso** — tudo o que sobe é moderado contra elas ([Community Rules](https://en.help.roblox.com/hc/articles/203313410)).

## O que cada imagem mostra (e por que é verdade)

1. **SURVIVE THE NIGHT** — 22:00 de um dia de tempestade (LUZ-05) numa rua residencial: a chuva (os riscos da tempestade, mais longos e inclinados pelo vento) e as poças nas sarjetas, um sobrevivente de pistola e lanterna, e o instante em que um relâmpago acende a cidade — o clarão tira até 60% da escuridão (`FLASH_LIFT`), a luz passa de `LIT_AMBIENT` e **a horda da rua inteira aparece de uma vez** (a revelação do raio: o servidor conta a rua escura como acesa, a tela desenha todo zumbi inteiro, `flashReveals`). As fileiras perto o veem (`!` vermelho, IA-05); as do fundo da rua só ouviram o tiro (`?` dourado, IA-02); um chega por trás. O tiro é o traçado do `weaponFx` do cano até o primeiro corpo na linha. Entre dois raios a mesma rua é a noite de sempre (`--storm-flash 0`: só o que a lanterna e o círculo do sobrevivente acendem).
2. **BUILD. BARRICADE. HOLD.** — uma casa com o telhado aberto (quem está dentro, EDI-04), uma parede de barricadas de madeira no quintal, cada uma com o canto de cima à esquerda na grade de 128 u como o jogo põe (`placement.ts` `ghostRect`, `placementValid`), aço na porta e madeira nas janelas encaixadas no vão (EDI-13), duas torretas ligadas à caixa de bateria pelo cabo amarelo (ELE-01..04, ELE-09, como o `PowerSet` do servidor diria; o lampião entra quando o quintal deixa uma célula livre para ele, e o desta cidade não deixa); a horda amontoada na parede, os tiros das torretas e dos sobreviventes.
3. **CRACK THE VAULT** — 21:00 no banco (EDI-24), o telhado aberto sobre os sobreviventes: a porta de aço da caixa-forte acabou de ceder ao pé de cabra (a laje virada contra a parede, como o `townView.ts` desenha a porta arrombada), quem a forçou ainda está no vão com o pé de cabra na mão, outro já está nos cofres de aluguel; e o **alarme** — no instante em que a porta cede o sino toca: a lâmpada vermelha pisca no pórtico (o `powered` dele, o LightSet do servidor) e ilumina a frente do banco, 220 u para a tela e para a horda. A horda de dois quarteirões vem: os primeiros já entraram pela porta da frente, a rua atrás deles converge na escadaria (`!` de quem vê os sobreviventes, `?` de quem só ouviu o alarme), dois sobreviventes seguram o salão atirando na porta.
4. **DEFEAT THE BOSSES** — a centopeia (ART-14) na praça onde o jogo a acorda (`world.bossAnchors`, CON-03), às 21:00, com as 50 placas da corrente, e três sobreviventes atirando nela.
5. **A NEW TOWN EVERY WORLD** — a cidade vista de cima às 10:00 (como no lobby, UI-10), no pedaço com mais lugares diferentes (o parque com o parquinho e os bosques de árvores de vários tipos da VEG-06, o campus, casas, ruas), um grupo atravessando e alguns zumbis vagando. Todo mundo morre → o mundo acaba e o próximo é outra cidade (MP-22).

**O instante do cofre, de propósito:** a porta fechada (a laje com o volante da fechadura) e o alarme tocando nunca aparecem juntos no jogo — o alarme é o que a porta cedendo dispara (`server/sim/vault.ts`: a porta aberta e o alarme no mesmo passo do servidor). Por isso a 03 é o instante logo depois: a porta arrombada, o pé de cabra ainda na mão, o alarme tocando. Enquanto alguém força a porta, a horda só vem pelo barulho do trabalho (um anel de 450 u a cada segundo, `?` dourado), sem luz vermelha.

## O ícone

O usado (`icon-c-horde`) não mudou nesta versão: o desenho novo da cidade não toca nada do que aparece nele (só o grão do asfalto sob a luz, porque a rua quieta da cidade de hoje é outra); a variante `icon-a-shot` ganhou o sangue em pixel art no acerto (ART-15). Três variantes, todas o mesmo renderizador a 3,5–4,5× (14–20 px por texel):

- `icon-a-shot`: o nome empilhado em cima, o sobrevivente atirando num zumbi embaixo — conta a história, mas a 50 px a cena vira um risco.
- `icon-b-walker`: um zumbi de perto na luz, o `!` em cima, o nome embaixo.
- `icon-c-horde` (**o escolhido**, `icon/icon.png`): três zumbis entrando na luz com os braços esticados e três `!` vermelhos, o nome embaixo. É o que melhor se lê de 512 a 50 px (três marcas vermelhas sobre verde e o nome), cabe inteiro no recorte redondo e diz o gênero de relance, com um só acento quente (o vermelho).

## Regenerar

```bash
npm run promo                                     # tudo em docs/promo/
npm run promo -- --only thumbnails                # ou icon, logo, previews, ou um nome: survive-the-night, build-barricade-hold, crack-the-vault, defeat-the-bosses, new-town-every-world
npm run promo -- --seed 1234 --out /tmp/promo     # outra cidade: cada cena é procurada nela
npm run promo -- --only defeat-the-bosses --boss 3 --boss-hour 10   # outro chefe (1 centopeia, 2 rafflesia, 3 gigante, 4 ouriço), outra hora
```

Outras opções: `--storm-flash` (o relâmpago da 01, de 0 a 1, padrão 0,75; 0 = a noite de tempestade entre dois raios), `--vault-hour` (a hora do banco, padrão 21), `--vault-zoom` (padrão 2), `--town-zoom` (zoom da vista da cidade, padrão 0,5). Um zoom fica em múltiplos de 0,25 (um número inteiro de pixels por texel). Com outra `--seed`, um banco virado para cima ou para baixo da tela cabe pior no quadro da 03 (a caixa-forte, o salão e a rua em fila vertical): o da cidade padrão fica de frente para a direita. As fontes: o título usa a fonte pixel grossa de `tools/title-font.mjs` (desenhada em código), e o "ZOMBIE SURVIVAL" a fonte 5 × 7 de `tools/pixel-font.mjs`.

Se a arte da cidade mudar (`npm run art:world`) ou o desenho de algo que aparece aqui, rode `npm run promo` de novo e reveja os `previews/` antes de subir.
