/**
 * Leitura de uma mensagem do WhatsApp (SEG-M12-005) e montagem do corpo que
 * vai para a rota de captura do app.
 *
 * Tudo aqui e puro: nao importa o Baileys e nao toca em rede nem em disco.
 * O Baileys entrega a mensagem "embrulhada" em varios casos (documento com
 * legenda, mensagem temporaria, visualizacao unica, edicao), e o codigo
 * antigo olhava so o primeiro nivel e ignorava o resto sem aviso.
 */

/** Tipos que embrulham a mensagem de verdade (FutureProofMessage no protocolo). */
const ENVELOPES = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
];

const MAX_NIVEIS = 5;

const MIDIAS = {
  audioMessage: 'audio',
  imageMessage: 'image',
  documentMessage: 'document',
  videoMessage: 'video',
  stickerMessage: 'sticker',
};

/** protocolMessage.type de edicao: numero no protocolo, nome quando vem como texto. */
function ehEdicaoDeProtocolo(protocolo) {
  return protocolo?.type === 14 || protocolo?.type === 'MESSAGE_EDIT';
}

/**
 * Tira os envelopes, como o normalizeMessageContent do Baileys. Devolve o
 * conteudo de dentro e os nomes dos envelopes por onde passou.
 */
export function desembrulhar(message) {
  const envelopes = [];
  let atual = message;
  for (let i = 0; i < MAX_NIVEIS; i++) {
    const nome = ENVELOPES.find((n) => atual && atual[n]);
    if (!nome) break;
    envelopes.push(nome);
    atual = atual[nome]?.message;
  }
  return { conteudo: atual || undefined, envelopes };
}

/** O texto de qualquer conteudo (texto puro ou legenda de midia). */
export function textoDoConteudo(c) {
  if (!c) return '';
  if (c.conversation) return c.conversation;
  if (c.extendedTextMessage) return c.extendedTextMessage.text || '';
  for (const chave of ['imageMessage', 'documentMessage', 'videoMessage']) {
    if (c[chave]) return c[chave].caption || '';
  }
  return '';
}

/** Id da mensagem citada (a que a pessoa respondeu), lido de qualquer tipo de conteudo. */
export function citadoDoConteudo(c) {
  if (!c) return null;
  for (const [chave, valor] of Object.entries(c)) {
    if (chave === 'messageContextInfo') continue;
    if (valor && typeof valor === 'object' && valor.contextInfo) {
      return valor.contextInfo.stanzaId || null;
    }
  }
  return null;
}

/** Telefone real do remetente, quando o Baileys o expoe (jid @lid esconde o numero). */
export function telefoneDoRemetente(key) {
  return key?.senderPn || key?.participantPn || key?.participantAlt || null;
}

function ehVisualizacaoUnica(envelopes, conteudo) {
  if (envelopes.some((e) => e.startsWith('viewOnce'))) return true;
  return Object.values(conteudo || {}).some((v) => v && typeof v === 'object' && v.viewOnce === true);
}

/**
 * Entende a mensagem. Devolve:
 *   { ignorar: true, motivo, tipos? }   quando nao deve ir ao app (com o motivo, para o log);
 *   { ignorar: false, tipo, texto, midia, reacao, citadoId, edicao }  quando deve.
 *
 * `tipos` sao so os nomes dos campos da mensagem (nunca o conteudo), para o
 * log dizer o que chegou sem guardar dado pessoal.
 */
