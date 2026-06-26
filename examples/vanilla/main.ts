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

login?.addEventListener('click', () => {
  void superrare.auth.login({ returnPath: '/callback.html' });
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
    returnPath: '/buy-complete.html',
  }).then(render).catch(render);
});

if (window.location.search.length > 0) {
  superrare.auth.exchangeCallback(new URLSearchParams(window.location.search))
    .then(async () => await superrare.user.me())
    .then(render)
    .catch(render);
}
