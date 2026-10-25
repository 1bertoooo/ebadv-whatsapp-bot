/**
 * Guardas que leem o proprio codigo: pegam a regressao que um teste de
 * comportamento nao pega (alguem voltar a escrever nome ou texto no log, a
 * usar setInterval, a deixar um travessao em comentario).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// montados por codigo para este arquivo nao conter o que procura
const TRAVESSAO = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const EMOJI = new RegExp('[' + String.fromCodePoint(0x1f300) + '-' + String.fromCodePoint(0x1faff) + String.fromCharCode(0x2600) + '-' + String.fromCharCode(0x27bf) + ']', 'u');

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arquivos(dir, ext) {
  const achados = [];
  for (const nome of fs.readdirSync(dir, { withFileTypes: true })) {
    if (nome.name === 'node_modules' || nome.name.startsWith('.')) continue;
    const caminho = path.join(dir, nome.name);
    if (nome.isDirectory()) achados.push(...arquivos(caminho, ext));
    else if (ext.some((e) => nome.name.endsWith(e))) achados.push(caminho);
  }
  return achados;
}

const fontes = arquivos(path.join(raiz, 'src'), ['.js']);

test('node --check passa em todo arquivo de src (copiado para .mjs, porque o projeto e ESM)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-bot-'));
  for (const f of fontes) {
    const copia = path.join(tmp, path.basename(f).replace(/\.js$/, '.mjs'));
    fs.copyFileSync(f, copia);
    const r = spawnSync(process.execPath, ['--check', copia], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(raiz, f)}: ${r.stderr}`);
  }
});

/** Primeiro argumento (objeto) de cada chamada logger.nivel({ ... }, ...), ignorando o que esta dentro de texto. */
function objetosDeLog(src) {
  const achados = [];
  const re = /logger(?:\[[^\]]+\]|\.(?:info|warn|error|debug))\(\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex - 1;
    let profundidade = 0;
    let aspas = null;
    const inicio = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (aspas) {
        if (c === '\\') i++;
        else if (c === aspas) aspas = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') aspas = c;
      else if (c === '{') profundidade++;
      else if (c === '}') {
        profundidade--;
        if (profundidade === 0) break;
      }
    }
    achados.push(src.slice(inicio, i + 1));
  }
  return achados;
}

const PROIBIDOS = [
  'sender', 'preview', 'nome', 'name', 'texto', 'text', 'pushName', 'subject', 'telefone', 'phone', 'fone',
  'payload', 'msg', 'mensagem', 'text_content', 'wa_sender_name', 'wa_sender_jid', 'wa_sender_phone', 'participante', 'participants',
];

test('LGPD-004: nenhuma chamada de logger leva nome, telefone, texto ou o corpo da mensagem', () => {
  let total = 0;
  for (const f of fontes) {
    const src = fs.readFileSync(f, 'utf8');
    for (const objeto of objetosDeLog(src)) {
      total++;
      for (const campo of PROIBIDOS) {
        const re = new RegExp(`[{,]\\s*${campo}\\s*[:,}]`);
        assert.ok(!re.test(objeto), `${path.relative(raiz, f)}: log com "${campo}": ${objeto.slice(0, 120)}`);
      }
    }
  }
  assert.ok(total > 40, `esperava achar as chamadas de log, achei ${total}`);
});

test('LGPD-004: o texto da mensagem nunca e interpolado numa linha de log', () => {
  for (const f of fontes) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /logger[^;]*\$\{[^}]*(text|texto|pushName|subject|nome)[^}]*\}/g;
    assert.equal(re.test(src), false, path.relative(raiz, f));
  }
});

test('SEG-M12-016: nenhum setInterval no bot (as voltas sao encadeadas, sem sobreposicao)', () => {
  for (const f of fontes) {
    assert.ok(!/setInterval\(/.test(fs.readFileSync(f, 'utf8')), path.relative(raiz, f));
  }
});

test('SEG-M12-002: o index.js nao grava o roteamento a partir do pedido (so depois de o app confirmar)', () => {
  const src = fs.readFileSync(path.join(raiz, 'src/index.js'), 'utf8');
  assert.ok(!/grupoOrg\.set\([^)]*p\.org_id/.test(src));
  assert.ok(!/groupCreate|groupLeave/.test(src));
});

test('SEG-M12-003: o contorno do requestId e o historico desligado estao no socket', () => {
  const src = fs.readFileSync(path.join(raiz, 'src/index.js'), 'utf8');
  assert.ok(/requestId/.test(src));
  assert.ok(/shouldSyncHistoryMessage:\s*\(\)\s*=>\s*false/.test(src));
});

test('SEG-M12-014: o socket usa cache de metadados de grupo e getMessage', () => {
  const src = fs.readFileSync(path.join(raiz, 'src/index.js'), 'utf8');
  assert.ok(/cachedGroupMetadata/.test(src));
  assert.ok(/getMessage/.test(src));
});

test('SEG-M12-011: o bot fecha a mascara de arquivos e a pasta da sessao', () => {
  const src = fs.readFileSync(path.join(raiz, 'src/index.js'), 'utf8');
  assert.ok(/process\.umask\(0o077\)/.test(src));
  assert.ok(/restringirPermissoes\(config\.authDir\)/.test(src));
});

test('FIX-BOTS-002: o aviso de bot pareado passa pela marca em disco e so some depois de o app responder', () => {
  const src = fs.readFileSync(path.join(raiz, 'src/index.js'), 'utf8');
  assert.ok(/avisoDePareamento\.marcar\(\)/.test(src));
  assert.ok(/avisoDePareamento\.pendente\(\)/.test(src));
  assert.ok(/if \(r !== null\) avisoDePareamento\.limpar\(\)/.test(src));
});

test('nenhum travessao nem emoji solto nos arquivos de codigo e de teste', () => {
  const todos = [...fontes, ...arquivos(path.join(raiz, 'test'), ['.js']), path.join(raiz, 'package.json'), path.join(raiz, 'README.md'), path.join(raiz, '.env.example')];
  for (const f of todos) {
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!TRAVESSAO.test(src), `travessao em ${path.relative(raiz, f)}`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(src), `emoji em ${path.relative(raiz, f)}`);
  }
});

test('SEG-M12-003: o package.json trava as versoes (nenhuma faixa com ^ ou ~)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
  for (const [nome, versao] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(versao, /^\d+\.\d+\.\d+$/, `${nome}: ${versao}`);
  }
  assert.match(pkg.dependencies['@whiskeysockets/baileys'], /^6\.7\.(2[2-9]|[3-9]\d)$/, 'Baileys abaixo da 6.7.22 tem a falha CVE-2026-48063');
});
