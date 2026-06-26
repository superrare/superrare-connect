export type ReturnPathNormalizationResult =
  | { ok: true; returnPath: string }
  | { ok: false; error: 'invalid_return_path' };

export function normalizeReturnPath(returnPath: string | undefined): ReturnPathNormalizationResult {
  if (returnPath === undefined) {
    return { ok: true, returnPath: '/' };
  }

  const trimmedReturnPath = returnPath.trim();
  if (trimmedReturnPath.length === 0) {
    return { ok: false, error: 'invalid_return_path' };
  }

  if (
    !trimmedReturnPath.startsWith('/') ||
    trimmedReturnPath.startsWith('//') ||
    hasControlCharacter(trimmedReturnPath) ||
    trimmedReturnPath.includes('\\') ||
    hasEncodedSlashOrBackslash(trimmedReturnPath) ||
    isAbsoluteUrl(trimmedReturnPath)
  ) {
    return { ok: false, error: 'invalid_return_path' };
  }

  return { ok: true, returnPath: trimmedReturnPath };
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol.length > 0;
  } catch {
    return false;
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint < 32;
  });
}

function hasEncodedSlashOrBackslash(value: string): boolean {
  return /%2f|%5c/i.test(value);
}
