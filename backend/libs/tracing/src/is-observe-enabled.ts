/** isObserveEnabled reports whether Nest observe/tracing instrumentation should load. */
export function isObserveEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const key = env.OBSERVE_APP_KEY?.trim() ?? '';
  const secret = env.OBSERVE_APP_SECRET?.trim() ?? '';
  return key.length > 0 && secret.length > 0;
}
