/**
 * Fila de pedidos do app para o bot (hoje so "entrar neste grupo por este
 * link"), com a regra de SEG-M12-002 e SEG-M12-009:
 *
 *  - o pedido so troca o roteamento do bot DEPOIS de o app confirmar que
 *    registrou o grupo para aquele escritorio; antes, o bot gravava na
 *    memoria que o grupo era da org do pedido, e quem tivesse o link de
 *    convite do grupo de outro escritorio derrubava a captura dele;
 *  - a apresentacao so e enviada a grupo novo e registrado;
 *  - so o tipo `entrar_grupo` existe: `criar_grupo`, `sair_grupo` e `recado`
 *    nao tinham quem os criasse no app e deixavam o bot executar envio
 *    livre.
 */
import { comLimite } from './grupos.js';
import { textoDeEntrada } from './textos.js';
import { lerJson, gravarJson } from './estado.js';

export const TIPOS_DE_PEDIDO = ['entrar_grupo'];

const CODIGO_DE_CONVITE = /^[A-Za-z0-9_-]{8,64}$/;

export function validarPedido(p) {
  if (!p || typeof p.id !== 'string' || !p.id) return { ok: false, motivo: 'pedido sem id' };
  if (!TIPOS_DE_PEDIDO.includes(p.tipo)) return { ok: false, motivo: 'tipo de pedido nao suportado' };
  if (typeof p.org_id !== 'string' || !p.org_id) return { ok: false, motivo: 'pedido sem organizacao' };
  const codigo = p.payload?.codigo;
  if (typeof codigo !== 'string' || !CODIGO_DE_CONVITE.test(codigo)) {
    return { ok: false, motivo: 'pedido sem codigo de convite valido' };
  }
  return { ok: true };
}

/**
 * Antes de ler a lista de participantes: o grupo pode ser deste escritorio?
 * Nunca se ele ja e da casa ou de outro escritorio. Assim a lista de gente
 * do grupo alheio nem chega a ser colhida nem devolvida a quem pediu.
 */
export function decidirEntrada({ jid, orgDoPedido, grupoOrg, gruposDaCasa }) {
  if (gruposDaCasa.has(jid)) return { permitido: false, jaRegistrado: false, motivo: 'grupo_da_casa' };
  const dono = grupoOrg.get(jid);
  if (dono && dono !== orgDoPedido) return { permitido: false, jaRegistrado: false, motivo: 'grupo_de_outro_escritorio' };
  if (dono === orgDoPedido) return { permitido: true, jaRegistrado: true, motivo: 'ja_registrado' };
  return { permitido: true, jaRegistrado: false, motivo: 'grupo_novo' };
}

/**
 * Depois de devolver o resultado ao app: o grupo esta mesmo registrado para
 * este escritorio? `resposta` e o que o POST devolveu (se trouxer
 * `registrado: false`, e recusa final); `tabela` e a lista de roteamento
 * buscada em seguida (a fonte da verdade hoje, porque o POST ainda nao diz).
 */
export function conferirRoteamento({ resposta, tabela, jid, orgDoPedido }) {
  if (resposta && resposta.registrado === false) return { confirmado: false, final: true, motivo: 'app_recusou' };
  if (!Array.isArray(tabela)) return { confirmado: false, final: false, motivo: 'tabela_indisponivel' };
  const linha = tabela.find((g) => g?.jid === jid);
  if (!linha) return { confirmado: false, final: false, motivo: 'nao_cadastrado' };
  if (linha.org_id !== orgDoPedido) return { confirmado: false, final: true, motivo: 'outra_organizacao' };
  return { confirmado: true, final: true, motivo: 'confirmado', nome: linha.nome || null };
}

/** Os ids do proprio bot (numero e @lid), para tirar o bot da lista de participantes. */
export function idsDoBot(user) {
  return new Set(
    [user?.id, user?.lid]
      .filter(Boolean)
      .map((x) => String(x).split(':')[0].split('@')[0]),
  );
}

/**
 * A lista de participantes no formato que a tela de cadastro espera. Prefere
 * o numero de verdade ao @lid, porque e pelo numero que a assistente
 * reconhece quem escreve.
 */
export function participantesBrutos(participantes, meusIds) {
  return (participantes || [])
    .filter((x) => !meusIds.has((x.id || '').split('@')[0]) && !meusIds.has((x.jid || '').split('@')[0]))
    .map((x) => {
      const fone = String(x.phoneNumber || x.jid || x.id || '').split('@')[0];
      return {
        jid: fone,
        fim: fone.slice(-4),
        admin: x.admin === 'admin' || x.admin === 'superadmin',
        wid: x.id || x.jid,
      };
    });
}

/** Grupos que o bot ja apresentou (guardado em disco, para um reinicio nao repetir a apresentacao). */
export function criarApresentados({ arquivo, fs, max = 500 } = {}) {
  const lista = lerJson(arquivo, [], fs);
  const conjunto = new Set(Array.isArray(lista) ? lista : []);
  return {
    tem: (jid) => conjunto.has(jid),
    add(jid) {
      conjunto.add(jid);
      const todos = [...conjunto].slice(-max);
      try {
        gravarJson(arquivo, todos, fs);
      } catch {
        // sem disco: segue so com a memoria
      }
    },
  };
}

const LIMITE_DE_FOTOS = 60;
const FOTOS_AO_MESMO_TEMPO = 4;
const TENTATIVAS_DE_CONFIRMACAO = 4;
const ESPERA_ENTRE_CONFIRMACOES_MS = 3000;
const TENTATIVAS_DE_RESPOSTA = 3;

/**
 * Monta o processador de pedidos. Tudo que toca o mundo entra por `deps`, para
 * o teste usar socket e app de mentira.
 */
