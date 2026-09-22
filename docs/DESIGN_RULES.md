# Bíblia de ambientação — Project Z

Regras do que **deve** e do que **não deve** existir no mundo do jogo, para que a cidade, os objetos e a interface façam sentido. Toda mudança de conteúdo (gerador de mapa, sprites, UI, spawns) segue este documento.

Cada regra tem um ID (`VEG-01`) e um tipo de verificação:

- **[auto]** — checada por código (`npm run validate:world`, roda no CI). Se falhar, o PR não passa.
- **[revisão]** — checada no playtest (via MCP no Studio) e na revisão do PR.

Ordem de prioridade quando duas regras brigam: **legibilidade de gameplay → lógica do mundo real → fidelidade ao Dead Town original**. Toda exceção de gameplay precisa estar escrita aqui, com o motivo.

## 0. Princípios

- **P1 — Faz sentido ou tem motivo.** Tudo segue a lógica do mundo real, ou é uma exceção de gameplay documentada.
- **P2 — Melhor que o original.** Copiamos o que o Dead Town faz bem e corrigimos o que ele faz mal (IA sem pathfinding, bugs de XP, estômago cheio deixando lento…).
- **P3 — Se parece X, se comporta como X.** Aparência e comportamento nunca se contradizem.
- **P4 — A cidade funcionava antes do surto.** Cada objeto tinha função numa cidade normal; o apocalipse só bagunçou.

## 1. Cenário e escala

- Cidade pequena norte-americana genérica (como o original: posto, escola, hospital, loja de armas), **poucos dias** depois do surto: grama ainda aparada, carros abandonados, lixo espalhado — nada de ruínas de décadas.
- Trânsito pela direita.
- **Escala: 1 m ≈ 55 unidades de mundo.**

| Elemento | Unidades | Metros | Observação |
|---|---|---|---|
| Jogador (diâmetro) | 36 | ~0,65 | largura de ombros vista de cima |
| Zumbi (diâmetro) | 32 (×1,4 no grande) | ~0,6 | |
| Porta | 112 | ~2,0 | **exceção [ESC-02]**: porta dupla para dar espaço de combate na entrada |
| Carro | 200 × 100 | 3,6 × 1,8 | máscara do original |
| Lixeira | 36 | ~0,65 | |
| Tronco de árvore (colisão) | 44 | ~0,8 | |
| Copa de árvore | 150–172 | 2,7–3,1 | aérea, não colide |
| Rua (2 faixas) | 384 | ~7 | |
| Avenida (2 + 2 faixas) | 768 | ~14 | canteiro central arborizado de 96 u |
| Calçada | 128 | ~2,3 | 48 de faixa de serviço (junto ao meio-fio) + 80 de faixa livre; o tile de calçada do original também tem 128 |
| Escola / hospital | 1064 × 812 | ~19 × 15 | sobra lote para pátio ou estacionamento |
| Beco mínimo entre prédios | 96 | ~1,7 | passam 2 corpos |

**Evidência do original** (`rom_play`: 1.658 instâncias analisadas): 85% das 220 árvores ficam na grama (quintais e parques); nenhuma fica na calçada residencial; as árvores de rua ficam a ~264 u do asfalto (calçada + jardim), com espaçamento mediano de 768 u. Lixeiras ficam na borda do meio-fio. Casas ficam a 240–496 u do asfalto; comércio a 0–240 u; os postos ficam em esquinas de avenida. **Não copiamos** do original: carros e barricadas dentro de cruzamentos, e carros ignorando a mão da via.

## 2. Ruas e calçadas (CID)

- **CID-01 [auto]** ✅ Toda calçada tem uma **faixa livre contínua** onde um círculo de raio 18 passa de ponta a ponta. ❌ Nenhum sólido (tronco, lixeira, carro, poste) na faixa livre.
- **CID-02 [auto]** ✅ Árvores de rua, postes, lixeiras e hidrantes ficam só na **faixa de serviço** (canteiro/covas junto ao meio-fio).
- **CID-03 [auto]** ✅ Faixa de pedestre em cada braço de cruzamento. ❌ Nada estacionado ou plantado a menos de um carro (200 u) da esquina, medido a partir da borda do cruzamento.
- **CID-04 [revisão]** ✅ Faixa central tracejada só em rua de mão dupla; avenidas podem ter canteiro central arborizado.
- **CID-05 [auto]** ✅ Toda rua e todo lote são alcançáveis a pé a partir do ponto de nascimento. ❌ Becos sem saída sem motivo.

