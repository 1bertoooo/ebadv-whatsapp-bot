/**
 * Bot do WhatsApp (Baileys, nao oficial): escuta os grupos cadastrados e leva
 * cada mensagem para a rota /api/whatsapp/capture do app, devolvendo ao grupo
 * a resposta (texto, reacao, figurinha, nota de voz). Tambem entrega a fila de
 * saida do app e atende a fila de pedidos (entrar em grupo de cliente).
 *
 * Roda no VPS como servico systemd (unidade `luana-bot`), com a sessao em
 * ./auth_state e o estado local em ./estado.
 *
 * A logica que da para testar sem o Baileys e sem rede mora em src/lib/ e tem
 * testes em test/ (npm test). Aqui ficam so as ligacoes: socket, eventos e
 * relogios.
 *
 * Regras que valem em todo o arquivo:
 *  - o log leva so ids, tipos e contagens, nunca nome nem texto (LGPD-004);
 *  - mensagens do proprio bot sao sempre ignoradas, para nao fazer laco;
 *  - o bot nao reconecta no mesmo processo: sai e o systemd sobe um limpo.
 *    Saida 3 quer dizer "nao suba de novo" (sessao encerrada, numero
 *    bloqueado, pareamento nao concluido).
 */
import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import axios from 'axios';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { lerConfig } from './lib/config.js';
import { opcoesDeRedacao, resumoDaMensagem, nivelDoIgnorado } from './lib/log.js';
import { extrairMensagem, tamanhoDoArquivo, decidirArquivo, montarPayload } from './lib/mensagem.js';
import { FilaEmDisco } from './lib/fila-local.js';
import { criarFluxoDeEntrada } from './lib/entrada.js';
import { criarFluxoDeSaida, enviarItemDeSaida } from './lib/saida.js';
import { entregarResposta } from './lib/entrega.js';
import { criarProcessadorDePedidos, criarApresentados, idsDoBot } from './lib/pedidos.js';
import { decidirSaida, registrarQueda, esperaAntesDeConectar } from './lib/conexao.js';
import { resolverGruposDaCasa, jidsParaOHeartbeat } from './lib/grupos.js';
import { LimitadorDeEnvio, ArmazemCurto, proximoIntervaloDePedidos, estenderModoRapido, diaEmSaoPaulo } from './lib/limites.js';
import { avisoDeArquivoGrande, REACAO_DE_AVISO } from './lib/textos.js';
import { esperar, comTentativas } from './lib/espera.js';
import { lerJson, gravarJson, restringirPermissoes } from './lib/estado.js';
import { versaoDoPacote } from './lib/versoes.js';
import { criarAvisoDePareamento } from './lib/pareamento.js';

// A sessao e o que o bot guarda de mais sensivel: nada de modo aberto.
process.umask(0o077);

const config = lerConfig(process.env);

if (!config.lisUrl || !config.segredo) {
  console.error('Faltam LIS_CAPTURE_URL ou LIS_CAPTURE_SECRET no .env');
  process.exit(1);
}
try {
  fs.chmodSync(path.resolve('.env'), 0o600);
} catch {
  // sem .env na pasta (variaveis vindas do systemd): nada a fazer
}

const logger = pino({ level: config.logLevel, redact: opcoesDeRedacao() });

const TEMPO_DE_SAIDA_MS = 8000;
const ARQUIVO_GRUPOS_DA_CASA = path.join(config.estadoDir, 'grupos-da-casa.json');
const ARQUIVO_REINICIOS = path.join(config.estadoDir, 'reinicios.json');
const ARQUIVO_APRESENTADOS = path.join(config.estadoDir, 'apresentados.json');
const avisoDePareamento = criarAvisoDePareamento({ arquivo: path.join(config.estadoDir, 'pareamento-novo.json') });

const authHeaders = { Authorization: `Bearer ${config.segredo}` };
const numeroExtra = () => (config.enviarNumeroId && config.numeroId ? { numero_id: config.numeroId } : {});

// --- estado em memoria -------------------------------------------------

/** jid do grupo -> nome. Os da casa levam o nome do WhatsApp; os de cliente, o do cadastro. */
const targetGroups = new Map();
/** jid do grupo de escritorio cliente -> id da organizacao dona dele. So o app decide isto. */
const grupoOrg = new Map();
/** jids dos grupos da casa (resolvidos por jid; ver lib/grupos.js). */
const gruposDaCasa = new Set();

const stats = {
  uptimeIniciadoEm: new Date().toISOString(),
  ultimaMsgRecebidaAt: null,
  ultimaMsgEnviadaAt: null,
  msgsHoje: 0,
  hojeStr: diaEmSaoPaulo(),
  conexao: 'connecting',
};
function statsResetSeNovoDia() {
  const hoje = diaEmSaoPaulo();
  if (hoje !== stats.hojeStr) {
    stats.hojeStr = hoje;
    stats.msgsHoje = 0;
  }
}

