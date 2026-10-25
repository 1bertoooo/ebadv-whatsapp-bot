/**
 * Fila de saida: mensagens que o app manda o bot enviar (lembretes, recados de
 * regra, placar da Sprint, resumo da Coala).
 *
 * O GET do app marca a mensagem como enviada ANTES de o bot enviar. Por isso,
 * assim que a mensagem chega ao bot ela vai para a fila em disco: se o envio
 * falhar (grupo de que o bot saiu, queda no meio, reinicio), o bot tenta de
 * novo em vez de ela sumir. Depois do envio, o bot guarda que enviou antes de
 * confirmar ao app, para uma falha na confirmacao nunca repetir o envio
 * (SEG-M12-006).
 *
 * Antes de enviar, o destino e conferido (SEG-M12-009) e o ritmo e limitado
 * (SEG-M12-014).
 */
import { destinoPermitido, baixarFigurinhaSegura } from './destino.js';
import { classificarFalha, esperaCrescente } from './espera.js';

const MAX_RECUSAS_DE_DESTINO = 5;

/**
 * Envia um item da fila de saida. Devolve o resultado do sendMessage (ou
 * null para "nada a enviar").
 */
export async function enviarItemDeSaida({ sock, m, http, hostsDeFigurinha = [] }) {
  if (m.action === 'delete' && m.target_msg_id) {
    return sock.sendMessage(m.group_jid, {
      delete: { remoteJid: m.group_jid, fromMe: true, id: m.target_msg_id, participant: undefined },
    });
  }
  if (m.sticker_url) {
    const webp = await baixarFigurinhaSegura({ http, url: m.sticker_url, hosts: hostsDeFigurinha });
    return sock.sendMessage(m.group_jid, { sticker: webp });
  }
  if (m.text) return sock.sendMessage(m.group_jid, { text: m.text });
  return null;
}

export function criarFluxoDeSaida({ config, http, fila, logger, limitador, agora = () => Date.now(), gruposConhecidos, enviar, aoEnviar = () => {}, aleatorio = Math.random }) {
  let emAndamento = false;

  /** Busca no app e poe tudo na fila em disco. Devolve quantas mensagens chegaram. */
  async function buscar() {
    const params = config.enviarNumeroId && config.numeroId ? { numero_id: config.numeroId } : undefined;
    let mensagens;
    try {
      const r = await http.get(`${config.lisBase}/api/whatsapp/outbound`, {
        headers: { Authorization: `Bearer ${config.segredo}` },
        params,
        timeout: 10000,
      });
      mensagens = r.data?.mensagens || [];
    } catch (err) {
      logger.debug({ err: err?.message }, 'fila de saida: falha ao buscar');
      return 0;
    }
    for (const m of mensagens) {
      const r = fila.adicionar(m.id, { m, enviado: null });
      if (r.descartados.length > 0) {
        logger.error({ descartadas: r.descartados.length }, 'fila de saida cheia: descartei as mais antigas');
      }
    }
    return mensagens.length;
  }

  async function confirmar(id, item) {
    try {
      await http.post(
        `${config.lisBase}/api/whatsapp/outbound`,
        { id: item.dados.m.id, bot_msg_id: item.dados.enviado?.bot_msg_id || null },
        { headers: { Authorization: `Bearer ${config.segredo}` }, timeout: 10000 },
      );
      fila.remover(id);
      return true;
    } catch (err) {
      const c = classificarFalha(err);
      if (!c.repetir) {
        fila.remover(id);
        logger.warn({ id, motivo: c.motivo }, 'confirmacao de envio recusada pelo app: tirei da fila');
        return true;
      }
      fila.registrarFalha(id, esperaCrescente(fila.tentativas(id) + 1, { aleatorio }));
      logger.warn({ id, motivo: c.motivo }, 'enviado, mas o app nao confirmou: confirmo de novo depois');
      return false;
    }
  }

  async function processar(id) {
    const item = fila.obter(id);
    if (!item) return 'fora_da_fila';
    const { m } = item.dados;

    if (!item.dados.enviado) {
      const d = destinoPermitido(m.group_jid, { gruposConhecidos: gruposConhecidos() });
      if (!d.ok) {
        const n = fila.tentativas(id) + 1;
        if (n >= MAX_RECUSAS_DE_DESTINO) {
          fila.remover(id);
          logger.error({ id, motivo: d.motivo, destino: d.tipo }, 'destino recusado: descartei a mensagem de saida');
        } else {
          fila.registrarFalha(id, esperaCrescente(n, { baseMs: 60_000, aleatorio }));
          logger.warn({ id, motivo: d.motivo, tentativa: n }, 'destino fora do mapa de grupos: tento de novo depois');
        }
        return 'destino_recusado';
      }

      let enviado;
      try {
        enviado = await enviar(m);
      } catch (err) {
        const n = fila.tentativas(id) + 1;
        fila.registrarFalha(id, esperaCrescente(n, { aleatorio }));
        logger.error({ id, motivo: m.motivo, err: err?.message, tentativa: n }, 'falha ao enviar mensagem de saida: tento de novo');
        return 'falhou';
      }
      if (enviado === null) {
        fila.remover(id);
        logger.warn({ id }, 'mensagem de saida vazia: pulei');
        return 'vazia';
      }
      limitador.registrar(agora());
      aoEnviar();
      fila.atualizarDados(id, { m, enviado: { bot_msg_id: enviado?.key?.id || null } });
      logger.info({ motivo: m.motivo, grupo: m.group_jid, tipo: m.sticker_url ? 'sticker' : m.action === 'delete' ? 'apagar' : 'texto' }, 'mensagem de saida enviada');
    }

    const atual = fila.obter(id);
    if (!atual) return 'fora_da_fila';
    return (await confirmar(id, atual)) ? 'enviada' : 'confirmacao_pendente';
  }

  /**
   * Envia o que ja passou da espera, respeitando o ritmo. Uma volta envia no
   * maximo uma mensagem nova: a seguinte espera o intervalo do limitador.
   */
  async function entregarProximas() {
    if (emAndamento) return { enviadas: 0 };
    emAndamento = true;
    try {
      const vencidos = fila.expirar();
      if (vencidos.length > 0) {
        logger.warn({ vencidas: vencidos.length, ids: vencidos.slice(0, 10) }, 'mensagens de saida vencidas: descartei');
      }
      let enviadas = 0;
      for (const id of fila.prontos()) {
        const atual = fila.obter(id);
        const jaEnviada = !!atual?.dados?.enviado;
        if (!jaEnviada && limitador.espera(agora()) > 0) break;
        const r = await processar(id);
        if (r === 'enviada') enviadas++;
        if (!jaEnviada && (r === 'enviada' || r === 'confirmacao_pendente')) break;
      }
      return { enviadas };
    } finally {
      emAndamento = false;
    }
  }

  return { buscar, entregarProximas, processar };
}
