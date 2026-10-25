import test from 'node:test';
import assert from 'node:assert/strict';
import { esperaCrescente, classificarFalha, comTentativas } from '../src/lib/espera.js';
import {
  classificarJid,
  destinoPermitido,
  urlDeFigurinhaPermitida,
  baixarFigurinhaSegura,
  LIMITE_FIGURINHA_BYTES,
} from '../src/lib/destino.js';
import { decidirSaida, registrarQueda, esperaAntesDeConectar } from '../src/lib/conexao.js';

// espera -------------------------------------------------------------

test('espera crescente dobra a cada tentativa e para no teto', () => {
  const sem = { jitter: 0 };
  assert.equal(esperaCrescente(1, { ...sem, baseMs: 5000 }), 5000);
  assert.equal(esperaCrescente(2, { ...sem, baseMs: 5000 }), 10000);
  assert.equal(esperaCrescente(3, { ...sem, baseMs: 5000 }), 20000);
  assert.equal(esperaCrescente(30, { ...sem, baseMs: 5000, maxMs: 900000 }), 900000);
  assert.equal(esperaCrescente(0, { ...sem, baseMs: 5000 }), 5000);
});

test('o jitter fica dentro de 20 por cento', () => {
  assert.equal(esperaCrescente(1, { baseMs: 10000, aleatorio: () => 0 }), 8000);
  assert.equal(esperaCrescente(1, { baseMs: 10000, aleatorio: () => 1 }), 12000);
});

test('classificarFalha: app fora do ar e segredo trocado repetem e avisam que e infraestrutura', () => {
  for (const err of [
    { message: 'timeout of 280000ms exceeded', code: 'ECONNABORTED' },
    { response: { status: 502 } },
    { response: { status: 503 } },
    { response: { status: 504 } },
    { response: { status: 401 } },
    { response: { status: 403 } },
    { response: { status: 429 } },
  ]) {
    const c = classificarFalha(err);
    assert.equal(c.repetir, true, JSON.stringify(err));
    assert.equal(c.infra, true, JSON.stringify(err));
  }
});

test('classificarFalha: erro 500 repete sem parar as outras; 4xx do app nao repete', () => {
  assert.deepEqual(classificarFalha({ response: { status: 500 } }), { repetir: true, infra: false, status: 500, motivo: 'erro_do_app' });
  assert.equal(classificarFalha({ response: { status: 409 } }).repetir, false);
  assert.equal(classificarFalha({ response: { status: 409 } }).motivo, 'org_diverge');
  assert.equal(classificarFalha({ response: { status: 413 } }).motivo, 'corpo_grande_demais');
  assert.equal(classificarFalha({ response: { status: 400 } }).repetir, false);
  assert.equal(classificarFalha({ response: { status: 404 } }).repetir, false);
});

test('comTentativas repete ate dar certo e para em erro que nao adianta repetir', async () => {
  let n = 0;
  const esperas = [];
  const ok = await comTentativas(async () => { n++; if (n < 3) throw { message: 'x' }; return 'pronto'; }, { esperarFn: async (ms) => esperas.push(ms) });
  assert.deepEqual(ok, { ok: true, valor: 'pronto' });
  assert.equal(n, 3);
  assert.deepEqual(esperas, [1500, 3000]);

  let m = 0;
  const falha = await comTentativas(async () => { m++; throw { response: { status: 400 } }; }, { esperarFn: async () => {} });
  assert.equal(falha.ok, false);
  assert.equal(m, 1);
});

// destino ------------------------------------------------------------

test('SEG-M12-009: classificar jid em grupo, privado e invalido', () => {
  assert.equal(classificarJid('120363025246125486@g.us'), 'grupo');
  assert.equal(classificarJid('5543988742822-1612345678@g.us'), 'grupo');
  assert.equal(classificarJid('5543988742822@s.whatsapp.net'), 'privado');
  for (const ruim of ['status@broadcast', '123@broadcast', '123@newsletter', '12345@lid', 'abc@g.us', '', null, undefined, '5543988742822']) {
    assert.equal(classificarJid(ruim), 'invalido', String(ruim));
  }
});

test('SEG-M12-009: grupo so recebe se estiver no mapa; privado so no formato de telefone', () => {
  const conhecidos = new Map([['120363025246125486@g.us', 'x']]);
  assert.equal(destinoPermitido('120363025246125486@g.us', { gruposConhecidos: conhecidos }).ok, true);
  const fora = destinoPermitido('120363999999999999@g.us', { gruposConhecidos: conhecidos });
  assert.equal(fora.ok, false);
  assert.equal(fora.motivo, 'grupo_fora_do_mapa');
  assert.equal(destinoPermitido('5543988742822@s.whatsapp.net', { gruposConhecidos: conhecidos }).ok, true);
  assert.equal(destinoPermitido('status@broadcast', { gruposConhecidos: conhecidos }).ok, false);
});

test('SEG-M12-009: figurinha so do balde stickers do Supabase, por https', () => {
  const ok = 'https://abcdefgh.supabase.co/storage/v1/object/public/stickers/oi.webp';
  assert.equal(urlDeFigurinhaPermitida(ok).ok, true);
  const recusadas = [
    'http://abcdefgh.supabase.co/storage/v1/object/public/stickers/oi.webp',
    'https://evil.example.com/storage/v1/object/public/stickers/oi.webp',
    'https://supabase.co.evil.com/storage/v1/object/public/stickers/oi.webp',
    'https://supabase.co/storage/v1/object/public/stickers/oi.webp',
    'https://abcdefgh.supabase.co/storage/v1/object/public/outro/oi.webp',
    'https://user:senha@abcdefgh.supabase.co/storage/v1/object/public/stickers/oi.webp',
    'https://abcdefgh.supabase.co:8443/storage/v1/object/public/stickers/oi.webp',
    'https://169.254.169.254/latest/meta-data/',
    'http://localhost:3000/x',
    'nao e url',
    '',
  ];
  for (const u of recusadas) assert.equal(urlDeFigurinhaPermitida(u).ok, false, u);
  assert.equal(urlDeFigurinhaPermitida('https://cdn.minha.com/storage/v1/object/public/stickers/a.webp', { hosts: ['cdn.minha.com'] }).ok, true);
});

