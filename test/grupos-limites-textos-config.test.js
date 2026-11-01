import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolverGruposDaCasa, jidsParaOHeartbeat, comLimite } from '../src/lib/grupos.js';
import { LimitadorDeEnvio, ArmazemCurto, proximoIntervaloDePedidos, estenderModoRapido, diaEmSaoPaulo } from '../src/lib/limites.js';
import { apresentacaoPadrao, apresentacaoComAviso, textoDeEntrada, avisoDeArquivoGrande } from '../src/lib/textos.js';
import { lerConfig, baseDoLis, listaDe, ligado, urlHttpsOuVazio } from '../src/lib/config.js';
import { lerJson, gravarJson, restringirPermissoes } from '../src/lib/estado.js';

// grupos -------------------------------------------------------------

const CASA = '120363000000000001@g.us';
const OUTRO = '120363000000000002@g.us';

test('SEG-M12-010: o nome acha o grupo da casa uma vez e o jid fica gravado', () => {
  const grupos = { [CASA]: { subject: 'EBADV. Captura' }, [OUTRO]: { subject: 'Grupo do cliente' } };
  const r = resolverGruposDaCasa({ gruposDoChip: grupos, nomes: ['EBADV. Captura'] });
  assert.deepEqual([...r.jids], [CASA]);
  assert.deepEqual(r.novosSalvos, { 'EBADV. Captura': CASA });
  assert.deepEqual(r.adotadosPorNome, [CASA]);
});

test('SEG-M12-010: depois de gravado, renomear o grupo da casa nao desliga a captura', () => {
  const grupos = { [CASA]: { subject: 'EBadv. Geral' } };
  const r = resolverGruposDaCasa({ gruposDoChip: grupos, nomes: ['EBADV. Captura'], salvos: { 'EBADV. Captura': CASA } });
  assert.deepEqual([...r.jids], [CASA]);
  assert.deepEqual(r.adotadosPorNome, []);
});

test('SEG-M12-001 e 010: grupo de terceiro com o mesmo nome nao entra como grupo da casa', () => {
  // o grupo da casa ja esta gravado; o de terceiro tem o mesmo nome
  const grupos = { [CASA]: { subject: 'EBadv. Agoge' }, [OUTRO]: { subject: 'EBadv. Agoge' } };
  const r = resolverGruposDaCasa({ gruposDoChip: grupos, nomes: ['EBadv. Agoge'], salvos: { 'EBadv. Agoge': CASA } });
  assert.deepEqual([...r.jids], [CASA]);
  assert.ok(!r.jids.has(OUTRO));
});

test('SEG-M12-001: dois grupos com o mesmo nome e nenhum gravado: nao adota nenhum', () => {
  const grupos = { [CASA]: { subject: 'EBadv. Agoge' }, [OUTRO]: { subject: 'EBadv. Agoge' } };
  const r = resolverGruposDaCasa({ gruposDoChip: grupos, nomes: ['EBadv. Agoge'] });
  assert.equal(r.jids.size, 0);
  assert.equal(r.ambiguos.length, 1);
  assert.deepEqual(r.ambiguos[0].jids.sort(), [CASA, OUTRO].sort());
  assert.deepEqual(r.novosSalvos, {});
});

test('grupo que ja e de escritorio cliente nunca e adotado como da casa pelo nome', () => {
  const grupos = { [OUTRO]: { subject: 'EBADV. Captura' } };
  const r = resolverGruposDaCasa({ gruposDoChip: grupos, nomes: ['EBADV. Captura'], jidsDeCliente: new Set([OUTRO]) });
  assert.equal(r.jids.size, 0);
  assert.equal(r.naoEncontrados.length, 1);
});

test('WA_GROUP_JIDS manda: o nome e ignorado', () => {
  const grupos = { [CASA]: { subject: 'qualquer coisa' }, [OUTRO]: { subject: 'EBADV. Captura' } };
  const r = resolverGruposDaCasa({ gruposDoChip: grupos, nomes: ['EBADV. Captura'], jidsConfigurados: [CASA, '120363000000000009@g.us'] });
  assert.deepEqual([...r.jids], [CASA]);
  assert.deepEqual(r.naoEncontrados, ['120363000000000009@g.us']);
  assert.equal(r.porJid, true);
});

test('grupo gravado de onde o bot saiu nao volta a ser procurado pelo nome', () => {
  const grupos = { [OUTRO]: { subject: 'EBADV. Captura' } };
  const r = resolverGruposDaCasa({ gruposDoChip: grupos, nomes: ['EBADV. Captura'], salvos: { 'EBADV. Captura': CASA } });
  assert.equal(r.jids.size, 0);
  assert.deepEqual(r.naoEncontrados, [CASA]);
});

