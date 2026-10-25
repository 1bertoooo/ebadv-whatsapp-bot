import test from 'node:test';
import assert from 'node:assert/strict';
import {
  desembrulhar,
  extrairMensagem,
  textoDoConteudo,
  citadoDoConteudo,
  telefoneDoRemetente,
  tamanhoDoArquivo,
  decidirArquivo,
  montarPayload,
} from '../src/lib/mensagem.js';

const pdf = { fileName: 'peticao.pdf', mimetype: 'application/pdf', caption: 'SILVA. protocolar a contestacao', fileLength: 1000 };

test('SEG-M12-005: documento com legenda chega embrulhado e e desembrulhado', () => {
  const m = { documentWithCaptionMessage: { message: { documentMessage: pdf } } };
  const { conteudo, envelopes } = desembrulhar(m);
  assert.deepEqual(envelopes, ['documentWithCaptionMessage']);
  assert.equal(conteudo.documentMessage, pdf);

  const r = extrairMensagem(m);
  assert.equal(r.ignorar, false);
  assert.equal(r.tipo, 'document');
  assert.equal(r.texto, 'SILVA. protocolar a contestacao');
  assert.equal(r.midia.chave, 'documentMessage');
  assert.equal(r.midia.meta, pdf);
});

test('SEG-M12-005: mensagem temporaria (ephemeral) de texto e de documento', () => {
  const texto = extrairMensagem({ ephemeralMessage: { message: { extendedTextMessage: { text: 'SILVA. juntar procuracao' } } } });
  assert.equal(texto.ignorar, false);
  assert.equal(texto.tipo, 'text');
  assert.equal(texto.texto, 'SILVA. juntar procuracao');

  const doc = extrairMensagem({ ephemeralMessage: { message: { documentWithCaptionMessage: { message: { documentMessage: pdf } } } } });
  assert.equal(doc.tipo, 'document');
  assert.deepEqual(doc.envelopes, ['ephemeralMessage', 'documentWithCaptionMessage']);
});

test('SEG-M12-005: nao desembrulha em laço infinito', () => {
  let m = { conversation: 'oi' };
  for (let i = 0; i < 12; i++) m = { ephemeralMessage: { message: m } };
  const { envelopes } = desembrulhar(m);
  assert.equal(envelopes.length, 5);
});

test('SEG-M12-005: edicao por protocolMessage e reconhecida, com o id da mensagem original', () => {
  const r = extrairMensagem({
    protocolMessage: { type: 14, key: { id: 'ORIGINAL1' }, editedMessage: { conversation: 'SILVA. texto corrigido' } },
  });
  assert.equal(r.ignorar, false);
  assert.equal(r.tipo, 'text');
  assert.equal(r.texto, 'SILVA. texto corrigido');
  assert.deepEqual(r.edicao, { idOriginal: 'ORIGINAL1' });
});

test('SEG-M12-005: edicao embrulhada em editedMessage tambem e reconhecida', () => {
  const r = extrairMensagem({
    editedMessage: {
      message: { protocolMessage: { type: 'MESSAGE_EDIT', key: { id: 'ORIG2' }, editedMessage: { extendedTextMessage: { text: 'novo' } } } },
    },
  });
  assert.equal(r.ignorar, false);
  assert.equal(r.texto, 'novo');
  assert.equal(r.edicao.idOriginal, 'ORIG2');
});

test('protocolMessage que nao e edicao (apagar para todos, configuracao) e ignorada com motivo', () => {
  const r = extrairMensagem({ protocolMessage: { type: 0, key: { id: 'X' } } });
  assert.equal(r.ignorar, true);
  assert.equal(r.motivo, 'protocolo');
});

