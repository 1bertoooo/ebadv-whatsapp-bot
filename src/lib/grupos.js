/**
 * Quais grupos o bot escuta (SEG-M12-001, SEG-M12-010).
 *
 * Antes, os grupos da casa eram reconhecidos pelo NOME exato, lido a cada
 * partida. Qualquer pessoa que criasse um grupo com esse nome e adicionasse o
 * numero entrava no mapa (e, pelo heartbeat, aparecia como grupo da casa), e
 * renomear o grupo da casa desligava a captura em silencio.
 *
 * Agora o que vale e o jid:
 *  1. se WA_GROUP_JIDS estiver definido, so ele conta e o nome e ignorado;
 *  2. senao, o nome serve uma vez so, para descobrir o jid: o grupo achado e
 *     gravado em estado/grupos-da-casa.json e dali em diante o jid manda.
 *     Dois grupos com o mesmo nome nao sao adotados (ambiguo).
 */

/**
 * @param gruposDoChip   { [jid]: { subject } }, o que o WhatsApp devolveu
 * @param nomes          WA_GROUP_NAMES
 * @param jidsConfigurados WA_GROUP_JIDS
 * @param salvos         { [nome]: jid } lido do arquivo de estado
 * @param jidsDeCliente  jids que o app cadastrou para escritorios clientes (nunca da casa)
 */
export function resolverGruposDaCasa({ gruposDoChip, nomes = [], jidsConfigurados = [], salvos = {}, jidsDeCliente = new Set() }) {
  const jids = new Set();
  const novosSalvos = { ...salvos };
  const adotadosPorNome = [];
  const ambiguos = [];
  const naoEncontrados = [];

  if (jidsConfigurados.length > 0) {
    for (const jid of jidsConfigurados) {
      if (gruposDoChip[jid]) jids.add(jid);
      else naoEncontrados.push(jid);
    }
    return { jids, novosSalvos, adotadosPorNome, ambiguos, naoEncontrados, porJid: true };
  }

  for (const nome of nomes) {
    const salvo = salvos[nome];
    if (salvo) {
      if (gruposDoChip[salvo]) jids.add(salvo);
      else naoEncontrados.push(salvo);
      continue;
    }
    const candidatos = Object.entries(gruposDoChip)
      .filter(([jid, g]) => g?.subject === nome && !jidsDeCliente.has(jid))
      .map(([jid]) => jid);
    if (candidatos.length === 1) {
      jids.add(candidatos[0]);
      novosSalvos[nome] = candidatos[0];
      adotadosPorNome.push(candidatos[0]);
    } else if (candidatos.length > 1) {
      ambiguos.push({ posicao: nomes.indexOf(nome), jids: candidatos });
    } else {
      naoEncontrados.push(`grupo_${nomes.indexOf(nome) + 1}`);
    }
  }
  return { jids, novosSalvos, adotadosPorNome, ambiguos, naoEncontrados, porJid: false };
}

const ROTULO_DE_CLIENTE = 'grupo de escritorio cliente';

/**
 * O mapa jid -> nome que vai no heartbeat. Os grupos da casa levam o nome
 * (o app procura o grupo da Sprint por ele); os de escritorio cliente levam um
 * rotulo fixo, porque o nome e escolhido pelo cliente e nao pode entrar na
 * linha de status da casa.
 */
export function jidsParaOHeartbeat({ targetGroups, grupoOrg }) {
  const mapa = {};
  for (const [jid, nome] of targetGroups) {
    mapa[jid] = grupoOrg.has(jid) ? ROTULO_DE_CLIENTE : nome;
  }
  return mapa;
}

/** Roda `fn` sobre os itens com no maximo `limite` ao mesmo tempo, mantendo a ordem do resultado. */
export async function comLimite(itens, limite, fn) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  async function trabalhador() {
    while (proximo < itens.length) {
      const i = proximo++;
      resultados[i] = await fn(itens[i], i);
    }
  }
  const n = Math.max(1, Math.min(limite, itens.length));
  await Promise.all(Array.from({ length: n }, trabalhador));
  return resultados;
}
