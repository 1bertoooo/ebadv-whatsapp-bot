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
// Lista de grupos separados por ; (ex: "EBADV. Captura;EBadv. Agogê")
// Fallback: WA_GROUP_NAME (compat retroativa, único grupo).
const WA_GROUP_NAMES = (process.env.WA_GROUP_NAMES || process.env.WA_GROUP_NAME || 'EBADV. Captura')
  .split(';')
  .map(s => s.trim())
  .filter(Boolean);
const AUTH_DIR = process.env.WA_AUTH_DIR || './auth_state';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
// Se WA_PHONE_NUMBER estiver setado (formato internacional sem +, ex: 5543988742822),
// o bot vai usar pareamento por código de 8 dígitos em vez de QR.
// Útil quando o WhatsApp bloqueia pareamento por QR (acontece com chip recém-ativado).
const WA_PHONE_NUMBER = process.env.WA_PHONE_NUMBER?.replace(/\D/g, '') || '';

if (!LIS_URL || !LIS_SECRET) {
  console.error('Faltam LIS_CAPTURE_URL ou LIS_CAPTURE_SECRET no .env');
  process.exit(1);
}

const logger = pino({ level: LOG_LEVEL });

// Cache de grupos alvo: jid -> nome (descoberto após conectar)
const targetGroups = new Map(); // Map<string jid, string name>

// Stats locais pro heartbeat
const stats = {
  uptimeIniciadoEm: new Date().toISOString(),
  ultimaMsgRecebidaAt: null,
  ultimaMsgEnviadaAt: null,
  msgsHoje: 0,
  hojeStr: new Date().toISOString().slice(0, 10),
  conexao: 'connecting',
};
function statsResetSeNovoDia() {
  const agora = new Date().toISOString().slice(0, 10);
  if (agora !== stats.hojeStr) {
    stats.hojeStr = agora;
    stats.msgsHoje = 0;
  }
}

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

  // Pareamento por código (em vez de QR) quando WA_PHONE_NUMBER está setado
  if (WA_PHONE_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(WA_PHONE_NUMBER);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log('\n========================================');
        console.log('CÓDIGO DE PAREAMENTO (8 dígitos):');
        console.log('');
        console.log('         ' + formatted);
        console.log('');
        console.log('No celular do bot:');
        console.log('  WhatsApp > Dispositivos conectados');
        console.log('  > Conectar dispositivo');
        console.log('  > Conectar com número de telefone');
        console.log('  > digite o número, depois o código acima');
        console.log('========================================\n');
      } catch (err) {
        logger.error({ err: err?.message }, 'falha ao gerar pairing code');
      }
    }, 3500);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !WA_PHONE_NUMBER) {
      console.log('\n========================================');
      console.log('LEIA O QR CODE ABAIXO COM O CELULAR DO BOT');
      console.log('WhatsApp > Dispositivos conectados > Conectar dispositivo');
      console.log('========================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('conectado ao WhatsApp');
      stats.conexao = 'open';
      // Tenta achar todos os grupos configurados
      sock.groupFetchAllParticipating().then((groups) => {
        targetGroups.clear();
        for (const [jid, g] of Object.entries(groups)) {
          if (WA_GROUP_NAMES.includes(g.subject)) {
            targetGroups.set(jid, g.subject);
            logger.info({ jid, name: g.subject }, 'grupo alvo localizado');
          }
        }
        const naoEncontrados = WA_GROUP_NAMES.filter(
          n => !Array.from(targetGroups.values()).includes(n),
        );
        if (naoEncontrados.length > 0) {
          logger.warn({ naoEncontrados }, 'grupos não encontrados — bot precisa estar neles');
        }
        // Anuncia ao LIS que está pareado
        notificarLIS('event', {
          type: 'bot_paired',
          wa_group_jid: '',
          jids_grupos: Object.fromEntries(targetGroups),
        }).catch(() => {});
      });
    } else if (connection === 'connecting') {
      stats.conexao = 'connecting';
    }

    if (connection === 'close') {
      stats.conexao = 'closed';
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, 'conexão fechou');
      if (shouldReconnect) setTimeout(start, 3000);
      else {
        stats.conexao = 'logged_out';
        logger.error('logged out — apague auth_state e leia QR de novo');
        process.exit(1);
      }
    }
  });

  // Novo membro / saída de membro
  sock.ev.on('group-participants.update', async (ev) => {
    if (!targetGroups.has(ev.id)) return;
    if (ev.action === 'add') {
      // Filtra: não cumprimenta o próprio bot
      const myJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
      const novos = (ev.participants || [])
        .filter(jid => jid !== myJid)
        .map(jid => ({ jid, name: '' }));
      if (novos.length === 0) return;

      try {
        const r = await notificarLIS('event', {
          type: 'member_joined',
          wa_group_jid: ev.id,
          wa_group_name: targetGroups.get(ev.id),
          new_members: novos,
          added_by_jid: ev.author || null,
        });
        // LIS devolve mensagens a enviar
        for (const m of r?.mensagens || []) {
          try {
            await sock.sendMessage(ev.id, {
              text: m.text,
              mentions: [m.jid],
            });
            stats.ultimaMsgEnviadaAt = new Date().toISOString();
          } catch (err) {
            logger.error({ err: err?.message }, 'falha ao cumprimentar membro');
          }
        }
      } catch (err) {
        logger.error({ err: err?.message }, 'falha notificar LIS de member_joined');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
        statsResetSeNovoDia();
        stats.ultimaMsgRecebidaAt = new Date().toISOString();
        stats.msgsHoje++;
      } catch (err) {
        logger.error({ err: err?.message, stack: err?.stack }, 'falha processando msg');
      }
    }
  });

  // Heartbeat a cada 60s pro LIS saber que tá vivo
  iniciarHeartbeat();

  // Pollster da fila de mensagens outbound (sprint, etc) a cada 30s
  iniciarOutboundPoller(sock);
}

