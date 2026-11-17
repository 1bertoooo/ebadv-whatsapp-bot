/**
 * EBADV WhatsApp Bot — escuta grupo "EBADV. Captura" e empurra cada
 * mensagem nova pro endpoint /api/whatsapp/capture do LIS.
 *
 * Estratégia: Baileys (não-oficial) com sessão persistida em ./auth_state.
 * Roda como serviço Windows via nssm — basta o PC ficar ligado.
 *
 * Mensagens próprias (do bot) são SEMPRE ignoradas pra evitar loop.
 * Só mensagens do grupo configurado (WA_GROUP_NAME) são processadas.
 */
import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import axios from 'axios';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LIS_URL = process.env.LIS_CAPTURE_URL;
const LIS_SECRET = process.env.LIS_CAPTURE_SECRET;
// Lista de grupos separados por ; (ex: "EBADV. Captura;EBadv. Agogê")
// Fallback: WA_GROUP_NAME (compat retroativa, único grupo).
const WA_GROUP_NAMES = (process.env.WA_GROUP_NAMES || process.env.WA_GROUP_NAME || 'EBADV. Captura')
  .split(';')
  .map(s => s.trim())
  .filter(Boolean);
const AUTH_DIR = process.env.WA_AUTH_DIR || './auth_state';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
// Se WA_PHONE_NUMBER estiver setado (formato internacional sem +, ex: 5543988742822),
// o bot vai usar pareamento por código de 8 dígitos em vez de QR.
// Útil quando o WhatsApp bloqueia pareamento por QR (acontece com chip recém-ativado).
const WA_PHONE_NUMBER = process.env.WA_PHONE_NUMBER?.replace(/\D/g, '') || '';
// Identidade deste chip no estoque (tabela wa_numero). Quando presente, o
// bot atende varios escritorios: busca a fila de pedidos e a tabela de
// roteamento grupo -> organizacao no LIS, em vez de depender so do
// WA_GROUP_NAMES fixo. Sem ele, o comportamento e o de sempre.
const WA_NUMERO_ID = process.env.WA_NUMERO_ID || '';

if (!LIS_URL || !LIS_SECRET) {
  console.error('Faltam LIS_CAPTURE_URL ou LIS_CAPTURE_SECRET no .env');
  process.exit(1);
}

const logger = pino({ level: LOG_LEVEL });

// Cache de grupos alvo: jid -> nome (descoberto após conectar)
const targetGroups = new Map(); // Map<string jid, string name>

// Stats locais pro heartbeat
const stats = {
  uptimeIniciadoEm: new Date().toISOString(),
  ultimaMsgRecebidaAt: null,
  ultimaMsgEnviadaAt: null,
  msgsHoje: 0,
  hojeStr: new Date().toISOString().slice(0, 10),
  conexao: 'connecting',
};
function statsResetSeNovoDia() {
  const agora = new Date().toISOString().slice(0, 10);
  if (agora !== stats.hojeStr) {
    stats.hojeStr = agora;
    stats.msgsHoje = 0;
  }
}

// A versão do WhatsApp Web que o socket anuncia ao conectar.
//
// fetchLatestBaileysVersion() lê um arquivo do repositório do Baileys que fica
// meses sem atualizar: em 16/11/2026 ele dizia 2.3000.1043857760 (de 26/07),
// enquanto o web.whatsapp.com já estava na 2.3000.1054767004. O WhatsApp recusa
// versão velha: em 13/11 a sessão caiu e em 16/11 o pareamento novo foi recusado
// com 401 antes de sair o código. fetchLatestWaWebVersion() lê a versão do
// próprio web.whatsapp.com (sw.js); se essa leitura falhar, vale a do Baileys.
async function versaoDoWhatsAppWeb() {
  try {
    const web = await fetchLatestWaWebVersion();
    if (web?.isLatest && Array.isArray(web.version)) return { version: web.version, origem: 'web.whatsapp.com' };
  } catch (err) {
    logger.warn({ err: err?.message }, 'não li a versão do web.whatsapp.com; vale a do Baileys');
  }
  const { version } = await fetchLatestBaileysVersion();
  return { version, origem: 'repositório do Baileys' };
}

// ============================================================
//  RECONECTAR PELO LIS (17/11/2026)
//  Antes, deslogada, a Luana saía com 3 e só voltava com alguém rodando o
//  parear.sh pelo Terminal, com a senha do root. Agora, sem sessão, o
//  processo continua vivo, manda sinal ao LIS como 'aguardando_pareamento'
//  e espera um pedido de código feito na tela /admin/luana (fila
//  wa_pedido, tipo 'parear'). Com o pedido, pede o código ao WhatsApp e
//  devolve ao LIS, que mostra o código para digitar no celular da Luana.
//  Só vale com WA_PHONE_NUMBER e WA_NUMERO_ID no .env; sem eles, tudo
//  continua como antes.
// ============================================================
const PAREAMENTO_PELO_LIS = !!(WA_PHONE_NUMBER && WA_NUMERO_ID);