test('SEG-M12-009: baixar figurinha usa teto de tamanho, sem redirecionamento, e recusa endereco fora da lista', async () => {
  const chamadas = [];
  const http = { get: async (url, opcoes) => { chamadas.push({ url, opcoes }); return { data: new Uint8Array([1, 2, 3]).buffer }; } };
  const url = 'https://abc.supabase.co/storage/v1/object/public/stickers/a.webp';
  const buf = await baixarFigurinhaSegura({ http, url });
  assert.equal(buf.length, 3);
  assert.equal(chamadas[0].opcoes.maxContentLength, LIMITE_FIGURINHA_BYTES);
  assert.equal(chamadas[0].opcoes.maxRedirects, 0);
  await assert.rejects(() => baixarFigurinhaSegura({ http, url: 'https://evil.example.com/x' }), /figurinha recusada/);
  assert.equal(chamadas.length, 1, 'nao pode ter feito requisicao para o endereco recusado');
  const grande = { get: async () => ({ data: new Uint8Array(LIMITE_FIGURINHA_BYTES + 1).buffer }) };
  await assert.rejects(() => baixarFigurinhaSegura({ http: grande, url }), /grande_demais/);
});

// conexao ------------------------------------------------------------

test('SEG-M12-013: sessao encerrada, numero bloqueado, sessao em outro lugar e multidevice saem com 3 e avisam o app', () => {
  for (const [code, motivo] of [[401, 'logged_out'], [403, 'forbidden'], [440, 'connection_replaced'], [411, 'multidevice_mismatch']]) {
    const d = decidirSaida({ code });
    assert.equal(d.codigoDeSaida, 3, String(code));
    assert.equal(d.avisarApp, true);
    assert.equal(d.motivo, motivo);
  }
});

test('SEG-M12-013: quedas comuns saem com 1 para o systemd subir de novo', () => {
  for (const code of [408, 428, 515, 503, undefined]) {
    const d = decidirSaida({ code });
    assert.equal(d.codigoDeSaida, 1, String(code));
    assert.equal(d.avisarApp, false);
  }
});

test('SEG-M12-013: pareamento que nao foi concluido sai com 3 sem avisar o app (um codigo por execucao)', () => {
  const d = decidirSaida({ code: 408, pareando: true, pareouComSucesso: false });
  assert.equal(d.codigoDeSaida, 3);
  assert.equal(d.motivo, 'pareamento_nao_concluido');
  assert.equal(d.avisarApp, false);
  // depois de parear, o 515 que o WhatsApp manda e uma queda comum
  assert.equal(decidirSaida({ code: 515, pareando: true, pareouComSucesso: true }).codigoDeSaida, 1);
});

test('SEG-M12-013: erro 500 so vira permanente na terceira seguida sem conectar', () => {
  const agora = 1_760_000_000_000;
  let h = [];
  assert.equal(decidirSaida({ code: 500, historico: h, agora }).codigoDeSaida, 1);
  h = registrarQueda(h, { code: 500, abriu: false }, agora);
  assert.equal(decidirSaida({ code: 500, historico: h, agora: agora + 1000 }).codigoDeSaida, 1);
  h = registrarQueda(h, { code: 500, abriu: false }, agora + 1000);
  const terceira = decidirSaida({ code: 500, historico: h, agora: agora + 2000 });
  assert.equal(terceira.codigoDeSaida, 3);
  assert.equal(terceira.motivo, 'bad_session');
  // se numa das partidas anteriores o bot chegou a conectar, nao desiste
  const comAbertura = registrarQueda(registrarQueda([], { code: 500, abriu: true }, agora), { code: 500, abriu: false }, agora + 1);
  assert.equal(decidirSaida({ code: 500, historico: comAbertura, agora: agora + 2 }).codigoDeSaida, 1);
});

test('SEG-M12-013: espera antes de conectar cresce com partidas seguidas sem conectar e zera quando conecta', () => {
  const agora = 1_760_000_000_000;
  assert.equal(esperaAntesDeConectar([], agora), 0);
  let h = registrarQueda([], { code: 408, abriu: false }, agora);
  assert.equal(esperaAntesDeConectar(h, agora + 1), 0);
  h = registrarQueda(h, { code: 408, abriu: false }, agora + 1);
  assert.equal(esperaAntesDeConectar(h, agora + 2), 10_000);
  h = registrarQueda(h, { code: 408, abriu: false }, agora + 2);
  assert.equal(esperaAntesDeConectar(h, agora + 3), 20_000);
  for (let i = 0; i < 10; i++) h = registrarQueda(h, { code: 408, abriu: false }, agora + 4 + i);
  assert.equal(esperaAntesDeConectar(h, agora + 100), 300_000);
  h = registrarQueda(h, { code: 408, abriu: true }, agora + 200);
  assert.equal(esperaAntesDeConectar(h, agora + 300), 0);
  // o historico velho nao pesa
  assert.equal(esperaAntesDeConectar(h, agora + 3 * 3600_000), 0);
});

test('registrarQueda poda o que passou da janela', () => {
  const agora = 1_760_000_000_000;
  const h = registrarQueda([{ ts: agora - 2 * 3600_000, code: 408, abriu: false }], { code: 408, abriu: false }, agora);
  assert.equal(h.length, 1);
});
