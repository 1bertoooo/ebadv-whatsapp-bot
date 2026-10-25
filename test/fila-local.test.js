import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilaEmDisco } from '../src/lib/fila-local.js';

function pasta() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fila-bot-'));
}

function relogio(inicio = 1_760_000_000_000) {
  let t = inicio;
  return { agora: () => t, avancar: (ms) => { t += ms; } };
}

test('SEG-M12-006: o item sobrevive a um reinicio (nova instancia sobre a mesma pasta)', () => {
  const dir = path.join(pasta(), 'fila');
  const r = relogio();
  const a = new FilaEmDisco({ dir, agora: r.agora });
  a.iniciar();
  assert.equal(a.adicionar('MSG1', { payload: { x: 1 } }).adicionado, true);
  r.avancar(10);
  a.adicionar('MSG2', { payload: { x: 2 } });

  const b = new FilaEmDisco({ dir, agora: r.agora });
  const lido = b.iniciar();
  assert.equal(lido.itens, 2);
  assert.deepEqual(b.prontos(), ['MSG1', 'MSG2']);
  assert.deepEqual(b.obter('MSG2').dados, { payload: { x: 2 } });
});

test('o mesmo id nao entra duas vezes', () => {
  const fila = new FilaEmDisco({ dir: path.join(pasta(), 'f') });
  fila.iniciar();
  assert.equal(fila.adicionar('A', {}).adicionado, true);
  const dup = fila.adicionar('A', {});
  assert.equal(dup.adicionado, false);
  assert.equal(dup.duplicado, true);
  assert.equal(fila.resumo().itens, 1);
});

test('falha agenda a proxima tentativa e o item so fica pronto depois da espera', () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: path.join(pasta(), 'f'), agora: r.agora });
  fila.iniciar();
  fila.adicionar('A', {});
  const f = fila.registrarFalha('A', 5000);
  assert.equal(f.tentativas, 1);
  assert.deepEqual(fila.prontos(), []);
  r.avancar(4999);
  assert.deepEqual(fila.prontos(), []);
  r.avancar(1);
  assert.deepEqual(fila.prontos(), ['A']);
  assert.equal(fila.tentativas('A'), 1);
});

test('tentativas e espera tambem sobrevivem ao reinicio', () => {
  const dir = path.join(pasta(), 'f');
  const r = relogio();
  const a = new FilaEmDisco({ dir, agora: r.agora });
  a.iniciar();
  a.adicionar('A', {});
  a.registrarFalha('A', 60_000);
  a.registrarFalha('A', 60_000);
  const b = new FilaEmDisco({ dir, agora: r.agora });
  b.iniciar();
  assert.equal(b.tentativas('A'), 2);
  assert.deepEqual(b.prontos(), []);
});

test('teto de itens: o mais antigo sai para dar lugar ao novo e e informado', () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: path.join(pasta(), 'f'), maxItens: 3, agora: r.agora });
  fila.iniciar();
  for (const id of ['1', '2', '3']) { fila.adicionar(id, {}); r.avancar(1); }
  const res = fila.adicionar('4', {});
  assert.deepEqual(res.descartados, ['1']);
  assert.deepEqual(fila.prontos(), ['2', '3', '4']);
  assert.equal(fs.readdirSync(fila.dir).length, 3);
});

test('teto de bytes: tira os mais antigos ate caber e recusa item maior que o teto', () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: path.join(pasta(), 'f'), maxBytes: 1000, agora: r.agora });
  fila.iniciar();
  fila.adicionar('a', { c: 'x'.repeat(200) }); r.avancar(1);
  fila.adicionar('b', { c: 'x'.repeat(200) }); r.avancar(1);
  fila.adicionar('c', { c: 'x'.repeat(200) }); r.avancar(1);
  const res = fila.adicionar('d', { c: 'x'.repeat(200) });
  assert.ok(res.descartados.includes('a'));
  assert.ok(fila.resumo().bytes <= 1000);
  const grande = fila.adicionar('e', { c: 'x'.repeat(5000) });
  assert.equal(grande.adicionado, false);
  assert.equal(grande.grandeDemais, true);
});

test('validade: o que passou do prazo e apagado do disco', () => {
  const r = relogio();
  const fila = new FilaEmDisco({ dir: path.join(pasta(), 'f'), validadeMs: 1000, agora: r.agora });
  fila.iniciar();
  fila.adicionar('velho', {});
  r.avancar(2000);
  fila.adicionar('novo', {});
  assert.deepEqual(fila.expirar(), ['velho']);
  assert.deepEqual(fila.prontos(), ['novo']);
  assert.equal(fs.readdirSync(fila.dir).length, 1);
});

test('remover apaga o arquivo e libera os bytes', () => {
  const fila = new FilaEmDisco({ dir: path.join(pasta(), 'f') });
  fila.iniciar();
  fila.adicionar('A', { c: 'abc' });
  assert.ok(fila.resumo().bytes > 0);
  assert.equal(fila.remover('A'), true);
  assert.equal(fila.resumo().bytes, 0);
  assert.equal(fs.readdirSync(fila.dir).length, 0);
  assert.equal(fila.remover('A'), false);
});

test('atualizarDados troca os dados e mantem as tentativas', () => {
  const fila = new FilaEmDisco({ dir: path.join(pasta(), 'f') });
  fila.iniciar();
  fila.adicionar('A', { m: 1, enviado: null });
  fila.registrarFalha('A', 10);
  fila.atualizarDados('A', { m: 1, enviado: { bot_msg_id: 'Z' } });
  const item = fila.obter('A');
  assert.equal(item.dados.enviado.bot_msg_id, 'Z');
  assert.equal(item.tentativas, 1);
});

test('arquivo corrompido e temporario sobrando sao limpos ao iniciar', () => {
  const dir = path.join(pasta(), 'f');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '00000000000001-000001-ruim.json'), '{nao e json');
  fs.writeFileSync(path.join(dir, 'x.json.tmp'), 'meio escrito');
  const fila = new FilaEmDisco({ dir });
  const lido = fila.iniciar();
  assert.equal(lido.itens, 0);
  assert.equal(lido.corrompidos, 1);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('pasta 0700 e arquivos 0600 (o corpo da mensagem fica so com o dono)', { skip: process.platform === 'win32' }, () => {
  const fila = new FilaEmDisco({ dir: path.join(pasta(), 'f') });
  fila.iniciar();
  fila.adicionar('A', {});
  assert.equal(fs.statSync(fila.dir).mode & 0o777, 0o700);
  const [arquivo] = fs.readdirSync(fila.dir);
  assert.equal(fs.statSync(path.join(fila.dir, arquivo)).mode & 0o777, 0o600);
});

test('ids com caracteres estranhos nao saem da pasta', () => {
  const fila = new FilaEmDisco({ dir: path.join(pasta(), 'f') });
  fila.iniciar();
  fila.adicionar('../../etc/passwd', {});
  const nomes = fs.readdirSync(fila.dir);
  assert.equal(nomes.length, 1);
  assert.ok(!nomes[0].includes('/'));
  assert.deepEqual(fila.prontos(), ['../../etc/passwd']);
});