test('SEG-M12-001: o heartbeat leva o nome so dos grupos da casa; cliente vai com rotulo fixo', () => {
  const targetGroups = new Map([[CASA, 'EBadv. Agoge'], [OUTRO, 'EBadv. Agoge']]);
  const grupoOrg = new Map([[OUTRO, 'org-cliente']]);
  const mapa = jidsParaOHeartbeat({ targetGroups, grupoOrg });
  assert.equal(mapa[CASA], 'EBadv. Agoge');
  assert.equal(mapa[OUTRO], 'grupo de escritorio cliente');
  assert.ok(!Object.values(mapa).some((n, i) => n === 'EBadv. Agoge' && Object.keys(mapa)[i] === OUTRO));
});

test('comLimite nunca passa do limite ao mesmo tempo e mantem a ordem', async () => {
  let ativos = 0;
  let maximo = 0;
  const r = await comLimite([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    ativos++;
    maximo = Math.max(maximo, ativos);
    await new Promise((res) => setTimeout(res, 5));
    ativos--;
    return n * 2;
  });
  assert.deepEqual(r, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(maximo <= 3);
  assert.deepEqual(await comLimite([], 3, async () => 1), []);
});

// limites ------------------------------------------------------------

test('SEG-M12-014: o limitador espaca os envios e respeita o teto por minuto', () => {
  const l = new LimitadorDeEnvio({ porMinuto: 3, porHora: 100, intervaloMinMs: 2000, intervaloMaxMs: 2000 });
  const t0 = 1_000_000;
  assert.equal(l.espera(t0), 0);
  l.registrar(t0);
  assert.equal(l.espera(t0), 2000);
  assert.equal(l.espera(t0 + 2000), 0);
  l.registrar(t0 + 2000);
  l.registrar(t0 + 4000);
  // tres no ultimo minuto: o proximo so quando o primeiro sair da janela
  assert.equal(l.espera(t0 + 6000), 60_000 - 6000);
  assert.equal(l.espera(t0 + 60_000), 0);
});

test('SEG-M12-014: teto por hora', () => {
  const l = new LimitadorDeEnvio({ porMinuto: 1000, porHora: 5, intervaloMinMs: 0, intervaloMaxMs: 0 });
  const t0 = 5_000_000;
  for (let i = 0; i < 5; i++) l.registrar(t0 + i * 1000);
  assert.equal(l.espera(t0 + 10_000), 3600_000 - 10_000);
  assert.equal(l.espera(t0 + 3600_000), 0);
});

test('SEG-M12-014: o intervalo entre envios e sorteado dentro da faixa', () => {
  const baixo = new LimitadorDeEnvio({ intervaloMinMs: 2000, intervaloMaxMs: 5000, aleatorio: () => 0 });
  baixo.registrar(0);
  assert.equal(baixo.espera(0), 2000);
  const alto = new LimitadorDeEnvio({ intervaloMinMs: 2000, intervaloMaxMs: 5000, aleatorio: () => 1 });
  alto.registrar(0);
  assert.equal(alto.espera(0), 5000);
});

test('ArmazemCurto: validade e teto (getMessage e cache de metadados de grupo)', () => {
  let t = 0;
  const a = new ArmazemCurto({ max: 2, validadeMs: 1000, agora: () => t });
  a.set('1', 'um');
  a.set('2', 'dois');
  a.set('3', 'tres');
  assert.equal(a.get('1'), undefined);
  assert.equal(a.get('2'), 'dois');
  t = 1001;
  assert.equal(a.get('3'), undefined);
  assert.equal(a.tamanho, 1);
  a.set('4', 'quatro');
  assert.equal(a.delete('4'), true);
  assert.equal(a.get('4'), undefined);
});

test('SEG-M12-016: a fila de pedidos corre no ritmo lento e acelera por um tempo depois de um sinal', () => {
  const base = { baseMs: 15_000, rapidoMs: 3000 };
  assert.equal(proximoIntervaloDePedidos({ agora: 1000, rapidoAte: 0, ...base }), 15_000);
  const rapidoAte = estenderModoRapido({ agora: 1000, rapidoAte: 0, duracaoMs: 180_000 });
  assert.equal(rapidoAte, 181_000);
  assert.equal(proximoIntervaloDePedidos({ agora: 50_000, rapidoAte, ...base }), 3000);
  assert.equal(proximoIntervaloDePedidos({ agora: 181_000, rapidoAte, ...base }), 15_000);
  assert.equal(estenderModoRapido({ agora: 1000, rapidoAte: 500_000, duracaoMs: 180_000 }), 500_000);
});

test('o dia de hoje conta no fuso de Sao Paulo, nao em UTC', () => {
  // 02:30 UTC de 11/10 ainda e 23:30 de 10/10 em Brasilia
  assert.equal(diaEmSaoPaulo(new Date('2026-10-11T02:30:00Z')), '2026-10-10');
  assert.equal(diaEmSaoPaulo(new Date('2026-10-11T03:00:00Z')), '2026-10-11');
});

// textos -------------------------------------------------------------

test('SEG-M12-020: a apresentacao padrao nao tem exclamacao, tem acento e nao cita nome de ninguem', () => {
  const t = apresentacaoPadrao();
  assert.ok(!t.includes('!'));
  assert.ok(t.includes('vocês'));
  assert.ok(!/voces/.test(t));
  assert.ok(t.includes('*CLIENTE. o que precisa ser feito*'));
  assert.ok(t.includes(String.fromCodePoint(0x2611, 0xfe0f)));
});

test('TXT-TERMOS-007: a apresentacao padrao chama o produto pelo nome (stabi.li), nao de painel', () => {
  const t = apresentacaoPadrao();
  assert.ok(t.includes('transformo em tarefa no stabi.li de vocês.'));
  assert.ok(!/painel/i.test(t));
  assert.ok(!/[\u2013\u2014]/.test(t));
});

test('LGPD-002: o aviso de privacidade leva o endereco configurado e nenhum outro', () => {
  const url = 'https://exemplo.test/privacidade';
  const t = apresentacaoComAviso({ urlDaPrivacidade: url });
  assert.ok(t.includes(url));
  assert.ok(t.includes('Para me tirar, é só me remover do grupo'));
  assert.ok(!t.includes('!'));
  assert.equal([...t.matchAll(/https?:\/\/\S+/g)].length, 1);
  assert.throws(() => apresentacaoComAviso({ urlDaPrivacidade: '' }), /sem endereco/);
});

test('LGPD-002: o texto de entrada ja fica pronto e desligado (padrao), liga com a configuracao', () => {
  const desligado = textoDeEntrada({ avisoDeEntrada: false, urlDaPrivacidade: '' });
  assert.equal(desligado.origem, 'padrao');
  const ligadoSemEndereco = textoDeEntrada({ avisoDeEntrada: true, urlDaPrivacidade: '' });
  assert.equal(ligadoSemEndereco.origem, 'padrao');
  const ligadoComEndereco = textoDeEntrada({ avisoDeEntrada: true, urlDaPrivacidade: 'https://exemplo.test/p' });
  assert.equal(ligadoComEndereco.origem, 'aviso');
  assert.ok(ligadoComEndereco.texto.includes('https://exemplo.test/p'));
});

test('SEG-M12-020: a apresentacao que o app mandar no pedido vence, com teto de tamanho', () => {
  const doApp = textoDeEntrada({ apresentacaoDoApp: '  Olá, sou a Clio.  ', avisoDeEntrada: true, urlDaPrivacidade: 'https://x.test' });
  assert.equal(doApp.origem, 'app');
  assert.equal(doApp.texto, 'Olá, sou a Clio.');
  assert.equal(textoDeEntrada({ apresentacaoDoApp: 'a'.repeat(5000) }).texto.length, 1500);
  assert.equal(textoDeEntrada({ apresentacaoDoApp: '   ' }).origem, 'padrao');
  assert.equal(textoDeEntrada({ apresentacaoDoApp: 42 }).origem, 'padrao');
});

test('SEG-M12-004: o aviso de arquivo grande diz o tamanho e o limite, sem exclamacao', () => {
  const t = avisoDeArquivoGrande({ tamanho: 5 * 1024 * 1024, limite: 3 * 1024 * 1024 });
  assert.ok(t.includes('5,0 MB'));
  assert.ok(t.includes('3,0 MB'));
  assert.ok(t.includes('não registrei'));
  assert.ok(!t.includes('!'));
  assert.ok(avisoDeArquivoGrande({ tamanho: null, limite: 3 * 1024 * 1024 }).includes('Esse arquivo passa'));
});

// config -------------------------------------------------------------

test('baseDoLis tira a rota, com ou sem barra no fim, de um jeito so', () => {
  assert.equal(baseDoLis('https://app.test/api/whatsapp/capture'), 'https://app.test');
  assert.equal(baseDoLis('https://app.test/api/whatsapp/capture/'), 'https://app.test');
  assert.equal(baseDoLis('https://app.test/'), 'https://app.test');
  assert.equal(baseDoLis(''), '');
  assert.equal(baseDoLis(undefined), '');
});

test('listaDe, ligado e urlHttpsOuVazio', () => {
  assert.deepEqual(listaDe('a; b ;;c', ';'), ['a', 'b', 'c']);
  assert.deepEqual(listaDe('a,b;c'), ['a', 'b', 'c']);
  assert.equal(ligado('1'), true);
  assert.equal(ligado('Sim'), true);
  assert.equal(ligado(''), false);
  assert.equal(ligado('0'), false);
  assert.equal(urlHttpsOuVazio('http://x.test'), '');
  assert.equal(urlHttpsOuVazio('lixo'), '');
  assert.equal(urlHttpsOuVazio('https://x.test/politica'), 'https://x.test/politica');
});

test('lerConfig: padroes seguros', () => {
  const c = lerConfig({ LIS_CAPTURE_URL: 'https://app.test/api/whatsapp/capture', LIS_CAPTURE_SECRET: 's' });
  assert.equal(c.lisBase, 'https://app.test');
  assert.equal(c.avisoDeEntrada, false);
  assert.equal(c.enviarNumeroId, false);
  assert.equal(c.enviarEdicoes, false);
  assert.equal(c.visualizacaoUnica, 'ignorar');
  assert.equal(c.limiteDeArquivoBytes, 3 * 1024 * 1024);
  assert.equal(c.timeoutDaCapturaMs, 280_000);
  assert.equal(c.intervaloDePedidosMs, 15_000);
  assert.deepEqual(c.nomesDosGrupos, ['EBADV. Captura']);
  assert.deepEqual(c.jidsDosGrupos, []);
});

test('lerConfig: aviso ligado sem endereco valido nao liga e pede aviso no log', () => {
  const sem = lerConfig({ WA_AVISO_ENTRADA: 'ligado' });
  assert.equal(sem.avisoDeEntrada, false);
  assert.equal(sem.avisoPedidoSemEndereco, true);
  const http = lerConfig({ WA_AVISO_ENTRADA: 'ligado', WA_URL_PRIVACIDADE: 'http://inseguro.test' });
  assert.equal(http.avisoDeEntrada, false);
  const ok = lerConfig({ WA_AVISO_ENTRADA: 'ligado', WA_URL_PRIVACIDADE: 'https://exemplo.test/privacidade' });
  assert.equal(ok.avisoDeEntrada, true);
  assert.equal(ok.urlDaPrivacidade, 'https://exemplo.test/privacidade');
  const soEndereco = lerConfig({ WA_URL_PRIVACIDADE: 'https://exemplo.test/privacidade' });
  assert.equal(soEndereco.avisoDeEntrada, false);
});

test('lerConfig: grupos por nome e por jid, limite de arquivo, figurinha', () => {
  const c = lerConfig({
    WA_GROUP_NAMES: 'A;B',
    WA_GROUP_JIDS: '120363000000000001@g.us, lixo, 120363000000000002@g.us',
    WA_LIMITE_ARQUIVO_MB: '2',
    WA_STICKER_HOSTS: 'CDN.exemplo.test',
    WA_VISUALIZACAO_UNICA: 'capturar',
    WA_ENVIAR_NUMERO_ID: '1',
    WA_NUMERO_ID: 'chip-1',
  });
  assert.deepEqual(c.nomesDosGrupos, ['A', 'B']);
  assert.deepEqual(c.jidsDosGrupos, ['120363000000000001@g.us', '120363000000000002@g.us']);
  assert.equal(c.limiteDeArquivoBytes, 2 * 1024 * 1024);
  assert.deepEqual(c.hostsDeFigurinha, ['cdn.exemplo.test']);
  assert.equal(c.visualizacaoUnica, 'capturar');
  assert.equal(c.enviarNumeroId, true);
  assert.equal(c.numeroId, 'chip-1');
});

// estado -------------------------------------------------------------

test('estado: gravar e ler JSON, e padrao quando nao existe ou esta quebrado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estado-bot-'));
  const arq = path.join(dir, 'sub', 'a.json');
  assert.deepEqual(lerJson(arq, { padrao: true }), { padrao: true });
  gravarJson(arq, { x: 1 });
  assert.deepEqual(lerJson(arq, null), { x: 1 });
  fs.writeFileSync(arq, 'quebrado');
  assert.deepEqual(lerJson(arq, []), []);
});

test('SEG-M12-011: a pasta da sessao fica 0700 e os arquivos 0600', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-bot-'));
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, 'creds.json'), '{}', { mode: 0o644 });
  fs.chmodSync(path.join(dir, 'creds.json'), 0o644);
  restringirPermissoes(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'creds.json')).mode & 0o777, 0o600);
  assert.equal(restringirPermissoes(path.join(dir, 'nao-existe')), 0);
});