let encerrando = false;
let sockAtual = null;
let gruposCarregados = false;
let abriuNestaPartida = false;
let jaPareadoNoInicio = true;
let pareando = false; // esta partida esta tentando parear (codigo pedido ou QR mostrado)
let pareouComSucesso = false;
let novoLogin = false;
let rapidoAte = 0; // pedidos: ritmo rapido ate este instante
let versaoDoBaileys = 'desconhecida';

let entrada = null;
let saida = null;
const limitador = new LimitadorDeEnvio({ porMinuto: config.saidaPorMinuto, porHora: config.saidaPorHora });
const enviadasRecentes = new ArmazemCurto({ max: 300, validadeMs: 3600_000 }); // getMessage do Baileys
const metadadosDeGrupo = new ArmazemCurto({ max: 200, validadeMs: 5 * 60_000 }); // cachedGroupMetadata
const avisosDeArquivo = new Map(); // grupo -> ultima vez que avisei por texto

let resolverRoteamentoPronto;
const roteamentoPronto = new Promise((r) => { resolverRoteamentoPronto = r; });

// --- saida ordenada ----------------------------------------------------

function registrarQuedaNoDisco({ code }) {
  try {
    const historico = lerJson(ARQUIVO_REINICIOS, []);
    gravarJson(ARQUIVO_REINICIOS, registrarQueda(Array.isArray(historico) ? historico : [], { code, abriu: abriuNestaPartida }));
  } catch (err) {
    logger.warn({ err: err?.message }, 'nao consegui gravar o historico de quedas');
  }
}

/**
 * Para de receber, espera por poucos segundos os POSTs em curso e sai. O que
 * nao terminar fica na fila em disco e e retomado na proxima partida.
 */
async function sairComOrdem(codigo, motivo, { registrar = null } = {}) {
  if (encerrando) return;
  encerrando = true;
  logger.warn({ codigo, motivo }, 'saindo');
  if (registrar) registrarQuedaNoDisco(registrar);
  setTimeout(() => process.exit(codigo), TEMPO_DE_SAIDA_MS + 4000).unref();
  try {
    if (entrada) await entrada.aguardarTermino(TEMPO_DE_SAIDA_MS);
  } catch {
    // sair e o que importa
  }
  process.exit(codigo);
}

process.on('SIGTERM', () => sairComOrdem(0, 'SIGTERM'));
process.on('SIGINT', () => sairComOrdem(0, 'SIGINT'));
process.on('unhandledRejection', (razao) => {
  logger.error({ err: String(razao?.message || razao) }, 'rejeicao sem tratamento');
  sairComOrdem(1, 'unhandledRejection', { registrar: { code: null } });
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err?.message, stack: err?.stack }, 'excecao sem tratamento');
  sairComOrdem(1, 'uncaughtException', { registrar: { code: null } });
});

// --- chamadas ao app ---------------------------------------------------

async function notificarLIS(endpoint, payload) {
  try {
    const r = await axios.post(`${config.lisBase}/api/whatsapp/${endpoint}`, { ...payload, ...numeroExtra() }, { headers: authHeaders, timeout: 15000 });
    return r.data;
  } catch (err) {
    logger.warn({ endpoint, err: err?.message }, 'notificarLIS falhou');
    return null;
  }
}

/** Aviso ao app de que o bot parou e precisa de gente. Espera a resposta, no maximo 8 s, e so depois sai. */
async function avisarBotDown(motivo, codigo) {
  if (!config.lisBase) return;
  const ctrl = new AbortController();
  const prazo = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(`${config.lisBase}/api/whatsapp/bot-down`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo, codigo, uptime_iniciado_em: stats.uptimeIniciadoEm, ...numeroExtra() }),
      signal: ctrl.signal,
    });
  } catch (e) {
    logger.warn({ err: e && e.message }, 'bot-down alert falhou');
  } finally {
    clearTimeout(prazo);
  }
}

// --- socket ------------------------------------------------------------

function envolverSocket(sock) {
  return {
    // guarda o que o bot enviou: sem isso, quando alguem nao decifra e pede
    // reenvio, o bot nao tem como reenviar ("Aguardando mensagem")
    sendMessage: async (jid, conteudo, opcoes) => {
      const enviado = await sock.sendMessage(jid, conteudo, opcoes);
      if (enviado?.key?.id && enviado.message) enviadasRecentes.set(enviado.key.id, enviado.message);
      return enviado;
    },
    sendPresenceUpdate: (...args) => sock.sendPresenceUpdate(...args),
  };
}

function atualizarMetadadosDoGrupo(sock, jid) {
  metadadosDeGrupo.delete(jid);
  sock.groupMetadata(jid)
    .then((meta) => metadadosDeGrupo.set(jid, meta))
    .catch(() => {
      // sem metadados em cache o Baileys consulta o servidor no proximo envio
    });
}

