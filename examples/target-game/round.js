const ROUND_SECONDS = 10;
const STORAGE_PREFIX = 'superrare-target-game-round:';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function newKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isKnownUnusedConsent(error) {
  return error?.code === 'CREDIT_GROUP_CONSENT_EXPIRED';
}

export class PaidRound {
  constructor({ game, root, getBalance, storageKey = 'target-game' }) {
    this.game = game;
    this.root = root;
    this.getBalance = getBalance;
    this.baseStorageKey = storageKey;
    this.state = null;
    this.storageKey = null;
    this.timer = null;
    this.statusNode = null;
    this.actionNode = null;
    this.arena = null;
    this.arenaMessage = null;
    this.target = null;
    this.scoreNode = null;
  }

  render() {
    this.root.replaceChildren();
    this.root.append(element('h2', 'Target game'));
    this.statusNode = element('p', 'Checking game access…', 'game-status');
    this.statusNode.setAttribute('role', 'status');
    this.root.append(this.statusNode);
    this.scoreNode = element('p', 'Score: 0', 'game-score');
    this.root.append(element('p', 'This demo records client-asserted scores; results are not independently verified.'));
    this.arena = element('div', undefined, 'arena');
    this.arena.setAttribute('aria-label', 'Target game arena');
    this.arenaMessage = element('p', 'Start a round to play.', 'arena-message');
    this.target = element('button', '', 'target');
    this.target.id = 'target';
    this.target.type = 'button';
    this.target.setAttribute('aria-label', 'Hit the target');
    this.target.hidden = true;
    this.target.addEventListener('click', () => this.hitTarget());
    this.arena.append(this.arenaMessage, this.target);
    this.root.append(this.arena);
    this.root.append(this.scoreNode);
    this.actionNode = element('div', undefined, 'game-actions');
    this.root.append(this.actionNode);
    void this.refresh();
    return this;
  }

  announce(message) {
    if (this.statusNode) this.statusNode.textContent = message;
  }

  accountStorageKey() {
    const authorization = this.game.getAuthorization();
    if (!authorization?.address) return null;
    const appId = authorization.appId;
    const groupId = authorization.groupId;
    return `${STORAGE_PREFIX}${encodeURIComponent(this.baseStorageKey)}:${encodeURIComponent(appId)}:${encodeURIComponent(groupId)}:${encodeURIComponent(authorization.address.toLowerCase())}`;
  }

  save() {
    if (!this.storageKey || !this.state) throw new Error('The paid round cannot be saved for this account.');
    // A failed storage write must stop before any consent or payment-facing call.
    localStorage.setItem(this.storageKey, JSON.stringify(this.state));
  }

