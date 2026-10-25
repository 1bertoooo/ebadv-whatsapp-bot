/**
 * Espera crescente e classificacao de falha de rede (SEG-M12-006).
 */

/**
 * Quanto esperar antes da proxima tentativa. A primeira repeticao espera
 * `baseMs`; cada uma depois dobra, ate `maxMs`. O jitter espalha as tentativas
 * para o bot nao bater no app todo no mesmo segundo quando ele voltar.
 */
export function esperaCrescente(tentativa, { baseMs = 5000, maxMs = 15 * 60_000, fator = 2, jitter = 0.2, aleatorio = Math.random } = {}) {
  const n = Math.max(1, Math.floor(tentativa || 1));
  const bruto = Math.min(maxMs, baseMs * fator ** (n - 1));
  const variacao = bruto * jitter * (aleatorio() * 2 - 1);
  return Math.max(0, Math.round(bruto + variacao));
}

/**
 * Diz o que fazer com uma chamada que falhou.
 *
 * `err` tem o formato do erro do axios: `err.response.status` quando o app
 * respondeu, `err.code` e `err.message` quando nem chegou a responder.
 *
 * - repetir: vale tentar de novo mais tarde;
 * - infra: o app (ou a rede) parece fora do ar, entao nao adianta tentar as
 *   outras mensagens agora;
 * - motivo: palavra curta para o log, sem dado pessoal.
 */
export function classificarFalha(err) {
  const status = err?.response?.status ?? null;
  if (status === null) {
    return { repetir: true, infra: true, status: null, motivo: 'sem_resposta' };
  }
  if (status === 401 || status === 403) {
    // Segredo trocado de um lado so: o dono corrige e a fila escoa sozinha.
    return { repetir: true, infra: true, status, motivo: 'nao_autorizado' };
  }
  if ([502, 503, 504, 408, 425, 429].includes(status)) {
    return { repetir: true, infra: true, status, motivo: 'app_indisponivel' };
  }
  if (status >= 500) {
    return { repetir: true, infra: false, status, motivo: 'erro_do_app' };
  }
  if (status === 413) return { repetir: false, infra: false, status, motivo: 'corpo_grande_demais' };
  if (status === 409) return { repetir: false, infra: false, status, motivo: 'org_diverge' };
  return { repetir: false, infra: false, status, motivo: 'recusado_pelo_app' };
}

/** Promessa que espera `ms`. Em teste, injeta-se uma versao instantanea. */
export function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chama `fn` ate `tentativas` vezes, com espera crescente curta entre elas.
 * Para chamadas rapidas que nao entram na fila em disco (por exemplo, avisar
 * ao app o id da resposta). Devolve { ok, valor } ou { ok: false, erro }.
 */
export async function comTentativas(fn, { tentativas = 3, esperaMs = 1500, esperarFn = esperar } = {}) {
  let ultimoErro = null;
  for (let i = 1; i <= tentativas; i++) {
    try {
      return { ok: true, valor: await fn(i) };
    } catch (err) {
      ultimoErro = err;
      if (!classificarFalha(err).repetir) break;
      if (i < tentativas) await esperarFn(esperaMs * i);
    }
  }
  return { ok: false, erro: ultimoErro };
}
