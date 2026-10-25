import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilaEmDisco } from '../src/lib/fila-local.js';
import { criarFluxoDeEntrada } from '../src/lib/entrada.js';
import { criarFluxoDeSaida, enviarItemDeSaida } from '../src/lib/saida.js';
import { entregarResposta, planejarEntrega, idParaOPatch } from '../src/lib/entrega.js';
import { LimitadorDeEnvio } from '../src/lib/limites.js';

const silencioso = { info() {}, warn() {}, error() {}, debug() {} };

function registrado() {
  const linhas = [];
  const f = (nivel) => (obj, msg) => linhas.push({ nivel, obj, msg });
  return { linhas, info: f('info'), warn: f('warn'), error: f('error'), debug: f('debug') };
}

function pasta() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fluxo-bot-')), 'fila');
}

function relogio(inicio = 1_760_000_000_000) {
  let t = inicio;
  return { agora: () => t, avancar: (ms) => { t += ms; } };
}

const config = {
  lisUrl: 'https://app.test/api/whatsapp/capture',
  lisBase: 'https://app.test',
  segredo: 'segredo',
  timeoutDaCapturaMs: 280_000,
  enviarNumeroId: false,
  numeroId: 'chip-1',
  hostsDeFigurinha: [],
};

const dadosDaMensagem = (id = 'MSG1') => ({
  payload: { wa_message_id: id, wa_group_jid: '1203@g.us', message_type: 'text', text_content: 'SILVA. juntar' },
  chave: { remoteJid: '1203@g.us', id, participant: '5511@s.whatsapp.net' },
});

function entradaDeTeste({ respostas, fila, relogioDeTeste = relogio() } = {}) {
  const posts = [];
  const entregas = [];
  const descartes = [];
  const log = registrado();
  const http = {
    post: async (url, corpo, opcoes) => {
      posts.push({ url, corpo, opcoes });
      const r = respostas.shift();
      if (r instanceof Error || r?.response || r?.erro) throw r.erro || r;
      return { status: 200, data: r };
    },
  };
  const fluxo = criarFluxoDeEntrada({
    config,
    http,
    fila,
    logger: log,
    esperarFn: (ms) => new Promise((res) => setTimeout(res, ms)),
    entregar: async (x) => entregas.push(x),
    aoDescartar: async (x) => descartes.push(x),
    aleatorio: () => 0.5,
  });
  return { fluxo, posts, entregas, descartes, log };
}

// entrada ------------------------------------------------------------

test('SEG-M12-006: com o app respondendo, a mensagem e entregue, a resposta vai para o grupo e a fila fica vazia', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const t = entradaDeTeste({ respostas: [{ ok: true, classification: 'captura', reaction_emoji: 'x', capture_id: 'C1' }], fila });
  const original = { key: { id: 'MSG1' } };
  const r = await t.fluxo.receber('MSG1', dadosDaMensagem(), original);
  assert.equal(r.ok, true);
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].url, config.lisUrl);
  assert.equal(t.posts[0].opcoes.timeout, 280_000);
  assert.equal(t.posts[0].opcoes.headers.Authorization, 'Bearer segredo');
  assert.equal(t.entregas.length, 1);
  assert.equal(t.entregas[0].original, original);
  assert.equal(t.entregas[0].resposta.reaction_emoji, 'x');
  assert.equal(fila.resumo().itens, 0);
});

test('SEG-M12-006: app fora do ar nao perde a mensagem: fica na fila com espera crescente e sai quando o app volta', async () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: pasta(), agora: r.agora });
  fila.iniciar();
  const queda = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const t = entradaDeTeste({ respostas: [queda, { response: { status: 503 } }, { ok: true, classification: 'captura' }], fila });

  const primeira = await t.fluxo.receber('MSG1', dadosDaMensagem());
  assert.equal(primeira.ok, false);
  assert.equal(primeira.descartada, false);
  assert.equal(fila.resumo().itens, 1, 'a mensagem continua guardada');
  assert.equal(fila.tentativas('MSG1'), 1);
  assert.equal(t.entregas.length, 0);

  // antes da espera, a varredura nao tenta de novo
  assert.equal((await t.fluxo.varrer()).tentadas, 0);
  assert.equal(t.posts.length, 1);

  r.avancar(6000);
  const v1 = await t.fluxo.varrer();
  assert.equal(v1.tentadas, 1);
  assert.equal(fila.tentativas('MSG1'), 2);
  assert.equal(t.posts.length, 2);

  // a segunda espera e maior que a primeira
  const antes = fila.obter('MSG1').proximaEm - r.agora();
  assert.ok(antes >= 9000 && antes <= 11000, `espera da segunda repeticao: ${antes}`);
  assert.equal((await t.fluxo.varrer()).tentadas, 0);

  r.avancar(antes);
  const v2 = await t.fluxo.varrer();
  assert.equal(v2.tentadas, 1);
  assert.equal(t.entregas.length, 1);
  assert.equal(fila.resumo().itens, 0);
});