export function extrairMensagem(message, opcoes = {}) {
  const visualizacaoUnica = opcoes.visualizacaoUnica || 'ignorar';
  if (!message) return { ignorar: true, motivo: 'sem_conteudo' };

  let { conteudo, envelopes } = desembrulhar(message);
  if (!conteudo) return { ignorar: true, motivo: 'sem_conteudo' };

  if (ehVisualizacaoUnica(envelopes, conteudo) && visualizacaoUnica !== 'capturar') {
    return { ignorar: true, motivo: 'visualizacao_unica' };
  }

  let edicao = null;
  if (conteudo.protocolMessage) {
    const p = conteudo.protocolMessage;
    if (!ehEdicaoDeProtocolo(p)) return { ignorar: true, motivo: 'protocolo', tipos: [`protocolo_${p.type ?? 'desconhecido'}`] };
    const interno = desembrulhar(p.editedMessage);
    if (!interno.conteudo) return { ignorar: true, motivo: 'edicao_sem_conteudo' };
    edicao = { idOriginal: p.key?.id || null };
    conteudo = interno.conteudo;
    envelopes = envelopes.concat(interno.envelopes);
  } else if (envelopes.includes('editedMessage')) {
    // Edicao que chegou embrulhada sem o protocolMessage: o conteudo de dentro
    // e o texto novo, mas nao ha como saber qual era a mensagem original.
    edicao = { idOriginal: null };
  }

  const citadoId = citadoDoConteudo(conteudo);

  if (conteudo.conversation || conteudo.extendedTextMessage) {
    return { ignorar: false, tipo: 'text', texto: textoDoConteudo(conteudo), midia: null, reacao: null, citadoId, edicao, envelopes };
  }
  for (const [chave, tipo] of Object.entries(MIDIAS)) {
    if (conteudo[chave]) {
      return {
        ignorar: false,
        tipo,
        texto: tipo === 'sticker' || tipo === 'audio' ? '' : textoDoConteudo(conteudo),
        midia: { chave, meta: conteudo[chave] },
        reacao: null,
        citadoId,
        edicao,
        envelopes,
      };
    }
  }
  if (conteudo.reactionMessage) {
    return {
      ignorar: false,
      tipo: 'reaction',
      texto: '',
      midia: null,
      reacao: {
        emoji: conteudo.reactionMessage.text,
        target_wa_message_id: conteudo.reactionMessage.key?.id || '',
      },
      citadoId: null,
      edicao: null,
      envelopes,
    };
  }
  return { ignorar: true, motivo: 'tipo_nao_tratado', tipos: Object.keys(conteudo) };
}

/**
 * Tamanho declarado do arquivo, em bytes. O Baileys entrega fileLength como
 * numero, texto ou objeto Long, conforme a versao.
 */
export function tamanhoDoArquivo(meta) {
  const v = meta?.fileLength;
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v.toNumber === 'function') return v.toNumber();
  if (typeof v.low === 'number') return (v.high || 0) * 2 ** 32 + (v.low >>> 0);
  return null;
}

/** Decide se vale baixar o arquivo, antes de baixar (SEG-M12-004). */
export function decidirArquivo({ tamanho, limite }) {
  if (tamanho == null) return { baixar: true, motivo: 'tamanho_desconhecido' };
  if (tamanho > limite) return { baixar: false, motivo: 'grande_demais', tamanho, limite };
  return { baixar: true, motivo: 'dentro_do_limite' };
}

/**
 * Corpo que vai para POST /api/whatsapp/capture. Os nomes dos campos sao o
 * contrato com o app e nao mudam. `capacidades: ['nota_de_voz']` avisa que
 * este bot sabe mandar nota de voz: sem isso o app responde so por escrito.
 */
export function montarPayload({ msg, extraido, grupoJid, grupoNome, orgId, arquivo, stickerB64, enviarEdicoes = false }) {
  const payload = {
    wa_message_id: msg.key.id,
    wa_group_jid: grupoJid,
    wa_group_name: grupoNome,
    // Vazio = grupo da casa; preenchido = escritorio cliente.
    org_id: orgId || undefined,
    wa_sender_jid: msg.key.participant || msg.participant || msg.key.remoteJid,
    wa_sender_phone: telefoneDoRemetente(msg.key),
    wa_sender_name: msg.pushName || null,
    wa_timestamp: Number(msg.messageTimestamp),
    wa_quoted_message_id: extraido.citadoId || null,
    message_type: extraido.tipo,
    text_content: extraido.texto || undefined,
    file: arquivo || undefined,
    reaction: extraido.reacao || undefined,
    sticker_b64: stickerB64 || undefined,
    capacidades: ['nota_de_voz'],
  };
  if (extraido.edicao && enviarEdicoes) payload.wa_edita_message_id = extraido.edicao.idOriginal;
  return payload;
}
