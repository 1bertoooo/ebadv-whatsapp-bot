# ebadv-whatsapp-bot

Bot Baileys que escuta o grupo **EBADV. Captura** no WhatsApp e empurra cada mensagem pro endpoint `/api/whatsapp/capture` do LIS (ebadv.work).

Roda como serviço Windows num PC ocioso do escritório, conectado a um chip dedicado.

## Stack

- Node.js 20+
- @whiskeysockets/baileys (engenharia reversa do WhatsApp Web)
- Conexão persistente via WebSocket, sessão salva em `./auth_state/`

## Instalação

```bash
git clone https://github.com/1bertoooo/ebadv-whatsapp-bot
cd ebadv-whatsapp-bot
npm install
cp .env.example .env
# edite .env com LIS_CAPTURE_SECRET (pegue no Vercel env vars do projeto ebadv-app)
npm start
```

Na primeira execução vai aparecer um QR code no terminal. Lê com o WhatsApp do **chip do bot** em *Dispositivos conectados → Conectar dispositivo*. Sessão fica salva em `./auth_state/` — não precisa ler de novo a menos que dê logout.

## Servir como serviço Windows

Recomendado: [nssm](https://nssm.cc/). Veja `PROMPT_COWORK.md` na raíz pra passo-a-passo.

## Como funciona

1. Bot conecta no WhatsApp, identifica o grupo "EBADV. Captura" e guarda o JID.
2. A cada mensagem do grupo (texto, áudio, imagem, documento, reação) — exceto as próprias —, monta payload e faz `POST $LIS_CAPTURE_URL` com `Authorization: Bearer $LIS_CAPTURE_SECRET`.
3. O LIS classifica (captura padrão, arquivo, conversa, etc), cria tarefa em "Para delegar" se for `CLIENTE. Assunto`, e devolve um `reply_text`.
4. Se vier `reply_text`, o bot responde no grupo citando a mensagem original.

Loop é evitado pelo filtro `msg.key.fromMe`.

## Logs

Stdout/stderr em formato pino. Se rodando como serviço, redirecione pra arquivo:

```
nssm set ebadv-whatsapp-bot AppStdout C:\ebadv-whatsapp-bot\logs\out.log
nssm set ebadv-whatsapp-bot AppStderr C:\ebadv-whatsapp-bot\logs\err.log
```

## Troubleshooting

| Sintoma | Solução |
|---|---|
| `connection.update { connection: 'close', code: 401 }` (loggedOut) | Apaga `./auth_state/` e roda `npm start` de novo pra escanear QR |
| Grupo não localizado | Confirma se o número do bot foi adicionado ao grupo, e se `WA_GROUP_NAME` no `.env` casa exatamente |
| Mensagens não chegam ao LIS | Verifica `LIS_CAPTURE_SECRET` (mesmo valor que está no Vercel env var `CAPTURE_WA_SECRET`) |
| Ban do WhatsApp | Registra outro chip, novo `auth_state/` |
