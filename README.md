# Relógio Double (cerebro-ai)

MVP SaaS em português (pt-BR) para **monitorar o Blaze Double** (blaze.bet.br) em near-real-time.

## Aviso legal / produto

**Double é RNG** (gerador de números aleatórios). Este projeto:

- **não** faz apostas reais nem auto-betting;
- **não** faz login na Blaze;
- **não** envia sinais via Telegram;
- **não** garante lucro.

Uso educativo / laboratório simulado. A previsão e o lab de gale são ferramentas de estudo, sem edge alegado.

## Stack

- Node.js 20+ · TypeScript · Express
- SQLite (`better-sqlite3`)
- TensorFlow.js (`@tensorflow/tfjs-node`) + fallback logístico multinomial em TS/JSON
- Mercado Pago PIX (R$ 29,90/mês)
- Frontend estático pt-BR em `public/`

Escolhemos **Express + static** (em vez de Next.js serverless) por ser o caminho mais estável em free-tier (Render/Fly) com **collector em background**, SQLite em disco e webhook longo.

## Como rodar localmente

```bash
cd cerebro-ai
cp .env.example .env
# edite ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET

npm install
npm run dev
# ou: npm run build && npm start
```

Abra `http://localhost:3000`.

Scripts:

| Script | Descrição |
|--------|-----------|
| `npm run dev` | Desenvolvimento com hot-reload (`tsx watch`) |
| `npm run build` | Compila TypeScript → `dist/` e copia `public/` |
| `npm start` | Sobe `node dist/index.js` |

## Variáveis de ambiente

Veja `.env.example`:

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `PORT` | não | Default `3000` |
| `NODE_ENV` | não | `development` / `production` |
| `BASE_URL` | sim em prod | URL pública (webhook MP), ex. `https://seu-app.onrender.com` |
| `JWT_SECRET` | sim em prod | String longa e aleatória |
| `ADMIN_EMAIL` | recomendado | Seed do admin no boot |
| `ADMIN_PASSWORD` | recomendado | Senha do admin (mín. 8) |
| `MERCADOPAGO_ACCESS_TOKEN` | não | Sem token → checkout **stub**; admin libera dias manualmente |
| `DATABASE_PATH` | não | Default `./data/cerebro.db` |
| `COLLECTOR_INTERVAL_MS` | não | Default `5000` |
| `FALLBACK_HISTORY_URL` | não | Proxy/espelho se a API Blaze falhar |

## Primeiro admin

No boot, se `ADMIN_EMAIL` / `ADMIN_PASSWORD` estiverem definidos e o e-mail ainda não existir, o usuário **admin** é criado automaticamente.

Admin:

- ignora paywall;
- acessa painel **Admin** (usuários, grant/revoke, collector, pagamentos).

## Assinatura PIX (Mercado Pago)

1. Crie um app no [Mercado Pago Developers](https://www.mercadopago.com.br/developers).
2. Copie o **Access Token** de produção (ou teste) para `MERCADOPAGO_ACCESS_TOKEN`.
3. Defina `BASE_URL` com a URL pública do app.
4. Configure a notificação / webhook para:
   - `{BASE_URL}/api/webhooks/mercadopago`
   - (alias) `{BASE_URL}/api/payments/webhook/mercadopago`
5. No checkout, o app cria pagamento PIX de **R$ 29,90**. Quando o webhook marcar `approved`, o usuário recebe **+30 dias** em `paid_until`.

### Sem token (stub)

Se `MERCADOPAGO_ACCESS_TOKEN` estiver vazio:

- o checkout retorna status `stub` com mensagem explicativa;
- a API e o admin continuam funcionando;
- use **Admin → +30d** para liberar assinantes manualmente.

## Coletor Blaze

Enquanto o servidor roda, um loop busca o histórico/current da API pública do Double:

- Primário: `blaze.bet.br/api/singleplayer-originals/...`
- Fallback: `FALLBACK_HISTORY_URL` (documentado; pode apontar para proxy)

Rodadas novas são persistidas em SQLite; o modelo é atualizado; uma previsão **travada** é registrada para a próxima rodada.

Em desenvolvimento, se a API estiver inacessível e o banco estiver vazio, um histórico **sintético DEV** pode ser semeado (não é dado real da Blaze).

## Lab Gale (simulado)

- Banca inicial **R$ 1100**
- Stake ~**1%** (piso escalado)
- G0/G1/G2 ≈ **11/22/44** em 1100 e **20/40/80** em 2000 (escala linear)
- **Branco** = skip
- Perda em **G2** → cooldown de **30** rodadas
- Gale pendente retoma no próximo sinal com confiança mínima

## Deploy (Render)

1. Crie um **Web Service** a partir do repositório.
2. Runtime: Node · Build: `npm install && npm run build` · Start: `npm start`
3. Disco persistente (recomendado) montado em `/opt/render/project/src/data` e `DATABASE_PATH=/opt/render/project/src/data/cerebro.db`
4. Configure as env vars (JWT, admin, `BASE_URL`, MP token).
5. Plano free “spin down” pausa o collector — use Always On se precisar de coleta contínua.

Arquivo auxiliar: `render.yaml`.

## Deploy (Fly.io)

```bash
fly launch
fly volumes create cerebro_data --size 1
# DATABASE_PATH=/data/cerebro.db e monte o volume em /data
fly secrets set JWT_SECRET=... ADMIN_EMAIL=... ADMIN_PASSWORD=... BASE_URL=https://....fly.dev
fly deploy
```

Arquivo auxiliar: `fly.toml`.

## Árvore principal

```
cerebro-ai/
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
├── render.yaml
├── fly.toml
├── public/           # UI pt-BR
│   ├── index.html
│   ├── css/app.css
│   └── js/app.js
├── data/             # SQLite (gitignored)
└── src/
    ├── index.ts
    ├── auth/
    ├── db/
    ├── middleware/
    ├── routes/
    ├── services/     # collector, predictor, MP, gale
    └── types/
```

## Limitações conhecidas

- A API Blaze pode bloquear IPs de datacenter; use `FALLBACK_HISTORY_URL` ou rode o collector em rede residencial.
- `tfjs-node` exige binários nativos; em alguns free-tiers o fallback logístico é usado automaticamente.
- SQLite + múltiplas instâncias: use **uma** réplica / um processo.
- Webhook MP precisa de URL pública HTTPS.
- Previsões são entretenimento estatístico sobre RNG — **sem valor esperado positivo alegado**.