test('SEG-M12-005: visualizacao unica e ignorada por padrao e capturada quando o dono decidir', () => {
  const m = { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg', viewOnce: true } } } };
  const padrao = extrairMensagem(m);
  assert.equal(padrao.ignorar, true);
  assert.equal(padrao.motivo, 'visualizacao_unica');
  const capturada = extrairMensagem(m, { visualizacaoUnica: 'capturar' });
  assert.equal(capturada.ignorar, false);
  assert.equal(capturada.tipo, 'image');

  const soComFlag = extrairMensagem({ imageMessage: { viewOnce: true } });
  assert.equal(soComFlag.motivo, 'visualizacao_unica');
});

test('tipos comuns continuam funcionando (texto, audio, imagem, video, figurinha, reacao)', () => {
  assert.equal(extrairMensagem({ conversation: 'oi' }).tipo, 'text');
  assert.equal(extrairMensagem({ audioMessage: { mimetype: 'audio/ogg' } }).tipo, 'audio');
  const img = extrairMensagem({ imageMessage: { caption: 'foto', mimetype: 'image/png' } });
  assert.equal(img.tipo, 'image');
  assert.equal(img.texto, 'foto');
  const vid = extrairMensagem({ videoMessage: { caption: 'video' } });
  assert.equal(vid.tipo, 'video');
  assert.equal(vid.midia.chave, 'videoMessage'); // o bot nao baixa video: so o texto e a legenda vao ao app
  assert.equal(extrairMensagem({ stickerMessage: {} }).tipo, 'sticker');
  const re = extrairMensagem({ reactionMessage: { text: 'x', key: { id: 'ALVO' } } });
  assert.equal(re.tipo, 'reaction');
  assert.deepEqual(re.reacao, { emoji: 'x', target_wa_message_id: 'ALVO' });
});

test('tipo desconhecido e ignorado com os nomes dos campos, nunca o conteudo', () => {
  const r = extrairMensagem({ contactMessage: { displayName: 'Maria Silva', vcard: 'BEGIN:VCARD' } });
  assert.equal(r.ignorar, true);
  assert.equal(r.motivo, 'tipo_nao_tratado');
  assert.deepEqual(r.tipos, ['contactMessage']);
  assert.ok(!JSON.stringify(r).includes('Maria'));
});

test('sem conteudo e ignorado', () => {
  assert.equal(extrairMensagem(null).motivo, 'sem_conteudo');
  assert.equal(extrairMensagem({ ephemeralMessage: {} }).motivo, 'sem_conteudo');
});

test('SEG-M12-005: a citacao e lida de qualquer tipo, tambem de audio e figurinha, e da mensagem desembrulhada', () => {
  assert.equal(citadoDoConteudo({ audioMessage: { contextInfo: { stanzaId: 'A1' } } }), 'A1');
  assert.equal(citadoDoConteudo({ stickerMessage: { contextInfo: { stanzaId: 'S1' } } }), 'S1');
  assert.equal(citadoDoConteudo({ messageContextInfo: { x: 1 }, conversation: 'oi' }), null);
  const r = extrairMensagem({
    ephemeralMessage: { message: { documentWithCaptionMessage: { message: { documentMessage: { ...pdf, contextInfo: { stanzaId: 'C9' } } } } } },
  });
  assert.equal(r.citadoId, 'C9');
});

test('textoDoConteudo le texto puro e legenda', () => {
  assert.equal(textoDoConteudo({ conversation: 'a' }), 'a');
  assert.equal(textoDoConteudo({ extendedTextMessage: { text: 'b' } }), 'b');
  assert.equal(textoDoConteudo({ documentMessage: { caption: 'c' } }), 'c');
  assert.equal(textoDoConteudo(undefined), '');
});

test('telefone do remetente: tenta as fontes da chave, nao a citacao (recurso que nao existia)', () => {
  assert.equal(telefoneDoRemetente({ senderPn: '1@s.whatsapp.net', participantPn: '2' }), '1@s.whatsapp.net');
  assert.equal(telefoneDoRemetente({ participantPn: '2' }), '2');
  assert.equal(telefoneDoRemetente({ participantAlt: '3' }), '3');
  assert.equal(telefoneDoRemetente({}), null);
});

test('SEG-M12-004: tamanho declarado do arquivo em numero, texto e Long', () => {
  assert.equal(tamanhoDoArquivo({ fileLength: 123 }), 123);
  assert.equal(tamanhoDoArquivo({ fileLength: '456' }), 456);
  assert.equal(tamanhoDoArquivo({ fileLength: { low: 789, high: 0, unsigned: true } }), 789);
  assert.equal(tamanhoDoArquivo({ fileLength: { low: 0, high: 1 } }), 2 ** 32);
  assert.equal(tamanhoDoArquivo({ fileLength: { toNumber: () => 55 } }), 55);
  assert.equal(tamanhoDoArquivo({}), null);
  assert.equal(tamanhoDoArquivo({ fileLength: 'abc' }), null);
});

test('SEG-M12-004: arquivo acima do limite nao e baixado; abaixo e desconhecido sim', () => {
  const limite = 3 * 1024 * 1024;
  assert.equal(decidirArquivo({ tamanho: limite + 1, limite }).baixar, false);
  assert.equal(decidirArquivo({ tamanho: limite, limite }).baixar, true);
  assert.equal(decidirArquivo({ tamanho: null, limite }).baixar, true);
  assert.equal(decidirArquivo({ tamanho: 350 * 1024 * 1024, limite }).motivo, 'grande_demais');
});

test('montarPayload mantem os campos do contrato com o app e declara nota_de_voz', () => {
  const msg = {
    key: { id: 'ABC', remoteJid: '1203@g.us', participant: '55119@s.whatsapp.net', senderPn: '55119@s.whatsapp.net' },
    pushName: 'Fulana',
    messageTimestamp: 1760000000,
  };
  const extraido = extrairMensagem({ extendedTextMessage: { text: 'SILVA. juntar', contextInfo: { stanzaId: 'Q1' } } });
  const p = montarPayload({ msg, extraido, grupoJid: '1203@g.us', grupoNome: 'Grupo', orgId: 'org-1' });
  assert.deepEqual(Object.keys(p).sort(), [
    'capacidades', 'file', 'message_type', 'org_id', 'reaction', 'sticker_b64', 'text_content',
    'wa_group_jid', 'wa_group_name', 'wa_message_id', 'wa_quoted_message_id', 'wa_sender_jid',
    'wa_sender_name', 'wa_sender_phone', 'wa_timestamp',
  ].sort());
  assert.deepEqual(p.capacidades, ['nota_de_voz']);
  assert.equal(p.wa_message_id, 'ABC');
  assert.equal(p.wa_sender_jid, '55119@s.whatsapp.net');
  assert.equal(p.wa_sender_phone, '55119@s.whatsapp.net');
  assert.equal(p.wa_quoted_message_id, 'Q1');
  assert.equal(p.org_id, 'org-1');
  assert.equal(p.wa_timestamp, 1760000000);
  assert.equal(p.wa_edita_message_id, undefined);
});

test('montarPayload: org_id some na casa e a edicao so vai com o interruptor ligado', () => {
  const msg = { key: { id: 'E1', remoteJid: '1@g.us' }, messageTimestamp: 1 };
  const extraido = extrairMensagem({ protocolMessage: { type: 14, key: { id: 'O1' }, editedMessage: { conversation: 'novo' } } });
  const desligado = montarPayload({ msg, extraido, grupoJid: '1@g.us', grupoNome: 'G' });
  assert.equal(desligado.org_id, undefined);
  assert.equal(desligado.wa_edita_message_id, undefined);
  const ligado = montarPayload({ msg, extraido, grupoJid: '1@g.us', grupoNome: 'G', enviarEdicoes: true });
  assert.equal(ligado.wa_edita_message_id, 'O1');
  assert.equal(ligado.wa_sender_jid, '1@g.us');
});
