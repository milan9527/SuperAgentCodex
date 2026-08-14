/**
 * Role Generator Service
 * 
 * This module provides AI-powered role generation for business scope creation.
 * It calls the backend API to generate agent suggestions using AI.
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.4, 9.5
 */

import { RestBusinessScopeService, type SuggestedAgent, type SuggestedTool } from './api/restBusinessScopeService';
import { shouldUseRestApi } from './api/index';

// ============================================================================
// TypeScript Interfaces
// ============================================================================

/**
 * Generated tool with skill definition
 */
export interface GeneratedTool {
  name: string;
  displayName: string;
  description: string;
  skillMd: string;
}

/**
 * Generated agent with full configuration
 */
export interface GeneratedAgent {
  id: string;
  name: string;
  roleId: string;
  role: string;
  avatar: string;
  description: string;
  responsibilities: string[];
  capabilities: string[];
  systemPromptSummary: string;
  tools: GeneratedTool[];
}

export interface GeneratedRole {
  roleId: string;
  roleName: string;
  coreResponsibilities: string[];
  keyCapabilities: string[];
  suggestedTools: string[];
}

// ============================================================================
// Helper Functions
// ============================================================================

const PINYIN_CHARACTERS: Record<string, string> = {
  风: 'feng',
  险: 'xian',
  策: 'ce',
  略: 'lue',
  师: 'shi',
  大: 'da',
  数: 'shu',
  据: 'ju',
  画: 'hua',
  像: 'xiang',
  分: 'fen',
  析: 'xi',
  测: 'ce',
  试: 'shi',
  角: 'jiao',
  色: 'se',
};

export function generateRoleId(roleName: string): string {
  const transliterated = Array.from(roleName.trim())
    .map((character) => {
      const pinyin = PINYIN_CHARACTERS[character];
      return pinyin ? ` ${pinyin} ` : character;
    })
    .join('');

  const roleId = transliterated
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');

  return roleId || 'generated-role';
}

const ROLE_TEMPLATES: Record<string, string[]> = {
  hr: ['Tech Recruiter', 'Onboarding Specialist', 'People Operations Analyst', 'Learning Coordinator', 'HR Service Agent'],
  asset: ['风险策略师', '大数据画像分析师', 'Asset Operations Specialist', 'Compliance Analyst', 'Recovery Coordinator'],
  it: ['IT Support Specialist', 'Systems Analyst', 'Security Coordinator', 'Platform Engineer', 'Service Desk Agent'],
  marketing: ['Campaign Strategist', 'Content Producer', 'Audience Analyst', 'Brand Coordinator', 'Marketing Operations Agent'],
  sales: ['Sales Development Rep', 'Account Analyst', 'Pipeline Coordinator', 'Customer Insights Agent', 'Sales Operations Specialist'],
  default: ['Operations Analyst', 'Process Coordinator', 'Knowledge Specialist', 'Quality Reviewer', 'Service Agent'],
};

function selectRoleTemplates(scopeName: string): string[] {
  const normalized = scopeName.toLowerCase();
  if (/(human resources|hr|人力)/i.test(normalized)) return ROLE_TEMPLATES.hr;
  if (/(asset|risk|逾期|资产|风险)/i.test(normalized)) return ROLE_TEMPLATES.asset;
  if (/(information technology|it|support|技术)/i.test(normalized)) return ROLE_TEMPLATES.it;
  if (/(marketing|campaign|市场)/i.test(normalized)) return ROLE_TEMPLATES.marketing;
  if (/(sales|销售)/i.test(normalized)) return ROLE_TEMPLATES.sales;
  return ROLE_TEMPLATES.default;
}

export async function generateRoles(scopeName: string, count: number = 5): Promise<GeneratedRole[]> {
  const templates = selectRoleTemplates(scopeName);
  return Array.from({ length: count }, (_, index) => {
    const roleName = templates[index % templates.length];
    return {
      roleId: generateRoleId(roleName),
      roleName,
      coreResponsibilities: [`Own ${roleName} workflows`, `Improve ${scopeName} outcomes`],
      keyCapabilities: ['Analysis', 'Coordination', 'Continuous improvement'],
      suggestedTools: ['Knowledge search', 'Workflow automation'],
    };
  });
}

/**
 * Generates a unique ID for an agent
 */
function generateAgentId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Gets an avatar character from a role name (fallback for when image generation is disabled)
 */
function getAvatarFromRole(roleName: string): string {
  // For Chinese names, use the first character
  if (/[\u4e00-\u9fa5]/.test(roleName)) {
    return roleName.charAt(0);
  }
  // For English names, use the first letter of each word (max 2)
  const words = roleName.split(' ');
  if (words.length >= 2) {
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }
  return roleName.charAt(0).toUpperCase();
}

/**
 * Generates avatar (image or text) based on environment configuration
 */
