/**
 * O que o bot faz com a resposta da rota de captura: nota de voz, figurinha,
 * reacao e texto no grupo, e o aviso ao app do id da mensagem que ele enviou.
 *
 * Contrato com o app (nota de voz, ver merge-main-voz.md):
 *  - o bot manda `capacidades: ['nota_de_voz']` na captura (montarPayload);
 *  - se a resposta trouxer `reply_audio_b64`, o bot manda a nota de voz
 *    citando a mensagem de quem falou e grava o id dela no app pelo PATCH
 *    (`capture_id` e `bot_reply_wa_id`): responder a nota continua a conversa;
 *  - se vier `reply_text` junto com o audio (os links), o texto sai depois e
 *    o id que vai no PATCH continua sendo o da nota de voz.
 *
 * Cada passo e "melhor esforco": uma falha no envio vai para o log (so o tipo
 * do erro) e nao impede os outros passos.
 */
import { baixarFigurinhaSegura } from './destino.js';

/** A ordem e o que sera feito, sem enviar nada. */
export function planejarEntrega(resposta) {
  const r = resposta || {};
  return {
    audio: r.reply_audio_b64 ? { base64: r.reply_audio_b64, mime: r.reply_audio_mime || null } : null,
    figurinhaUrl: r.sticker_url || null,
    reacao: r.reaction_emoji || null,
    texto: r.reply_text || null,
    captureId: r.capture_id || null,
  };
}

/** Quem recebe o PATCH: o id da nota de voz, ou, sem ela, o do texto. */
export function idParaOPatch({ idDoAudio, idDoTexto, captureId }) {
  const id = idDoAudio || idDoTexto || null;
  if (!id || !captureId) return null;
  return { capture_id: captureId, bot_reply_wa_id: id };
}

/**
 * @param sock     { sendMessage, sendPresenceUpdate }
 * @param chave    chave da mensagem original ({ remoteJid, id, participant })
 * @param original a mensagem original inteira, se ainda estiver na memoria (para citar); senao null
 * @param deps     { notaDeVoz, http, hostsDeFigurinha, patchDoId, logger, aoEnviar }
 */
export async function entregarResposta({ sock, grupoJid, chave, original, resposta, deps }) {
  const { notaDeVoz, http, hostsDeFigurinha = [], patchDoId, logger, aoEnviar = () => {} } = deps;
  const plano = planejarEntrega(resposta);
  const citar = original ? { quoted: original } : undefined;
  const resumo = { audio: false, figurinha: false, reacao: false, texto: false, patch: false };
  let idDoAudio = null;
  let idDoTexto = null;

  if (plano.audio) {
    try {
      const bruto = Buffer.from(plano.audio.base64, 'base64');
      const nota = await notaDeVoz(bruto);
      try { await sock.sendPresenceUpdate('recording', grupoJid); } catch { /* presenca e enfeite */ }
      const conteudo = { audio: nota.audio, mimetype: 'audio/ogg; codecs=opus', ptt: true };
      if (nota.segundos) conteudo.seconds = nota.segundos;
      const enviado = await sock.sendMessage(grupoJid, conteudo, citar);
      try { await sock.sendPresenceUpdate('paused', grupoJid); } catch { /* idem */ }
      aoEnviar();
      idDoAudio = enviado?.key?.id || null;
      resumo.audio = true;
      logger.info({ bytes: nota.audio.length, segundos: nota.segundos, convertido: nota.convertido }, 'nota de voz enviada');
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao enviar nota de voz');
    }
  }

  if (plano.figurinhaUrl) {
    try {
      const webp = await baixarFigurinhaSegura({ http, url: plano.figurinhaUrl, hosts: hostsDeFigurinha });
      await sock.sendMessage(grupoJid, { sticker: webp });
      aoEnviar();
      resumo.figurinha = true;
      logger.info('figurinha enviada');
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao enviar figurinha');
    }
  }

  if (plano.reacao) {
    try {
      const key = original?.key || { remoteJid: chave.remoteJid, id: chave.id, participant: chave.participant, fromMe: false };
      await sock.sendMessage(grupoJid, { react: { text: plano.reacao, key } });
      resumo.reacao = true;
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao reagir');
    }
  }

  if (plano.texto) {
    try {
      const enviado = await sock.sendMessage(grupoJid, { text: plano.texto }, citar);
      aoEnviar();
      idDoTexto = enviado?.key?.id || null;
      resumo.texto = true;
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao enviar resposta de texto');
    }
  }

  const patch = idParaOPatch({ idDoAudio, idDoTexto, captureId: plano.captureId });
  if (patch) {
    const r = await patchDoId(patch);
    resumo.patch = !!r?.ok;
    if (!r?.ok) logger.warn({ err: r?.erro?.message }, 'falha reportando bot_reply_wa_id');
  }
  return resumo;
}
