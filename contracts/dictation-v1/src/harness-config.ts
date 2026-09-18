export function resolveHarnessAudioPath(
  env: NodeJS.Dict<string>,
  defaultPath: string,
): string {
  const custom = env.HARNESS_AUDIO?.trim();
  return custom ? custom : defaultPath;
}

export function formatFinalLine(run: number, text: string): string {
  return `run ${run} final.text: ${text}`;
}
