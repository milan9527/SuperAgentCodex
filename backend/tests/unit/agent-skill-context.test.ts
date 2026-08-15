import { describe, expect, it } from 'vitest';
import {
  dedupeGeneratedSkillContext,
  renderGeneratedSkillContext,
  stripGeneratedSkillContext,
} from '../../src/services/agent-skill-context.js';

const FIRST = 'Relevant project skills are available under .agents/skills: old-skill.';
const CURRENT = 'Relevant project skills are available under .agents/skills: current-skill.';

describe('generated subagent skill context', () => {
  it('strips all generated context before persisting a system prompt', () => {
    expect(stripGeneratedSkillContext([
      'Business instructions.',
      '',
      FIRST,
      '',
      CURRENT,
    ].join('\n'))).toBe('Business instructions.');
  });

  it('keeps only the latest generated context in an existing TOML snapshot', () => {
    const result = dedupeGeneratedSkillContext([
      'developer_instructions = """Business instructions.',
      '',
      FIRST,
      '',
      `${CURRENT}"""`,
    ].join('\n'));

    expect(result).not.toContain(FIRST);
    expect(result.match(/Relevant project skills are available under \.agents\/skills:/g))
      .toHaveLength(1);
    expect(result).toContain(CURRENT);
    expect(result).toMatch(/current-skill\."""$/);
  });

  it('deduplicates skill names when rendering current context', () => {
    expect(renderGeneratedSkillContext(['analyze', 'analyze', ' report ']))
      .toBe('Relevant project skills are available under .agents/skills: analyze, report.');
  });
});
