import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TIPOS_DE_PEDIDO,
  validarPedido,
  decidirEntrada,
  conferirRoteamento,
  idsDoBot,
  participantesBrutos,
  criarApresentados,
  criarProcessadorDePedidos,
} from '../src/lib/pedidos.js';

const JID = '120363111111111111@g.us';
const CASA = '120363000000000001@g.us';

const silencioso = { info() {}, warn() {}, error() {}, debug() {} };

function logRegistrado() {
  const linhas = [];
  const f = (nivel) => (obj, msg) => linhas.push({ nivel, obj, msg });
  return { linhas, info: f('info'), warn: f('warn'), error: f('error'), debug: f('debug') };
}

function pedido(extra = {}) {
  return { id: 'ped-1', org_id: 'org-A', tipo: 'entrar_grupo', payload: { codigo: 'ABCDEFGHIJKLMNOP' }, ...extra };
}

function montar({ tabela, resposta = { ok: true }, grupoOrg = new Map(), gruposDaCasa = new Set(), erroAoEntrar = null, config = {}, participantes } = {}) {
  const chamadas = [];
  const enviados = [];
  const sock = {
    user: { id: '5543000000000:7@s.whatsapp.net', lid: '99999:7@lid' },
    groupAcceptInvite: async (c) => {
      chamadas.push(['accept', c]);
      if (erroAoEntrar) throw erroAoEntrar;
      return JID;
    },
    groupGetInviteInfo: async () => ({ id: JID }),
    groupMetadata: async (j) => {
      chamadas.push(['meta', j]);
      return {
        subject: 'Escritorio Novo',
        participants: participantes || [
          { id: '5543111111111@s.whatsapp.net', admin: 'admin' },
          { id: '5543000000000@s.whatsapp.net' },
          { id: '99999@lid', jid: '99999@lid' },
          { id: '222@lid', phoneNumber: '5511222222222@s.whatsapp.net' },
        ],
      };
    },
    profilePictureUrl: async (id) => {
      chamadas.push(['foto', id]);
      return 'https://pp.test/' + id;
    },
  };
  const targetGroups = new Map();
  const respostasAoApp = [];
  const proc = criarProcessadorDePedidos({
    sock,
    grupoOrg,
    targetGroups,
    gruposDaCasa,
    apresentados: criarApresentados({ arquivo: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apr-')), 'a.json') }),
    config: { avisoDeEntrada: false, urlDaPrivacidade: '', ...config },
    logger: silencioso,
    esperar: async () => {},
    responderPedido: async (id, ok, resultado, erro) => {
      respostasAoApp.push({ id, ok, resultado, erro });
      return resposta;
    },
    buscarTabela: async () => (typeof tabela === 'function' ? tabela() : tabela),
    enviarTexto: async (jid, texto) => enviados.push({ jid, texto }),
  });
  return { proc, sock, chamadas, enviados, grupoOrg, targetGroups, respostasAoApp };
}

test('SEG-M12-009: so o tipo entrar_grupo existe; recado, criar_grupo e sair_grupo sao recusados e o socket nem e tocado', async () => {
  assert.deepEqual(TIPOS_DE_PEDIDO, ['entrar_grupo']);
  for (const tipo of ['recado', 'criar_grupo', 'sair_grupo', 'qualquer']) {
    const { proc, chamadas, respostasAoApp, enviados } = montar({ tabela: [] });
    const r = await proc.processar(pedido({ tipo, payload: { jid: CASA, texto: 'oi', nome: 'x' } }));
    assert.equal(r.ok, false, tipo);
    assert.equal(chamadas.length, 0);
    assert.equal(enviados.length, 0);
    assert.equal(respostasAoApp[0].ok, false);
    assert.match(respostasAoApp[0].erro, /nao suportado/);
  }
});

test('validarPedido exige id, organizacao e codigo de convite valido', () => {
  assert.equal(validarPedido(pedido()).ok, true);
  assert.equal(validarPedido(pedido({ id: '' })).ok, false);
  assert.equal(validarPedido(pedido({ org_id: undefined })).ok, false);
  assert.equal(validarPedido(pedido({ payload: {} })).ok, false);
  assert.equal(validarPedido(pedido({ payload: { codigo: 'https://chat.whatsapp.com/xxx' } })).ok, false);
  assert.equal(validarPedido(null).ok, false);
});

test('SEG-M12-002: grupo novo so entra no roteamento e so recebe a apresentacao depois de o app confirmar', async () => {
  const tabela = [{ jid: JID, nome: 'Escritorio Novo', modo: 'captura', org_id: 'org-A' }];
  const { proc, grupoOrg, targetGroups, enviados, respostasAoApp } = montar({ tabela });
  const r = await proc.processar(pedido());
  assert.equal(r.ok, true);
  assert.equal(grupoOrg.get(JID), 'org-A');
  assert.equal(targetGroups.get(JID), 'Escritorio Novo');
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].jid, JID);
  assert.match(enviados[0].texto, /Clio/);
  assert.equal(respostasAoApp[0].ok, true);
  assert.equal(respostasAoApp[0].resultado.jid, JID);
});

