import { createSuperRareClient } from '../../src/index.js';

const superrare = createSuperRareClient({
  apiUrl: 'http://localhost:3000',
});

const output = document.querySelector('#output');
const login = document.querySelector('#login');
const buy = document.querySelector('#buy');

const render = (value: unknown): void => {
  if (output !== null) {
    output.textContent = JSON.stringify(value, null, 2);
  }
};

// Every hosted flow opens in its own window, so the SDK must be called
// directly from the click handler — that keeps the window inside the user
// gesture and the browser allows it.
login?.addEventListener('click', () => {
  superrare.auth.login()
    .then(async (result) => (result.status === 'authenticated' ? await superrare.user.me() : result))
    .then(render)
    .catch(render);
});

buy?.addEventListener('click', () => {
  void superrare.actions.buy({
    target: {
      kind: 'erc721-direct-listing',
      chainId: 11155111,
      contract: '0x252f829f6ea6623c883d6f433dc6999b94817419',
      tokenId: '1',
    },
    expected: { currency: 'ETH', price: '1000000000000' },
  }).then(render).catch(render);
});
