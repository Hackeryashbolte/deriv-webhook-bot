require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const APP_ID = process.env.DERIV_APP_ID || '1089';
const MODE = (process.env.TRADE_MODE || 'DEMO').toUpperCase(); // DEMO or REAL
const TOKEN = MODE === 'REAL' ? process.env.DERIV_REAL_TOKEN : process.env.DERIV_DEMO_TOKEN;
const SYMBOL = process.env.DERIV_SYMBOL || 'frxXAUUSD';
const STAKE = parseFloat(process.env.STAKE_AMOUNT || '1');
const MULTIPLIER = parseFloat(process.env.MULTIPLIER || '50');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// Health check - visit this URL in browser to confirm server is alive
app.get('/', (req, res) => {
  res.send(`Deriv webhook server is running. Mode: ${MODE}, Symbol: ${SYMBOL}`);
});

// Main webhook endpoint - TradingView alerts POST here
app.post('/webhook', async (req, res) => {
  try {
    if (WEBHOOK_SECRET && req.body.secret !== WEBHOOK_SECRET) {
      console.log('Rejected: bad secret');
      return res.status(401).send('Unauthorized');
    }

    const action = (req.body.action || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(action)) {
      return res.status(400).send('Invalid action, expected BUY or SELL');
    }

    console.log(`[${new Date().toISOString()}] Signal received: ${action}`);
    const result = await placeTrade(action);
    console.log('Trade placed successfully:', result.contract_id);
    res.status(200).send('Trade order sent: ' + result.contract_id);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

function placeTrade(action) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) {
      return reject(new Error(`No API token set for mode ${MODE}. Check Render environment variables.`));
    }

    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error('Timeout waiting for Deriv response (15s)'));
      }
    }, 15000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ authorize: TOKEN }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data);

      if (msg.msg_type === 'authorize') {
        if (msg.error) {
          settled = true;
          clearTimeout(timeout);
          ws.close();
          return reject(new Error('Authorize failed: ' + msg.error.message));
        }
        const contractType = action === 'BUY' ? 'MULTUP' : 'MULTDOWN';
        ws.send(JSON.stringify({
          buy: 1,
          price: STAKE,
          parameters: {
            amount: STAKE,
            basis: 'stake',
            contract_type: contractType,
            currency: 'USD',
            symbol: SYMBOL,
            multiplier: MULTIPLIER
          }
        }));
      }

      if (msg.msg_type === 'buy') {
        settled = true;
        clearTimeout(timeout);
        if (msg.error) {
          ws.close();
          return reject(new Error('Buy failed: ' + msg.error.message));
        }
        ws.close();
        resolve(msg.buy);
      }
    });

    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} | mode=${MODE} | symbol=${SYMBOL} | stake=${STAKE} | multiplier=${MULTIPLIER}`);
});