async function start() {
  if (!fs.existsSync(config.authDir)) fs.mkdirSync(config.authDir, { recursive: true, mode: 0o700 });
  restringirPermissoes(config.authDir);
  try {
    fs.mkdirSync(config.estadoDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(config.estadoDir, 0o700);
  } catch (err) {
    logger.warn({ err: err?.message }, 'nao consegui preparar a pasta de estado');
  }

  const filaEntrada = new FilaEmDisco({
    dir: path.join(config.estadoDir, 'fila-entrada'),
    maxItens: config.filaMaxItens,
    maxBytes: config.filaMaxBytes,
    validadeMs: config.filaEntradaValidadeMs,
  });
  const filaSaida = new FilaEmDisco({
    dir: path.join(config.estadoDir, 'fila-saida'),
    maxItens: config.filaMaxItens,
    maxBytes: Math.floor(config.filaMaxBytes / 4),
    validadeMs: config.filaSaidaValidadeMs,
  });
  const lidoEntrada = filaEntrada.iniciar();
  const lidoSaida = filaSaida.iniciar();
  logger.info({ entrada: lidoEntrada.itens, saida: lidoSaida.itens, corrompidos: lidoEntrada.corrompidos + lidoSaida.corrompidos }, 'filas em disco carregadas');

  // Partidas seguidas sem nem conectar: espera crescente em vez de insistir a cada 20 s.
  const historico = lerJson(ARQUIVO_REINICIOS, []);
  const espera = esperaAntesDeConectar(Array.isArray(historico) ? historico : []);
  if (espera > 0) {
    logger.warn({ espera_s: Math.round(espera / 1000) }, 'varias partidas seguidas sem conectar: espero antes de tentar de novo');
    await esperar(espera);
  }

  versaoDoBaileys = versaoDoPacote('@whiskeysockets/baileys', { resolver: (n) => import.meta.resolve(n) });
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ baileysVersion: versaoDoBaileys, waWebVersion: version.join('.') }, 'iniciando');
  if (config.avisoPedidoSemEndereco) {
    logger.warn('WA_AVISO_ENTRADA ligado sem WA_URL_PRIVACIDADE valido (https): o aviso fica desligado');
  }

  // Sessao ja pareada: tem a conta registrada. `registered` sozinho nao basta no multi-dispositivo.
  jaPareadoNoInicio = !!(state.creds?.registered || state.creds?.account);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'warn', redact: opcoesDeRedacao() }),
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    cachedGroupMetadata: async (jid) => metadadosDeGrupo.get(jid),
    getMessage: async (key) => enviadasRecentes.get(key?.id),
  });
  sockAtual = sock;
  const sockEnvio = envolverSocket(sock);

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao salvar a sessao');
    }
  });

  // --- fluxos (filas e entrega) ---

  const depsDeEntrega = {
    notaDeVoz,
    http: axios,
    hostsDeFigurinha: config.hostsDeFigurinha,
    patchDoId: (corpo) => patchDoId(corpo),
    logger,
    aoEnviar: () => { stats.ultimaMsgEnviadaAt = new Date().toISOString(); },
  };

  entrada = criarFluxoDeEntrada({
    config,
    http: axios,
    fila: filaEntrada,
    logger,
    esperarFn: esperar,
    entregar: async ({ chave, original, resposta }) => {
      await entregarResposta({ sock: sockEnvio, grupoJid: chave.remoteJid, chave, original, resposta, deps: depsDeEntrega });
    },
    aoDescartar: async ({ chave, payload, motivo }) => {
      if (motivo === 'corpo_grande_demais') {
        await avisarArquivoGrande({ chave, original: null, tamanho: payload?.file?.size ?? null });
      }
    },
  });

  saida = criarFluxoDeSaida({
    config,
    http: axios,
    fila: filaSaida,
    logger,
    limitador,
    gruposConhecidos: () => targetGroups,
    enviar: (m) => enviarItemDeSaida({ sock: sockEnvio, m, http: axios, hostsDeFigurinha: config.hostsDeFigurinha }),
    aoEnviar: () => { stats.ultimaMsgEnviadaAt = new Date().toISOString(); },
  });

  const processadorDePedidos = criarProcessadorDePedidos({
    sock,
    grupoOrg,
    targetGroups,
    gruposDaCasa,
    apresentados: criarApresentados({ arquivo: ARQUIVO_APRESENTADOS }),
    config,
    logger,
    esperar,
    responderPedido,
    buscarTabela: atualizarRoteamento,
    enviarTexto: async (jid, texto) => {
      await sockEnvio.sendMessage(jid, { text: texto });
      stats.ultimaMsgEnviadaAt = new Date().toISOString();
    },
  });

  // --- pareamento por codigo (em vez de QR) quando WA_PHONE_NUMBER esta definido ---

  if (!jaPareadoNoInicio && config.telefoneDoChip) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(config.telefoneDoChip);
        pareando = true;
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log('\n========================================');
        console.log('CÓDIGO DE PAREAMENTO (8 dígitos):');
        console.log('');
        console.log('         ' + formatted);
        console.log('');
        console.log('No celular do bot:');
        console.log('  WhatsApp > Dispositivos conectados');
        console.log('  > Conectar dispositivo');
        console.log('  > Conectar com número de telefone');
        console.log('  > digite o número, depois o código acima');
        console.log('========================================\n');
      } catch (err) {
        logger.error({ err: err?.message }, 'falha ao gerar pairing code');
      }
    }, 3500);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !config.telefoneDoChip) {
      pareando = true;
      console.log('\n========================================');
      console.log('LEIA O QR CODE ABAIXO COM O CELULAR DO BOT');
      console.log('WhatsApp > Dispositivos conectados > Conectar dispositivo');
      console.log('========================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (update.isNewLogin) {
      novoLogin = true;
      pareouComSucesso = true;
      // o WhatsApp manda reiniciar logo em seguida: a marca em disco leva o aviso ao processo novo
      try {
        avisoDePareamento.marcar();
      } catch (err) {
        logger.warn({ err: err?.message }, 'nao consegui gravar a marca de pareamento novo');
      }
    }

    if (connection === 'open') {
      abriuNestaPartida = true;
      pareouComSucesso = true;
      stats.conexao = 'open';
      logger.info('conectado ao WhatsApp');
      carregarGrupos(sock).catch((err) => logger.error({ err: err?.message }, 'falha ao carregar os grupos'));
    } else if (connection === 'connecting') {
      stats.conexao = 'connecting';
    }

    if (connection === 'close') tratarQueda(lastDisconnect?.error);
  });

  // --- grupos: participantes e metadados ---

  sock.ev.on('group-participants.update', async (ev) => {
    atualizarMetadadosDoGrupo(sock, ev.id);
    if (!targetGroups.has(ev.id)) return;
    const meusIds = idsDoBot(sock.user);
    const jidDe = (p) => (typeof p === 'string' ? p : p?.id || p?.jid || '');
    const ehEu = (p) => meusIds.has(jidDe(p).split(':')[0].split('@')[0]);

    // O bot foi tirado do grupo: para de escutar e avisa o app (antes ninguem sabia).
    if (ev.action === 'remove' && (ev.participants || []).some(ehEu)) {
      grupoOrg.delete(ev.id);
      targetGroups.delete(ev.id);
      gruposDaCasa.delete(ev.id);
      logger.warn({ jid: ev.id }, 'o bot saiu ou foi removido do grupo');
      await notificarLIS('event', { type: 'bot_removed', wa_group_jid: ev.id });
      return;
    }

    if (ev.action === 'add') {
      const novos = (ev.participants || []).filter((p) => !ehEu(p)).map((p) => ({ jid: jidDe(p), name: '' }));
      if (novos.length === 0) return;
      try {
        const r = await notificarLIS('event', {
          type: 'member_joined',
          wa_group_jid: ev.id,
          wa_group_name: targetGroups.get(ev.id),
          new_members: novos,
          added_by_jid: ev.author || null,
        });
        // O app devolve as mensagens de boas-vindas; sai uma de cada vez, com pausa.
        for (const m of r?.mensagens || []) {
          try {
            await sockEnvio.sendMessage(ev.id, { text: m.text, mentions: [m.jid] });
            stats.ultimaMsgEnviadaAt = new Date().toISOString();
          } catch (err) {
            logger.error({ err: err?.message }, 'falha ao cumprimentar membro');
          }
          await esperar(1500 + Math.floor(Math.random() * 1500));
        }
      } catch (err) {
        logger.error({ err: err?.message }, 'falha notificar LIS de member_joined');
      }
    }
  });

  sock.ev.on('groups.update', (updates) => {
    for (const u of updates || []) {
      if (!u?.id) continue;
      // O nome muda no mapa so de grupo que ja era conhecido da casa. Grupo novo
      // nunca entra por nome (renomear um grupo para o nome de outro nao o promove).
      if (u.subject && gruposDaCasa.has(u.id)) targetGroups.set(u.id, u.subject);
      atualizarMetadadosDoGrupo(sock, u.id);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type, requestId }) => {
    if (type !== 'notify') return;
    // CVE-2026-48063 (Baileys): mensagem falsa chega como upsert com requestId. Contorno do proprio aviso.
    if (requestId) {
      logger.warn('upsert com requestId descartado');
      return;
    }
    if (encerrando) return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
        statsResetSeNovoDia();
        stats.ultimaMsgRecebidaAt = new Date().toISOString();
        stats.msgsHoje++;
      } catch (err) {
        logger.error({ err: err?.message, stack: err?.stack }, 'falha processando msg');
      }
    }
  });

  iniciarHeartbeat();
  iniciarRelogios();
  iniciarRoteamento();
  iniciarPedidos(processadorDePedidos);
}

