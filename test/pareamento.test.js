import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { criarAvisoDePareamento } from '../src/lib/pareamento.js';

function pastaTemporaria() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pareamento-'));
}

test('sem marca, nada pendente', () => {
  const dir = pastaTemporaria();
  const aviso = criarAvisoDePareamento({ arquivo: path.join(dir, 'estado', 'pareamento-novo.json') });
  assert.equal(aviso.pendente(), false);
});

test('marcar deixa pendente, inclusive para um processo novo lendo o mesmo arquivo', () => {
  const dir = pastaTemporaria();
  const arquivo = path.join(dir, 'estado', 'pareamento-novo.json');
  criarAvisoDePareamento({ arquivo }).marcar();
  assert.equal(criarAvisoDePareamento({ arquivo }).pendente(), true);
});

test('a marca nasce so com o dono (0600) e a pasta em 0700', () => {
  const dir = pastaTemporaria();
  const arquivo = path.join(dir, 'estado', 'pareamento-novo.json');
  const antes = process.umask(0o022);
  try {
    criarAvisoDePareamento({ arquivo }).marcar();
  } finally {
    process.umask(antes);
  }
  assert.equal(fs.statSync(arquivo).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(arquivo)).mode & 0o777, 0o700);
});

test('limpar apaga a marca e pode ser chamado sem marca', () => {
  const dir = pastaTemporaria();
  const arquivo = path.join(dir, 'estado', 'pareamento-novo.json');
  const aviso = criarAvisoDePareamento({ arquivo });
  aviso.marcar();
  aviso.limpar();
  assert.equal(aviso.pendente(), false);
  assert.equal(fs.existsSync(arquivo), false);
  aviso.limpar();
});

test('arquivo corrompido nao conta como pendente nem quebra', () => {
  const dir = pastaTemporaria();
  const arquivo = path.join(dir, 'pareamento-novo.json');
  fs.writeFileSync(arquivo, '{nao e json');
  assert.equal(criarAvisoDePareamento({ arquivo }).pendente(), false);
});
