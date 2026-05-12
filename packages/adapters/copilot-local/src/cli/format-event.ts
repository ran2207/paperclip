export function printCopilotStreamEvent(line: string, _debug: boolean): void {
  if (!line) return;
  process.stdout.write(line);
  if (!line.endsWith("\n")) process.stdout.write("\n");
}