test('SEG-M12-006: o app lento (timeout) tambem nao perde a mensagem', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const t = entradaDeTeste({ respostas: [Object.assign(new Error('timeout of 280000ms exceeded'), { code: 'ECONNABORTED' })], fila });
  const r = await t.fluxo.receber('MSG1', dadosDaMensagem());
  assert.equal(r.motivo, 'sem_resposta');
  assert.equal(fila.resumo().itens, 1);
});

test('SEG-M12-006: segredo trocado (401) fica na fila ate o dono corrigir', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const t = entradaDeTeste({ respostas: [{ response: { status: 401 } }], fila });
  const r = await t.fluxo.receber('MSG1', dadosDaMensagem());
  assert.equal(r.descartada, false);
  assert.equal(r.motivo, 'nao_autorizado');
  assert.equal(fila.resumo().itens, 1);
});

test('SEG-M12-006: o reinicio do processo nao perde o que estava na fila', async () => {
  const dir = pasta();
  const r = relogio();
  const antes = new FilaEmDisco({ dir, agora: r.agora });
  antes.iniciar();
  const t1 = entradaDeTeste({ respostas: [Object.assign(new Error('x'), { code: 'ECONNRESET' })], fila: antes });
  await t1.fluxo.receber('MSG1', dadosDaMensagem());
  assert.equal(antes.resumo().itens, 1);

  // o processo sai (o bot sai a cada queda de conexao) e sobe outro
  const depois = new FilaEmDisco({ dir, agora: r.agora });
  assert.equal(depois.iniciar().itens, 1);
  const t2 = entradaDeTeste({ respostas: [{ ok: true }], fila: depois });
  r.avancar(10 * 60_000);
  const v = await t2.fluxo.varrer();
  assert.equal(v.tentadas, 1);
  assert.equal(t2.posts[0].corpo.wa_message_id, 'MSG1');
  assert.equal(t2.entregas.length, 1);
  assert.equal(t2.entregas[0].original, null, 'depois do reinicio nao ha mensagem original para citar');
  assert.equal(depois.resumo().itens, 0);
});

test('SEG-M12-006: recusa definitiva do app (409, 400) descarta com motivo no log, sem repetir', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const t = entradaDeTeste({ respostas: [{ response: { status: 409 } }], fila });
  const r = await t.fluxo.receber('MSG1', dadosDaMensagem());
  assert.equal(r.descartada, true);
  assert.equal(fila.resumo().itens, 0);
  assert.equal(t.descartes.length, 1);
  assert.equal(t.descartes[0].motivo, 'org_diverge');
  const linha = t.log.linhas.find((l) => l.msg.includes('descartada'));
  assert.deepEqual(Object.keys(linha.obj).sort(), ['id', 'motivo', 'status']);
});

test('SEG-M12-004: 413 do app avisa o descarte para o grupo ser avisado', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const t = entradaDeTeste({ respostas: [{ response: { status: 413 } }], fila });
  await t.fluxo.receber('MSG1', dadosDaMensagem());
  assert.equal(t.descartes[0].motivo, 'corpo_grande_demais');
});

test('SEG-M12-006: a varredura para na primeira falha de infraestrutura e segue quando o app volta', async () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: pasta(), agora: r.agora });
  fila.iniciar();
  fila.adicionar('A', dadosDaMensagem('A'));
  r.avancar(1);
  fila.adicionar('B', dadosDaMensagem('B'));
  r.avancar(1);
  fila.adicionar('C', dadosDaMensagem('C'));
  const t = entradaDeTeste({ respostas: [new Error('app fora'), { ok: true }, { ok: true }, { ok: true }], fila });
  const v = await t.fluxo.varrer();
  assert.equal(v.tentadas, 1, 'parou na primeira falha de infraestrutura');
  assert.equal(t.posts.length, 1, 'nao bateu no app fora do ar com as outras duas');
  assert.equal(fila.resumo().itens, 3);
  r.avancar(60_000);
  const v2 = await t.fluxo.varrer();
  assert.equal(v2.tentadas, 3);
  assert.equal(fila.resumo().itens, 0);
  assert.deepEqual(t.posts.map((p) => p.corpo.wa_message_id), ['A', 'A', 'B', 'C'], 'a ordem de chegada e mantida');
});

