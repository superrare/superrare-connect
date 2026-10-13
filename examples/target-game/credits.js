import { describeSdkFailure } from './hosted-flow.js';
const MAINNET_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const STORAGE_VERSION = 'v1';

function text(element, value) {
  element.textContent = value;
}

function formatPrice(atomic) {
  if (!/^\d+$/.test(String(atomic))) return 'an amount shown by the wallet';
  const value = BigInt(atomic);
  const whole = value / 1_000_000n;
  const fraction = String(value % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return `$${whole}${fraction ? `.${fraction}` : ''} USDC`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export class Credits {
  constructor({ client, game, root, display, connectUrl, storageKey, usdcAddress, changed }) {
    this.client = client;
    this.game = game;
    this.root = root;
    this.display = display;
    this.connectUrl = connectUrl;
    this.storageKey = storageKey ?? 'superrare-target-game';
    this.usdcAddress = (usdcAddress ?? MAINNET_USDC).toLowerCase();
    this.changed = changed ?? (() => {});
    this.balance = undefined;
    this.record = undefined;
    this.accountAddress = undefined;
    this.claimPromises = new Map();
    this.rendered = false;
  }

  render() {
    if (this.rendered) return this;
    this.rendered = true;
    this.root.replaceChildren();

    this.balanceLabel = document.createElement('p');
    this.balanceLabel.setAttribute('aria-live', 'polite');
    text(this.balanceLabel, 'Credits: not loaded');
    this.root.append(this.balanceLabel);

    this.statusLabel = document.createElement('p');
    this.statusLabel.setAttribute('role', 'status');
    this.statusLabel.setAttribute('aria-live', 'polite');
    this.root.append(this.statusLabel);

    this.actions = document.createElement('div');
    this.actions.className = 'credit-actions';
    this.root.append(this.actions);

    this.technical = document.createElement('details');
    const summary = document.createElement('summary');
    text(summary, 'Purchase details');
    this.technical.append(summary);
    this.detailsText = document.createElement('p');
    this.detailsText.className = 'technical-details';
    this.technical.append(this.detailsText);
    this.root.append(this.technical);
    this.technical.addEventListener('toggle', () => {
      if (this.technical.open) void this.refresh();
    });
    void this.refresh();
    return this;
  }

  _authorization() {
    const authorization = this.game.getAuthorization();
    if (!authorization?.address) return undefined;
    return { ...authorization, address: authorization.address.toLowerCase() };
  }

  _stateKey(address) {
    return `${this.storageKey}:${STORAGE_VERSION}:${address}`;
  }

  _loadRecord(address) {
    try {
      const serialized = localStorage.getItem(this._stateKey(address));
      if (!serialized) return undefined;
      const value = JSON.parse(serialized);
      if (!value || typeof value !== 'object' || !value.purchase?.id) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  _saveRecord(record) {
    // A failed write must stop before any payment request is sent.
    localStorage.setItem(this._stateKey(this.accountAddress), JSON.stringify(record));
    this.record = record;
    this._showDetails();
  }

  _showDetails() {
    if (!this.record) {
      text(this.detailsText, this.accountAddress
        ? 'No purchase is in progress for this game account.'
        : 'Saved purchases remain isolated per game account. Reauthorize the same account to resume or reconcile them; this page does not clear saved purchase state.');
      return;
    }
    const purchase = this.record.purchase;
    text(this.detailsText, [
      `Purchase ID: ${purchase.id}`,
      `Quote expires: ${purchase.expiresAt}`,
      this.record.intentId ? `Connect intent: ${this.record.intentId}` : '',
      this.record.transactionHash ? `Transaction: ${this.record.transactionHash}` : '',
    ].filter(Boolean).join('\n'));
  }

  _say(message) {
    text(this.statusLabel, message);
  }

  _renderActions() {
    this.actions.replaceChildren();
    const addButton = (label, action, className = '') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      text(button, label);
      button.disabled = this.busy;
      button.addEventListener('click', () => void action());
      this.actions.append(button);
      return button;
    };

    if (!this.accountAddress) return;
    const record = this.record;
    if (record?.credited || record?.purchase?.creditedAt) {
      addButton('Buy more credits', () => this._createQuote(), 'primary');
      return;
    }
    if (!record) {
      addButton('Buy credits', () => this._createQuote(), 'primary');
      return;
    }

    if (record.transactionHash) {
      addButton('Continue purchase', () => this._continuePurchase(), 'primary');
      addButton('Enter transaction', () => this._enterTransaction());
      return;
    }

    if (record.intentId || record.outcomeUnknown) {
      addButton('Continue purchase', () => this._continuePurchase(), 'primary');
      addButton('Enter transaction', () => this._enterTransaction());
      if (['failed', 'cancelled', 'expired'].includes(record.intentStatus) && !record.transactionHash) {
        addButton('Start a fresh quote', () => this._cancelQuote());
      }
      return;
    }

    if (record.confirmPayment) {
      addButton(`Confirm ${record.purchase.packCredits} credits · ${formatPrice(record.purchase.packPriceAtomic)}`, () => this._pay(), 'primary');
      addButton('Cancel quote', () => this._cancelQuote());
      return;
    }

    addButton('Continue purchase', () => this._continuePurchase(), 'primary');
  }

  async refresh() {
    if (!this.rendered) return;
    const authorization = this._authorization();
    if (!authorization) {
      this.accountAddress = undefined;
      this.balance = undefined;
      text(this.balanceLabel, 'Credits: connect your game account to load balance.');
      this.record = undefined;
      this._showDetails();
      this._renderActions();
      return;
    }

    this.accountAddress = authorization.address;
    this.record = this._loadRecord(this.accountAddress);
    this._showDetails();
    this._renderActions();
    try {
      const balance = await this.game.credits.getBalance();
      const currentAuthorization = this._authorization();
      if (currentAuthorization?.address !== authorization.address) {
        this.balance = undefined;
        text(this.balanceLabel, currentAuthorization
          ? 'Credits: loading current game account…'
          : 'Credits: connect your game account to load balance.');
        this.accountAddress = currentAuthorization?.address;
        this.record = currentAuthorization ? this._loadRecord(currentAuthorization.address) : undefined;
        this._say(currentAuthorization
          ? 'Game account changed while loading. Showing only the newly authorized account; saved purchases remain isolated per account.'
          : 'Game authorization expired while loading. Saved purchase records remain preserved per account; authorize the game again to resume.');
        this._showDetails();
        this._renderActions();
        this.changed();
        if (currentAuthorization) void this.refresh();
        return;
      }
      this.balance = balance;
      text(this.balanceLabel, `Credits: ${balance.available} available`);
      if (this.record) {
        if (this.record.transactionHash && !this.record.credited && !this.record.intentId) {
          await this._claim(this.record.transactionHash);
        }
      }
      this._renderActions();
    } catch (error) {
      const currentAuthorization = this._authorization();
      this.balance = undefined;
      text(this.balanceLabel, currentAuthorization
        ? 'Credits: balance could not be loaded.'
        : 'Credits: connect your game account to load balance.');
      if (currentAuthorization?.address !== authorization.address) {
        this.accountAddress = currentAuthorization?.address;
        this.record = currentAuthorization ? this._loadRecord(currentAuthorization.address) : undefined;
        this._say(currentAuthorization
          ? 'Game account changed while loading. Showing only the newly authorized account; saved purchases remain isolated per account.'
          : `Could not load credit balance (${describeSdkFailure(error)}); game authorization is no longer available. Saved purchase records remain preserved per account.`);
        this._showDetails();
        this._renderActions();
        this.changed();
        if (currentAuthorization) void this.refresh();
        return;
      }
      this._say(`Could not load credit balance (${describeSdkFailure(error)}). The current authorization is preserved; retry the balance request.`);
    }
  }

  async _createQuote() {
    if (this.busy || !this._authorization()) return;
    this.busy = true;
    this._renderActions();
    this._say('Loading a purchase quote…');
    try {
      const quote = await this.game.credits.createPurchase();
      const authorization = this._authorization();
      if (!authorization) throw new Error('Connect a game wallet before buying credits.');
      if (quote.chainId !== 1) throw new Error('This example only accepts Ethereum mainnet credit quotes.');
      if (this.usdcAddress !== MAINNET_USDC || quote.usdcAddress.toLowerCase() !== this.usdcAddress) {
        throw new Error('The credit quote does not use the configured Ethereum mainnet USDC contract. No payment was started.');
      }
      if (quote.address.toLowerCase() !== authorization.address) {
        throw new Error('This quote belongs to a different wallet. Refresh your game connection and try again.');
      }
      this.accountAddress = authorization.address;
      const record = { purchase: quote, confirmPayment: true, outcomeUnknown: false };
      this._saveRecord(record);
      this._say(`Review the quote, then explicitly confirm ${quote.packCredits} credits for ${formatPrice(quote.packPriceAtomic)}.`);
    } catch (error) {
      this._say(`Could not create a safe purchase quote: ${errorMessage(error)} You can try again.`);
    } finally {
      this.busy = false;
      this._renderActions();
    }
  }

  _cancelQuote() {
    const definitivelyFailed = ['failed', 'cancelled', 'expired'].includes(this.record?.intentStatus);
    if (!this.record || this.record.transactionHash
      || (this.record.intentId && !definitivelyFailed)
      || (this.record.outcomeUnknown && !definitivelyFailed)) return;
    try {
      localStorage.removeItem(this._stateKey(this.accountAddress));
      this.record = undefined;
      this._showDetails();
      this._say(definitivelyFailed
        ? 'The payment intent is definitively closed with no transaction hash. You may request a fresh quote; no credits were claimed.'
        : 'Quote cancelled. No payment was requested.');
    } catch (error) {
      this._say(`Could not clear this quote: ${errorMessage(error)}`);
    }
    this._renderActions();
  }

  async _pay() {
    const authorization = this._authorization();
    const record = this.record;
    if (this.busy || !authorization || !record?.confirmPayment || authorization.address !== this.accountAddress) return;
    const quote = record.purchase;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      this._say('This quote expired before payment. Cancel it and request a fresh quote; no transfer was started.');
      return;
    }
    if (quote.chainId !== 1 || quote.usdcAddress.toLowerCase() !== this.usdcAddress || this.usdcAddress !== MAINNET_USDC || quote.address.toLowerCase() !== authorization.address) {
      this._say('This quote no longer matches the connected mainnet wallet. No payment was started.');
      return;
    }
    this.busy = true;
    this._renderActions();
    try {
      // Keep the exact quote and an ambiguous-outcome marker durable before the SDK opens hosted checkout.
      const pending = { ...record, confirmPayment: false, outcomeUnknown: true };
      this._saveRecord(pending);
      this._say(`Opening hosted wallet checkout in the ${this.display === 'embed' ? 'embedded dialog' : 'popup window'}. No transfer is submitted until the hosted wallet asks for explicit approval.`);
      const intent = await this.client.actions.transfer({
        chainId: quote.chainId,
        to: quote.treasuryAddress,
        currency: 'USDC',
        amount: quote.packPriceAtomic,
        beforeOpen: () => this._saveRecord(pending),
      });
      const withIntent = { ...pending, intentId: intent.intentId, outcomeUnknown: false };
      this._saveRecord(withIntent);
      this._say('Payment request opened. Continue purchase to check its status; a grant is claimed only after a transaction hash is known.');
    } catch (error) {
      this._say(`The payment result is not confirmed (${errorMessage(error)}). Do not start another transfer. Continue purchase to check again, or enter the transaction hash if your wallet completed it.`);
    } finally {
      this.busy = false;
      this._renderActions();
    }
  }

  async _continuePurchase() {
    if (this.busy || !this.record || !this._authorization()) return;
    const authorization = this._authorization();
    if (authorization.address !== this.accountAddress) {
      this._say('This purchase belongs to another wallet. Reconnect that wallet to continue; its record is kept separately.');
      return;
    }
    this.busy = true;
    this._renderActions();
    try {
      await this._reconcilePurchase();
      if (this.record?.intentId) {
        const intent = await this.client.actions.getStatus({ intentId: this.record.intentId });
        const hash = intent.result?.transactionHash ?? intent.result?.approvalTxHash;
        this._saveRecord({
          ...this.record,
          ...(hash ? { transactionHash: hash } : {}),
          intentStatus: intent.status,
          outcomeUnknown: false,
        });
        if (intent.status === 'completed' && hash) {
          await this._claim(hash);
        } else if (['failed', 'cancelled', 'expired'].includes(intent.status)) {
          this._say(`Payment ${intent.status}; no completed transfer was confirmed. Check the wallet and retain this purchase before requesting anything new.`);
        } else if (intent.status === 'completed') {
          this._say('Connect completed the action but returned no transaction hash. The purchase remains saved; do not start another transfer.');
        } else {
          this._say(`Payment is ${intent.status}. Keep this purchase and continue later; do not request another transfer.`);
        }
      } else if (this.record?.transactionHash) {
        await this._claim(this.record.transactionHash);
      } else {
        this._say('The payment outcome is unknown and no intent ID was saved. Do not create another transfer. Enter the transaction hash if your wallet completed the payment.');
      }
    } catch (error) {
      this._say(`Purchase status could not be confirmed: ${errorMessage(error)} The same purchase is saved; retry Continue purchase.`);
    } finally {
      this.busy = false;
      this._renderActions();
    }
  }

  async _reconcilePurchase() {
    if (!this.record) return;
    const saved = this.record;
    try {
      const purchase = await this.game.credits.getPurchase(saved.purchase.id);
      if (purchase.address.toLowerCase() !== this.accountAddress) {
        this._say('The saved purchase belongs to another wallet. Reconnect that wallet to continue.');
        return;
      }
      const latest = this._loadRecord(this.accountAddress) ?? saved;
      const transactionHash = purchase.transactionHash || latest.transactionHash;
      this._saveRecord({ ...latest, purchase, transactionHash: transactionHash || undefined, credited: Boolean(purchase.creditedAt), outcomeUnknown: transactionHash ? false : latest.outcomeUnknown });
      if (purchase.creditedAt) {
        this._say('Credits received. Balance refreshed.');
        this.balance = await this.game.credits.getBalance();
        text(this.balanceLabel, `Credits: ${this.balance.available} available`);
        this._saveRecord({ ...this.record, credited: true });
        this.changed();
      }
    } catch (error) {
      // Keep local transfer evidence; absence of a server response is not proof of failure.
      if (saved.transactionHash) throw error;
    }
  }

  _claim(transactionHash) {
    if (!this.record) return Promise.resolve();
    const key = `${this.record.purchase.id}:${transactionHash.toLowerCase()}`;
    const existing = this.claimPromises.get(key);
    if (existing) return existing;
    const pending = this._claimOnce(transactionHash).finally(() => this.claimPromises.delete(key));
    this.claimPromises.set(key, pending);
    return pending;
  }

  async _claimOnce(transactionHash) {
    const record = this.record;
    let claimHash = record.transactionHash || transactionHash;
    let intentStatus = record.intentStatus;
    try {
      if (record.intentId) {
        const intent = await this.client.actions.getStatus({ intentId: record.intentId });
        const completedHash = intent.result?.transactionHash ?? intent.result?.approvalTxHash;
        if (intent.status !== 'completed') {
          this._saveRecord({
            ...record,
            transactionHash: claimHash,
            intentStatus: intent.status,
          });
          this._say(`Transaction hash saved. The hosted transfer is ${intent.status}, not completed; continue this purchase to reconcile its status before claiming credits.`);
          return;
        }
        if (!completedHash || !/^0x[0-9a-fA-F]{64}$/.test(completedHash)) {
          throw new Error('Connect reported completion without a valid transaction hash.');
        }
        if (record.transactionHash
          && record.transactionHash.toLowerCase() !== completedHash.toLowerCase()) {
          throw new Error('Connect reported a different transaction hash; the saved purchase hash was not replaced.');
        }
        claimHash = completedHash;
        intentStatus = intent.status;
      }
      this._saveRecord({
        ...record,
        transactionHash: claimHash,
        ...(intentStatus ? { intentStatus } : {}),
        outcomeUnknown: false,
      });
      const result = await this.game.credits.claimPurchase({ purchaseId: record.purchase.id, transactionHash: claimHash });
      const latest = this._loadRecord(this.accountAddress) ?? this.record;
      this._saveRecord({ ...latest, purchase: result.purchase, credited: Boolean(result.purchase.creditedAt), transactionHash: claimHash });
      this.balance = result.balance;
      text(this.balanceLabel, `Credits: ${result.balance.available} available`);
      this._say(result.purchase.creditedAt ? 'Credits received. You can continue playing.' : 'Transaction recorded; credit confirmation is pending. Continue purchase later to check again.');
      this.changed();
    } catch (error) {
      this._say(`Transaction is saved, but claiming could not be confirmed: ${errorMessage(error)} Continue purchase retries the same transaction safely.`);
    }
    this._renderActions();
  }

  onIntentSettled(intent) {
    const record = this.record;
    if (!record?.intentId || intent?.intentId !== record.intentId
      || this._authorization()?.address !== this.accountAddress) return;
    const transactionHash = intent.result?.transactionHash ?? intent.result?.approvalTxHash;
    const validHash = transactionHash && /^0x[0-9a-fA-F]{64}$/.test(transactionHash)
      ? transactionHash
      : undefined;
    const definitivelyFailed = ['failed', 'cancelled', 'expired'].includes(intent.status);
    const saved = {
      ...record,
      ...(validHash ? { transactionHash: validHash } : {}),
      intentStatus: intent.status,
      outcomeUnknown: definitivelyFailed ? false : record.outcomeUnknown,
    };
    this._saveRecord(saved);
    if (intent.status === 'completed' && validHash) {
      void this._claim(validHash);
      return;
    }
    this._say(definitivelyFailed
      ? `Payment ${intent.status}; no completed transfer was confirmed. Check your wallet and keep this purchase before requesting anything new.`
      : intent.status === 'completed'
        ? 'Connect completed the action but returned no valid transaction hash. The purchase remains saved; do not start another transfer.'
        : `Payment status is ${intent.status}. Continue this same purchase later; do not request another transfer.`);
    this._renderActions();
  }

  async _enterTransaction() {
    if (!this.record || !this._authorization() || this._authorization().address !== this.accountAddress) return;
    const hash = window.prompt('Enter the Ethereum transaction hash for this saved purchase. Do not enter a different transaction.');
    if (hash === null) return;
    const normalized = hash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
      this._say('That does not look like a transaction hash. The saved purchase was not changed.');
      return;
    }
    if (this.record.transactionHash && this.record.transactionHash.toLowerCase() !== normalized.toLowerCase()) {
      this._say('A transaction hash is already saved for this purchase. It cannot be replaced here.');
      return;
    }
    this.busy = true;
    this._renderActions();
    try {
      this._saveRecord({ ...this.record, transactionHash: normalized, outcomeUnknown: false });
      await this._claim(normalized);
    } finally {
      this.busy = false;
      this._renderActions();
    }
  }
}