function iniciarOutboundPoller(sock) {
  const verificar = async () => {
    try {
      const r = await axios.get(`${LIS_BASE}/api/whatsapp/outbound`, {
        headers: { Authorization: `Bearer ${LIS_SECRET}` },
        timeout: 10000,
      });
      const mensagens = r.data?.mensagens || [];
      for (const m of mensagens) {
        try {
          let sent;
          if (m.action === 'delete' && m.target_msg_id) {
            // Apaga pra todos via Baileys revoke
            sent = await sock.sendMessage(m.group_jid, {
              delete: { remoteJid: m.group_jid, fromMe: true, id: m.target_msg_id, participant: undefined },
            });
            logger.info({ motivo: m.motivo, target: m.target_msg_id }, 'mensagem apagada');
          } else if (m.sticker_url) {
            // Baixa o webp e envia como sticker nativo
            const stickerRes = await axios.get(m.sticker_url, { responseType: 'arraybuffer', timeout: 15000 });
            sent = await sock.sendMessage(m.group_jid, { sticker: Buffer.from(stickerRes.data) });
          } else if (m.text) {
            sent = await sock.sendMessage(m.group_jid, { text: m.text });
          } else {
            logger.warn({ id: m.id }, 'mensagem outbound vazia — pulando');
            continue;
          }
          stats.ultimaMsgEnviadaAt = new Date().toISOString();
          await axios.post(
            `${LIS_BASE}/api/whatsapp/outbound`,
            { id: m.id, bot_msg_id: sent?.key?.id || null },
            { headers: { Authorization: `Bearer ${LIS_SECRET}` }, timeout: 10000 },
          );
          logger.info({ motivo: m.motivo, group: m.group_jid, kind: m.sticker_url ? 'sticker' : 'text' }, 'mensagem outbound enviada');
        } catch (err) {
          logger.error({ id: m.id, err: err?.message }, 'falha enviar mensagem outbound');
        }
      }
    } catch (err) {
      // Silencioso — outbound é best-effort
    }
  };
  setTimeout(verificar, 15000);
  setInterval(verificar, 30_000);
}

const LIS_BASE = (LIS_URL || '').replace(/\/api\/whatsapp\/.*$/, '');