## 3. Vegetação (VEG)

- **VEG-01 [auto]** ❌ Árvore na faixa livre da calçada, na pista, na frente de porta/garagem ou a menos de 200 u de uma esquina.
- **VEG-02 [auto]** ✅ Árvores de rua só em covas na faixa de serviço, alinhadas e espaçadas regularmente (480–600 u, ~9–11 m); uma cova vazia conta como múltiplo do espaçamento.
- **VEG-03 [revisão]** ✅ A maioria das árvores fica em **quintais** (laterais e fundos), **praças/parques** e **terrenos baldios**. Parques densos; zona comercial pouco arborizada.
- **VEG-04 [auto]** ✅ A copa pode cobrir calçada e rua (é aérea); o **tronco nunca**. A copa fica translúcida quando há um ator embaixo.
- **VEG-05 [revisão]** ❌ Árvore menor que o jogador ou do tamanho de um prédio.

## 4. Edifícios (EDI)

- **EDI-01 [auto]** ✅ Porta sempre virada para a rua, com acesso livre: um círculo de raio 18 vai da calçada ao interior.
- **EDI-02 [auto]** ✅ Recuo por tipo: **casa** com jardim frontal de 112–176 u, caminho até a porta e quintal; **comércio** (mercado, farmácia, lojas, restaurante) a no máximo 16 u da calçada, com estacionamento nos fundos; **posto** na esquina com pátio de bombas de pelo menos 320 u; **escola/hospital** maiores, com pátio ou estacionamento.
- **EDI-03 [auto]** ✅ Loot coerente com o tipo: farmácia/hospital → remédios; loja de armas → munição e pólvora; mercado/restaurante → comida; posto → óleo; oficina/"tech" → peças e chips. Cor do telhado e emblema identificam o tipo.
- **EDI-04 [revisão]** ✅ De fora, o telhado esconde todo o interior; ele some **só com o jogador dentro** (regra do autor: dentro/fora puro, como o `par_building` do original).
- **EDI-05 [auto]** ❌ Prédio invadindo calçada ou rua; prédios colados sem beco de pelo menos 96 u.
- **EDI-06 [revisão]** ✅ Comércio nas vias principais e esquinas; residências nas ruas secundárias.
- **EDI-07 [revisão]** ✅ Interiores (quando houver móveis) com caminho livre de pelo menos um corpo e nada bloqueando a porta.

## 5. Veículos (VEI)

- **VEI-01 [auto]** ✅ Carro estacionado fica paralelo ao meio-fio (a ~12 u dele), na faixa de estacionamento, no sentido da mão (direita), com pelo menos 40 u entre carros. Em estacionamentos, vagas perpendiculares são permitidas.
- **VEI-02 [auto]** ❌ Carro em cruzamento, faixa de pedestre, calçada ou na frente de porta/garagem.
- **VEI-03 [auto]** ✅ Carros abandonados/batidos em ângulo no meio da rua são permitidos (é um apocalipse), mas **poucos** (no máximo 15% dos carros de rua) e sempre deixando pelo menos uma faixa livre contínua de 150 u por pista.
- **VEI-04 [revisão]** ✅ Cores variadas e plausíveis (levemente dessaturadas). ❌ Neon, cores de desenho animado.

## 6. Mobiliário urbano e lixo (MOB)

- **MOB-01 [auto]** ✅ Lixeira junto ao meio-fio perto de entradas (até 400 u na mesma calçada), ou em becos e fundos de lote. ❌ No meio da faixa livre.
- **MOB-02 [revisão]** ✅ Postes/lampiões na faixa de serviço, espaçados; iluminam só se tiverem motivo (ver LUZ-02).
- **MOB-03 [revisão]** ✅ Todo objeto tem função ou história. ❌ Objetos soltos sem razão de estar ali.