async function generateAvatar(roleName: string, description?: string): Promise<string> {
  // Check if avatar generation is enabled via environment variable
  const enableAvatarGeneration = import.meta.env?.VITE_ENABLE_AVATAR_GENERATION === 'true';
  
  if (!enableAvatarGeneration) {
    return getAvatarFromRole(roleName);
  }

  try {
    // Get backend URL from environment
    const backendUrl = import.meta.env?.VITE_API_BASE_URL ?? '';
    
    console.log('Generating avatar for:', roleName);
    
    // Call backend API to generate avatar image with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 min timeout
    
    const response = await fetch(`${backendUrl}/api/avatars/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: roleName, description }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Avatar generation failed: ${response.status}`);
    }

    const { avatarKey } = await response.json();
    console.log('Avatar generated:', avatarKey);
    
    // Return the raw S3 key — avatarUtils.ts resolves it to a backend URL for display
    return avatarKey;
  } catch (error) {
    console.warn('Avatar generation failed, falling back to text:', error);
    return getAvatarFromRole(roleName);
  }
}

/**
 * Converts a suggested agent from API to GeneratedAgent format
 */
async function mapSuggestedAgentToGeneratedAgent(suggested: SuggestedAgent): Promise<GeneratedAgent> {
  let avatar: string;
  try {
    avatar = await generateAvatar(suggested.displayName, suggested.description);
  } catch (error) {
    console.warn('Avatar generation error, using fallback:', error);
    avatar = getAvatarFromRole(suggested.displayName);
  }
  
  return {
    id: generateAgentId(),
    name: suggested.name,
    roleId: suggested.name,
    role: suggested.displayName,
    avatar,
    description: suggested.description,
    responsibilities: suggested.responsibilities,
    capabilities: suggested.capabilities,
    systemPromptSummary: suggested.systemPrompt,
    tools: suggested.suggestedTools.map(tool => ({
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      skillMd: tool.skillMd,
    })),
  };
}

// ============================================================================
// Main Service Functions
// ============================================================================

/**
 * Generates agents using AI via backend API.
 * Throws error if API call fails - no fallback.
 * 
 * @param scopeName - The business scope name to analyze
 * @param count - Number of agents to generate (default: 5)
 * @returns Promise resolving to array of generated agents
 */
export async function generateAgents(scopeName: string, count: number = 5): Promise<GeneratedAgent[]> {
  if (!shouldUseRestApi()) {
    const roles = await generateRoles(scopeName, count);
    return Promise.all(roles.map(async (role) => ({
      id: generateAgentId(),
      name: role.roleId,
      roleId: role.roleId,
      role: role.roleName,
      avatar: await generateAvatar(role.roleName),
      description: `${role.roleName} for ${scopeName}`,
      responsibilities: role.coreResponsibilities,
      capabilities: role.keyCapabilities,
      systemPromptSummary: `You are the ${role.roleName} for ${scopeName}.`,
      tools: role.suggestedTools.map((tool) => ({
        name: generateRoleId(tool),
        displayName: tool,
        description: `${tool} capability`,
        skillMd: `# ${tool}\n\nSupports ${role.roleName} workflows.`,
      })),
    })));
  }

  console.log('Generating agents for scope:', scopeName);
  
  const suggestedAgents = await RestBusinessScopeService.suggestAgents({
    businessScopeName: scopeName,
    agentCount: count,
  });

  console.log('Suggested agents received:', suggestedAgents.length);

  // Generate avatars in parallel for all agents
  const agents = await Promise.all(suggestedAgents.map(mapSuggestedAgentToGeneratedAgent));
  
  console.log('Agents with avatars ready:', agents.length);
  return agents;
}

/**
 * Generates agents with document context using AI via backend API.
 * 
 * @param scopeName - The business scope name
 * @param documentContents - Array of document text contents
 * @param count - Number of agents to generate
 * @returns Promise resolving to array of generated agents
 */
export async function generateAgentsWithDocuments(
  scopeName: string,
  documentContents: string[],
  count: number = 5
): Promise<GeneratedAgent[]> {
  if (!shouldUseRestApi()) {
    return generateAgents(scopeName, count);
  }

  console.log('Generating agents with documents for scope:', scopeName);

  const suggestedAgents = await RestBusinessScopeService.suggestAgents({
    businessScopeName: scopeName,
    documentContents,
    agentCount: count,
  });

  console.log('Suggested agents received:', suggestedAgents.length);

  // Generate avatars in parallel for all agents
  const agents = await Promise.all(suggestedAgents.map(mapSuggestedAgentToGeneratedAgent));
  
  console.log('Agents with avatars ready:', agents.length);
  return agents;
}

// ============================================================================
// Service Export
// ============================================================================

/**
 * Role Generator Service
 * Provides AI-powered role generation for business scope creation
 */
export const RoleGeneratorService = {
  generateRoleId,
  generateRoles,
  generateAgents,
  generateAgentsWithDocuments,
};

export default RoleGeneratorService;
