/**
 * Fluxo das mensagens que chegam do grupo e vao para o app (SEG-M12-006).
 *
 *   receber() -> grava na fila em disco -> tentar() -> POST no app
 *      ok:        tira da fila e entrega a resposta (reacao, texto, voz)
 *      falhou:    se vale repetir, agenda com espera crescente; senao descarta
 *                 e avisa no log (so ids e motivo)
 *   varrer()   -> de tempos em tempos, tenta de novo o que ficou pendente
 *                 (inclusive o que sobrou de antes de um reinicio)
 *
 * O app confirma a mensagem pelo `wa_message_id` (dedup), entao repetir o POST
 * nao cria tarefa duplicada.
 */
import { classificarFalha, esperaCrescente } from './espera.js';

const MAX_TENTATIVAS = 100; // quem manda e a validade da fila (24 h); isto so evita laco infinito

export function criarFluxoDeEntrada({ config, http, fila, logger, esperarFn, entregar, aoDescartar = () => {}, aleatorio = Math.random }) {
  const emAndamento = new Map(); // id -> promessa
  const memoria = new Map(); // id -> mensagem original do Baileys (so enquanto o processo vive)

  async function executar(id) {
    const item = fila.obter(id);
    if (!item) return { ok: false, motivo: 'fora_da_fila' };
    const { payload, chave } = item.dados;
    let res;
    try {
      res = await http.post(config.lisUrl, payload, {
        headers: { Authorization: `Bearer ${config.segredo}` },
        // o app pode levar ate 300 s (agente, Vision, SharePoint)
        timeout: config.timeoutDaCapturaMs,
        maxBodyLength: 100 * 1024 * 1024,
        maxContentLength: 100 * 1024 * 1024,
      });
    } catch (err) {
      const c = classificarFalha(err);
      const tentativa = fila.tentativas(id) + 1;
      if (!c.repetir || tentativa >= MAX_TENTATIVAS) {
        fila.remover(id);
        memoria.delete(id);
        logger.warn({ id, status: c.status, motivo: c.motivo }, 'mensagem descartada: o app recusou');
        try {
          await aoDescartar({ chave, payload, motivo: c.motivo, status: c.status });
        } catch (e) {
          logger.warn({ id, err: e?.message }, 'falha ao avisar o descarte');
        }
        return { ok: false, descartada: true, ...c };
      }
      const espera = esperaCrescente(tentativa, { aleatorio });
      fila.registrarFalha(id, espera);
      logger.warn(
        { id, status: c.status, motivo: c.motivo, tentativa, proxima_em_s: Math.round(espera / 1000) },
        'mensagem nao entregue ao app: fica na fila e tento de novo',
      );
      return { ok: false, descartada: false, ...c };
    }

    // Confirmado: sai da fila ANTES de entregar a resposta, para uma falha no
    // envio da reacao nunca repetir o POST.
    fila.remover(id);
    const original = memoria.get(id) || null;
    memoria.delete(id);
    const dados = res?.data || {};
    logger.info(
      {
        id,
        classification: dados.classification,
        has_reaction: !!dados.reaction_emoji,
        has_reply: !!dados.reply_text,
        has_sticker: !!dados.sticker_url,
        has_audio: !!dados.reply_audio_b64,
        duplicated: !!dados.duplicated,
      },
      'app respondeu',
    );
    try {
      await entregar({ chave, original, resposta: dados, payload });
    } catch (err) {
      logger.error({ id, err: err?.message }, 'falha ao entregar a resposta do app');
    }
    return { ok: true };
  }

  function tentar(id) {
    if (emAndamento.has(id)) return emAndamento.get(id);
    const promessa = executar(id).catch((err) => {
      logger.error({ id, err: err?.message }, 'erro inesperado ao entregar mensagem ao app');
      return { ok: false, descartada: false, motivo: 'erro_interno', infra: false };
    });
    emAndamento.set(id, promessa);
    promessa.then(() => emAndamento.delete(id));
    return promessa;
  }

  /** Guarda a mensagem em disco e ja tenta entregar. */
  function receber(id, dados, original) {
    let r;
    try {
      r = fila.adicionar(id, dados);
    } catch (err) {
      logger.error({ id, err: err?.message }, 'nao consegui gravar a mensagem na fila em disco');
      return Promise.resolve({ ok: false, motivo: 'disco' });
    }
    if (r.descartados.length > 0) {
      logger.error({ descartadas: r.descartados.length, ids: r.descartados.slice(0, 10) }, 'fila de entrada cheia: descartei as mensagens mais antigas');
    }
    if (r.duplicado) {
      logger.debug({ id }, 'mensagem ja estava na fila');
      return Promise.resolve({ ok: false, motivo: 'duplicada' });
    }
    if (!r.adicionado) {
      logger.error({ id }, 'mensagem nao coube na fila em disco');
      return Promise.resolve({ ok: false, motivo: 'nao_coube' });
    }
    if (original) memoria.set(id, original);
    return tentar(id);
  }

  /** Tenta de novo o que esta pendente e ja passou da espera. Para na primeira falha de infraestrutura. */
  async function varrer({ limite = 20 } = {}) {
    const vencidos = fila.expirar();
    if (vencidos.length > 0) {
      logger.error({ vencidas: vencidos.length, ids: vencidos.slice(0, 10) }, 'mensagens vencidas na fila de entrada: descartei');
    }
    let tentadas = 0;
    for (const id of fila.prontos(undefined, limite)) {
      if (emAndamento.has(id)) continue;
      const r = await tentar(id);
      tentadas++;
      if (r && !r.ok && r.infra) break;
    }
    return { tentadas, restam: fila.resumo().itens };
  }

  /** Espera os POSTs em curso por ate `ms` (saida ordenada). Devolve true se todos terminaram. */
  async function aguardarTermino(ms) {
    if (emAndamento.size === 0) return true;
    const todas = Promise.allSettled([...emAndamento.values()]).then(() => true);
    return Promise.race([todas, esperarFn(ms).then(() => false)]);
  }

  return { receber, tentar, varrer, aguardarTermino, emAndamento, memoria };
}
