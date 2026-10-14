import { applyInput, parseSavedRound, targetSnapshotSchema, targetStateSchema } from './target-engine.js';

const TICK_MILLISECONDS = 50;
const MAX_PENDING_INPUTS = 32;
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

async function unusedReplacementKey(previousKey, credits) {
  const input = new TextEncoder().encode(`target-game-unused-renewal:v1:${previousKey}:${credits}`);
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function serverRunKey(paidKey) {
  const input = new TextEncoder().encode(`target-game-server-run:v1:${paidKey}`);
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isKnownUnusedConsent(error) {
  return error?.code === 'CREDIT_GROUP_CONSENT_EXPIRED';
}

function recoveryMessage(error) {
  const code = error?.code;
  if (error?.name === 'ConnectSessionRequiredError' || code === 'CONNECT_UNAUTHORIZED') {
    return 'Sign in to SuperRare, then continue. Your play is saved.';
  }
  if (code === 'authorization_required' || error?.status === 401) {
    return 'Your game connection needs renewing. Continue will reconnect and retry your saved play.';
  }
  if (code === 'CREDIT_GROUP_INSUFFICIENT_CREDITS') {
    return 'Buy credits, then continue your saved play.';
  }
  if (code === 'CREDIT_GROUP_NEW_USES_PAUSED' || code === 'CREDIT_GROUP_NOT_ACTIVE') {
    return 'This game is temporarily paused. Your saved play is kept.';
  }
  if (code === 'CREDIT_GROUP_APP_NOT_APPROVED' || code === 'FORBIDDEN') {
    return 'This game is not currently approved to start a play. Your saved play is kept.';
  }
  return 'Could not start the game. Continue safely retries your saved play.';
}

export class PaidRound {
  constructor({ game, scoringGame, root, getBalance, storageKey = 'target-game' }) {
    this.game = game;
    this.scoringGame = scoringGame;
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
    this.topScoreNode = null;
    this.socket = null;
    this.runConnecting = false;
    this.completing = false;
    this.connectTimer = null;
    this.predictedView = null;
    this.lastPacketAt = 0;
    this.lastSentTick = -1;
    this.receivedSnapshot = false;
    this.startingRound = false;
    this.playActionGeneration = 0;
  }

  render() {
    this.root.replaceChildren();
    this.root.append(element('h2', 'Target game'));
    this.statusNode = element('p', 'Checking game access…', 'game-status');
    this.statusNode.setAttribute('role', 'status');
    this.root.append(this.statusNode);
    this.scoreNode = element('p', 'Score: 0', 'game-score');
    this.root.append(element('p', 'The platform runs this game’s bundled server verifier. Inputs are sent to the server; only its recorded result is a verified score.'));
    this.topScoreNode = element('p', 'Server-verified top score: loading…');
    this.root.append(this.topScoreNode);
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
    void this.refreshTopScore();
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
      return parseSavedRound(JSON.parse(raw));
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
    const key = this.accountStorageKey();
    if (key === this.storageKey && (this.socket || this.runConnecting || this.completing || this.startingRound)) return;
    this.disconnectRun();
    this.clearActions();
    this.target.hidden = true;
    this.arenaMessage.hidden = false;
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
    if (this.state?.phase === 'terminal' && this.state.unused === true) {
      this.scoreNode.textContent = 'Score: 0';
      this.arenaMessage.textContent = 'Start a round to play.';
      this.announce(`Continue starts your ${this.state.request.expectedCredits}-credit play.`);
      this.button('Continue', () => void this.recover());
      return;
    }
    if (this.state?.version === 1 && ['playing', 'submitting'].includes(this.state.phase)) {
      this.markExpired('This older round used client scoring and cannot become server-verified. Its records are preserved.');
      return;
    }
    if (!this.state || ['terminal', 'completed'].includes(this.state.phase)) {
      this.scoreNode.textContent = this.state?.result
        ? `Verified score: ${this.state.result.score}`
        : this.state?.phase === 'completed' ? `Previous client-asserted score: ${this.state.score ?? 0}` : 'Score: 0';
      this.arenaMessage.textContent = this.state?.phase === 'terminal'
        ? this.state.diagnostic : 'Start a server-validated round to play.';
      this.announce(this.state?.phase === 'terminal'
        ? `${this.state.diagnostic} Any credits already used remain charged.`
        : 'Ready for a server-validated paid round.');
      await this.showPlayAction();
      return;
    }
    this.scoreNode.textContent = `Score: ${this.state.run?.view?.score ?? 0}`;
    this.arenaMessage.textContent = 'Continue reconnects this same paid round; its server clock does not restart.';
    this.announce(`Continue starts or recovers your ${this.state.request.expectedCredits}-credit play.`);
    this.button('Continue', () => void this.recover());
  }

  async showPlayAction() {
    const generation = ++this.playActionGeneration;
    const accountKey = this.storageKey;
    const previous = this.state;
    this.clearActions();
    try {
      const [terms] = await Promise.all([this.game.getTerms(), this.scoringGame.getActiveScoringEvent()]);
      if (generation !== this.playActionGeneration || this.storageKey !== accountKey || this.state !== previous) return;
      this.button(`Play · ${terms.credits} credit${terms.credits === 1 ? '' : 's'}`, () => void this.prepareRound(terms.credits));
    } catch (error) {
      if (generation !== this.playActionGeneration || this.storageKey !== accountKey || this.state !== previous) return;
      this.announce(`Could not load the game price: ${errorMessage(error)} No new play was started.`);
      this.button('Retry', () => void this.showPlayAction());
    }
  }

  async prepareRound(displayedCredits) {
    if (this.startingRound || !Number.isSafeInteger(displayedCredits) || displayedCredits <= 0) return;
    if (this.state && !['completed', 'terminal'].includes(this.state.phase)) {
      await this.recover();
      return;
    }
    this.startingRound = true;
    this.playActionGeneration += 1;
    const accountKey = this.storageKey;
    const previous = this.state;
    this.clearActions();
    this.announce('Starting your game…');
    try {
      if (!this.game.getAuthorization()) await this.game.connect();
      const [terms, balance, event] = await Promise.all([
        this.game.getTerms(), this.getBalance(), this.scoringGame.getActiveScoringEvent(),
      ]);
      if (this.storageKey !== accountKey || this.state !== previous || this.accountStorageKey() !== accountKey) return;
      if (!terms || !balance) throw new Error('Could not read the game terms or credit balance.');
      if (terms.credits !== displayedCredits) {
        this.announce(`The price changed to ${terms.credits} credits. Click the updated Play button to approve that cost.`);
        await this.showPlayAction();
        return;
      }
      if (balance.available < terms.credits) {
        this.announce(`Not enough credits for ${terms.title}. Buy credits in the Connect panel, then try again.`);
        await this.showPlayAction();
        return;
      }
      await this.confirmRound(terms, undefined, event.eventId);
    } catch (error) {
      if (this.storageKey !== accountKey) return;
      if (this.state !== previous) this.showRecoveryError(error);
      else {
        this.announce(`Could not start a round: ${errorMessage(error)}`);
        await this.showPlayAction();
      }
    } finally {
      this.startingRound = false;
    }
  }

  async confirmRound(terms, replacementKey, eventId) {
    if (!this.storageKey) return;
    this.clearActions();
    const accountKey = this.storageKey;
    const key = replacementKey ?? newKey();
    let run;
    try {
      const activeEvent = eventId ?? (await this.scoringGame.getActiveScoringEvent()).eventId;
      run = {
        eventId: activeEvent, key: await serverRunKey(key),
        serverTick: -1, inputSeq: 0, inputTick: -1, pendingInputs: [],
      };
    } catch (error) {
      this.announce(`Could not prepare the server-validated game: ${errorMessage(error)} No credits were used.`);
      void this.showPlayAction();
      return;
    }
    if (this.storageKey !== accountKey || this.accountStorageKey() !== accountKey) return;
    this.state = {
      version: 2,
      key,
      phase: 'pending',
      score: 0,
      createdAt: Date.now(),
      run,
      request: {
        idempotencyKey: key,
        fingerprint: `target-game:${key}`,
        expectedCredits: terms.credits,
        metadata: { example: 'target-game' },
      },
      terms: { title: terms.title, credits: terms.credits },
    };
    // Both the paid-start key and server-run key are durable before either POST.
    const attempt = this.state;
    try {
      this.save();
    } catch (error) {
      this.state = null;
      this.announce(`Cannot safely start: ${errorMessage(error)}`);
      void this.showPlayAction();
      return;
    }
    this.announce(`Starting ${terms.title}…`);
    try {
      if (!this.game.getAuthorization()) await this.game.connect();
      if (this.storageKey !== accountKey || this.state !== attempt) return;
      if (this.accountStorageKey() !== accountKey) {
        this.showRecoveryError(new Error('The current wallet does not own this saved play.'),
          'Switch back to the wallet that owns this saved play, then continue.');
        return;
      }
      const { consent } = await this.game.requestConsent(attempt.request);
      if (this.storageKey !== accountKey || this.state !== attempt) return;
      const session = await this.game.startWithConsent({ ...attempt.request, consent });
      if (this.storageKey !== accountKey || this.state !== attempt) return;
      this.acceptSession(session);
      await this.beginPlay();
    } catch (error) {
      if (this.storageKey !== accountKey || this.state !== attempt) return;
      await this.handleAttemptError(error);
    }
  }

  acceptSession(session) {
    this.state.session = session.session;
    this.state.game = session.game;
    this.state.phase = 'ready';
    this.save();
  }

  async handleAttemptError(error) {
    if (isKnownUnusedConsent(error)) {
      const diagnostic = 'Studio confirmed this attempt expired without using credits.';
      const previousPhase = this.state.phase;
      try {
        localStorage.setItem(`${this.storageKey}:diagnostic:${this.state.key}`, JSON.stringify({
          key: this.state.key, phase: 'terminal', diagnostic, createdAt: this.state.createdAt, endedAt: Date.now(),
        }));
        this.state.phase = 'terminal';
        this.state.diagnostic = diagnostic;
        this.state.unused = true;
        this.save();
      } catch (storageError) {
        this.state.phase = previousPhase;
        delete this.state.diagnostic;
        delete this.state.unused;
        this.showRecoveryError(storageError, 'Allow this page to save its round before continuing.');
        return;
      }
      await this.restartUnusedRound();
      return;
    }
    this.showRecoveryError(error);
  }

  showRecoveryError(error, message = recoveryMessage(error)) {
    this.announce(message);
    this.clearActions();
    this.button('Continue', () => void this.recover());
    const details = element('details');
    details.append(element('summary', 'Error details'), element('p', errorMessage(error)));
    this.actionNode.append(details);
  }

  async restartUnusedRound() {
    const previous = this.state;
    const accountKey = this.storageKey;
    this.clearActions();
    this.announce('Starting your game…');
    try {
      const terms = await this.game.getTerms();
      if (this.storageKey !== accountKey || this.state !== previous) return;
      if (terms.credits !== previous.request.expectedCredits) {
        this.announce(`The price changed to ${terms.credits} credits. Click Play to approve the new cost.`);
        this.button(`Play · ${terms.credits} credit${terms.credits === 1 ? '' : 's'}`, () => void this.prepareRound(terms.credits));
        this.button('Cancel', () => void this.refresh());
        return;
      }
      const key = await unusedReplacementKey(previous.key, terms.credits);
      if (this.storageKey !== accountKey || this.state !== previous) return;
      await this.confirmRound(terms, key);
    } catch (error) {
      if (this.storageKey === accountKey && this.state === previous) this.showRecoveryError(error);
    }
  }

  async recover() {
    if (!this.state || !this.storageKey) return;
    const accountKey = this.storageKey;
    const previous = this.state;
    this.clearActions();
    this.announce('Starting your game…');
    try {
      if (!this.game.getAuthorization()) await this.game.connect();
      if (this.storageKey !== accountKey || this.state !== previous) return;
      if (this.accountStorageKey() !== accountKey) {
        this.showRecoveryError(new Error('The current wallet does not own this saved play.'),
          'Switch back to the wallet that owns this saved play, then continue.');
        return;
      }
      if (previous.session) {
        if (previous.result) await this.submitAndComplete();
        else await this.beginPlay();
        return;
      }
      const session = await this.game.recoverStart({ idempotencyKey: previous.key });
      if (this.storageKey !== accountKey || this.state !== previous) return;
      this.acceptSession(session);
      await this.beginPlay();
    } catch (error) {
      if (this.storageKey !== accountKey || this.state !== previous) return;
      if (error?.status === 410) {
        this.markExpired(errorMessage(error));
        return;
      }
      await this.handleAttemptError(error);
    }
  }

  markExpired(diagnostic = 'The saved PlaySession has expired.') {
    this.disconnectRun();
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
    void this.showPlayAction();
  }

  disconnectRun() {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.timer = null;
    this.connectTimer = null;
    this.runConnecting = false;
    this.receivedSnapshot = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
  }

  async beginPlay() {
    if (!this.state?.session || !this.storageKey || this.runConnecting || this.socket) return;
    const attempt = this.state;
    const accountKey = this.storageKey;
    this.runConnecting = true;
    this.clearActions();
    this.announce('Connecting to the platform’s server-validated game…');
    try {
      if (!attempt.run) {
        const { eventId } = await this.scoringGame.getActiveScoringEvent();
        const key = await serverRunKey(attempt.key);
        if (this.state !== attempt || this.storageKey !== accountKey) return;
        attempt.version = 2;
        attempt.run = { eventId, key, serverTick: -1, inputSeq: 0, inputTick: -1, pendingInputs: [] };
      }
      attempt.phase = 'run_pending';
      this.save();
      const response = await this.scoringGame.startServerValidatedRun({
        sessionToken: attempt.session.token,
        eventId: attempt.run.eventId,
        idempotencyKey: attempt.run.key,
      });
      if (this.state !== attempt || this.storageKey !== accountKey) return;
      const run = response.run;
      if (run.eventId !== attempt.run.eventId || run.engine !== 'custom' || run.engineVersion !== 'custom-v1'
        || (attempt.run.runId && run.runId !== attempt.run.runId)
        || (attempt.run.configDigest && run.configDigest !== attempt.run.configDigest)) {
        throw new Error('The platform returned a different run or verifier for this paid play.');
      }
      const initialView = targetStateSchema.parse(run.state);
      const socketUrl = new URL(run.webSocketUrl);
      const expectedProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (socketUrl.protocol !== expectedProtocol || socketUrl.host !== location.host
        || socketUrl.pathname !== `/api/v1/server-game-runs/${run.runId}/connect`) {
        throw new Error('The platform game socket must belong to this hosted game origin.');
      }
      attempt.run = {
        ...attempt.run, runId: run.runId, configDigest: run.configDigest,
        startedAt: run.startedAt, expiresAt: run.expiresAt, view: initialView,
        pendingInputs: attempt.run.pendingInputs.map((input) => ({ ...input, sent: false })),
      };
      attempt.phase = 'connecting';
      this.save();
      this.predictedView = initialView;
      this.lastSentTick = -1;
      this.receivedSnapshot = false;
      const socket = new WebSocket(socketUrl);
      this.socket = socket;
      const ownsSocket = () => this.socket === socket && this.state === attempt && this.storageKey === accountKey;
      this.connectTimer = setTimeout(() => {
        if (ownsSocket()) this.showRunError(new Error('The platform game socket did not return its initial state.'));
      }, 12000);
      socket.addEventListener('message', (event) => {
        if (!ownsSocket()) return;
        try {
          this.acceptSnapshot(targetSnapshotSchema.parse(JSON.parse(event.data)));
        } catch (error) {
          this.showRunError(error);
        }
      });
      socket.addEventListener('error', () => {
        if (ownsSocket()) this.showRunError(new Error('The platform game socket could not connect.'));
      });
      socket.addEventListener('close', () => {
        if (ownsSocket() && !attempt.result) this.showRunError(new Error('The platform game socket was interrupted.'));
      });
      this.timer = setInterval(() => {
        if (ownsSocket() && this.receivedSnapshot && !attempt.result) {
          this.flushInputs();
          this.renderRun();
        }
      }, 25);
    } catch (error) {
      if (this.state !== attempt || this.storageKey !== accountKey) return;
      this.runConnecting = false;
      if (error?.status === 410 || error?.code === 'RUN_EXPIRED') this.markExpired('The platform reports this paid run has expired.');
      else this.showRunError(error);
    }
  }

  estimatedServerTick() {
    return Math.max(0, this.state.run.serverTick) + Math.floor((performance.now() - this.lastPacketAt) / TICK_MILLISECONDS);
  }

  acceptSnapshot(packet) {
    if ('error' in packet) {
      if (['INPUT_RATE_LIMITED', 'RUN_CATCHING_UP', 'INPUT_OUT_OF_ORDER'].includes(packet.error)) {
        this.state.run.pendingInputs = this.state.run.pendingInputs.map((input) => ({ ...input, sent: false }));
        this.lastSentTick = Math.max(this.state.run.inputTick, packet.serverTick ?? this.estimatedServerTick());
        this.save();
        return;
      }
      if (packet.error === 'RUN_FINISHED') {
        this.target.hidden = true;
        this.announce('Waiting for the platform’s recorded result…');
        return;
      }
      throw new Error(`Platform game: ${packet.error}`);
    }
    const run = this.state.run;
    if (packet.runId !== run.runId || packet.configDigest !== run.configDigest) {
      throw new Error('The platform snapshot belongs to a different run or verifier.');
    }
    if (packet.serverTick < run.serverTick || packet.inputSeq < run.inputSeq) return;
    if (packet.result?.runId && packet.result.runId !== run.runId) {
      throw new Error('The platform result belongs to a different run.');
    }
    this.receivedSnapshot = true;
    this.runConnecting = false;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.lastPacketAt = performance.now();
    this.state.run = {
      ...run, view: packet.state, serverTick: packet.serverTick,
      inputSeq: packet.inputSeq, inputTick: packet.inputTick,
      pendingInputs: run.pendingInputs.filter((input) => input.seq > packet.inputSeq),
    };
    if (packet.result?.status === 'expired') {
      this.markExpired('The platform reports this paid run has expired.');
      return;
    }
    if (packet.result && 'score' in packet.result) {
      this.state.result = packet.result;
      this.state.score = packet.result.score;
      this.state.phase = 'finalizing';
      this.save();
      this.disconnectRun();
      this.target.hidden = true;
      this.arenaMessage.hidden = false;
      this.arenaMessage.textContent = `Server-verified score: ${packet.result.score}. Completing this paid round…`;
      void this.submitAndComplete();
      return;
    }
    this.state.phase = packet.state.gameOver ? 'finalizing' : 'playing';
    this.save();
    if (!packet.state.started && !packet.state.gameOver
      && !this.state.run.pendingInputs.some(({ input }) => input.action === 'start')) {
      this.queueInput({ action: 'start' });
    } else {
      this.reconcilePrediction();
      this.flushInputs();
      this.renderRun();
    }
  }

  reconcilePrediction() {
    let predicted = this.state.run.view;
    for (const pending of this.state.run.pendingInputs) {
      predicted = applyInput(predicted, pending.input, Math.max(predicted.tick, this.state.run.serverTick));
    }
    this.predictedView = predicted;
  }

  queueInput(input) {
    if (!this.receivedSnapshot || !this.socket || this.state.run.pendingInputs.length >= MAX_PENDING_INPUTS) return;
    const run = this.state.run;
    const last = run.pendingInputs.at(-1);
    const seq = (last?.seq ?? run.inputSeq) + 1;
    this.state.run.pendingInputs = [...run.pendingInputs, { seq, input, sent: false }];
    this.save();
    this.reconcilePrediction();
    this.flushInputs();
    this.renderRun();
  }

  flushInputs() {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.receivedSnapshot || this.state.result) return;
    const tick = this.estimatedServerTick();
    if (tick <= Math.max(this.lastSentTick, this.state.run.inputTick)) return;
    const next = this.state.run.pendingInputs.find((input) => !input.sent);
    if (!next) return;
    try {
      this.socket.send(JSON.stringify({ type: 'input', seq: next.seq, input: next.input }));
      this.state.run.pendingInputs = this.state.run.pendingInputs.map((input) => input.seq === next.seq ? { ...input, sent: true } : input);
      this.lastSentTick = tick;
    } catch (error) {
      this.showRunError(error);
    }
  }

  hitTarget() {
    if (this.state?.phase !== 'playing' || !this.predictedView?.started || this.predictedView.gameOver) return;
    try {
      this.queueInput({ action: 'hit', targetId: this.predictedView.target.id });
    } catch (error) {
      this.showRunError(error);
    }
  }

  renderRun() {
    const view = this.predictedView;
    if (!view) return;
    const remainingTicks = view.startTick === null ? view.rules.roundTicks
      : Math.max(0, view.rules.roundTicks - (this.estimatedServerTick() - view.startTick));
    this.target.hidden = !view.started || view.gameOver || remainingTicks <= 0;
    this.target.disabled = this.state.run.pendingInputs.length >= MAX_PENDING_INPUTS;
    this.arenaMessage.hidden = !this.target.hidden;
    this.arenaMessage.textContent = view.gameOver || remainingTicks <= 0
      ? 'Waiting for the platform’s recorded result…' : 'Starting your server-validated round…';
    const maxX = Math.max(0, this.arena.clientWidth - this.target.offsetWidth);
    const maxY = Math.max(0, this.arena.clientHeight - this.target.offsetHeight);
    this.target.style.left = `${view.target.x * maxX}px`;
    this.target.style.top = `${view.target.y * maxY}px`;
    this.scoreNode.textContent = `Score: ${view.score}${this.state.run.pendingInputs.length ? ' (pending server confirmation)' : ''}`;
    this.announce(view.gameOver || remainingTicks <= 0
      ? 'Waiting for the platform’s recorded result…'
      : `Time left: ${(remainingTicks * TICK_MILLISECONDS / 1000).toFixed(1)}s`);
    this.clearActions();
  }

  showRunError(error) {
    this.disconnectRun();
    this.target.hidden = true;
    this.arenaMessage.hidden = false;
    this.arenaMessage.textContent = 'Continue reconnects this same paid round; its server clock does not restart.';
    this.showRecoveryError(error, 'Game connection interrupted. Continue recovers this same paid round without using another credit.');
  }

  async submitAndComplete() {
    if (!this.state?.result || this.completing) return;
    const attempt = this.state;
    const accountKey = this.storageKey;
    this.completing = true;
    this.clearActions();
    this.target.hidden = true;
    this.announce(`The platform recorded verified score ${attempt.result.score}. Completing this round…`);
    try {
      this.save();
      if (!attempt.completed) {
        await this.game.complete({ sessionId: attempt.session.id, sessionToken: attempt.session.token });
        if (this.state !== attempt || this.storageKey !== accountKey) return;
        attempt.completed = true;
      }
      attempt.phase = 'completed';
      this.save();
      this.scoreNode.textContent = `Verified score: ${attempt.result.score}`;
      this.arenaMessage.hidden = false;
      this.arenaMessage.textContent = `Round complete. Server-verified score: ${attempt.result.score}.`;
      this.announce(`Round complete. Server-verified score: ${attempt.result.score}.`);
      await this.showPlayAction();
      void this.refreshTopScore();
    } catch (error) {
      if (this.state === attempt && this.storageKey === accountKey) {
        this.showRecoveryError(error, `The platform already recorded score ${attempt.result.score}. Continue only retries this round’s completion.`);
      }
    } finally {
      this.completing = false;
    }
  }

  async refreshTopScore() {
    try {
      const score = await this.scoringGame.getServerTopScore();
      this.topScoreNode.textContent = `Server-verified top score: ${score ?? '—'}`;
    } catch (error) {
      this.topScoreNode.textContent = `Server-verified top score unavailable: ${errorMessage(error)}`;
    }
  }
}
