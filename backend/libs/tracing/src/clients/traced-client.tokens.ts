const underlyingTokens = new Map<string | symbol, symbol>();

/** underlyingClientToken builds the injection token for the unwrapped ClientProxy. */
export function underlyingClientToken(name: string | symbol): symbol {
  const existing = underlyingTokens.get(name);
  if (existing) {
    return existing;
  }
  const token = Symbol(`${String(name)}_CLIENT`);
  underlyingTokens.set(name, token);
  return token;
}