async function notificarLIS(endpoint, payload) {
  const url = `${LIS_BASE}/api/whatsapp/${endpoint}`;
  try {
    const r = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${LIS_SECRET}` },
      timeout: 15000,
    });
    return r.data;
  } catch (err) {
    logger.warn({ endpoint, err: err?.message }, 'notificarLIS falhou');
    return null;
  }
}

function iniciarHeartbeat() {
  const enviar = async () => {
    try {
      await notificarLIS('heartbeat', {
        conexao: stats.conexao,
        baileys_version: 'baileys',
        uptime_iniciado_em: stats.uptimeIniciadoEm,
        ultima_msg_recebida_at: stats.ultimaMsgRecebidaAt,
        ultima_msg_enviada_at: stats.ultimaMsgEnviadaAt,
        msgs_processadas_hoje: stats.msgsHoje,
        jids_grupos: Object.fromEntries(targetGroups),
      });
    } catch {}
  };
  // primeiro envio imediato + cada 60s
  setTimeout(enviar, 5000);
  setInterval(enviar, 60_000);
}

async function handleMessage(sock, msg) {
  // Ignora self-send pra evitar loop
  if (msg.key.fromMe) return;
  // Ignora msg sem conteúdo
  if (!msg.message) return;
  // Só escuta grupos alvo
  const groupJid = msg.key.remoteJid;
  const groupName = targetGroups.get(groupJid);
  if (!groupName) return;

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
    // Baixa o webp e enviou como data URL pra Luana descrever via Vision
    try {
      const f = await downloadAsFile(sock, msg, 'stickerMessage', m.stickerMessage);
      if (f?.base64) {
        var stickerB64 = `data:${f.mime || 'image/webp'};base64,${f.base64}`;
      }
    } catch (err) {
      logger.warn({ err: err?.message }, 'falha ao baixar sticker');
    }
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
    wa_group_jid: groupJid,
    wa_group_name: groupName, // <-- modo no LIS: "EBADV. Captura" ou "EBadv. Agogê"
    wa_sender_jid: msg.key.participant || msg.participant || msg.key.remoteJid,
    wa_sender_name: msg.pushName || null,
    wa_timestamp: Number(msg.messageTimestamp),
    wa_quoted_message_id: quotedId,
    message_type: type,
    text_content: text || undefined,
    file: file || undefined,
    reaction: reaction || undefined,
    sticker_b64: typeof stickerB64 !== 'undefined' ? stickerB64 : undefined,
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

  const { reply_text, reaction_emoji, classification, capture_id, sticker_url } = res.data || {};
  logger.info(
    { classification, has_reaction: !!reaction_emoji, has_reply: !!reply_text, has_sticker: !!sticker_url },
    'LIS respondeu',
  );

  // Envia sticker se a Luana decidiu mandar (Agogê)
  if (sticker_url) {
    try {
      const r = await axios.get(sticker_url, { responseType: 'arraybuffer', timeout: 15000 });
      await sock.sendMessage(groupJid, { sticker: Buffer.from(r.data) });
      stats.ultimaMsgEnviadaAt = new Date().toISOString();
      logger.info({ sticker_url: sticker_url.split('/').pop() }, 'sticker enviado');
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao enviar sticker');
    }
  }

  // Reage com emoji na mensagem original (☑️ pra captura, 📸 pra imagem etc)
  if (reaction_emoji) {
    try {
      await sock.sendMessage(groupJid, {
        react: { text: reaction_emoji, key: msg.key },
      });
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao reagir');
    }
  }

  // Texto só quando houver algo a esclarecer (erro, pedido de input, confirmação de arquivo)
  if (reply_text) {
    let sent;
    try {
      sent = await sock.sendMessage(groupJid, { text: reply_text }, { quoted: msg });
      stats.ultimaMsgEnviadaAt = new Date().toISOString();
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao enviar reply');
    }

    // Reporta wa_message_id da própria resposta pro LIS — habilita correção via reply
    if (sent?.key?.id && capture_id) {
      try {
        await axios.patch(
          LIS_URL,
          { capture_id, bot_reply_wa_id: sent.key.id },
          { headers: { Authorization: `Bearer ${LIS_SECRET}` }, timeout: 10000 },
        );
      } catch (err) {
        logger.warn({ err: err?.message }, 'falha reportando bot_reply_wa_id');
      }
    }
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