  load() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!value || value.version !== 1 || typeof value.key !== 'string' || typeof value.phase !== 'string') return null;
      return value;
    } catch (error) {
      throw new Error(`Could not read this account's saved round: ${errorMessage(error)}`);
    }
  }

  clearActions() {
    this.actionNode.replaceChildren();
  }

  button(label, action, className) {
    const button = element('button', label, className);
    button.type = 'button';
    button.addEventListener('click', action);
    this.actionNode.append(button);
    return button;
  }

  async refresh() {
    if (!this.actionNode) return;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearActions();
    const key = this.accountStorageKey();
    if (!key) {
      this.storageKey = null;
      this.state = null;
      this.scoreNode.textContent = 'Score: 0';
      this.announce('Connect your game account in the Connect panel before playing.');
      return;
    }
    this.storageKey = key;
    try {
      this.state = this.load();
    } catch (error) {
      this.announce(errorMessage(error));
      return;
    }
    if (!this.state || this.state.phase === 'terminal' || this.state.phase === 'completed') {
      this.state = this.state?.phase === 'terminal' || this.state?.phase === 'completed' ? this.state : null;
      this.scoreNode.textContent = `Score: ${Number(this.state?.score) || 0}`;
      this.arenaMessage.textContent = this.state?.phase === 'completed'
        ? 'Round complete. Start another round when ready.'
        : this.state?.phase === 'terminal'
          ? `${this.state.diagnostic ?? 'This round is terminal.'} No replay or automatic refund.`
          : 'Start a round to play.';
      this.announce(this.state?.phase === 'completed'
        ? 'Round complete. Start another round when ready.'
        : this.state?.phase === 'terminal'
          ? `${this.state.diagnostic ?? 'A previous round is terminal.'} Any credits already used remain charged; no refund is assumed. You may explicitly start a new round.`
          : 'Ready for a paid round.');
      this.button('Play', () => void this.prepareRound());
      return;
    }
    this.scoreNode.textContent = `Score: ${Number(this.state.score) || 0}`;
    if (this.state.phase === 'ready' && this.state.session) {
      if (Date.parse(this.state.session.expiresAt) <= Date.now()) {
        this.markExpired();
        return;
      }
      this.announce('Your paid round is ready. Continue to play this same round.');
      this.button('Continue', () => this.beginPlay());
      return;
    }
    if (this.state.phase === 'playing') {
      if (Date.now() >= this.state.deadline || Date.parse(this.state.session?.expiresAt ?? '') <= Date.now()) {
        if (Date.parse(this.state.session?.expiresAt ?? '') <= Date.now()) this.markExpired();
        else void this.finishRound();
        return;
      }
      this.announce('Round in progress. Continue the same paid round.');
      this.button('Continue', () => this.resumePlay());
      return;
    }
    this.announce('A previous paid round needs recovery. Continue retries that same round; it will not create a new charge.');
    this.button('Continue', () => void this.recover());
  }

  async prepareRound() {
    this.clearActions();
    this.announce('Checking game terms and available credits…');
    try {
      const [terms, balance] = await Promise.all([this.game.getTerms(), this.getBalance()]);
      if (!terms || !balance) throw new Error('Could not read the game terms or credit balance.');
      if (balance.available < terms.credits) {
        this.announce(`Not enough credits for ${terms.title}. Buy credits in the Connect panel, then try again.`);
        this.button('Play', () => void this.prepareRound());
        return;
      }
      this.announce('Confirm one paid play. No credits are used until you confirm.');
      const description = element('p', `${terms.title} — ${terms.credits} credit${terms.credits === 1 ? '' : 's'} for one round.`);
      description.className = 'game-confirmation';
      const confirm = element('button', `Confirm and play (${terms.credits} credit${terms.credits === 1 ? '' : 's'})`);
      confirm.type = 'button';
      confirm.addEventListener('click', () => void this.confirmRound(terms));
      const cancel = element('button', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => {
        this.announce('No round started.');
        this.clearActions();
        this.button('Play', () => void this.prepareRound());
      });
      this.actionNode.replaceChildren(description, confirm, cancel);
    } catch (error) {
      this.announce(`Could not prepare a round: ${errorMessage(error)}`);
      this.clearActions();
      this.button('Play', () => void this.prepareRound());
    }
  }

  async confirmRound(terms) {
    if (!this.storageKey) return;
    this.clearActions();
    const key = newKey();
    this.state = {
      version: 1,
      key,
      phase: 'pending',
      score: 0,
      createdAt: Date.now(),
      request: {
        idempotencyKey: key,
        fingerprint: `target-game:${key}`,
        expectedCredits: terms.credits,
        metadata: { example: 'target-game' },
      },
      terms: { title: terms.title, credits: terms.credits },
    };
    try {
      this.save();
    } catch (error) {
      this.state = null;
      this.announce(`Cannot safely start: ${errorMessage(error)}`);
      this.button('Play', () => void this.prepareRound());
      return;
    }
    this.announce(`Starting ${terms.title}…`);
    try {
      const { consent } = await this.game.requestConsent(this.state.request);
      const session = await this.game.startWithConsent({ idempotencyKey: key, consent });
      this.acceptSession(session);
    } catch (error) {
      this.handleAttemptError(error, 'The start result is not known. Continue will recover this same paid play.');
    }
  }

  acceptSession(session) {
    this.state.session = session.session;
    this.state.game = session.game;
    this.state.leaderboard = session.defaultLeaderboard;
    this.state.phase = 'ready';
    this.save();
    this.announce('Paid round ready. Continue starts your 10-second target game.');
    this.clearActions();
    this.button('Continue', () => this.beginPlay());
  }

  handleAttemptError(error, unknownMessage) {
    if (isKnownUnusedConsent(error)) {
      const diagnostic = `Studio confirmed the consent expired unused: ${errorMessage(error)}`;
      const previousPhase = this.state.phase;
      try {
        localStorage.setItem(`${this.storageKey}:diagnostic:${this.state.key}`, JSON.stringify({
          key: this.state.key, phase: 'terminal', diagnostic, createdAt: this.state.createdAt, endedAt: Date.now(),
        }));
        this.state.phase = 'terminal';
        this.state.diagnostic = diagnostic;
        this.save();
      } catch (storageError) {
        this.state.phase = previousPhase;
        delete this.state.diagnostic;
        this.announce(`Studio reports an unused expired consent, but its terminal record could not be saved: ${errorMessage(storageError)} Continue retains the same start key.`);
        this.clearActions();
        this.button('Continue', () => void this.recover());
        return;
      }
      this.announce(`${diagnostic}. No credits were used. You may explicitly start a new round.`);
      this.clearActions();
      this.button('Play', () => void this.prepareRound());
      return;
    }
    this.announce(`${unknownMessage} ${errorMessage(error)}`);
    this.clearActions();
    this.button('Continue', () => void this.recover());
  }

  async recover() {
    if (!this.state || !this.storageKey) return;
    this.clearActions();
    this.announce('Recovering the same paid play…');
    try {
      const session = await this.game.recoverStart({ idempotencyKey: this.state.key });
      this.acceptSession(session);
    } catch (error) {
      if (error?.status === 410) {
        this.markExpired(errorMessage(error));
        return;
      }
      this.handleAttemptError(error, 'Recovery did not settle. Continue retries with the same start key.');
    }
  }

  markExpired(diagnostic = 'The saved PlaySession has expired.') {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    try {
      localStorage.setItem(`${this.storageKey}:diagnostic:${this.state.key}`, JSON.stringify({
        key: this.state.key,
        phase: 'terminal',
        diagnostic,
        createdAt: this.state.createdAt,
        endedAt: Date.now(),
      }));
    } catch { /* Keep the active record when diagnostic storage is unavailable. */ }
    this.target.hidden = true;
    this.arenaMessage.hidden = false;
    this.arenaMessage.textContent = diagnostic;
    this.state.phase = 'terminal';
    this.state.diagnostic = diagnostic;
    try { this.save(); } catch { /* Do not imply a refund or create another start automatically. */ }
    this.announce(`${diagnostic} Any credits already used remain charged; no refund is initiated, and this old round cannot be replayed. You may explicitly start a new round.`);
    this.clearActions();
    this.button('Play', () => void this.prepareRound());
  }

  beginPlay() {
    if (!this.state?.session || !this.storageKey) return;
    if (Date.parse(this.state.session.expiresAt) <= Date.now()) {
      this.markExpired();
      return;
    }
    this.state.phase = 'playing';
    this.state.deadline = Date.now() + ROUND_SECONDS * 1000;
    this.state.score = 0;
    try { this.save(); } catch (error) {
      this.state.phase = 'ready';
      this.announce(`Cannot safely save this round: ${errorMessage(error)}`);
      return;
    }
    this.resumePlay();
  }

  hitTarget() {
    if (!this.state || this.state.phase !== 'playing' || Date.now() >= this.state.deadline) return;
    this.state.score += 1;
    this.scoreNode.textContent = `Score: ${this.state.score}`;
    try {
      this.save();
      const maxX = Math.max(0, this.arena.clientWidth - this.target.offsetWidth);
      const maxY = Math.max(0, this.arena.clientHeight - this.target.offsetHeight);
      this.target.style.left = `${Math.random() * maxX}px`;
      this.target.style.top = `${Math.random() * maxY}px`;
    } catch (error) { this.announce(`Could not save score: ${errorMessage(error)}`); }
  }

  resumePlay() {
    if (!this.state || this.state.phase !== 'playing') return;
    this.clearActions();
    this.arenaMessage.hidden = true;
    this.target.hidden = false;
    const maxX = Math.max(0, this.arena.clientWidth - this.target.offsetWidth);
    const maxY = Math.max(0, this.arena.clientHeight - this.target.offsetHeight);
    this.target.style.left = `${Math.random() * maxX}px`;
    this.target.style.top = `${Math.random() * maxY}px`;
    const tick = () => {
      const remaining = Math.max(0, this.state.deadline - Date.now());
      this.announce(`Time left: ${(remaining / 1000).toFixed(1)}s`);
      if (remaining <= 0) void this.finishRound();
    };
    tick();
    if (this.timer === null) this.timer = setInterval(tick, 100);
  }

  async finishRound() {
    if (!this.state || !this.state.session || !this.storageKey || ['submitting', 'completed', 'terminal'].includes(this.state.phase)) return;
    if (this.timer !== null) clearInterval(this.timer);
    this.target.hidden = true;
    this.arenaMessage.hidden = false;
    this.arenaMessage.textContent = 'Round ended. Your score is being recorded.';
    this.timer = null;
    this.state.phase = 'submitting';
    this.state.scoreKey = `${this.state.key}:score`;
    try { this.save(); } catch (error) {
      this.announce(`Round ended, but its result could not be saved: ${errorMessage(error)}`);
      return;
    }
    this.clearActions();
    this.announce('Submitting your client-asserted score and completing this round…');
    await this.submitAndComplete();
  }

  async submitAndComplete() {
    const { session } = this.state;
    try {
      if (!this.state.scoreSubmitted) {
        await this.game.submitClientAssertedScore({
          sessionToken: session.token,
          leaderboardKey: this.state.leaderboard?.key ?? 'default',
          score: this.state.score,
          idempotencyKey: this.state.scoreKey,
          metadata: { trustLevel: 'client_asserted', example: 'target-game' },
        });
        this.state.scoreSubmitted = true;
        this.save();
      }
      if (!this.state.completed) {
        await this.game.complete({ sessionId: session.id, sessionToken: session.token });
        this.state.completed = true;
        this.state.phase = 'completed';
        this.save();
      }
      this.arenaMessage.textContent = `Round complete. Score ${this.state.score} is client-asserted, not independently verified.`;
      this.announce(`Round complete. Score ${this.state.score} is client-asserted, not independently verified. Start another round when ready.`);
      this.clearActions();
      this.button('Play', () => void this.prepareRound());
    } catch (error) {
      if (error?.status === 410) {
        this.markExpired(errorMessage(error));
        return;
      }
      this.announce(`Result not confirmed: ${errorMessage(error)} Continue retries this round's submission safely.`);
      this.clearActions();
      this.button('Continue', () => void this.recoverFinishedRound());
    }

  }

  async recoverFinishedRound() {
    if (!this.state || !this.storageKey) return;
    if (Date.parse(this.state.session?.expiresAt ?? '') <= Date.now()) {
      this.markExpired();
      return;
    }
    this.state.phase = 'submitting';
    try { this.save(); } catch (error) {
      this.announce(`Could not save recovery state: ${errorMessage(error)}`);
      return;
    }
    await this.submitAndComplete();
  }
}
