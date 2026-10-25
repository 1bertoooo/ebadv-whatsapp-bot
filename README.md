# ebadv-whatsapp-bot

Bot do WhatsApp (Baileys, biblioteca nao oficial). Fica nos grupos cadastrados, leva cada mensagem para a rota de captura do app, devolve ao grupo a resposta (texto, reacao, figurinha, nota de voz), entrega a fila de saida do app e atende a fila de pedidos (entrar em grupo de escritorio cliente). Um numero (chip) atende a casa e todos os escritorios clientes.

Roda no VPS, como servico systemd (unidade `luana-bot`), com a sessao do WhatsApp em `auth_state/` e o estado local em `estado/`. Os nomes de endereco, numero e grupos ficam no `.env` do servidor; este repositorio so tem marcadores.

## Como funciona

1. Ao conectar, o bot descobre os grupos da casa (por `WA_GROUP_JIDS`, ou pelo nome uma vez so, gravando o jid em `estado/grupos-da-casa.json`) e busca no app a tabela de roteamento dos escritorios clientes (`WA_NUMERO_ID`).
2. Cada mensagem de grupo escutado vira um corpo JSON (texto, audio, imagem, documento, figurinha, reacao) e e gravada na fila em disco (`estado/fila-entrada/`) antes de qualquer envio. Documento com legenda, mensagem temporaria e mensagem editada sao desembrulhados; visualizacao unica e ignorada por padrao.
3. O bot faz `POST` na rota de captura. Se o app responder, a mensagem sai da fila e o bot entrega a resposta: nota de voz (quando a resposta traz audio; o bot declara `capacidades: ['nota_de_voz']`), figurinha, reacao e texto. O id da mensagem enviada volta ao app por `PATCH` (`capture_id` e `bot_reply_wa_id`).
4. Se o app estiver fora do ar, demorar ou o processo reiniciar, a mensagem continua na fila e e repetida com espera crescente (5 s, 10 s, 20 s, ate 15 min), por ate 24 horas. O app confirma pelo `wa_message_id`, entao repetir nao cria tarefa duplicada.
5. A fila de saida do app (lembretes, recados de regra, placar da Sprint) e buscada a cada 30 s, guardada em disco e enviada no ritmo do limitador (intervalo de 2 a 5 s, 10 por minuto, 100 por hora). Antes de enviar, o bot confere o destino: grupo so se estiver no mapa de grupos do bot; mensagem privada so para telefone no formato do app; figurinha so do balde `stickers` do Supabase, ate 512 KB.
6. Arquivo acima do limite (`WA_LIMITE_ARQUIVO_MB`, 3 MB) nao e baixado: o bot reage no grupo e responde que o arquivo passou do limite, em vez de a mensagem sumir.
7. Pedido de entrar em grupo (`entrar_grupo`): o bot entra pelo convite e devolve ao app o resultado. So troca o roteamento e so se apresenta no grupo depois de o app confirmar que registrou o grupo para aquele escritorio. Grupo da casa ou de outro escritorio e recusado antes de ler os participantes.

Mensagens do proprio bot sao sempre ignoradas.

## Estado local (`estado/`)

Pasta so do dono (modo 0700, arquivos 0600), fora do git. Tem a fila de entrada e a de saida (um arquivo por mensagem), `grupos-da-casa.json` (jid dos grupos da casa descobertos por nome uma vez), `apresentados.json` (grupos onde o bot ja se apresentou), `reinicios.json` (historico de quedas, para a espera crescente) e `pareamento-novo.json` (existe so entre um pareamento e o aviso ao app: o WhatsApp manda reiniciar logo depois de parear, e o processo novo precisa saber que o app ainda nao foi avisado).

## Log

Em `/var/log/luana-bot.log` (saida do pino). So ids, tipos, tamanhos e codigos entram no log: nunca nome de pessoa, nome de grupo, telefone nem parte do texto de mensagem, em nenhum nivel. O pino ainda apaga campos com esses nomes se alguem os escrever por descuido. O log gira todo dia e guarda 14 dias (o `atualizar-bot.sh` instala a regra do logrotate).

## Codigos de saida

- `1`: queda comum de conexao. O systemd sobe de novo; se varias partidas seguidas nem chegarem a conectar, a espera antes de conectar cresce (ate 5 min).
- `3`: nao subir de novo. Sessao encerrada pelo WhatsApp (401), numero bloqueado (403), mesma sessao aberta em outro lugar (440), incompatibilidade de dispositivo (411), sessao ruim tres vezes seguidas (500) ou pareamento que nao foi concluido. Nos quatro primeiros casos o bot avisa o app (`/api/whatsapp/bot-down`) antes de sair. A unidade precisa ter `RestartPreventExitStatus=3`.
- `0`: parada pedida (`systemctl stop` ou `restart`).

Ao sair, o bot espera ate 8 s pelos envios ao app em curso. O que nao terminar fica na fila em disco.

## Pareamento

Com `WA_PHONE_NUMBER` definido e sem sessao, o bot pede UM codigo de 8 digitos por execucao e o escreve no log (`CÓDIGO DE PAREAMENTO`). Se o codigo expirar sem uso, o bot sai com `3` e nao tenta de novo sozinho; rode o `parear.sh` outra vez.

## Variaveis

Todas estao comentadas no `.env.example`. As principais: `LIS_CAPTURE_URL`, `LIS_CAPTURE_SECRET`, `WA_GROUP_JIDS` ou `WA_GROUP_NAMES`, `WA_NUMERO_ID`, `WA_PHONE_NUMBER`. As desligadas por padrao: `WA_AVISO_ENTRADA` (aviso de privacidade na entrada), `WA_ENVIAR_NUMERO_ID`, `WA_ENVIAR_EDICOES`.

## Dependencias e testes

As versoes estao travadas no `package.json` (sem `^`). O `package-lock.json` ainda nao existe no repositorio: gere-o numa maquina com rede (`npm install --omit=dev --package-lock-only` ou `npm install` no VPS), versione-o e passe a instalar com `npm ci`.

```bash
npm test      # node --test, sem instalar nada alem do proprio Node
```

Os testes cobrem a logica pura em `src/lib/` (leitura de mensagem, fila em disco, repeticao, destino, pedidos, limites, textos). Nao ha teste que fale com o WhatsApp.

`npm run fumaca` roda o `src/index.js` de verdade contra modulos de mentira (Baileys, axios e pino) e um roteiro de mensagens, pedido e app fora do ar. Leva uns 25 s e nao faz parte do `npm test`.

## Publicar

O codigo novo entra no VPS pelo `atualizar-bot.sh` (fica em `Controle/_ops/luana/`, fora do repositorio, porque traz o endereco do servidor). Ele confere o sha256 de cada arquivo, guarda o anterior ao lado, confere a sintaxe, instala as dependencias, reinicia e diz se conectou.