// --- queda de conexao ---------------------------------------------------

function tratarQueda(erro) {
  stats.conexao = 'closed';
  const code = new Boom(erro)?.output?.statusCode;
  const historico = lerJson(ARQUIVO_REINICIOS, []);
  const d = decidirSaida({
    code,
    pareando: pareando && !jaPareadoNoInicio,
    pareouComSucesso,
    historico: Array.isArray(historico) ? historico : [],
  });
  logger.warn({ code, saida: d.codigoDeSaida, motivo: d.motivo }, 'conexão fechou');

  if (!d.permanente) {
    // NAO chamar start() de novo aqui. Reconectar dentro do mesmo processo
    // empilha sockets: o novo passa a receber mensagem e o antigo continua
    // registrado, e sobra um socket meio vivo, que le mas nao consegue enviar
    // nem entrar em grupo ("Connection Closed"). Em 16/09/2026 o log tinha 199
    // quedas para 192 reconexoes e 514 "Connection Closed".
    //
    // Sair e deixar o systemd subir de novo devolve um processo com um socket
    // so. A espera entre partidas seguidas cresce (ver esperaAntesDeConectar).
    // O drop-in `nunca-desiste.conf` tira o teto de 5 partidas em 300 s, que em
    // 04/10/2026 deixou o bot fora por dois dias, entao a protecao contra
    // tempestade passou a ser esta espera crescente.
    logger.warn('saindo para o systemd subir um processo limpo');
    setTimeout(() => sairComOrdem(d.codigoDeSaida, d.motivo, { registrar: { code } }), 500);
    return;
  }

  stats.conexao = 'logged_out';
  if (d.motivo === 'pareamento_nao_concluido') {
    logger.error('pareamento nao concluido: o codigo expirou sem ser usado. Rode o parear.sh de novo');
  } else {
    logger.error({ motivo: d.motivo }, 'sessao encerrada pelo WhatsApp (logged out): precisa parear de novo ou conferir se ha outra copia da sessao rodando');
  }
  // Sai com 3: a unidade tem RestartPreventExitStatus=3. Avisa o app e SO DEPOIS sai
  // (antes o aviso saia sem await e morria junto com o processo).
  registrarQuedaNoDisco({ code });
  (d.avisarApp ? avisarBotDown(d.motivo, code) : Promise.resolve()).finally(() => sairComOrdem(d.codigoDeSaida, d.motivo));
}