export function criarProcessadorDePedidos(deps) {
  const {
    sock,
    grupoOrg,
    targetGroups,
    gruposDaCasa,
    apresentados,
    config,
    logger,
    esperar,
    responderPedido, // (id, ok, resultado, erro) => dados da resposta do app, ou null se nao chegou
    buscarTabela, // () => lista de grupos do roteamento, ou null
    enviarTexto, // (jid, texto) => Promise
  } = deps;

  async function entrar(p) {
    let jid;
    let jaDentro = false;
    try {
      jid = await sock.groupAcceptInvite(p.payload.codigo);
    } catch (err) {
      // Se o bot ja esta no grupo o WhatsApp responde com conflito. Isso so
      // diz que ele esta la: de quem e o grupo quem diz e a conferencia abaixo.
      const info = await sock.groupGetInviteInfo(p.payload.codigo).catch(() => null);
      if (!info?.id) throw err;
      jid = info.id;
      jaDentro = true;
    }

    const decisao = decidirEntrada({ jid, orgDoPedido: p.org_id, grupoOrg, gruposDaCasa });
    if (!decisao.permitido) {
      logger.warn({ pedido: p.id, jid, motivo: decisao.motivo }, 'pedido recusado antes de ler o grupo');
      throw new Error('grupo indisponivel para este escritorio');
    }

    const meta = await sock.groupMetadata(jid);
    const brutos = participantesBrutos(meta.participants, idsDoBot(sock.user)).slice(0, 1024);

    // A tela de cadastro precisa do numero e da foto para a pessoa se
    // reconhecer. O nome o WhatsApp nao entrega (esta na agenda de quem olha).
    // Fotos em poucas consultas por vez, e so as primeiras: grupo grande nao
    // vira rajada de consultas ao WhatsApp.
    const participantes = await comLimite(brutos, FOTOS_AO_MESMO_TEMPO, async (b, i) => {
      let foto = null;
      if (i < LIMITE_DE_FOTOS) {
        try {
          foto = await sock.profilePictureUrl(b.wid, 'preview');
        } catch {
          // sem foto, ou escondida nas configuracoes de privacidade dela
        }
      }
      return { jid: b.jid, fim: b.fim, admin: b.admin, fone: b.jid, foto };
    });

    logger.info({ pedido: p.id, jid, gente: participantes.length, jaDentro, jaRegistrado: decisao.jaRegistrado }, 'entrei no grupo do cliente');
    return { resultado: { jid, nome: meta.subject, participantes }, jid, nome: meta.subject, jaRegistrado: decisao.jaRegistrado };
  }

  async function devolver(p, ok, resultado, erro) {
    let ultima = null;
    for (let i = 1; i <= TENTATIVAS_DE_RESPOSTA; i++) {
      ultima = await responderPedido(p.id, ok, resultado, erro);
      if (ultima !== null) return ultima;
      if (i < TENTATIVAS_DE_RESPOSTA) await esperar(2000 * i);
    }
    return null;
  }

  async function confirmar({ jid, orgId, resposta }) {
    let conf = { confirmado: false, final: false, motivo: 'nao_tentou' };
    for (let i = 1; i <= TENTATIVAS_DE_CONFIRMACAO; i++) {
      const tabela = await buscarTabela();
      conf = conferirRoteamento({ resposta, tabela, jid, orgDoPedido: orgId });
      if (conf.final) return conf;
      if (i < TENTATIVAS_DE_CONFIRMACAO) await esperar(ESPERA_ENTRE_CONFIRMACOES_MS);
    }
    return conf;
  }

  async function processar(p) {
    const v = validarPedido(p);
    if (!v.ok) {
      logger.warn({ pedido: p?.id, tipo: p?.tipo, motivo: v.motivo }, 'pedido recusado');
      if (p?.id) await devolver(p, false, null, v.motivo);
      return { ok: false, motivo: v.motivo };
    }

    let feito;
    try {
      feito = await entrar(p);
    } catch (err) {
      logger.error({ pedido: p.id, err: err?.message }, 'pedido falhou');
      await devolver(p, false, null, String(err?.message || err));
      return { ok: false, motivo: 'falhou' };
    }

    const resposta = await devolver(p, true, feito.resultado, null);
    if (resposta === null) {
      logger.error({ pedido: p.id }, 'nao consegui devolver o resultado do pedido ao app');
      return { ok: false, motivo: 'sem_resposta_do_app' };
    }

    const conf = await confirmar({ jid: feito.jid, orgId: p.org_id, resposta });
    if (!conf.confirmado) {
      // Nao troca o roteamento e nao apresenta: o app e quem decide de quem e o grupo.
      logger.warn({ pedido: p.id, jid: feito.jid, motivo: conf.motivo }, 'app nao confirmou o grupo: roteamento e apresentacao ficam como estavam');
      return { ok: false, motivo: conf.motivo };
    }

    grupoOrg.set(feito.jid, p.org_id);
    targetGroups.set(feito.jid, conf.nome || feito.nome || 'Grupo');

    if (!feito.jaRegistrado && !apresentados.tem(feito.jid)) {
      const { texto, origem } = textoDeEntrada({
        apresentacaoDoApp: p.payload?.apresentacao,
        avisoDeEntrada: config.avisoDeEntrada,
        urlDaPrivacidade: config.urlDaPrivacidade,
      });
      try {
        await enviarTexto(feito.jid, texto);
        apresentados.add(feito.jid);
        logger.info({ pedido: p.id, jid: feito.jid, origem }, 'apresentacao enviada');
      } catch (err) {
        logger.warn({ pedido: p.id, err: err?.message }, 'nao consegui enviar a apresentacao');
      }
    }
    return { ok: true, jid: feito.jid };
  }

  return { processar, entrar, confirmar };
}
