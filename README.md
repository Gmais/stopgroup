# Stop Online

Adedonha multiplayer em tempo real. Node 22.13+ (usa `node:sqlite`), Express + Socket.IO, front-end sem build.

    npm install
    npm start          # http://localhost:3000   (PORT, HOST, DB_FILE, TRUST_PROXY opcionais)
    npm test           # regras (unitário) + partida simulada com 4 jogadores

Convite: `/s/CODIGO`. Backend autoritativo (sorteio, cronômetro, respostas, votos, pontos); o cliente só exibe o estado
recebido. Respostas alheias só são enviadas após o fim da rodada. Estado completo é salvo em SQLite (`data/stop.db`) e
restaurado ao reiniciar; salas inativas expiram (6 h; 1 h após o fim; 30 min se nunca iniciadas).

Notas: tolerância de 800 ms para respostas já em trânsito no instante do fim da rodada; tokens de jogador ficam só no
navegador (o servidor guarda o hash); para produção use HTTPS atrás de proxy e `TRUST_PROXY=1`.