test('SEG-M12-006: erro 500 de uma mensagem nao trava as outras', async () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: pasta(), agora: r.agora });
  fila.iniciar();
  fila.adicionar('RUIM', dadosDaMensagem('RUIM'));
  r.avancar(1);
  fila.adicionar('BOA', dadosDaMensagem('BOA'));
  const t = entradaDeTeste({ respostas: [{ response: { status: 500 } }, { ok: true }], fila });
  const v = await t.fluxo.varrer();
  assert.equal(v.tentadas, 2);
  assert.deepEqual(fila.prontos(r.agora() + 10 * 60_000), ['RUIM']);
});

test('SEG-M12-006: mensagem vencida (24 h) sai da fila com aviso no log, e o log nao leva o texto', async () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: pasta(), agora: r.agora, validadeMs: 24 * 3600_000 });
  fila.iniciar();
  fila.adicionar('VELHA', dadosDaMensagem('VELHA'));
  r.avancar(25 * 3600_000);
  const t = entradaDeTeste({ respostas: [], fila });
  await t.fluxo.varrer();
  assert.equal(fila.resumo().itens, 0);
  const l = t.log.linhas.find((x) => x.msg.includes('vencidas'));
  assert.ok(l);
  assert.ok(!JSON.stringify(t.log.linhas).includes('SILVA'));
});

test('a mesma mensagem recebida duas vezes nao vira dois POSTs', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const t = entradaDeTeste({ respostas: [Object.assign(new Error('x'), { code: 'ECONNRESET' }), { ok: true }], fila });
  await t.fluxo.receber('MSG1', dadosDaMensagem());
  const dup = await t.fluxo.receber('MSG1', dadosDaMensagem());
  assert.equal(dup.motivo, 'duplicada');
  assert.equal(t.posts.length, 1);
});

test('saida ordenada: aguardarTermino espera o POST em curso e desiste no prazo', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  let liberar;
  const travado = new Promise((res) => { liberar = res; });
  const http = { post: async () => { await travado; return { data: {} }; } };
  const fluxo = criarFluxoDeEntrada({ config, http, fila, logger: silencioso, esperarFn: (ms) => new Promise((r) => setTimeout(r, ms)), entregar: async () => {} });
  const p = fluxo.receber('MSG1', dadosDaMensagem());
  assert.equal(await fluxo.aguardarTermino(20), false);
  liberar();
  await p;
  assert.equal(await fluxo.aguardarTermino(20), true);
});

test('o log da entrada traz so ids, tipos e contagens', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const t = entradaDeTeste({ respostas: [{ ok: true, classification: 'captura', reply_text: 'Registrei a tarefa do Fulano' }], fila });
  await t.fluxo.receber('MSG1', dadosDaMensagem());
  const texto = JSON.stringify(t.log.linhas);
  assert.ok(!texto.includes('SILVA'));
  assert.ok(!texto.includes('Fulano'));
  assert.ok(!texto.includes('5511'));
});

// saida --------------------------------------------------------------

function saidaDeTeste({ mensagens = [], grupos = new Map([['120363000000000001@g.us', 'G']]), enviar, postDeConfirmacao, fila, relogioDeTeste = relogio(), config: cfg = config } = {}) {
  const gets = [];
  const posts = [];
  const enviadas = [];
  const log = registrado();
  const http = {
    get: async (url, opcoes) => { gets.push({ url, opcoes }); return { data: { ok: true, mensagens } }; },
    post: async (url, corpo) => {
      posts.push({ url, corpo });
      if (postDeConfirmacao) return postDeConfirmacao(corpo);
      return { data: { ok: true } };
    },
  };
  const limitador = new LimitadorDeEnvio({ porMinuto: 10, porHora: 100, intervaloMinMs: 2000, intervaloMaxMs: 2000 });
  const fluxo = criarFluxoDeSaida({
    config: cfg,
    http,
    fila,
    logger: log,
    limitador,
    agora: relogioDeTeste.agora,
    gruposConhecidos: () => grupos,
    enviar: enviar || (async (m) => { enviadas.push(m); return { key: { id: 'BOT-' + m.id } }; }),
    aleatorio: () => 0.5,
  });
  return { fluxo, gets, posts, enviadas, log, limitador };
}