## 7. Apocalipse e narrativa ambiental (APO)

- **APO-01 [revisão]** ✅ Sinais de abandono de poucos dias: carros batidos, portas abertas, lixo espalhado, manchas de sangue, barricadas improvisadas em algumas casas.
- **APO-02 [auto]** ❌ Destroços bloqueando rotas inteiras.
- **APO-03 [revisão]** ❌ Elementos de outro gênero ou época (neon cyberpunk, ruínas de décadas, fantasia).
- **APO-04 [revisão]** ✅ Densidade de zumbis coerente com o lugar (hospital e escola mais cheios; parques mais vazios) — quando o spawner suportar.

## 8. Escala e proporções (ESC)

- **ESC-01 [auto]** ❌ Qualquer objeto do mundo real em proporção absurda em relação ao jogador (tabela da seção 1, com tolerância de ±30%).
- **ESC-02** Exceção documentada: porta de 112 u (~2 m) para permitir combate na entrada e passagem de zumbis pelo pathfinding.

## 9. Colisão e física (COL)

- **COL-01 [revisão]** ✅ Se parece sólido, colide; se colide, parece sólido.
- **COL-02 [auto]** ✅ Aéreo não colide (copas, telhados); chão não colide (poças, manchas, faixas, canteiros de grama).
- **COL-03 [auto]** ❌ Jogador, zumbi ou item nascendo dentro de um sólido.
- **COL-04 [revisão]** ❌ Decoração escura que pareça sombra de um objeto que não existe (lição da mancha de grama).
- **INT-01 [auto]** ✅ Integridade do gerador: nenhum sólido sobreposto, grade espacial consistente com a lista de sólidos, 4 paredes íntegras por prédio (com uma porta), praças dos chefes livres, e tudo alcançável a pé a partir do ponto de nascimento.

## 10. Luz, sombra e tempo (LUZ)

- **LUZ-01 [revisão]** ✅ De dia todas as sombras apontam para o mesmo lado (sol); à noite, se afastam das fontes de luz.
- **LUZ-02 [revisão]** ✅ Só ilumina o que tem motivo: o próprio jogador (~250 u), fogueira/braseiro acesos, lampião ligado, disparos e explosões.
- **LUZ-03 [revisão]** ✅ A noite é escura mas legível: o jogador sempre enxerga ao redor de si.

## 11. Legibilidade de gameplay (LEG)

- **LEG-01 [revisão]** ✅ O que é interativo mostra a pílula "E: …"; decoração nunca imita algo interativo.
- **LEG-02 [revisão]** ✅ Cores com significado fixo (herdado do original): vermelho = sangue do jogador/dano, verde = sangue de zumbi, roxo = veneno, amarelo = eletricidade, azul = máquinas.
- **LEG-03 [revisão]** ✅ Inimigos sempre se destacam do fundo (silhueta + cor + "!").

## 12. Interface (UI)

- **UI-01 [revisão]** ✅ Toda cor, fonte e raio vêm do tema do tweakcn (`design/tweakcn-theme.json` → `npm run theme` → `themeTokens.ts`). ❌ Cores ou fontes literais nas telas.
- **UI-02 [revisão]** ❌ Nada sob a barra do Roblox; nenhuma tecla que o CoreGui captura (Esc, Tab).
- **UI-03 [revisão]** ✅ Textos em inglês via `lang.ts` (EN/KR).

## 13. Conteúdo e propriedade intelectual (CON)

- **CON-01** ❌ Nome, logo ou arte do Dead Town. ✅ Créditos mantêm "Inspired by Dead Town (Lemon Puppy Games)".
- **CON-02** ❌ Marcas reais em lojas, carros ou produtos.

## Como adicionar ou mudar uma regra

1. Dê um ID novo na categoria certa (ou crie a categoria).
2. Escreva o ✅ deve / ❌ não deve e o **motivo** quando não for óbvio.
3. Marque **[auto]** só se houver checagem no validador; caso contrário, **[revisão]**.
4. Se for uma exceção de gameplay, registre na seção de escala ou na própria regra.
