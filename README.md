# Luna

Conversa por vídeo com uma IA de rosto 3D realista, no navegador do PC ou do iPhone.
Ela te ouve, te vê pela câmera, responde por voz na hora e te olha nos olhos.

**Abrir:** https://gagliardi13.github.io/LUNA/

## Como funciona

| Parte | O que faz | Onde roda |
|---|---|---|
| Rosto 3D (TalkingHead + three.js) | expressões, boca sincronizada em pt-BR, olhar | no aparelho |
| `vision.js` (MediaPipe) | acompanha seu rosto: para onde ela olha e suas expressões | no aparelho (grátis) |
| `gemini.js` | conversa ao vivo com o Gemini 3.8 Live: voz, interrupção e imagens da câmera | Google |
| `openai.js` | plano B automático: se a cota do Gemini acabar, a conversa continua pela OpenAI | OpenAI |
| `servidor/worker.js` | guarda as chaves e entrega tokens temporários | Cloudflare Worker `sol-voz` |
| `emotion.js` | uma IA pequena lê a conversa e decide as reações do rosto | OpenAI (via Worker) |
| `lipsync.js` | boca guiada pelo som real da voz (não sai de sincronia) | no aparelho |
| `look.js` | luz de estúdio, enquadramento, óculos, cabelo | no aparelho |
| `commands.js` | comandos por voz: expressões, gestos, fundo, cabelo, óculos, câmera, humor | no aparelho |

## Configuração (uma vez)

1. **Cloudflare** → Worker `sol-voz` → **Edit code** → cole `servidor/worker.js` → **Deploy**.
   Variáveis: `GEMINI_API_KEY` (Secret), além das que a Sol já usa (`APP_TOKEN`, `OPENAI_API_KEY`, `ALLOWED_ORIGINS`).
2. **GitHub Pages**: Settings → Pages → `main` / `(root)`.
3. Abra o site, preencha endereço do Worker, senha e seu nome → **Começar conversa**.

## Recursos

- **Modos de conversa:** livre, desabafo (ouvinte estilo terapeuta), encontro (flerte e romance) e professora (aprender um assunto). Escolha na tela inicial ou peça por voz.
- **Busca no Google** durante a conversa (notícias, versões, preços).
- **Compartilhar a tela** (computador): ela vê seu terminal/código e ajuda.
- **Comandos por voz:** expressões, gestos, fundo, cabelo, óculos, câmera, humor.

## Plano B automático

Toda conversa começa pelo Gemini (grátis). Se a cota acabar, ao conectar ou no meio da conversa,
a Luna passa sozinha para a OpenAI (crédito da sua conta) e continua o assunto. Na próxima conversa
ela tenta o Gemini de novo. O canto da tela mostra qual está em uso.
Na OpenAI não há busca na internet, e as imagens da câmera são enviadas com menos frequência (custam mais).

## Uso e custos

- Plano grátis do Gemini: limitado por consumo diário; a linha no canto mostra os tokens da sessão.
  No plano grátis o Google pode usar o conteúdo (incluindo imagens da câmera) para melhorar os produtos.
- "Econômico" manda poucas imagens; "Contínuo" manda 1 por segundo (mais natural, gasta mais).
- Sem fone, a Luna não ouve enquanto fala (para não ouvir a própria voz). Toque nela para interromper.

## Personalizar

- Personalidade e modos (livre, desabafo, encontro, professora): `persona.js`
- Cor do cabelo, luzes e enquadramento: `LOOK` em `look.js`
- Óculos: `glasses.js`

## Créditos e licenças

- TalkingHead © Mika Suominen, licença MIT (`lib/talkinghead/LICENSE`).
- Avatar `avatars/luna.glb`: criado no Avaturn, **uso não comercial**. Para uso comercial, troque por um avatar próprio.
- MediaPipe (Google), three.js (MIT).
