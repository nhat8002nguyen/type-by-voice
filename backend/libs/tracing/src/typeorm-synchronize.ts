/** shouldSynchronizeTypeOrm reports whether TypeORM may auto-create schema for this process. */
export function shouldSynchronizeTypeOrm(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV === 'development') {
    return true;
  }
  return env.TYPEORM_SYNCHRONIZE === 'true';
}
