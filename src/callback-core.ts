/**
 * The one-time parameters the hosted login page reports back to the SDK
 * (via `postMessage` to the opener, or in the return URL's query for a
 * redirect login): the intent they belong to, the CSRF `state` the SDK
 * created, and the single-use code the backend exchanges for a Connect
 * session.
 */
export type ConnectAuthCallbackParams = {
  intentId: string;
  state: string;
  code: string;
};

export type ConnectAuthCallbackParseErrorCode =
  | 'missing_intent_id'
  | 'missing_state'
  | 'missing_code'
  | 'duplicate_intent_id'
  | 'duplicate_state'
  | 'duplicate_code'
  | 'malformed_intent_id'
  | 'malformed_state'
  | 'malformed_code';

export type ConnectAuthCallbackParseResult =
  | { ok: true; params: ConnectAuthCallbackParams }
  | { ok: false; error: ConnectAuthCallbackParseErrorCode };

type CallbackParameterRule = {
  name: keyof ConnectAuthCallbackParams;
  missingError: ConnectAuthCallbackParseErrorCode;
  duplicateError: ConnectAuthCallbackParseErrorCode;
  malformedError: ConnectAuthCallbackParseErrorCode;
};

const intentIdRule: CallbackParameterRule = {
  name: 'intentId',
  missingError: 'missing_intent_id',
  duplicateError: 'duplicate_intent_id',
  malformedError: 'malformed_intent_id',
};

const stateRule: CallbackParameterRule = {
  name: 'state',
  missingError: 'missing_state',
  duplicateError: 'duplicate_state',
  malformedError: 'malformed_state',
};

const codeRule: CallbackParameterRule = {
  name: 'code',
  missingError: 'missing_code',
  duplicateError: 'duplicate_code',
  malformedError: 'malformed_code',
};

export function parseConnectAuthCallbackSearchParams(
  searchParams: URLSearchParams,
): ConnectAuthCallbackParseResult {
  const intentIdResult = readRequiredCallbackParameter(searchParams, intentIdRule);
  if (!intentIdResult.ok) return intentIdResult;

  const stateResult = readRequiredCallbackParameter(searchParams, stateRule);
  if (!stateResult.ok) return stateResult;

  const codeResult = readRequiredCallbackParameter(searchParams, codeRule);
  if (!codeResult.ok) return codeResult;

  return {
    ok: true,
    params: {
      intentId: intentIdResult.value,
      state: stateResult.value,
      code: codeResult.value,
    },
  };
}

function readRequiredCallbackParameter(
  searchParams: URLSearchParams,
  rule: CallbackParameterRule,
): { ok: true; value: string } | { ok: false; error: ConnectAuthCallbackParseErrorCode } {
  const values = searchParams.getAll(rule.name);
  if (values.length === 0) return { ok: false, error: rule.missingError };
  if (values.length > 1) return { ok: false, error: rule.duplicateError };

  const value = values[0];
  if (value === undefined || isMalformedCallbackParameterValue(value)) {
    return { ok: false, error: rule.malformedError };
  }

  return { ok: true, value };
}

function isMalformedCallbackParameterValue(value: string): boolean {
  return value.trim().length === 0 || Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint < 32;
  });
}