test('SEG-M12-002: se o app NAO registrou o grupo, o bot nao troca o roteamento nem se apresenta', async () => {
  const { proc, grupoOrg, targetGroups, enviados } = montar({ tabela: [] });
  const r = await proc.processar(pedido());
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'nao_cadastrado');
  assert.equal(grupoOrg.has(JID), false);
  assert.equal(targetGroups.has(JID), false);
  assert.equal(enviados.length, 0);
});

test('SEG-M12-002: se o app registrou o grupo para OUTRA organizacao, nada muda no bot', async () => {
  const { proc, grupoOrg, enviados } = montar({ tabela: [{ jid: JID, nome: 'X', org_id: 'org-B' }] });
  const r = await proc.processar(pedido());
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'outra_organizacao');
  assert.equal(grupoOrg.has(JID), false);
  assert.equal(enviados.length, 0);
});

test('SEG-M12-002: se a resposta do app disser registrado false, e recusa final', async () => {
  const { proc, grupoOrg, enviados } = montar({ tabela: [{ jid: JID, org_id: 'org-A' }], resposta: { ok: true, registrado: false } });
  const r = await proc.processar(pedido());
  assert.equal(r.motivo, 'app_recusou');
  assert.equal(grupoOrg.has(JID), false);
  assert.equal(enviados.length, 0);
});

test('SEG-M12-002: tabela indisponivel tenta de novo e confirma quando voltar', async () => {
  let n = 0;
  const { proc, grupoOrg, enviados } = montar({
    tabela: () => (++n < 3 ? null : [{ jid: JID, nome: 'Escritorio Novo', org_id: 'org-A' }]),
  });
  const r = await proc.processar(pedido());
  assert.equal(r.ok, true);
  assert.equal(n, 3);
  assert.equal(grupoOrg.get(JID), 'org-A');
  assert.equal(enviados.length, 1);
});

test('SEG-M12-002: grupo de outro escritorio e recusado ANTES de ler participantes (nada vaza para quem pediu)', async () => {
  const grupoOrg = new Map([[JID, 'org-B']]);
  const { proc, chamadas, respostasAoApp, enviados } = montar({ tabela: [], grupoOrg, erroAoEntrar: Object.assign(new Error('conflict'), { data: 409 }) });
  const r = await proc.processar(pedido());
  assert.equal(r.ok, false);
  assert.equal(chamadas.some((c) => c[0] === 'meta'), false, 'nao pode ler os participantes');
  assert.equal(chamadas.some((c) => c[0] === 'foto'), false);
  assert.equal(respostasAoApp[0].ok, false);
  assert.equal(respostasAoApp[0].resultado, null);
  assert.match(respostasAoApp[0].erro, /indisponivel/);
  assert.equal(grupoOrg.get(JID), 'org-B', 'o dono do grupo no mapa nao muda');
  assert.equal(enviados.length, 0);
});