const mensagemDeSaida = (id, extra = {}) => ({ id, group_jid: '120363000000000001@g.us', text: 'Lembrete: prazo amanha', motivo: 'regra', ...extra });

test('SEG-M12-006: a mensagem de saida vai para a fila em disco assim que chega, antes de enviar', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const t = saidaDeTeste({ mensagens: [mensagemDeSaida('S1'), mensagemDeSaida('S2')], fila });
  assert.equal(await t.fluxo.buscar(), 2);
  assert.equal(fila.resumo().itens, 2);
  assert.equal(t.enviadas.length, 0);
});

test('SEG-M12-006: falha no envio nao perde a mensagem; ela sai na tentativa seguinte e so entao e confirmada', async () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: pasta(), agora: r.agora });
  fila.iniciar();
  let n = 0;
  const t = saidaDeTeste({
    mensagens: [mensagemDeSaida('S1')],
    fila,
    relogioDeTeste: r,
    enviar: async (m) => { n++; if (n === 1) throw new Error('Connection Closed'); return { key: { id: 'BOT1' } }; },
  });
  await t.fluxo.buscar();
  await t.fluxo.entregarProximas();
  assert.equal(fila.resumo().itens, 1);
  assert.equal(t.posts.length, 0, 'nao confirma o que nao foi enviado');
  r.avancar(10 * 60_000);
  const e = await t.fluxo.entregarProximas();
  assert.equal(e.enviadas, 1);
  assert.equal(fila.resumo().itens, 0);
  assert.deepEqual(t.posts[0].corpo, { id: 'S1', bot_msg_id: 'BOT1' });
});

test('SEG-M12-006: se o envio deu certo e a confirmacao falhou, a confirmacao repete mas a mensagem NAO e reenviada', async () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: pasta(), agora: r.agora });
  fila.iniciar();
  let confirmacoes = 0;
  const t = saidaDeTeste({
    mensagens: [mensagemDeSaida('S1')],
    fila,
    relogioDeTeste: r,
    postDeConfirmacao: () => { confirmacoes++; if (confirmacoes === 1) throw new Error('app fora'); return { data: { ok: true } }; },
  });
  await t.fluxo.buscar();
  await t.fluxo.entregarProximas();
  assert.equal(t.enviadas.length, 1);
  assert.equal(fila.resumo().itens, 1);
  r.avancar(10 * 60_000);
  await t.fluxo.entregarProximas();
  assert.equal(t.enviadas.length, 1, 'nao reenviou');
  assert.equal(confirmacoes, 2);
  assert.equal(fila.resumo().itens, 0);
});

test('SEG-M12-009: destino fora do mapa de grupos nao e enviado e e descartado depois de poucas tentativas', async () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: pasta(), agora: r.agora });
  fila.iniciar();
  const t = saidaDeTeste({ mensagens: [mensagemDeSaida('S1', { group_jid: '120363999999999999@g.us' })], fila, relogioDeTeste: r });
  await t.fluxo.buscar();
  for (let i = 0; i < 6; i++) {
    await t.fluxo.entregarProximas();
    r.avancar(60 * 60_000);
  }
  assert.equal(t.enviadas.length, 0);
  assert.equal(fila.resumo().itens, 0);
  assert.ok(t.log.linhas.some((l) => l.msg.includes('destino recusado')));
});

test('SEG-M12-009: jid que nao e grupo nem telefone nunca e enviado', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const t = saidaDeTeste({ mensagens: [mensagemDeSaida('S1', { group_jid: 'status@broadcast' })], fila });
  await t.fluxo.buscar();
  await t.fluxo.entregarProximas();
  assert.equal(t.enviadas.length, 0);
});

test('SEG-M12-009: mensagem privada para telefone no formato do app continua saindo', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const t = saidaDeTeste({ mensagens: [mensagemDeSaida('S1', { group_jid: '5543988742822@s.whatsapp.net', text: 'Lembrete' })], fila });
  await t.fluxo.buscar();
  const e = await t.fluxo.entregarProximas();
  assert.equal(e.enviadas, 1);
});

test('SEG-M12-014: o ritmo de envio espaca as mensagens (uma por volta ate o intervalo passar)', async () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: pasta(), agora: r.agora });
  fila.iniciar();
  const t = saidaDeTeste({ mensagens: ['S1', 'S2', 'S3'].map((id) => mensagemDeSaida(id)), fila, relogioDeTeste: r });
  await t.fluxo.buscar();
  assert.equal((await t.fluxo.entregarProximas()).enviadas, 1);
  assert.equal((await t.fluxo.entregarProximas()).enviadas, 0, 'ainda dentro do intervalo');
  r.avancar(2000);
  assert.equal((await t.fluxo.entregarProximas()).enviadas, 1);
  r.avancar(2000);
  assert.equal((await t.fluxo.entregarProximas()).enviadas, 1);
  assert.equal(fila.resumo().itens, 0);
});