/**
 * A sessão gravada serve para entrar? Vale a que o WhatsApp registrou
 * ('registered') ou a que já tem conta ('account', gravada quando o
 * pareamento dá certo). Tentativa de pareamento que não terminou deixa
 * uma sessão pela metade, que o WhatsApp recusa com 401 no reinício: essa
 * não serve, e vai para o lado.
 */
function sessaoUtil() {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8'));
    return creds?.registered === true || !!creds?.account;
  } catch {
    return false;
  }
}

/** Põe a sessão de agora ao lado, com data, só com leitura do dono. A próxima começa limpa. */
function guardarSessaoVelha() {
  if (!fs.existsSync(AUTH_DIR)) return;
  const carimbo = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const destino = `${path.resolve(AUTH_DIR)}_backup_${carimbo}`;
  try {
    fs.renameSync(AUTH_DIR, destino);
    fs.chmodSync(destino, 0o700);
    logger.info({ destino }, 'sessão guardada ao lado; a próxima começa limpa');
  } catch (err) {
    logger.warn({ err: err?.message }, 'não consegui guardar a sessão velha');
  }
}

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Sem sessão: espera, de 20 em 20 segundos, um pedido de código feito na
 * tela do LIS. Não abre conexão com o WhatsApp enquanto ninguém pede, para
 * não gastar o número com tentativas (em 16/11/2026 quatro tentativas em
 * 20 minutos fizeram o WhatsApp recusar novos pedidos).
 */
async function esperarPedidoDeCodigo() {
  stats.conexao = 'aguardando_pareamento';
  iniciarHeartbeat();
  logger.info('sem sessão no WhatsApp: esperando o pedido de código pela tela Luana no WhatsApp, no LIS');
  for (;;) {
    try {
      const r = await axios.get(
        `${LIS_BASE}/api/whatsapp/pedidos?numero_id=${encodeURIComponent(WA_NUMERO_ID)}&tipo=parear`,
        { headers: { Authorization: `Bearer ${LIS_SECRET}` }, timeout: 10000 },
      );
      const recebidos = r.data?.pedidos || [];
      // Um LIS antigo ignora o tipo=parear e devolve qualquer pedido: o que não
      // é de código volta como erro, para não ficar parado como "executando".
      for (const p of recebidos.filter((x) => x.tipo !== 'parear')) {
        await responderPedido(p.id, false, null, 'a Luana está sem sessão no WhatsApp; peça de novo depois que ela voltar');
      }
      const pedidos = recebidos.filter((x) => x.tipo === 'parear');
      if (pedidos.length) {
        // vem do mais velho para o mais novo; vale o mais novo
        const escolhido = pedidos[pedidos.length - 1];
        for (const p of pedidos.slice(0, -1)) {
          await responderPedido(p.id, false, null, 'pedido repetido: valeu o mais novo');
        }
        logger.info({ pedido: escolhido.id }, 'pedido de código recebido do LIS');
        return escolhido;
      }
    } catch (err) {
      logger.warn({ err: err?.message }, 'pareamento: falha ao buscar pedido no LIS');
    }
    await esperar(20_000);
  }
}

async function principal() {
  if (PAREAMENTO_PELO_LIS && !sessaoUtil()) {
    guardarSessaoVelha();
    const pedido = await esperarPedidoDeCodigo();
    return start(pedido);
  }
  return start(null);
}

