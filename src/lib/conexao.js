/**
 * O que fazer quando a conexao com o WhatsApp cai (SEG-M12-013).
 *
 * O bot nao reconecta dentro do mesmo processo (empilha sockets): ele sai e o
 * systemd sobe um processo limpo. O que muda aqui e o codigo de saida e a
 * espera antes de conectar de novo:
 *  - saida 1: queda comum, o systemd sobe de novo (com espera crescente se
 *    for em sequencia);
 *  - saida 3: nao adianta subir de novo (o systemd tem
 *    RestartPreventExitStatus=3). E o caso de sessao encerrada pelo
 *    WhatsApp, numero bloqueado, mesma sessao aberta em outro lugar e
 *    pareamento que nao foi concluido.
 */

// Os numeros do DisconnectReason do Baileys, repetidos aqui para o modulo nao
// depender da biblioteca.
export const MOTIVOS_PERMANENTES = {
  401: 'logged_out',
  403: 'forbidden',
  440: 'connection_replaced',
  411: 'multidevice_mismatch',
};

const BAD_SESSION = 500;
const QUEDAS_SEGUIDAS_PARA_DESISTIR = 3;
const JANELA_DO_HISTORICO_MS = 30 * 60_000;
const JANELA_DA_ESPERA_MS = 15 * 60_000;

/** Quedas seguidas sem nunca ter chegado a conectar, da mais recente para tras. */
function falhasSeguidas(historico, agora, janelaMs) {
  let n = 0;
  for (let i = historico.length - 1; i >= 0; i--) {
    const r = historico[i];
    if (agora - r.ts > janelaMs) break;
    if (r.abriu) break;
    n++;
  }
  return n;
}

/**
 * Decide a saida diante de um `connection: close`.
 *
 * `historico` e a lista de quedas anteriores ({ ts, code, abriu }). O codigo
 * 500 (badSession) so e permanente depois de varias seguidas sem conectar,
 * porque o Baileys usa 500 tambem para erro de fluxo passageiro.
 */
export function decidirSaida({ code, pareando = false, pareouComSucesso = false, historico = [], agora = Date.now() }) {
  if (pareando && !pareouComSucesso) {
    return { codigoDeSaida: 3, avisarApp: false, motivo: 'pareamento_nao_concluido', permanente: true };
  }
  if (MOTIVOS_PERMANENTES[code]) {
    return { codigoDeSaida: 3, avisarApp: true, motivo: MOTIVOS_PERMANENTES[code], permanente: true };
  }
  if (code === BAD_SESSION) {
    const ultimas = historico
      .filter((r) => agora - r.ts <= JANELA_DO_HISTORICO_MS)
      .slice(-(QUEDAS_SEGUIDAS_PARA_DESISTIR - 1));
    if (ultimas.length === QUEDAS_SEGUIDAS_PARA_DESISTIR - 1 && ultimas.every((r) => r.code === BAD_SESSION && !r.abriu)) {
      return { codigoDeSaida: 3, avisarApp: true, motivo: 'bad_session', permanente: true };
    }
  }
  return { codigoDeSaida: 1, avisarApp: false, motivo: 'queda_comum', permanente: false };
}

/** Junta a queda nova ao historico e poda o que passou da janela. */
export function registrarQueda(historico, { code, abriu }, agora = Date.now()) {
  const novo = [...historico, { ts: agora, code: code ?? null, abriu: !!abriu }];
  return novo.filter((r) => agora - r.ts <= JANELA_DO_HISTORICO_MS).slice(-50);
}

/**
 * Quanto esperar antes de conectar, ao subir. Zero quando a partida anterior
 * deu certo; cresce quando varias partidas seguidas nem chegaram a conectar,
 * para nao insistir contra o WhatsApp a cada 20 segundos para sempre.
 */
export function esperaAntesDeConectar(historico, agora = Date.now()) {
  const n = falhasSeguidas(historico, agora, JANELA_DA_ESPERA_MS);
  if (n < 2) return 0;
  return Math.min(300_000, 5000 * 2 ** (n - 1));
}