// --- grupos -------------------------------------------------------------

async function carregarGrupos(sock) {
  // o roteamento dos escritorios clientes precisa estar carregado antes de decidir o que e da casa
  await Promise.race([roteamentoPronto, esperar(10_000)]);

  const grupos = await sock.groupFetchAllParticipating();
  for (const [jid, g] of Object.entries(grupos)) metadadosDeGrupo.set(jid, g);

  const lido = lerJson(ARQUIVO_GRUPOS_DA_CASA, {});
  const r = resolverGruposDaCasa({
    gruposDoChip: grupos,
    nomes: config.nomesDosGrupos,
    jidsConfigurados: config.jidsDosGrupos,
    salvos: lido?.salvos || {},
    jidsDeCliente: new Set(grupoOrg.keys()),
  });

  gruposDaCasa.clear();
  for (const jid of r.jids) {
    gruposDaCasa.add(jid);
    targetGroups.set(jid, grupos[jid]?.subject || 'Grupo');
  }
  if (r.adotadosPorNome.length > 0) {
    try {
      gravarJson(ARQUIVO_GRUPOS_DA_CASA, { salvos: r.novosSalvos });
    } catch (err) {
      logger.warn({ err: err?.message }, 'nao consegui gravar os grupos da casa');
    }
    for (const jid of r.adotadosPorNome) {
      logger.info({ jid }, 'grupo da casa localizado pelo nome e gravado: dai em diante vale o jid');
    }
  }
  for (const a of r.ambiguos) {
    logger.warn({ posicao: a.posicao, jids: a.jids }, 'mais de um grupo com o mesmo nome: nao adotei nenhum. Fixe o jid em WA_GROUP_JIDS');
  }
  for (const n of r.naoEncontrados) {
    logger.warn({ esperado: n }, 'grupo da casa nao encontrado: o bot precisa estar nele. Se o grupo foi recriado, apague estado/grupos-da-casa.json ou use WA_GROUP_JIDS');
  }

  // grupos de cliente que o roteamento ja trouxe e que o chip tem: mesmo mapa
  for (const jid of grupoOrg.keys()) {
    if (grupos[jid] && !targetGroups.has(jid)) targetGroups.set(jid, grupos[jid].subject || 'Grupo');
  }
  gruposCarregados = true;
  logger.info({ casa: gruposDaCasa.size, clientes: grupoOrg.size }, 'grupos carregados');

  // So anuncia "pareado" depois de um pareamento novo; antes, toda reconexao zerava o alarme e reescrevia a data.
  if (novoLogin || !jaPareadoNoInicio || avisoDePareamento.pendente()) {
    notificarLIS('event', {
      type: 'bot_paired',
      wa_group_jid: '',
      jids_grupos: jidsParaOHeartbeat({ targetGroups, grupoOrg }),
    })
      .then((r) => {
        // so apaga a marca depois de o app responder; fora do ar, o aviso e repetido na proxima conexao
        if (r !== null) avisoDePareamento.limpar();
      })
      .catch(() => {});
  }
}

