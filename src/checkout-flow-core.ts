import type { ConnectErc1155CheckoutTarget, CreateConnectIntentRequest } from './auth-flow-core.js';
import { normalizeReturnPath, type ReturnPathNormalizationResult } from './return-path-core.js';

export type CheckoutStartParams = {
  target: ConnectErc1155CheckoutTarget;
  returnPath?: string;
  initiatingOrigin?: string;
};

export type BuildConnectCheckoutIntentRequestInput = CheckoutStartParams & {
  state: string;
};

export type BuildConnectCheckoutIntentRequestResult =
  | { ok: true; request: CreateConnectIntentRequest }
  | Extract<ReturnPathNormalizationResult, { ok: false }>;

export function buildConnectCheckoutIntentRequest(
  input: BuildConnectCheckoutIntentRequestInput,
): BuildConnectCheckoutIntentRequestResult {
  const returnPathResult = normalizeReturnPath(input.returnPath);
  if (!returnPathResult.ok) {
    return returnPathResult;
  }

  return {
    ok: true,
    request: {
      action: {
        type: 'checkout',
        target: input.target,
      },
      returnPath: returnPathResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
    },
  };
}
