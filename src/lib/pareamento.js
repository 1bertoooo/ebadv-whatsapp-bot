/**
 * Aviso de "bot pareado" que sobrevive ao reinicio.
 *
 * Depois de um pareamento novo o WhatsApp manda reiniciar a conexao (codigo
 * 515), e o bot sai para o systemd subir um processo limpo. O processo novo ja
 * nasce com a conta registrada e nao sabe que acabou de parear. Por isso, ao
 * ver o pareamento (`isNewLogin`), o bot grava uma marca em disco; na proxima
 * conexao aberta ele avisa o app e so apaga a marca depois de o app responder.
 * Se o app estiver fora do ar, a marca fica e o aviso e repetido na conexao
 * seguinte.
 *
 * Sem a marca, o aviso so saia de quem estava sem sessao no inicio da partida
 * e o app nunca soube do pareamento (o alarme ficava ligado e a data de
 * pareamento, velha). Ver FIX-BOTS-002 no registro do lote BOTS.
 */
import nodeFs from 'node:fs';
import { lerJson, gravarJson } from './estado.js';

export function criarAvisoDePareamento({ arquivo, fs = nodeFs, agora = () => new Date() }) {
  return {
    /** Grava que um pareamento novo aconteceu e ainda nao foi dito ao app. */
    marcar() {
      gravarJson(arquivo, { pendente: true, em: agora().toISOString() }, fs);
    },
    /** Falta avisar o app? */
    pendente() {
      const v = lerJson(arquivo, null, fs);
      return !!(v && v.pendente === true);
    },
    /** O app ja foi avisado. */
    limpar() {
      try {
        fs.unlinkSync(arquivo);
      } catch {
        // ja nao existia
      }
    },
  };
}
