/**
 * EBADV WhatsApp Bot — escuta grupo "EBADV. Captura" e empurra cada
 * mensagem nova pro endpoint /api/whatsapp/capture do LIS.
 *
 * Estratégia: Baileys (não-oficial) com sessão persistida em ./auth_state.
 * Roda como serviço Windows via nssm — basta o PC ficar ligado.
 *
 * Mensagens próprias (do bot) são SEMPRE ignoradas pra evitar loop.
 * Só mensagens do grupo configurado (WA_GROUP_NAME) são processadas.
 */
import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import axios from 'axios';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';

const LIS_URL = process.env.LIS_CAPTURE_URL;
const LIS_SECRET = process.env.LIS_CAPTURE_SECRET;
const WA_GROUP_NAME = process.env.WA_GROUP_NAME || 'EBADV. Captura';
const AUTH_DIR = process.env.WA_AUTH_DIR || './auth_state';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

if (!LIS_URL || !LIS_SECRET) {
  console.error('Faltam LIS_CAPTURE_URL ou LIS_CAPTURE_SECRET no .env');
  process.exit(1);
}

const logger = pino({ level: LOG_LEVEL });

// Cache: nome do grupo -> jid (descoberto na primeira mensagem dele)
let targetGroupJid = null;

async function start() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ baileysVersion: version }, 'iniciando');

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'warn' }),
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n========================================');
      console.log('LEIA O QR CODE ABAIXO COM O CELULAR DO BOT');
      console.log('WhatsApp > Dispositivos conectados > Conectar dispositivo');
      console.log('========================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('conectado ao WhatsApp');
      // tenta achar o grupo configurado
      sock.groupFetchAllParticipating().then((groups) => {
        for (const [jid, g] of Object.entries(groups)) {
          if (g.subject === WA_GROUP_NAME) {
            targetGroupJid = jid;
            logger.info({ jid, name: g.subject }, 'grupo alvo localizado');
          }
        }
        if (!targetGroupJid) {
          logger.warn({ procurado: WA_GROUP_NAME }, 'grupo não encontrado — bot precisa estar no grupo');
        }
      });
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, 'conexão fechou');
      if (shouldReconnect) setTimeout(start, 3000);
      else {
        logger.error('logged out — apague auth_state e leia QR de novo');
        process.exit(1);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err: err?.message, stack: err?.stack }, 'falha processando msg');
      }
    }
  });
}

async function handleMessage(sock, msg) {
  // Ignora self-send pra evitar loop
  if (msg.key.fromMe) return;
  // Ignora msg sem conteúdo
  if (!msg.message) return;
  // Só escuta o grupo alvo
  if (!targetGroupJid || msg.key.remoteJid !== targetGroupJid) return;

  // Identifica tipo
  const m = msg.message;
  let type;
  let text = '';
  let file = null;
  let reaction = null;

  if (m.conversation) {
    type = 'text';
    text = m.conversation;
  } else if (m.extendedTextMessage) {
    type = 'text';
    text = m.extendedTextMessage.text || '';
  } else if (m.audioMessage) {
    type = 'audio';
    file = await downloadAsFile(sock, msg, 'audioMessage', m.audioMessage);
  } else if (m.imageMessage) {
    type = 'image';
    text = m.imageMessage.caption || '';
    file = await downloadAsFile(sock, msg, 'imageMessage', m.imageMessage);
  } else if (m.documentMessage) {
    type = 'document';
    text = m.documentMessage.caption || '';
    file = await downloadAsFile(sock, msg, 'documentMessage', m.documentMessage);
  } else if (m.videoMessage) {
    type = 'video';
    text = m.videoMessage.caption || '';
  } else if (m.stickerMessage) {
    type = 'sticker';
  } else if (m.reactionMessage) {
    type = 'reaction';
    reaction = {
      emoji: m.reactionMessage.text,
      target_wa_message_id: m.reactionMessage.key?.id || '',
    };
  } else {
    logger.debug({ keys: Object.keys(m) }, 'tipo desconhecido — ignorando');
    return;
  }

  // Quoted message
  const ctxInfo =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    null;
  const quotedId = ctxInfo?.stanzaId || null;

  const payload = {
    wa_message_id: msg.key.id,
    wa_group_jid: msg.key.remoteJid,
    wa_sender_jid: msg.key.participant || msg.participant || msg.key.remoteJid,
    wa_sender_name: msg.pushName || null,
    wa_timestamp: Number(msg.messageTimestamp),
    wa_quoted_message_id: quotedId,
    message_type: type,
    text_content: text || undefined,
    file: file || undefined,
    reaction: reaction || undefined,
  };

  logger.info(
    {
      type,
      sender: payload.wa_sender_name,
      preview: text ? text.slice(0, 60) : `<${type}>`,
    },
    'mensagem recebida',
  );

  // POST pro LIS
  let res;
  try {
    res = await axios.post(LIS_URL, payload, {
      headers: { Authorization: `Bearer ${LIS_SECRET}` },
      timeout: 60000,
      maxBodyLength: 100 * 1024 * 1024,
      maxContentLength: 100 * 1024 * 1024,
    });
  } catch (err) {
    logger.error({ err: err?.message, code: err?.response?.status }, 'POST /capture falhou');
    return;
  }

  const { reply_text, classification } = res.data || {};
  logger.info({ classification, has_reply: !!reply_text }, 'LIS respondeu');

  if (reply_text) {
    await sock.sendMessage(targetGroupJid, { text: reply_text }, { quoted: msg });
  }
}

async function downloadAsFile(sock, msg, kind, meta) {
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
    const name = meta.fileName || `${kind}_${msg.key.id}`;
    return {
      name,
      mime: meta.mimetype || 'application/octet-stream',
      size: buffer.length,
      base64: buffer.toString('base64'),
    };
  } catch (err) {
    logger.error({ err: err?.message }, 'falha ao baixar mídia');
    return null;
  }
}

start().catch((e) => {
  logger.error({ err: e?.message, stack: e?.stack }, 'fatal');
  process.exit(1);
});
