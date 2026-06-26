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

type CallbackParameterName = 'intentId' | 'state' | 'code';

type CallbackParameterRule = {
  name: CallbackParameterName;
  missingError: ConnectAuthCallbackParseErrorCode;
  duplicateError: ConnectAuthCallbackParseErrorCode;
  malformedError: ConnectAuthCallbackParseErrorCode;
};

const callbackParameterRules: readonly CallbackParameterRule[] = [
  {
    name: 'intentId',
    missingError: 'missing_intent_id',
    duplicateError: 'duplicate_intent_id',
    malformedError: 'malformed_intent_id',
  },
  {
    name: 'state',
    missingError: 'missing_state',
    duplicateError: 'duplicate_state',
    malformedError: 'malformed_state',
  },
  {
    name: 'code',
    missingError: 'missing_code',
    duplicateError: 'duplicate_code',
    malformedError: 'malformed_code',
  },
];

export function parseConnectAuthCallbackSearchParams(
  searchParams: URLSearchParams,
): ConnectAuthCallbackParseResult {
  const intentIdResult = readRequiredCallbackParameter(searchParams, callbackParameterRules[0]);
  if (!intentIdResult.ok) return intentIdResult;

  const stateResult = readRequiredCallbackParameter(searchParams, callbackParameterRules[1]);
  if (!stateResult.ok) return stateResult;

  const codeResult = readRequiredCallbackParameter(searchParams, callbackParameterRules[2]);
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
  rule: CallbackParameterRule | undefined,
): { ok: true; value: string } | { ok: false; error: ConnectAuthCallbackParseErrorCode } {
  if (rule === undefined) {
    throw new Error('unreachable: missing callback parameter rule');
  }

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
  return value.trim().length === 0 || hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint < 32;
  });
}