test('SEG-M12-002: grupo da casa nunca e entregue a um escritorio', async () => {
  const { proc, grupoOrg, chamadas, enviados } = montar({ tabela: [], gruposDaCasa: new Set([JID]) });
  const r = await proc.processar(pedido());
  assert.equal(r.ok, false);
  assert.equal(grupoOrg.has(JID), false);
  assert.equal(chamadas.some((c) => c[0] === 'meta'), false);
  assert.equal(enviados.length, 0);
});

test('SEG-M12-002: pedido repetido para grupo que ja e do mesmo escritorio nao repete a apresentacao', async () => {
  const grupoOrg = new Map([[JID, 'org-A']]);
  const { proc, enviados } = montar({ tabela: [{ jid: JID, nome: 'Escritorio Novo', org_id: 'org-A' }], grupoOrg });
  const r = await proc.processar(pedido());
  assert.equal(r.ok, true);
  assert.equal(enviados.length, 0);
});

test('SEG-M12-002: o bot ja dentro do grupo (conflito do WhatsApp) segue como sucesso quando o grupo e livre', async () => {
  const { proc, enviados, grupoOrg } = montar({ tabela: [{ jid: JID, org_id: 'org-A', nome: 'N' }], erroAoEntrar: new Error('conflict') });
  const r = await proc.processar(pedido());
  assert.equal(r.ok, true);
  assert.equal(grupoOrg.get(JID), 'org-A');
  assert.equal(enviados.length, 1);
});

test('SEG-M12-002: a apresentacao nao e enviada duas vezes nem depois de um reinicio', async () => {
  const arquivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apr-')), 'a.json');
  const a = criarApresentados({ arquivo });
  assert.equal(a.tem(JID), false);
  a.add(JID);
  const depoisDoReinicio = criarApresentados({ arquivo });
  assert.equal(depoisDoReinicio.tem(JID), true);
});

test('SEG-M12-020: a apresentacao que o app mandar no pedido e a que vai ao grupo', async () => {
  const { proc, enviados } = montar({ tabela: [{ jid: JID, org_id: 'org-A', nome: 'N' }] });
  await proc.processar(pedido({ payload: { codigo: 'ABCDEFGHIJKLMNOP', apresentacao: 'Olá. Sou a Clio da agência.' } }));
  assert.equal(enviados[0].texto, 'Olá. Sou a Clio da agência.');
});