// --- multi-escritorio: roteamento e pedidos -----------------------------

/** Busca a tabela de roteamento no app e atualiza o mapa. Devolve a lista, ou null se falhar. */
async function atualizarRoteamento() {
  if (!config.numeroId) return null;
  try {
    const r = await axios.put(
      `${config.lisBase}/api/whatsapp/pedidos?numero_id=${encodeURIComponent(config.numeroId)}`,
      {},
      { headers: authHeaders, timeout: 10000 },
    );
    const lista = r.data?.grupos || [];
    const antes = new Set(grupoOrg.keys());
    grupoOrg.clear();
    for (const g of lista) {
      if (gruposDaCasa.has(g.jid)) {
        logger.warn({ jid: g.jid }, 'roteamento traz grupo da casa como de escritorio: ignorei');
        continue;
      }
      grupoOrg.set(g.jid, g.org_id);
      if (!targetGroups.has(g.jid)) {
        targetGroups.set(g.jid, g.nome || 'Grupo');
        logger.info({ jid: g.jid }, 'grupo de cliente adicionado ao roteamento');
      }
    }
    // Escritorio que saiu da tabela para de ser escutado na hora. Sem esta
    // poda, um cliente que cancelou continuaria sendo lido ate alguem
    // reiniciar o processo.
    for (const jid of antes) {
      if (!grupoOrg.has(jid) && !gruposDaCasa.has(jid)) {
        targetGroups.delete(jid);
        logger.info({ jid }, 'grupo de cliente saiu do roteamento');
      }
    }
    return lista;
  } catch (err) {
    logger.warn({ err: err?.message }, 'roteamento: falha ao buscar grupos');
    return null;
  }
}

function iniciarRoteamento() {
  if (!config.numeroId) {
    resolverRoteamentoPronto();
    return;
  }
  const volta = async () => {
    await atualizarRoteamento();
    resolverRoteamentoPronto();
    setTimeout(volta, 120_000);
  };
  volta();
}

async function responderPedido(id, ok, resultado, erro) {
  try {
    const r = await axios.post(
      `${config.lisBase}/api/whatsapp/pedidos`,
      { id, ok, resultado, erro },
      { headers: authHeaders, timeout: 10000 },
    );
    return r.data ?? {};
  } catch (err) {
    logger.error({ id, err: err?.message }, 'nao consegui devolver o resultado do pedido');
    return null;
  }
}

function iniciarPedidos(processador) {
  if (!config.numeroId) return;
  const volta = async () => {
    if (encerrando) return;
    try {
      const r = await axios.get(`${config.lisBase}/api/whatsapp/pedidos?numero_id=${encodeURIComponent(config.numeroId)}`, {
        headers: authHeaders,
        timeout: 10000,
      });
      const pedidos = r.data?.pedidos || [];
      if (pedidos.length > 0) rapidoAte = estenderModoRapido({ agora: Date.now(), rapidoAte, duracaoMs: config.pedidosRapidoPorMs });
      for (const p of pedidos) await processador.processar(p);
    } catch (err) {
      logger.warn({ err: err?.message }, 'fila de pedidos: falha ao buscar');
    } finally {
      // encadeado: a proxima volta so conta depois de esta terminar, e o ritmo e lento
      // fora do periodo em que alguem espera a tela de cadastro
      setTimeout(volta, proximoIntervaloDePedidos({ agora: Date.now(), rapidoAte, baseMs: config.intervaloDePedidosMs, rapidoMs: config.pedidosRapidoMs }));
    }
  };
  setTimeout(volta, 8000);
}

// --- relogios das filas ---------------------------------------------------

function iniciarRelogios() {
  const podeEnviar = () => !encerrando && stats.conexao === 'open' && gruposCarregados;

  // fila de entrada: o que ficou pendente (app fora do ar, reinicio) e tentado de novo
  const voltaDaEntrada = async () => {
    try {
      if (!encerrando) await entrada.varrer();
    } catch (err) {
      logger.warn({ err: err?.message }, 'varredura da fila de entrada falhou');
    }
    setTimeout(voltaDaEntrada, 20_000);
  };
  setTimeout(voltaDaEntrada, 10_000);

  // fila de saida: busca no app a cada 30 s (ja guarda em disco) e envia no ritmo do limitador
  const buscaDaSaida = async () => {
    try {
      if (podeEnviar()) await saida.buscar();
    } catch (err) {
      logger.warn({ err: err?.message }, 'busca da fila de saida falhou');
    }
    setTimeout(buscaDaSaida, 30_000);
  };
  setTimeout(buscaDaSaida, 15_000);

  const envioDaSaida = async () => {
    try {
      if (podeEnviar()) await saida.entregarProximas();
    } catch (err) {
      logger.warn({ err: err?.message }, 'envio da fila de saida falhou');
    }
    setTimeout(envioDaSaida, 3000);
  };
  setTimeout(envioDaSaida, 18_000);
}

