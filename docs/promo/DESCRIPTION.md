# LAST TOWN — o texto da página do jogo no Roblox

O que vai nos campos de texto da experiência (Creator Dashboard → o jogo → **Configure › Basic Settings**; a API do
Open Cloud aceita e ignora nome e descrição, então é à mão: `docs/CREATOR_HUB.md`). Em inglês, como a página. A arte
(thumbnails, ícone, logos) está nesta mesma pasta: `docs/promo/README.md`.

## Nome

```text
Last Town: Zombie Survival
```

O jogo se chama **Last Town** (decisão do dono, 2026-09-24); "Zombie Survival" é o subtítulo da loja, o mesmo do logo.

## Descrição

A apresentação e, embaixo dela, **as regras e o recurso** — cole os dois juntos, nesta ordem.

```text
🧟 The town fell in days. You're still standing. Survive the night.

LAST TOWN is a top-down co-op zombie survival game. Every world is a brand-new town — houses, shops, a hospital, a campus, a bank — and every night the horde comes for it.

☀️ DAY: Loot 24 kinds of buildings, craft weapons and gear, and fortify a house before sunset.
🌙 NIGHT: Board up the windows, light a fire, and hold the line with up to 6 friends. Every shot is noise, and noise draws them in.
💀 BOSSES & HEISTS: Face bosses that stalk the streets, or crack the bank vault… and survive the alarm.
📈 GROW: Level up, unlock skills, earn titles, and show off outfits and pets.

When everyone falls, the town is lost — and a new one rises on day 1.

How long will you last?
```

```text
No pay-to-win: everything that decides whether you live through the night is earned in the game.

Rules:
- Play fair: no exploits, cheats or scripts, and no abusing bugs.
- Be kind: no harassment, hate, bullying or scams in chat.
- Keep personal information private: yours and everyone else's.
- Don't ruin the game for other survivors on purpose.
- Follow the Roblox Community Standards.
Breaking a rule can get you kicked or banned. Only a person bans, never the game on its own.
Appeals: contact the developer through the group linked on this experience's page: <link do grupo>
```

**As regras e o recurso não são opcionais.** As diretrizes de ban do Roblox pedem regras que todo usuário consiga ler
e um jeito de recorrer ao criador, e a mensagem de ban do jogo diz "The rules and how to appeal are on this
experience's page" (`src/shared/data/rules.ts`): a página é o único lugar que um jogador banido ainda abre. O texto
das regras é o mesmo de `RULES_TEXT` (no jogo, How to play › Rules); se um mudar, mude o outro. Troque
`<link do grupo>` pelo link do grupo e ponha o mesmo grupo em **Social links**.

### Conferir antes de publicar

A página só pode prometer o que o jogo faz (as regras de publicidade do Roblox: _Misrepresented Gameplay_). Hoje,
nesta branch:

- **"a bank" / "crack the bank vault… and survive the alarm"**: o banco ainda **não** está no jogo (o README desta
  pasta diz por que a thumbnail 3 é a loja de armas). Publique esta descrição quando o banco entrar — e, junto, a
  thumbnail 3 nova, "CRACK THE VAULT" (`npm run promo`).
- **"24 kinds of buildings"**: `src/shared/data/buildings.ts` tem hoje 15 tipos de prédio (casa, casa grande, escola,
  hospital, posto, farmácia, mercado, mercadinho, loja de armas, loja de roupas, restaurante e os quatro do campus).
  O número tem que bater com o jogo no dia da publicação.
- **"hold the line with up to 6 friends"**: o servidor tem **6 vagas** (`MAX_PLAYERS`), ou seja, você e até **5**
  amigos. Se o número ficar, a frase certa é "with up to 5 friends" (ou "in a squad of up to 6").
- O campo de descrição tem limite de caracteres: confira no painel que as regras couberam inteiras.

## Repositório no GitHub

Sugestão para **About** (a engrenagem ao lado de "About" na página do repositório):

- **Description:** `Last Town: Zombie Survival — a top-down co-op zombie survival game for Roblox (up to 6 players), in pixel art, written in roblox-ts and drawn entirely in ScreenGui.`
- **Topics:** `roblox`, `roblox-ts`, `roblox-game`, `luau`, `rojo`, `typescript`, `game-development`, `zombie`,
  `zombie-survival`, `survival-game`, `co-op`, `multiplayer`, `top-down`, `pixel-art`, `procedural-generation`