test('LGPD-002: com o aviso ligado, a apresentacao leva o endereco da politica; desligado, nao', async () => {
  const tabela = [{ jid: JID, org_id: 'org-A', nome: 'N' }];
  const desligado = montar({ tabela });
  await desligado.proc.processar(pedido());
  assert.ok(!/https?:\/\//.test(desligado.enviados[0].texto));

  const ligado = montar({ tabela, config: { avisoDeEntrada: true, urlDaPrivacidade: 'https://exemplo.test/privacidade' } });
  await ligado.proc.processar(pedido());
  assert.ok(ligado.enviados[0].texto.includes('https://exemplo.test/privacidade'));
});

test('a lista de participantes tira o proprio bot, prefere o numero ao @lid e limita as fotos', async () => {
  const { proc, respostasAoApp } = montar({ tabela: [{ jid: JID, org_id: 'org-A', nome: 'N' }] });
  await proc.processar(pedido());
  const gente = respostasAoApp[0].resultado.participantes;
  assert.equal(gente.length, 2);
  assert.deepEqual(gente.map((g) => g.fone), ['5543111111111', '5511222222222']);
  assert.equal(gente[0].admin, true);
  assert.equal(gente[0].fim, '1111');
});

test('SEG-M12-012: as fotos sao pedidas em poucas consultas por vez e so as primeiras', async () => {
  const muitos = Array.from({ length: 100 }, (_, i) => ({ id: `55430000${String(i).padStart(5, '0')}@s.whatsapp.net` }));
  let ativos = 0;
  let maximo = 0;
  let consultas = 0;
  const { proc, sock } = montar({ tabela: [{ jid: JID, org_id: 'org-A', nome: 'N' }], participantes: muitos });
  sock.profilePictureUrl = async () => {
    consultas++;
    ativos++;
    maximo = Math.max(maximo, ativos);
    await new Promise((r) => setTimeout(r, 1));
    ativos--;
    return 'x';
  };
  await proc.processar(pedido());
  assert.ok(maximo <= 4, `maximo ao mesmo tempo: ${maximo}`);
  assert.equal(consultas, 60);
});

test('erro ao entrar no grupo devolve o erro ao app e nao toca o roteamento', async () => {
  const log = logRegistrado();
  const chamadas = [];
  const sock = { groupAcceptInvite: async () => { throw new Error('not-authorized'); }, groupGetInviteInfo: async () => null };
  const grupoOrg = new Map();
  const respostas = [];
  const proc = criarProcessadorDePedidos({
    sock, grupoOrg, targetGroups: new Map(), gruposDaCasa: new Set(),
    apresentados: criarApresentados({ arquivo: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apr-')), 'a.json') }),
    config: {}, logger: log, esperar: async () => {},
    responderPedido: async (id, ok, resultado, erro) => { respostas.push({ id, ok, erro }); return { ok: true }; },
    buscarTabela: async () => { chamadas.push('tabela'); return []; },
    enviarTexto: async () => chamadas.push('texto'),
  });
  const r = await proc.processar(pedido());
  assert.equal(r.ok, false);
  assert.deepEqual(respostas, [{ id: 'ped-1', ok: false, erro: 'not-authorized' }]);
  assert.deepEqual(chamadas, []);
  assert.equal(grupoOrg.size, 0);
  assert.ok(log.linhas.every((l) => !JSON.stringify(l.obj).includes('Escritorio')));
});

test('app fora do ar ao devolver o resultado: tenta de novo, e desiste sem trocar o roteamento', async () => {
  const { proc, grupoOrg } = montar({ tabela: [{ jid: JID, org_id: 'org-A' }], resposta: null });
  const r = await proc.processar(pedido());
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'sem_resposta_do_app');
  assert.equal(grupoOrg.has(JID), false);
});

test('decidirEntrada e conferirRoteamento sozinhos', () => {
  const grupoOrg = new Map([[JID, 'org-A']]);
  const gruposDaCasa = new Set([CASA]);
  assert.equal(decidirEntrada({ jid: CASA, orgDoPedido: 'org-A', grupoOrg, gruposDaCasa }).motivo, 'grupo_da_casa');
  assert.equal(decidirEntrada({ jid: JID, orgDoPedido: 'org-B', grupoOrg, gruposDaCasa }).motivo, 'grupo_de_outro_escritorio');
  assert.equal(decidirEntrada({ jid: JID, orgDoPedido: 'org-A', grupoOrg, gruposDaCasa }).jaRegistrado, true);
  assert.equal(decidirEntrada({ jid: '1@g.us', orgDoPedido: 'org-A', grupoOrg, gruposDaCasa }).motivo, 'grupo_novo');
  assert.equal(conferirRoteamento({ resposta: {}, tabela: [{ jid: JID, org_id: 'org-A', nome: 'N' }], jid: JID, orgDoPedido: 'org-A' }).confirmado, true);
  assert.equal(conferirRoteamento({ resposta: {}, tabela: null, jid: JID, orgDoPedido: 'org-A' }).final, false);
});

test('idsDoBot e participantesBrutos', () => {
  const ids = idsDoBot({ id: '5543:12@s.whatsapp.net', lid: '777:3@lid' });
  assert.deepEqual([...ids].sort(), ['5543', '777']);
  const brutos = participantesBrutos([{ id: '5543@s.whatsapp.net' }, { id: '777@lid' }, { id: '999@lid', phoneNumber: '5511999999999@s.whatsapp.net', admin: 'superadmin' }], ids);
  assert.equal(brutos.length, 1);
  assert.equal(brutos[0].jid, '5511999999999');
  assert.equal(brutos[0].admin, true);
});
