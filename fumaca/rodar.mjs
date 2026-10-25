/**
 * Fumaca do index.js sem WhatsApp e sem rede.
 *
 * Copia src/ para uma pasta temporaria, poe ali modulos de mentira no lugar do
 * Baileys, do axios e do pino, e roda o bot de verdade contra um roteiro:
 * conecta, recebe mensagens (documento com legenda embrulhado, arquivo grande,
 * mensagem temporaria, upsert com requestId, mensagem com o app fora do ar) e
 * um pedido de entrar em grupo. No fim confere o que o bot enviou e o que
 * gravou em disco.
 *
 *   node fumaca/rodar.mjs
 *
 * Nao e parte do `npm test` (leva uns 15 s por causa dos relogios do bot).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fumaca-bot-'));
fs.cpSync(path.join(raiz, 'src'), path.join(tmp, 'src'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

function modulo(nome, arquivos, extra = {}) {
  const dir = path.join(tmp, 'node_modules', nome);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: nome, version: '9.9.9', type: 'module', main: 'index.js', ...extra }));
  for (const [arq, conteudo] of Object.entries(arquivos)) fs.writeFileSync(path.join(dir, arq), conteudo);
}

const REGISTRO = path.join(tmp, 'registro.json');

modulo('dotenv', { 'index.js': 'export default {};', 'config.js': '' }, { exports: { '.': './index.js', './config': './config.js' } });
modulo('qrcode-terminal', { 'index.js': 'export default { generate() {} };' });
modulo('@hapi/boom', { 'index.js': 'export class Boom { constructor(e) { this.output = { statusCode: e?.output?.statusCode }; } }' });
modulo('pino', {
  'index.js': `
const niveis = ['debug', 'info', 'warn', 'error'];
export default function pino(o = {}) {
  const l = {};
  for (const n of niveis) l[n] = (obj, msg) => {
    if (typeof obj === 'string') { msg = obj; obj = {}; }
    globalThis.__registro?.logs.push({ n, obj, msg });
  };
  return l;
}`,
});

// axios de mentira: o roteiro decide o que cada chamada devolve
modulo('axios', {
  'index.js': `
const r = () => globalThis.__registro;
function chamada(metodo, url, corpo, opcoes) {
  r().http.push({ metodo, url, corpo: metodo === 'get' ? undefined : corpo, params: opcoes?.params });
  return globalThis.__roteiro(metodo, url, corpo, opcoes);
}
export default {
  get: (u, o) => chamada('get', u, undefined, o),
  post: (u, c, o) => chamada('post', u, c, o),
  put: (u, c, o) => chamada('put', u, c, o),
  patch: (u, c, o) => chamada('patch', u, c, o),
};`,
});

// Baileys de mentira: o socket guarda os handlers e o roteiro os dispara
modulo('@whiskeysockets/baileys', {
  'index.js': `
export async function useMultiFileAuthState(dir) {
  return { state: { creds: { registered: true, account: {} } }, saveCreds: async () => {} };
}
export async function fetchLatestBaileysVersion() { return { version: [2, 3000, 1] }; }
export async function downloadMediaMessage() { return Buffer.from('conteudo-do-arquivo'); }
export default function makeWASocket(opcoes) {
  const handlers = {};
  const sock = {
    opcoes,
    ev: { on: (e, f) => { (handlers[e] ||= []).push(f); } },
    authState: { creds: { registered: true } },
    user: { id: '5500000000000:1@s.whatsapp.net', lid: '111:1@lid' },
    async sendMessage(jid, conteudo, o) {
      globalThis.__registro.envios.push({ jid, conteudo: { ...conteudo, audio: undefined, sticker: undefined }, citou: !!o?.quoted });
      const m = { key: { id: 'BOT' + globalThis.__registro.envios.length }, message: { conversation: 'x' } };
      return m;
    },
    async sendPresenceUpdate() {},
    async groupFetchAllParticipating() { return globalThis.__grupos(); },
    async groupMetadata(jid) { return { id: jid, subject: 'Escritorio Novo', participants: [{ id: '5543111111111@s.whatsapp.net', admin: 'admin' }] }; },
    async groupAcceptInvite() { return '120363777777777777@g.us'; },
    async groupGetInviteInfo() { return { id: '120363777777777777@g.us' }; },
    async profilePictureUrl() { return null; },
    async requestPairingCode() { return 'ABCD1234'; },
    updateMediaMessage() {},
  };
  globalThis.__sock = sock;
  globalThis.__emitir = async (evento, dados) => { for (const f of handlers[evento] || []) await f(dados); };
  globalThis.__roteiroIniciar?.();
  return sock;
}`,
});

const CASA = '120363000000000001@g.us';
const CLIENTE = '120363000000000002@g.us';
const NOVO = '120363777777777777@g.us';

fs.writeFileSync(
  path.join(tmp, 'preload.mjs'),
  `
import fs from 'node:fs';
globalThis.__registro = { http: [], envios: [], logs: [] };
let mensagemQ = 0;
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.__grupos = () => ({
  '${CASA}': { subject: 'EBADV. Captura' },
  '${CLIENTE}': { subject: 'Escritorio Cliente' },
});
globalThis.__roteiro = async (metodo, url, corpo) => {
  if (url.includes('/pedidos') && metodo === 'put') {
    const grupos = [{ jid: '${CLIENTE}', nome: 'Escritorio Cliente', modo: 'captura', org_id: 'org-cliente' }];
    if (globalThis.__registro.http.some((h) => h.metodo === 'post' && h.url.endsWith('/pedidos'))) {
      grupos.push({ jid: '${NOVO}', nome: 'Escritorio Novo', modo: 'captura', org_id: 'org-novo' });
    }
    return { data: { ok: true, grupos } };
  }
  if (url.includes('/pedidos') && metodo === 'get') {
    globalThis.__pedidoEntregue = (globalThis.__pedidoEntregue || 0) + 1;
    const pedidos = globalThis.__pedidoEntregue === 1 ? [{ id: 'ped-1', org_id: 'org-novo', tipo: 'entrar_grupo', payload: { codigo: 'ABCDEFGHIJKLMNOP' } }] : [];
    return { data: { ok: true, pedidos } };
  }
  if (url.endsWith('/pedidos') && metodo === 'post') return { data: { ok: true } };
  if (url.endsWith('/capture') && metodo === 'post') {
    if (corpo.wa_message_id === 'MSGQ' && ++mensagemQ === 1) {
      const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e;
    }
    return { data: { ok: true, classification: 'captura', reaction_emoji: 'R', capture_id: 'CAP-' + corpo.wa_message_id, reply_text: corpo.wa_message_id === 'MSGDOC' ? 'Anexei o PDF' : null } };
  }
  if (url.endsWith('/capture') && metodo === 'patch') return { data: { ok: true } };
  if (url.endsWith('/outbound') && metodo === 'get') return { data: { ok: true, mensagens: globalThis.__saida || [] } };
  if (url.endsWith('/outbound') && metodo === 'post') return { data: { ok: true } };
  return { data: { ok: true } };
};
globalThis.__roteiroIniciar = () => {
  (async () => {
    await dorme(200);
    await globalThis.__emitir('connection.update', { connection: 'open' });
    await dorme(500);
    const base = (id, grupo, message, extra = {}) => ({ messages: [{ key: { id, remoteJid: grupo, participant: '5543999999999@s.whatsapp.net' }, pushName: 'Fulana de Tal', messageTimestamp: 1760000000, message, ...extra }], type: 'notify' });
    // 1. documento com legenda (embrulhado) no grupo da casa
    await globalThis.__emitir('messages.upsert', base('MSGDOC', '${CASA}', { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'peticao.pdf', mimetype: 'application/pdf', caption: 'SILVA. protocolar a contestacao', fileLength: 1000 } } } }));
    // 2. arquivo grande
    await globalThis.__emitir('messages.upsert', base('MSGGRANDE', '${CASA}', { documentMessage: { fileName: 'enorme.pdf', mimetype: 'application/pdf', fileLength: 5 * 1024 * 1024 } }));
    // 3. mensagem temporaria no grupo do cliente
    await globalThis.__emitir('messages.upsert', base('MSGTEMP', '${CLIENTE}', { ephemeralMessage: { message: { extendedTextMessage: { text: 'SEGREDO-DO-CLIENTE. juntar procuracao' } } } }));
    // 4. upsert com requestId: descartado
    await globalThis.__emitir('messages.upsert', { ...base('MSGFALSA', '${CASA}', { conversation: 'forjada' }), requestId: 'abc' });
    // 5. grupo que nao e alvo: ignorado
    await globalThis.__emitir('messages.upsert', base('MSGFORA', '120363999999999999@g.us', { conversation: 'de outro grupo' }));
    // 6. app fora do ar na primeira tentativa
    await globalThis.__emitir('messages.upsert', base('MSGQ', '${CASA}', { conversation: 'CLIENTE. com o app fora do ar' }));
    // 7. mensagem de saida do app
    globalThis.__saida = [{ id: 'S1', group_jid: '${CASA}', text: 'Lembrete do app', motivo: 'regra' }, { id: 'S2', group_jid: '120363999999999999@g.us', text: 'para grupo desconhecido', motivo: 'regra' }];
  })();
  setTimeout(() => {
    fs.writeFileSync(process.env.FUMACA_REGISTRO, JSON.stringify(globalThis.__registro));
    process.exit(0);
  }, 22000);
};
`,
);

const env = {
  PATH: process.env.PATH,
  FUMACA_REGISTRO: REGISTRO,
  LIS_CAPTURE_URL: 'https://app.test/api/whatsapp/capture',
  LIS_CAPTURE_SECRET: 'segredo',
  WA_GROUP_NAMES: 'EBADV. Captura',
  WA_NUMERO_ID: 'chip-1',
  WA_AUTH_DIR: path.join(tmp, 'auth_state'),
  WA_ESTADO_DIR: path.join(tmp, 'estado'),
  WA_PEDIDOS_INTERVALO_S: '15',
};
const r = spawnSync(process.execPath, ['--import', path.join(tmp, 'preload.mjs'), path.join(tmp, 'src/index.js')], { cwd: tmp, env, encoding: 'utf8', timeout: 60_000 });
if (!fs.existsSync(REGISTRO)) {
  console.error('o bot nao terminou como esperado');
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(1);
}
const reg = JSON.parse(fs.readFileSync(REGISTRO, 'utf8'));
if (process.env.FUMACA_DEBUG) {
  for (const l of reg.logs) console.log(l.n, l.msg, JSON.stringify(l.obj));
  console.log(JSON.stringify(reg.http.map((h) => h.metodo + ' ' + h.url)));
}
const capturas = reg.http.filter((h) => h.metodo === 'post' && h.url.endsWith('/capture'));
const porId = (id) => capturas.filter((c) => c.corpo.wa_message_id === id);

// 1. documento embrulhado chegou ao app, com a legenda e o contrato da nota de voz
assert.equal(porId('MSGDOC').length, 1, 'documento com legenda nao chegou');
assert.equal(porId('MSGDOC')[0].corpo.message_type, 'document');
assert.equal(porId('MSGDOC')[0].corpo.text_content, 'SILVA. protocolar a contestacao');
assert.deepEqual(porId('MSGDOC')[0].corpo.capacidades, ['nota_de_voz']);
assert.ok(porId('MSGDOC')[0].corpo.file?.base64, 'o arquivo deveria ter ido');
assert.equal(porId('MSGDOC')[0].corpo.org_id, undefined, 'grupo da casa nao leva org_id');
// 2. arquivo grande: nao foi ao app, o grupo foi avisado
assert.equal(porId('MSGGRANDE').length, 0);
assert.ok(reg.envios.some((e) => e.conteudo.react && e.conteudo.react.key.id === 'MSGGRANDE'), 'sem reacao de aviso');
assert.ok(reg.envios.some((e) => e.conteudo.text && /limite/.test(e.conteudo.text)), 'sem frase de aviso');
// 3. mensagem temporaria do cliente chegou com a org do cadastro
assert.equal(porId('MSGTEMP').length, 1);
assert.equal(porId('MSGTEMP')[0].corpo.org_id, 'org-cliente');
assert.equal(porId('MSGTEMP')[0].corpo.text_content, 'SEGREDO-DO-CLIENTE. juntar procuracao');
// 4 e 5. requestId e grupo fora: nada
assert.equal(porId('MSGFALSA').length, 0);
assert.equal(porId('MSGFORA').length, 0);
// 6. app fora do ar: a mensagem ficou na fila e foi entregue depois
assert.equal(porId('MSGQ').length, 2, 'deveria ter tentado duas vezes');
// reacoes e PATCH
assert.ok(reg.envios.some((e) => e.conteudo.react && e.conteudo.react.key.id === 'MSGDOC' && e.conteudo.react.text === 'R'));
assert.ok(reg.envios.some((e) => e.conteudo.text === 'Anexei o PDF' && e.citou));
const patches = reg.http.filter((h) => h.metodo === 'patch');
assert.ok(patches.some((p) => p.corpo.capture_id === 'CAP-MSGDOC' && p.corpo.bot_reply_wa_id), 'sem PATCH do id da resposta');
// 7. saida: so o destino conhecido saiu; o desconhecido nao
assert.ok(reg.envios.some((e) => e.jid === CASA && e.conteudo.text === 'Lembrete do app'), 'a mensagem de saida nao saiu');
assert.ok(!reg.envios.some((e) => e.conteudo.text === 'para grupo desconhecido'));
// pedido: entrou, o app confirmou na tabela, o bot se apresentou
assert.ok(reg.envios.some((e) => e.jid === NOVO && /Clio/.test(e.conteudo.text || '')), 'sem apresentacao no grupo novo');
const heartbeats = reg.http.filter((h) => h.url.endsWith('/heartbeat'));
assert.ok(heartbeats.length >= 1);
assert.equal(heartbeats[0].corpo.baileys_version, '9.9.9');
assert.equal(heartbeats[0].corpo.numero_id, undefined, 'numero_id so vai com WA_ENVIAR_NUMERO_ID');
assert.equal(heartbeats[0].corpo.jids_grupos[CLIENTE], 'grupo de escritorio cliente');
assert.equal(heartbeats[0].corpo.jids_grupos[CASA], 'EBADV. Captura');
// o jid da casa foi gravado
const gravado = JSON.parse(fs.readFileSync(path.join(tmp, 'estado/grupos-da-casa.json'), 'utf8'));
assert.deepEqual(gravado.salvos, { 'EBADV. Captura': CASA });
// log sem dado pessoal
const todoOLog = JSON.stringify(reg.logs);
for (const proibido of ['Fulana', 'SEGREDO-DO-CLIENTE', 'SILVA', 'contestacao', 'Escritorio Cliente', 'Escritorio Novo', '5543999999999']) {
  assert.ok(!todoOLog.includes(proibido), `o log carrega "${proibido}"`);
}
// fila de entrada vazia no fim
const sobra = fs.existsSync(path.join(tmp, 'estado/fila-entrada')) ? fs.readdirSync(path.join(tmp, 'estado/fila-entrada')).length : 0;
assert.equal(sobra, 0, 'a fila de entrada deveria ter esvaziado');

console.log('fumaca ok:', JSON.stringify({ capturas: capturas.length, envios: reg.envios.length, linhasDeLog: reg.logs.length }));