// --- heartbeat ------------------------------------------------------------

function iniciarHeartbeat() {
  // Se o processo fica 15 minutos sem conseguir falar com o app, sai para o
  // systemd subir um processo limpo. Em 04/10/2026 o bot parou de dar sinal e
  // ficou quase dois dias fora sem ninguem perceber. A fila em disco guarda o
  // que estava pendente.
  let ultimoOk = Date.now();
  const enviar = async () => {
    const r = await notificarLIS('heartbeat', {
      conexao: stats.conexao,
      baileys_version: versaoDoBaileys,
      uptime_iniciado_em: stats.uptimeIniciadoEm,
      ultima_msg_recebida_at: stats.ultimaMsgRecebidaAt,
      ultima_msg_enviada_at: stats.ultimaMsgEnviadaAt,
      msgs_processadas_hoje: stats.msgsHoje,
      // grupo da casa leva o nome; grupo de escritorio cliente leva so um rotulo
      jids_grupos: jidsParaOHeartbeat({ targetGroups, grupoOrg }),
    });
    if (r !== null) {
      ultimoOk = Date.now();
      // sinal opcional do app de que ha pedido esperando: acelera a fila de pedidos
      if (Number(r.pedidos_pendentes) > 0) {
        rapidoAte = estenderModoRapido({ agora: Date.now(), rapidoAte, duracaoMs: config.pedidosRapidoPorMs });
      }
    } else if (Date.now() - ultimoOk > 15 * 60_000) {
      logger.error('15 minutos sem falar com o LIS: saindo para o systemd subir um processo limpo');
      sairComOrdem(1, 'sem_contato_com_o_app', { registrar: { code: null } });
      return;
    }
    setTimeout(enviar, 60_000);
  };
  setTimeout(enviar, 5000);
}

// --- mensagem recebida ----------------------------------------------------

/**
 * Avisa no grupo que o arquivo passou do limite (em vez de a mensagem sumir).
 * A reacao sai sempre; a frase, no maximo uma por minuto por grupo.
 */
async function avisarArquivoGrande({ chave, original, tamanho }) {
  const sock = sockAtual ? envolverSocket(sockAtual) : null;
  if (!sock) return;
  const grupoJid = chave.remoteJid;
  try {
    const key = original?.key || { remoteJid: chave.remoteJid, id: chave.id, participant: chave.participant, fromMe: false };
    await sock.sendMessage(grupoJid, { react: { text: REACAO_DE_AVISO, key } });
  } catch (err) {
    logger.error({ err: err?.message }, 'falha ao reagir ao arquivo grande');
  }
  const agora = Date.now();
  if (agora - (avisosDeArquivo.get(grupoJid) || 0) < 60_000) return;
  avisosDeArquivo.set(grupoJid, agora);
  try {
    await sock.sendMessage(grupoJid, { text: avisoDeArquivoGrande({ tamanho, limite: config.limiteDeArquivoBytes }) }, original ? { quoted: original } : undefined);
    stats.ultimaMsgEnviadaAt = new Date().toISOString();
  } catch (err) {
    logger.error({ err: err?.message }, 'falha ao avisar do arquivo grande');
  }
}