test('SEG-M12-015: numero_id so vai na busca da fila de saida quando o interruptor estiver ligado', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const desligado = saidaDeTeste({ fila });
  await desligado.fluxo.buscar();
  assert.equal(desligado.gets[0].opcoes.params, undefined);
  const ligado = saidaDeTeste({ fila, config: { ...config, enviarNumeroId: true } });
  await ligado.fluxo.buscar();
  assert.deepEqual(ligado.gets[0].opcoes.params, { numero_id: 'chip-1' });
  assert.equal(ligado.gets[0].url, 'https://app.test/api/whatsapp/outbound');
});

test('app fora do ar ao buscar a fila de saida nao derruba nada', async () => {
  const fila = new FilaEmDisco({ dir: pasta() });
  fila.iniciar();
  const log = registrado();
  const fluxo = criarFluxoDeSaida({
    config, http: { get: async () => { throw new Error('fora'); } }, fila, logger: log,
    limitador: new LimitadorDeEnvio(), gruposConhecidos: () => new Map(), enviar: async () => null,
  });
  assert.equal(await fluxo.buscar(), 0);
});

test('enviarItemDeSaida: texto, apagar, figurinha so do balde, vazio', async () => {
  const chamadas = [];
  const sock = { sendMessage: async (jid, conteudo) => { chamadas.push([jid, conteudo]); return { key: { id: 'X' } }; } };
  const http = { get: async () => ({ data: new Uint8Array([1]).buffer }) };
  await enviarItemDeSaida({ sock, m: { group_jid: 'G', text: 'oi' }, http });
  await enviarItemDeSaida({ sock, m: { group_jid: 'G', action: 'delete', target_msg_id: 'ALVO' }, http });
  await enviarItemDeSaida({ sock, m: { group_jid: 'G', sticker_url: 'https://abc.supabase.co/storage/v1/object/public/stickers/a.webp' }, http });
  assert.equal(chamadas[0][1].text, 'oi');
  assert.equal(chamadas[1][1].delete.id, 'ALVO');
  assert.ok(Buffer.isBuffer(chamadas[2][1].sticker));
  await assert.rejects(() => enviarItemDeSaida({ sock, m: { group_jid: 'G', sticker_url: 'https://evil.test/x.webp' }, http }), /figurinha recusada/);
  assert.equal(await enviarItemDeSaida({ sock, m: { group_jid: 'G' }, http }), null);
});

// entrega ------------------------------------------------------------

function sockDeEntrega({ falhaEm = [] } = {}) {
  const envios = [];
  return {
    envios,
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid, conteudo, opcoes) => {
      const tipo = conteudo.audio ? 'audio' : conteudo.sticker ? 'sticker' : conteudo.react ? 'reacao' : 'texto';
      if (falhaEm.includes(tipo)) throw new Error('falhou ' + tipo);
      envios.push({ tipo, jid, conteudo, opcoes });
      return { key: { id: `ID-${tipo}` } };
    },
  };
}

function depsDeEntrega(extra = {}) {
  const patches = [];
  return {
    patches,
    deps: {
      notaDeVoz: async (b) => ({ audio: b, segundos: 4, convertido: true }),
      http: { get: async () => ({ data: new Uint8Array([1, 2]).buffer }) },
      hostsDeFigurinha: [],
      patchDoId: async (corpo) => { patches.push(corpo); return { ok: true }; },
      logger: silencioso,
      ...extra,
    },
  };
}

const chave = { remoteJid: '1203@g.us', id: 'MSG1', participant: '5511@s.whatsapp.net' };