async function start(pedido) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, origem } = await versaoDoWhatsAppWeb();
  logger.info({ baileysVersion: version, origemDaVersao: origem }, 'iniciando');

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'warn' }),
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Pedido de código vindo do LIS: a tela fica sabendo do código e de uma
  // falha só (a primeira); um código entregue pode virar falha depois, se
  // vencer ou se a conexão cair antes de ele ser usado.
  let conectou = false;
  let codigoEntregue = false;
  let falhaRespondida = false;
  const responderFalha = async (motivo) => {
    if (!pedido || falhaRespondida) return;
    falhaRespondida = true;
    await responderPedido(pedido.id, false, null, motivo);
  };

  // Pareamento por código (em vez de QR) quando WA_PHONE_NUMBER está setado
  if (WA_PHONE_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(WA_PHONE_NUMBER);
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
        if (pedido) {
          codigoEntregue = true;
          await responderPedido(pedido.id, true, { codigo: formatted, gerado_em: new Date().toISOString() }, null);
          logger.info({ pedido: pedido.id }, 'código de pareamento entregue ao LIS');
        }
      } catch (err) {
        logger.error({ err: err?.message }, 'falha ao gerar pairing code');
        await responderFalha(`o WhatsApp recusou o pedido de código (${err?.message || err})`);
      }
    }, 3500);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !WA_PHONE_NUMBER) {
      console.log('\n========================================');
      console.log('LEIA O QR CODE ABAIXO COM O CELULAR DO BOT');
      console.log('WhatsApp > Dispositivos conectados > Conectar dispositivo');
      console.log('========================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      conectou = true;
      logger.info('conectado ao WhatsApp');
      stats.conexao = 'open';
      // Tenta achar todos os grupos configurados
      sock.groupFetchAllParticipating().then((groups) => {
        targetGroups.clear();
        for (const [jid, g] of Object.entries(groups)) {
          if (WA_GROUP_NAMES.includes(g.subject)) {
            targetGroups.set(jid, g.subject);
            logger.info({ jid, name: g.subject }, 'grupo alvo localizado');
          }
        }
        // grupos cadastrados no LIS (um por escritorio cliente) entram
        // no mesmo cache: o roteamento por nome fixo vira um caso
        // particular do roteamento por tabela.
        for (const [jid, org] of grupoOrg) {
          if (groups[jid] && !targetGroups.has(jid)) {
            targetGroups.set(jid, groups[jid].subject);
            logger.info({ jid, org, name: groups[jid].subject }, 'grupo de cliente localizado');
          }
        }
        const naoEncontrados = WA_GROUP_NAMES.filter(
          n => !Array.from(targetGroups.values()).includes(n),
        );
        if (naoEncontrados.length > 0) {
          logger.warn({ naoEncontrados }, 'grupos não encontrados — bot precisa estar neles');
        }
        // Anuncia ao LIS que está pareado
        notificarLIS('event', {
          type: 'bot_paired',
          wa_group_jid: '',
          jids_grupos: Object.fromEntries(targetGroups),
        }).catch(() => {});
      });
    } else if (connection === 'connecting') {
      stats.conexao = 'connecting';
    }

    if (connection === 'close') {
      stats.conexao = 'closed';
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, 'conexão fechou');
      // Pareamento pedido pelo LIS que não chegou a conectar: a tela precisa
      // saber. 515 é o "reinicie" que o WhatsApp manda logo depois de o
      // código dar certo; esse não é falha.
      if (pedido && !conectou && code !== DisconnectReason.restartRequired) {
        const motivo = !codigoEntregue
          ? `o WhatsApp recusou o pedido de código (erro ${code})`
          : code === 408
            ? 'o código venceu sem ser usado'
            : `a conexão caiu antes de o código ser usado (erro ${code})`;
        responderFalha(motivo).catch(() => {});
      }
      if (shouldReconnect) {
        // NAO chamar start() de novo aqui. Reconectar dentro do mesmo
        // processo empilha sockets: o novo passa a receber mensagem e o
        // antigo continua registrado, e sobra um socket meio vivo, que
        // le mas nao consegue enviar nem entrar em grupo ("Connection
        // Closed"). Em 16/09/2026 o log tinha 199 quedas para 192
        // reconexoes e 514 "Connection Closed", e um cliente empacou no
        // cadastro por causa disso.
        //
        // Sair e deixar o systemd subir de novo devolve um processo com
        // um socket so. A unidade tem Restart=on-failure, RestartSec=10
        // e teto de 5 partidas em 300s, que e a protecao contra tempestade.
        logger.warn('saindo para o systemd subir um processo limpo');
        // Depois de um pareamento que deu certo (515) espera um pouco mais,
        // para a sessão nova terminar de ser gravada antes de sair.
        setTimeout(() => process.exit(1), code === DisconnectReason.restartRequired ? 3000 : 500);
      }
      else {
        stats.conexao = 'logged_out';
        logger.error('logged out - apague auth_state e leia QR de novo');
        // Avisa o LIS e SO DEPOIS sai. Antes o fetch saia sem await e o
        // process.exit vinha na mesma volta: o aviso morria junto com o
        // processo e a queda so aparecia no watchdog do dia seguinte.
        //
        // Com o pareamento pelo LIS (17/11/2026): guarda a sessão recusada e
        // sai com 1; o systemd sobe um processo que espera, sem conectar, o
        // código pedido na tela /admin/luana. Se a recusa veio durante um
        // pareamento, a tela já sabe, e não sai outro e-mail de "caiu".
        if (PAREAMENTO_PELO_LIS) {
          const aviso = pedido ? Promise.resolve() : avisarDeslogado(code);
          aviso.finally(() => {
            guardarSessaoVelha();
            process.exit(1);
          });
          return;
        }
        // Sem ele: sai com 3, e nao 1; a unidade do systemd tem
        // RestartPreventExitStatus=3. Deslogado nao volta sozinho (precisa
        // parear de novo), e subir em loop so gastaria o chip.
        avisarDeslogado(code).finally(() => process.exit(3));
      }
    }
  });

  // Novo membro / saída de membro
  sock.ev.on('group-participants.update', async (ev) => {
    if (!targetGroups.has(ev.id)) return;
    if (ev.action === 'add') {
      // Filtra: não cumprimenta o próprio bot
      const myJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
      const novos = (ev.participants || [])
        .filter(jid => jid !== myJid)
        .map(jid => ({ jid, name: '' }));
      if (novos.length === 0) return;

      try {
        const r = await notificarLIS('event', {
          type: 'member_joined',
          wa_group_jid: ev.id,
          wa_group_name: targetGroups.get(ev.id),
          new_members: novos,
          added_by_jid: ev.author || null,
        });
        // LIS devolve mensagens a enviar
        for (const m of r?.mensagens || []) {
          try {
            await sock.sendMessage(ev.id, {
              text: m.text,
              mentions: [m.jid],
            });
            stats.ultimaMsgEnviadaAt = new Date().toISOString();
          } catch (err) {
            logger.error({ err: err?.message }, 'falha ao cumprimentar membro');
          }
        }
      } catch (err) {
        logger.error({ err: err?.message }, 'falha notificar LIS de member_joined');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
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

  // Heartbeat a cada 60s pro LIS saber que tá vivo
  iniciarHeartbeat();

  // Pollster da fila de mensagens outbound (sprint, etc) a cada 1 min
  iniciarOutboundPoller(sock);

  // Fila de pedidos (entrar em grupo de cliente) e tabela de roteamento
  if (WA_NUMERO_ID) {
    iniciarPedidoPoller(sock);
    iniciarRoteamento(sock);
  }
}

// ============================================================
//  MULTI-ESCRITORIO
//  Duas coisas novas, ambas puxadas pelo bot (o VPS nao abre porta):
//   1. a fila de pedidos — hoje so "entra neste grupo por este link";
//   2. a tabela de roteamento grupo -> organizacao, que substitui a
//      lista fixa de nomes quando o bot atende mais de um escritorio.
// ============================================================

/** jid do grupo -> id da organizacao dona dele */
const grupoOrg = new Map();

async function iniciarRoteamento(sock) {
  const buscar = async () => {
    try {
      const r = await axios.put(
        `${LIS_BASE}/api/whatsapp/pedidos?numero_id=${encodeURIComponent(WA_NUMERO_ID)}`,
        {},
        { headers: { Authorization: `Bearer ${LIS_SECRET}` }, timeout: 10000 },
      );
      const grupos = r.data?.grupos || [];
      const antes = new Set(grupoOrg.keys());
      grupoOrg.clear();
      for (const g of grupos) {
        grupoOrg.set(g.jid, g.org_id);
        if (!targetGroups.has(g.jid)) {
          targetGroups.set(g.jid, g.nome || 'Grupo');
          logger.info({ jid: g.jid, nome: g.nome }, 'grupo de cliente adicionado ao roteamento');
        }
      }
      // Escritorio que saiu da tabela para de ser escutado na hora. Sem
      // esta poda, um cliente que cancelou continuaria sendo lido ate
      // alguem reiniciar o processo — e o bot pode demorar dias assim.
      for (const jid of antes) {
        if (!grupoOrg.has(jid) && !WA_GROUP_NAMES.includes(targetGroups.get(jid))) {
          targetGroups.delete(jid);
          logger.info({ jid }, 'grupo de cliente saiu do roteamento');
        }
      }
    } catch (err) {
      logger.warn({ err: err?.message }, 'roteamento: falha ao buscar grupos');
    }
  };
  await buscar();
  setInterval(buscar, 600_000); // 10 min (economia na Vercel, 03/11/2026)
}

function iniciarPedidoPoller(sock) {
  const rodar = async () => {
    let pedidos = [];
    try {
      const r = await axios.get(
        `${LIS_BASE}/api/whatsapp/pedidos?numero_id=${encodeURIComponent(WA_NUMERO_ID)}`,
        { headers: { Authorization: `Bearer ${LIS_SECRET}` }, timeout: 10000 },
      );
      pedidos = r.data?.pedidos || [];
    } catch (err) {
      logger.warn({ err: err?.message }, 'fila de pedidos: falha ao buscar');
      return;
    }

    for (const p of pedidos) {
      try {
        const resultado = await executarPedido(sock, p);
        await responderPedido(p.id, true, resultado, null);
      } catch (err) {
        logger.error({ pedido: p.id, err: err?.message }, 'pedido falhou');
        await responderPedido(p.id, false, null, String(err?.message || err));
      }
    }
  };
  setTimeout(rodar, 8000);
  setInterval(rodar, 60_000); // 1 min: pedidos de entrar em grupo são raros (economia na Vercel, 03/11/2026)
}

async function executarPedido(sock, p) {
  if (p.tipo === 'entrar_grupo') {
    const codigo = p.payload?.codigo;
    if (!codigo) throw new Error('pedido sem codigo de convite');

    // groupAcceptInvite devolve o jid do grupo. Se ja estivermos dentro,
    // o WhatsApp responde com erro de conflito — tratado como sucesso,
    // porque o efeito desejado (estar no grupo) ja vale.
    let jid;
    try {
      jid = await sock.groupAcceptInvite(codigo);
    } catch (err) {
      const info = await sock.groupGetInviteInfo(codigo).catch(() => null);
      if (!info?.id) throw err;
      jid = info.id;
    }

    const meta = await sock.groupMetadata(jid);

    // Tirar o proprio bot da lista e mais chato do que parece: o WhatsApp
    // pode listar o mesmo aparelho pelo numero (@s.whatsapp.net) ou pelo
    // identificador anonimo (@lid), e os dois nao se parecem em nada. Sem
    // comparar os dois, a tela de cadastro mostra a Luana como se fosse
    // uma pessoa do escritorio. (visto em 11/09/2026)
    const meusIds = new Set(
      [sock.user?.id, sock.user?.lid]
        .filter(Boolean)
        .map(x => x.split(':')[0].split('@')[0]),
    );
    const brutos = (meta.participants || [])
      .filter(x => !meusIds.has((x.id || '').split('@')[0]) && !meusIds.has((x.jid || '').split('@')[0]))
      .map(x => {
        // preferimos o numero de verdade: e por ele que a assistente
        // reconhece quem escreveu, e o @lid nao serve para isso.
        const fone = (x.phoneNumber || x.jid || x.id || '').split('@')[0];
        return {
          jid: fone,
          fim: fone.slice(-4),
          admin: x.admin === 'admin' || x.admin === 'superadmin',
          wid: x.id || x.jid,
        };
      });

    // A tela de cadastro mostrava so os quatro ultimos digitos, o que nao
    // ajuda ninguem a se reconhecer numa lista. Vai o numero inteiro e a
    // foto de perfil.
    //
    // O NOME o WhatsApp nao entrega, e isso nao tem conserto do nosso
    // lado: o nome que voce ve no seu celular esta na SUA agenda e nunca
    // sai dela. O que existe e o apelido publico, e ele so chega quando a
    // pessoa escreve alguma mensagem. Por isso a tela nasce com o nome em
    // branco para preencher.
    const participantes = await Promise.all(brutos.map(async (b) => {
      let foto = null;
      try {
        foto = await sock.profilePictureUrl(b.wid, 'preview');
      } catch {
        // sem foto, ou escondida nas configuracoes de privacidade dela
      }
      return { jid: b.jid, fim: b.fim, admin: b.admin, fone: b.jid, foto };
    }));

    grupoOrg.set(jid, p.org_id);
    targetGroups.set(jid, meta.subject);
    logger.info({ jid, nome: meta.subject, gente: participantes.length }, 'entrei no grupo do cliente');

    await sock.sendMessage(jid, {
      text: 'Oi! Sou a Clio, a assistente do stabi.li. A partir de agora eu leio o que passa aqui e transformo em tarefa no painel de voces. Para eu registrar alguma coisa, escreva assim:\n\n*CLIENTE. o que precisa ser feito*\n\nQuando eu registrar, marco a mensagem com \u2611\ufe0f.',
    }).catch(() => {});

    return { jid, nome: meta.subject, participantes };
  }

  if (p.tipo === 'criar_grupo') {
    // Para o escritorio que ainda nao tem grupo: a gente cria, devolve
    // o link e ele convida a equipe. O nosso numero nasce administrador,
    // entao depois consegue sair sozinho se o teste nao virar contrato.
    const nome = p.payload?.nome || 'Escritorio';
    const g = await sock.groupCreate(nome, []);
    const codigo = await sock.groupInviteCode(g.id);
    grupoOrg.set(g.id, p.org_id);
    targetGroups.set(g.id, nome);
    logger.info({ jid: g.id, nome }, 'grupo criado para cliente');
    return { jid: g.id, nome, convite: 'https://chat.whatsapp.com/' + codigo, participantes: [] };
  }

  if (p.tipo === 'sair_grupo') {
    const jid = p.payload?.jid;
    if (!jid) throw new Error('pedido sem jid');
    await sock.groupLeave(jid);
    grupoOrg.delete(jid);
    targetGroups.delete(jid);
    return { jid, saiu: true };
  }

  if (p.tipo === 'recado') {
    const { jid, texto } = p.payload || {};
    if (!jid || !texto) throw new Error('pedido sem jid ou texto');
    await sock.sendMessage(jid, { text: texto });
    return { enviado: true };
  }

  throw new Error('tipo de pedido desconhecido: ' + p.tipo);
}

async function responderPedido(id, ok, resultado, erro) {
  try {
    await axios.post(
      `${LIS_BASE}/api/whatsapp/pedidos`,
      { id, ok, resultado, erro },
      { headers: { Authorization: `Bearer ${LIS_SECRET}` }, timeout: 10000 },
    );
  } catch (err) {
    logger.error({ id, err: err?.message }, 'nao consegui devolver o resultado do pedido');
  }
}

function iniciarOutboundPoller(sock) {
  const verificar = async () => {
    try {
      const r = await axios.get(`${LIS_BASE}/api/whatsapp/outbound`, {
        headers: { Authorization: `Bearer ${LIS_SECRET}` },
        timeout: 10000,
      });
      const mensagens = r.data?.mensagens || [];
      for (const m of mensagens) {
        try {
          let sent;
          if (m.action === 'delete' && m.target_msg_id) {
            // Apaga pra todos via Baileys revoke
            sent = await sock.sendMessage(m.group_jid, {
              delete: { remoteJid: m.group_jid, fromMe: true, id: m.target_msg_id, participant: undefined },
            });
            logger.info({ motivo: m.motivo, target: m.target_msg_id }, 'mensagem apagada');
          } else if (m.sticker_url) {
            // Baixa o webp e envia como sticker nativo
            const stickerRes = await axios.get(m.sticker_url, { responseType: 'arraybuffer', timeout: 15000 });
            sent = await sock.sendMessage(m.group_jid, { sticker: Buffer.from(stickerRes.data) });
          } else if (m.text) {
            sent = await sock.sendMessage(m.group_jid, { text: m.text });
          } else {
            logger.warn({ id: m.id }, 'mensagem outbound vazia — pulando');
            continue;
          }
          stats.ultimaMsgEnviadaAt = new Date().toISOString();
          await axios.post(
            `${LIS_BASE}/api/whatsapp/outbound`,
            { id: m.id, bot_msg_id: sent?.key?.id || null },
            { headers: { Authorization: `Bearer ${LIS_SECRET}` }, timeout: 10000 },
          );
          logger.info({ motivo: m.motivo, group: m.group_jid, kind: m.sticker_url ? 'sticker' : 'text' }, 'mensagem outbound enviada');
        } catch (err) {
          logger.error({ id: m.id, err: err?.message }, 'falha enviar mensagem outbound');
        }
      }
    } catch (err) {
      // Silencioso — outbound é best-effort
    }
  };
  setTimeout(verificar, 15000);
  setInterval(verificar, 60_000); // 1 min (economia na Vercel, 03/11/2026)
}

// Aviso de "deslogado" para o LIS, com prazo: no maximo 8 s esperando.
async function avisarDeslogado(code) {
  const base = (process.env.LIS_CAPTURE_URL || '').replace(/\/capture$/, '');
  if (!base) return;
  const ctrl = new AbortController();
  const prazo = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(base + '/bot-down', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + (process.env.LIS_CAPTURE_SECRET || ''),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        motivo: 'logged_out',
        codigo: code,
        uptime_iniciado_em: stats.uptimeIniciadoEm,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    logger.warn({ err: e && e.message }, 'bot-down alert falhou');
  } finally {
    clearTimeout(prazo);
  }
}

const LIS_BASE = (LIS_URL || '').replace(/\/api\/whatsapp\/.*$/, '');

async function notificarLIS(endpoint, payload) {
  const url = `${LIS_BASE}/api/whatsapp/${endpoint}`;
  try {
    const r = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${LIS_SECRET}` },
      timeout: 15000,
    });
    return r.data;
  } catch (err) {
    logger.warn({ endpoint, err: err?.message }, 'notificarLIS falhou');
    return null;
  }
}

let heartbeatLigado = false;
function iniciarHeartbeat() {
  // Liga uma vez só: o processo que espera o código já liga, e o start() liga de novo.
  if (heartbeatLigado) return;
  heartbeatLigado = true;
  // Se o processo fica 15 minutos sem conseguir falar com o LIS, sai para o
  // systemd subir um processo limpo. Em 04/10/2026 o bot parou de dar sinal
  // e ficou quase dois dias fora sem ninguem perceber.
  let ultimoOk = Date.now();
  const enviar = async () => {
    const r = await notificarLIS('heartbeat', {
      conexao: stats.conexao,
      baileys_version: 'baileys',
      uptime_iniciado_em: stats.uptimeIniciadoEm,
      ultima_msg_recebida_at: stats.ultimaMsgRecebidaAt,
      ultima_msg_enviada_at: stats.ultimaMsgEnviadaAt,
      msgs_processadas_hoje: stats.msgsHoje,
      jids_grupos: Object.fromEntries(targetGroups),
    }).catch(() => null);
    if (r !== null) {
      ultimoOk = Date.now();
    } else if (Date.now() - ultimoOk > 15 * 60_000) {
      logger.error('15 minutos sem falar com o LIS: saindo para o systemd subir um processo limpo');
      process.exit(1);
    }
  };
  // primeiro envio imediato + cada 60s
  setTimeout(enviar, 5000);
  setInterval(enviar, 120_000); // 2 min; o vigia do LIS só alarma com 5 min sem sinal (economia na Vercel, 03/11/2026)
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

  // Identifica tipo
  const m = msg.message;
  let type;
  let text = '';
  let file = null;
  let reaction = null;

  if (m.conversation) {
    type = 'text';
    text = m.conversation;
  } else if (m.extendedTextMessage) {
    type = 'text';
    text = m.extendedTextMessage.text || '';
  } else if (m.audioMessage) {
    type = 'audio';
    file = await downloadAsFile(sock, msg, 'audioMessage', m.audioMessage);
  } else if (m.imageMessage) {
    type = 'image';
    text = m.imageMessage.caption || '';
    file = await downloadAsFile(sock, msg, 'imageMessage', m.imageMessage);
  } else if (m.documentMessage) {
    type = 'document';
    text = m.documentMessage.caption || '';
    file = await downloadAsFile(sock, msg, 'documentMessage', m.documentMessage);
  } else if (m.videoMessage) {
    type = 'video';
    text = m.videoMessage.caption || '';
  } else if (m.stickerMessage) {
    type = 'sticker';
    // Baixa o webp e enviou como data URL pra Luana descrever via Vision
    try {
      const f = await downloadAsFile(sock, msg, 'stickerMessage', m.stickerMessage);
      if (f?.base64) {
        var stickerB64 = `data:${f.mime || 'image/webp'};base64,${f.base64}`;
      }
    } catch (err) {
      logger.warn({ err: err?.message }, 'falha ao baixar sticker');
    }
  } else if (m.reactionMessage) {
    type = 'reaction';
    reaction = {
      emoji: m.reactionMessage.text,
      target_wa_message_id: m.reactionMessage.key?.id || '',
    };
  } else {
    logger.debug({ keys: Object.keys(m) }, 'tipo desconhecido — ignorando');
    return;
  }

  // Quoted message
  const ctxInfo =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    null;
  const quotedId = ctxInfo?.stanzaId || null;

  const payload = {
    wa_message_id: msg.key.id,
    wa_group_jid: groupJid,
    wa_group_name: groupName, // <-- modo no LIS: "EBADV. Captura" ou "EBadv. Agogê"
    // De quem e esta mensagem. Vazio = grupo da casa (a EB), que e o
    // caso de todos os grupos historicos. Preenchido = escritorio
    // cliente, e o LIS grava a tarefa na organizacao dele.
    org_id: grupoOrg.get(groupJid) || undefined,
    wa_sender_jid: msg.key.participant || msg.participant || msg.key.remoteJid,
    // Baileys adicionou senderPn/participantPn pra expor o telefone real
    // mesmo quando o JID público é @lid (anônimo do WhatsApp Business).
    // Tentamos várias fontes — o LIS usa pra mapear no app_user via whatsapp_phone.
    wa_sender_phone:
      msg.key.senderPn ||
      msg.key.participantPn ||
      msg.key.participantAlt ||
      (ctxInfo && (ctxInfo.participantPn || ctxInfo.participantAlt)) ||
      null,
    wa_sender_name: msg.pushName || null,
    wa_timestamp: Number(msg.messageTimestamp),
    wa_quoted_message_id: quotedId,
    message_type: type,
    text_content: text || undefined,
    file: file || undefined,
    reaction: reaction || undefined,
    sticker_b64: typeof stickerB64 !== 'undefined' ? stickerB64 : undefined,
    // o LIS so responde em audio para bot que sabe mandar nota de voz
    capacidades: ['nota_de_voz'],
  };

  logger.info(
    {
      type,
      sender: payload.wa_sender_name,
      preview: text ? text.slice(0, 60) : `<${type}>`,
    },
    'mensagem recebida',
  );

  // POST pro LIS
  let res;
  try {
    res = await axios.post(LIS_URL, payload, {
      headers: { Authorization: `Bearer ${LIS_SECRET}` },
      // audio da Luana: transcrever, pensar, usar ferramenta e falar pode
      // passar de um minuto
      timeout: 150000,
      maxBodyLength: 100 * 1024 * 1024,
      maxContentLength: 100 * 1024 * 1024,
    });
  } catch (err) {
    logger.error({ err: err?.message, code: err?.response?.status }, 'POST /capture falhou');
    return;
  }

  const { reply_text, reaction_emoji, classification, capture_id, sticker_url, reply_audio_b64 } = res.data || {};
  logger.info(
    {
      classification,
      has_reaction: !!reaction_emoji,
      has_reply: !!reply_text,
      has_sticker: !!sticker_url,
      has_audio: !!reply_audio_b64,
    },
    'LIS respondeu',
  );

  // Resposta falada da Luana: nota de voz citando o audio de quem pediu.
  // O id da nota de voz volta para o LIS (responder a ela continua a
  // conversa). Se houver texto junto (os links), ele sai depois.
  let enviadoParaOLis = null;
  if (reply_audio_b64) {
    try {
      const bruto = Buffer.from(reply_audio_b64, 'base64');
      const nota = await notaDeVoz(bruto);
      try { await sock.sendPresenceUpdate('recording', groupJid); } catch {}
      const conteudo = { audio: nota.audio, mimetype: 'audio/ogg; codecs=opus', ptt: true };
      if (nota.segundos) conteudo.seconds = nota.segundos;
      const sentAudio = await sock.sendMessage(groupJid, conteudo, { quoted: msg });
      try { await sock.sendPresenceUpdate('paused', groupJid); } catch {}
      stats.ultimaMsgEnviadaAt = new Date().toISOString();
      enviadoParaOLis = sentAudio?.key?.id || null;
      logger.info({ bytes: nota.audio.length, segundos: nota.segundos, convertido: nota.convertido }, 'nota de voz enviada');
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao enviar nota de voz');
    }
  }

  // Envia sticker se a Luana decidiu mandar (Agogê)
  if (sticker_url) {
    try {
      const r = await axios.get(sticker_url, { responseType: 'arraybuffer', timeout: 15000 });
      await sock.sendMessage(groupJid, { sticker: Buffer.from(r.data) });
      stats.ultimaMsgEnviadaAt = new Date().toISOString();
      logger.info({ sticker_url: sticker_url.split('/').pop() }, 'sticker enviado');
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao enviar sticker');
    }
  }

  // Reage com emoji na mensagem original (☑️ pra captura, 📸 pra imagem etc)
  if (reaction_emoji) {
    try {
      await sock.sendMessage(groupJid, {
        react: { text: reaction_emoji, key: msg.key },
      });
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao reagir');
    }
  }

  // Texto só quando houver algo a esclarecer (erro, pedido de input, confirmação de arquivo)
  if (reply_text) {
    let sent;
    try {
      sent = await sock.sendMessage(groupJid, { text: reply_text }, { quoted: msg });
      stats.ultimaMsgEnviadaAt = new Date().toISOString();
    } catch (err) {
      logger.error({ err: err?.message }, 'falha ao enviar reply');
    }
    if (!enviadoParaOLis && sent?.key?.id) enviadoParaOLis = sent.key.id;
  }

  // Reporta wa_message_id da própria resposta pro LIS: habilita correção via
  // reply e, na nota de voz, a conversa continuar quando respondem a ela
  if (enviadoParaOLis && capture_id) {
    try {
      await axios.patch(
        LIS_URL,
        { capture_id, bot_reply_wa_id: enviadoParaOLis },
        { headers: { Authorization: `Bearer ${LIS_SECRET}` }, timeout: 10000 },
      );
    } catch (err) {
      logger.warn({ err: err?.message }, 'falha reportando bot_reply_wa_id');
    }
  }
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
    const relogio = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} sem(); }, 20000);
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

async function downloadAsFile(sock, msg, kind, meta) {
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
    logger.error({ err: err?.message }, 'falha ao baixar mídia');
    return null;
  }
}

principal().catch((e) => {
  logger.error({ err: e?.message, stack: e?.stack }, 'fatal');
  process.exit(1);
});
