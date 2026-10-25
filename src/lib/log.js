/**
 * O que pode e o que nao pode ir para o log (LGPD-004, SEG-M12-007).
 *
 * Regra: no log entram so ids e tipos (id da mensagem, jid do grupo, tipo,
 * tamanho, classificacao, codigo de status). Nome de pessoa, nome de grupo,
 * telefone e qualquer parte do texto de mensagem nunca entram, em nenhum
 * nivel. O arquivo do log fica no VPS, fora do banco e de qualquer pedido de
 * exclusao.
 */

/**
 * Campos que o pino apaga se alguem, por descuido, os puser numa linha de
 * log. E a segunda barreira: a primeira e nao os escrever.
 */
export const CAMPOS_PROIBIDOS_NO_LOG = [
  'sender',
  'preview',
  'nome',
  'name',
  'texto',
  'text',
  'pushName',
  'subject',
  'telefone',
  'phone',
  'fone',
  'jidDoRemetente',
  'participante',
];

export function opcoesDeRedacao() {
  const caminhos = [];
  for (const campo of CAMPOS_PROIBIDOS_NO_LOG) {
    caminhos.push(campo, `*.${campo}`);
  }
  return { paths: caminhos, censor: '[removido]' };
}

/**
 * Resumo de uma mensagem para o log: tipo, tamanhos e ids, nunca o conteudo.
 */
export function resumoDaMensagem({ tipo, texto, arquivo, waMessageId, grupoJid }) {
  const r = { tipo };
  if (waMessageId) r.id = waMessageId;
  if (grupoJid) r.grupo = grupoJid;
  if (typeof texto === 'string') r.tamanho_texto = texto.length;
  if (arquivo) r.tamanho_arquivo = arquivo.size ?? null;
  return r;
}

/** Nivel de log para uma mensagem que o bot decidiu nao enviar ao app. */
export function nivelDoIgnorado(motivo) {
  if (motivo === 'protocolo' || motivo === 'sem_conteudo') return 'debug';
  return 'warn';
}

/**
 * Para os testes: diz se um objeto de log carrega algum campo proibido, em
 * qualquer profundidade.
 */
export function camposProibidosEm(obj, caminho = '') {
  const achados = [];
  if (!obj || typeof obj !== 'object') return achados;
  for (const [k, v] of Object.entries(obj)) {
    if (CAMPOS_PROIBIDOS_NO_LOG.includes(k)) achados.push(caminho + k);
    achados.push(...camposProibidosEm(v, `${caminho}${k}.`));
  }
  return achados;
}