async function handleMessage(sock, msg) {
  // Ignora self-send pra evitar loop
  if (msg.key.fromMe) return;
  // Ignora msg sem conteúdo
  if (!msg.message) return;
  // Só escuta grupos alvo
  const groupJid = msg.key.remoteJid;
  const groupName = targetGroups.get(groupJid);
  if (!groupName) return;

  // Documento com legenda, mensagem temporaria e editada chegam embrulhadas:
  // extrairMensagem desembrulha. O que for ignorado e dito no log, com o tipo.
  const extraido = extrairMensagem(msg.message, { visualizacaoUnica: config.visualizacaoUnica });
  if (extraido.ignorar) {
    logger[nivelDoIgnorado(extraido.motivo)]({ motivo: extraido.motivo, tipos: extraido.tipos, id: msg.key.id, grupo: groupJid }, 'mensagem ignorada');
    return;
  }
  if (extraido.edicao && !config.enviarEdicoes) {
    logger.warn({ id: msg.key.id, id_original: extraido.edicao.idOriginal, grupo: groupJid }, 'edicao nao enviada: o app ainda nao trata edicao (WA_ENVIAR_EDICOES)');
    return;
  }

  // Arquivo: confere o tamanho ANTES de baixar. Acima do limite avisa o grupo.
  let arquivo = null;
  let stickerB64;
  if (extraido.midia && extraido.tipo !== 'video') {
    const tamanho = tamanhoDoArquivo(extraido.midia.meta);
    const decisao = decidirArquivo({ tamanho, limite: config.limiteDeArquivoBytes });
    if (!decisao.baixar) {
      logger.warn({ id: msg.key.id, tipo: extraido.tipo, tamanho, limite: config.limiteDeArquivoBytes, grupo: groupJid }, 'arquivo grande demais: avisei no grupo e nao enviei ao app');
      await avisarArquivoGrande({ chave: { remoteJid: groupJid, id: msg.key.id, participant: msg.key.participant || null }, original: msg, tamanho });
      return;
    }
    const baixado = await baixarComoArquivo(sock, msg, extraido.midia.chave, extraido.midia.meta);
    if (baixado && baixado.size > config.limiteDeArquivoBytes) {
      logger.warn({ id: msg.key.id, tipo: extraido.tipo, tamanho: baixado.size, grupo: groupJid }, 'arquivo grande demais depois de baixar: avisei no grupo e nao enviei ao app');
      await avisarArquivoGrande({ chave: { remoteJid: groupJid, id: msg.key.id, participant: msg.key.participant || null }, original: msg, tamanho: baixado.size });
      return;
    }
    if (extraido.tipo === 'sticker') {
      // a figurinha vai como data URL para a Luana descrever via Vision
      if (baixado?.base64) stickerB64 = `data:${baixado.mime || 'image/webp'};base64,${baixado.base64}`;
    } else {
      arquivo = baixado;
    }
  }

  const payload = montarPayload({
    msg,
    extraido,
    grupoJid: groupJid,
    grupoNome: groupName,
    orgId: grupoOrg.get(groupJid),
    arquivo,
    stickerB64,
    enviarEdicoes: config.enviarEdicoes,
  });

  logger.info(resumoDaMensagem({ tipo: extraido.tipo, texto: extraido.texto, arquivo, waMessageId: msg.key.id, grupoJid: groupJid }), 'mensagem recebida');

  // Guarda em disco e entrega. O POST nao bloqueia o recebimento da proxima mensagem.
  entrada.receber(
    msg.key.id,
    { payload, chave: { remoteJid: groupJid, id: msg.key.id, participant: msg.key.participant || null } },
    msg,
  );
}

async function baixarComoArquivo(sock, msg, kind, meta) {
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
    const name = meta.fileName || `${kind}_${msg.key.id}`;
    return {
      name,
      mime: meta.mimetype || 'application/octet-stream',
      size: buffer.length,
      base64: buffer.toString('base64'),
    };
  } catch (err) {
    logger.error({ err: err?.message, tipo: kind }, 'falha ao baixar mídia');
    return null;
  }
}

/** Grava no app o id da mensagem que o bot enviou (habilita corrigir e continuar a conversa por resposta). */
async function patchDoId(corpo) {
  return comTentativas(
    () => axios.patch(config.lisUrl, corpo, { headers: authHeaders, timeout: 10000 }),
    { tentativas: 3, esperaMs: 1500 },
  );
}

/**
 * Deixa o audio da Luana no formato da nota de voz do WhatsApp (ogg/opus,
 * mono, 48 kHz) e mede a duracao. Usa o ffmpeg se estiver instalado; sem
 * ele, manda o opus como veio do LIS, que o WhatsApp tambem toca.
 */
function notaDeVoz(bruto) {
  return new Promise((resolve) => {
    let ff;
    try {
      ff = spawn('ffmpeg', ['-hide_banner', '-i', 'pipe:0', '-ac', '1', '-ar', '48000', '-c:a', 'libopus',
        '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1']);
    } catch {
      return resolve({ audio: bruto, segundos: 0, convertido: false });
    }
    const partes = [];
    let erro = '';
    let pronto = false;
    const sem = () => { if (!pronto) { pronto = true; resolve({ audio: bruto, segundos: 0, convertido: false }); } };
    const relogio = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* ja saiu */ } sem(); }, 20000);
    ff.on('error', () => { clearTimeout(relogio); sem(); });
    ff.stdout.on('data', (d) => partes.push(d));
    ff.stderr.on('data', (d) => { erro += d.toString(); if (erro.length > 20000) erro = erro.slice(-10000); });
    ff.on('close', (codigo) => {
      clearTimeout(relogio);
      if (pronto) return;
      const audio = Buffer.concat(partes);
      if (codigo !== 0 || !audio.length) return sem();
      const tempos = [...erro.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const ultimo = tempos[tempos.length - 1];
      const segundos = ultimo ? Math.round(+ultimo[1] * 3600 + +ultimo[2] * 60 + +ultimo[3]) : 0;
      pronto = true;
      resolve({ audio, segundos, convertido: true });
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(bruto);
  });
}

start().catch((e) => {
  logger.error({ err: e?.message, stack: e?.stack }, 'fatal');
  process.exit(1);
});