test('nota de voz: com audio na resposta o bot manda a nota citando quem falou, o texto junto, e o PATCH leva o id da nota', async () => {
  const sock = sockDeEntrega();
  const { deps, patches } = depsDeEntrega();
  const original = { key: { id: 'MSG1' }, message: {} };
  const r = await entregarResposta({
    sock, grupoJid: '1203@g.us', chave, original, deps,
    resposta: { reply_audio_b64: Buffer.from('opus').toString('base64'), reply_text: 'Links: x', capture_id: 'CAP1', reaction_emoji: null },
  });
  assert.deepEqual(sock.envios.map((e) => e.tipo), ['audio', 'texto']);
  assert.equal(sock.envios[0].conteudo.ptt, true);
  assert.equal(sock.envios[0].conteudo.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(sock.envios[0].conteudo.seconds, 4);
  assert.equal(sock.envios[0].opcoes.quoted, original);
  assert.equal(sock.envios[1].opcoes.quoted, original);
  assert.deepEqual(patches, [{ capture_id: 'CAP1', bot_reply_wa_id: 'ID-audio' }]);
  assert.equal(r.patch, true);
});

test('nota de voz: sem audio, o PATCH leva o id do texto; sem capture_id nao ha PATCH', async () => {
  const sock = sockDeEntrega();
  const { deps, patches } = depsDeEntrega();
  await entregarResposta({ sock, grupoJid: '1203@g.us', chave, original: null, deps, resposta: { reply_text: 'ok', capture_id: 'C2' } });
  assert.deepEqual(patches, [{ capture_id: 'C2', bot_reply_wa_id: 'ID-texto' }]);
  assert.equal(sock.envios[0].opcoes, undefined, 'sem a mensagem original em memoria, nao cita');

  const sock2 = sockDeEntrega();
  const d2 = depsDeEntrega();
  await entregarResposta({ sock: sock2, grupoJid: '1203@g.us', chave, original: null, deps: d2.deps, resposta: { reply_text: 'ok', capture_id: null } });
  assert.equal(d2.patches.length, 0);
});

test('falha no envio da nota de voz nao impede o texto, a reacao nem o PATCH com o id do texto', async () => {
  const sock = sockDeEntrega({ falhaEm: ['audio'] });
  const { deps, patches } = depsDeEntrega();
  const r = await entregarResposta({
    sock, grupoJid: '1203@g.us', chave, original: null, deps,
    resposta: { reply_audio_b64: 'AAAA', reply_text: 'texto', reaction_emoji: 'x', capture_id: 'C3' },
  });
  assert.equal(r.audio, false);
  assert.equal(r.reacao, true);
  assert.equal(r.texto, true);
  assert.deepEqual(patches, [{ capture_id: 'C3', bot_reply_wa_id: 'ID-texto' }]);
});

test('reacao: sem a mensagem original, a chave e reconstruida do que ficou na fila', async () => {
  const sock = sockDeEntrega();
  const { deps } = depsDeEntrega();
  await entregarResposta({ sock, grupoJid: '1203@g.us', chave, original: null, deps, resposta: { reaction_emoji: 'x' } });
  assert.deepEqual(sock.envios[0].conteudo.react.key, { remoteJid: '1203@g.us', id: 'MSG1', participant: '5511@s.whatsapp.net', fromMe: false });
});

test('figurinha de endereco fora da lista e recusada sem derrubar o resto', async () => {
  const sock = sockDeEntrega();
  const { deps } = depsDeEntrega();
  const r = await entregarResposta({
    sock, grupoJid: '1203@g.us', chave, original: null, deps,
    resposta: { sticker_url: 'https://evil.test/x.webp', reply_text: 'ok' },
  });
  assert.equal(r.figurinha, false);
  assert.equal(r.texto, true);
});

test('PATCH que falha e registrado sem derrubar a entrega', async () => {
  const sock = sockDeEntrega();
  const log = registrado();
  const { deps } = depsDeEntrega({ logger: log, patchDoId: async () => ({ ok: false, erro: new Error('app fora') }) });
  const r = await entregarResposta({ sock, grupoJid: '1203@g.us', chave, original: null, deps, resposta: { reply_text: 'a', capture_id: 'C' } });
  assert.equal(r.patch, false);
  assert.ok(log.linhas.some((l) => l.nivel === 'warn'));
});

test('planejarEntrega e idParaOPatch', () => {
  assert.deepEqual(planejarEntrega(null), { audio: null, figurinhaUrl: null, reacao: null, texto: null, captureId: null });
  assert.equal(idParaOPatch({ idDoAudio: 'A', idDoTexto: 'T', captureId: 'C' }).bot_reply_wa_id, 'A');
  assert.equal(idParaOPatch({ idDoAudio: null, idDoTexto: 'T', captureId: 'C' }).bot_reply_wa_id, 'T');
  assert.equal(idParaOPatch({ idDoAudio: null, idDoTexto: null, captureId: 'C' }), null);
  assert.equal(idParaOPatch({ idDoAudio: 'A', idDoTexto: null, captureId: null }), null);
});
