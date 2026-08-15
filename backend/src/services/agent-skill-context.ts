const GENERATED_SKILL_CONTEXT_PATTERN =
  /^[ \t]*Relevant project skills are available under \.agents\/skills:[^\r\n]*\.[ \t]*(?:\r?\n)?/gm;
const GENERATED_SKILL_CONTEXT_LINE_PATTERN =
  /^[ \t]*Relevant project skills are available under \.agents\/skills:[^\r\n]*\.[ \t]*(?:""")?[ \t]*$/;

export function stripGeneratedSkillContext(value: string): string {
  return value
    .replace(GENERATED_SKILL_CONTEXT_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderGeneratedSkillContext(skillNames: string[]): string {
  const uniqueNames = [...new Set(skillNames.map(name => name.trim()).filter(Boolean))];
  return uniqueNames.length > 0
    ? `Relevant project skills are available under .agents/skills: ${uniqueNames.join(', ')}.`
    : '';
}

export function dedupeGeneratedSkillContext(value: string): string {
  const lines = value.split(/\r?\n/);
  const generatedIndexes = lines.flatMap((line, index) => (
    GENERATED_SKILL_CONTEXT_LINE_PATTERN.test(line) ? [index] : []
  ));
  if (generatedIndexes.length <= 1) return value;

  const lastGeneratedIndex = generatedIndexes.at(-1);
  return lines
    .filter((line, index) => (
      !GENERATED_SKILL_CONTEXT_LINE_PATTERN.test(line) || index === lastGeneratedIndex
    ))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
