import { Credits } from './credits.js';
import { PaidRound } from './round.js';

const params = new URLSearchParams(location.search);
const appId = params.get('appId');
const groupId = params.get('groupId');
const studioUrl = params.get('studioUrl') ?? 'https://studio.superrare.com';
const apiUrl = params.get('apiUrl') ?? 'https://api.superrare.com';
const connectUrl = params.get('connectUrl') ?? 'https://connect.superrare.com';
const mainnetUsdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const configText = document.querySelector('#configuration');
const connectButton = document.querySelector('#connect');
const connectionStatus = document.querySelector('#connection-status');
let credits;
let round;
let busy = false;

if (!appId || !groupId) {
  connectionStatus.textContent = 'Add your Studio appId and credit groupId to the URL. See the example README.';
  connectButton.disabled = true;
} else {
  configText.textContent = `App ${appId} · credit group ${groupId} · Studio ${studioUrl}`;
  const client = window.SuperRareConnect.createSuperRareClient({
    studioUrl,
    apiUrl,
    connectUrl,
    onIntentSettled: (intent) => credits?.onIntentSettled(intent),
  });
  const game = client.games.forGame({ appId, groupId });
  const baseKey = `superrare-target-game:${encodeURIComponent(studioUrl)}:${appId}:${groupId}`;
  const changed = () => {
    connectButton.textContent = game.getAuthorization() ? 'Connected' : 'Connect';
  };
  credits = new Credits({
    client,
    game,
    root: document.querySelector('#credits'),
    storageKey: `${baseKey}:purchase`,
    onStatus: (message) => { connectionStatus.textContent = message; },
    connectUrl,
    usdcAddress: mainnetUsdc,
    changed,
  });
  round = new PaidRound({
    game,
    root: document.querySelector('#game'),
    storageKey: `${baseKey}:round`,
    getBalance: () => credits.balance,
    onStatus: (message) => { connectionStatus.textContent = message; },
  });
  credits.render();
  round.render();
  changed();
  connectButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    connectButton.disabled = true;
    connectionStatus.textContent = 'Connecting your game access…';
    try {
      await game.connect();
      await Promise.all([credits.refresh(), round.refresh()]);
      connectionStatus.textContent = 'Connected. Buy credits or continue your saved round.';
      changed();
    } catch {
      connectionStatus.textContent = 'Could not connect. Try Connect again; no play or payment was started.';
    } finally {
      busy = false;
      connectButton.disabled = false;
    }
  });
}
