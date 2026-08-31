import type {
  ConnectErc1155CheckoutTarget,
  ConnectIntentPayment,
  CreateConnectIntentRequest,
} from './auth-flow-core.js';
import { normalizeReturnPath, type ReturnPathNormalizationResult } from './return-path-core.js';

export type CheckoutStartParams = {
  target: ConnectErc1155CheckoutTarget;
  returnPath?: string;
  initiatingOrigin?: string;
  /**
   * Set `{ method: 'wallet' }` for sales that must never offer card payment —
   * required for custom settlement contracts that key on the receiving
   * wallet. See {@link ConnectIntentPayment}.
   */
  payment?: ConnectIntentPayment;
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
      ...(input.payment === undefined ? {} : { payment: input.payment }),
    },
  };
}
